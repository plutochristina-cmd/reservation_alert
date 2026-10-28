module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { businessId, bizItemId, businessTypeId, startDate, endDate } = req.query;

  if (!businessId) {
    return res.status(400).json({ error: 'businessId is required' });
  }

  const targetBizId = String(businessId).trim();
  const targetItemId = String(bizItemId || '1').trim();
  const targetTypeId = Number(businessTypeId) || 13;

  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://booking.naver.com/',
      'Content-Type': 'application/json'
    };

    let resolvedBizId = targetBizId;
    let resolvedItemId = targetItemId;

    // Place ID인 경우 booking businessId 역추적 및 기본 itemId('1') 자동 보정 + 매장 예약 마감 규칙 조회
    const checkQuery = `
      query getBiz($businessId: String!) {
        business(input: {businessId: $businessId, lang: "ko"}) {
          name
          bookingAvailableCode
          bookingAvailableValue
          bookingTimeUnitCode
        }
        bizItems(input: {businessId: $businessId, lang: "ko"}) {
          id
          name
          bookingAvailableCode
          bookingAvailableValue
          bookingTimeUnitCode
          minBookingCount
          maxBookingCount
          minBookingTime
          maxBookingTime
          bookableSettingJson
        }
      }
    `;
    let checkResp = await fetch('https://booking.naver.com/graphql', {
      method: 'POST',
      headers,
      body: JSON.stringify({ query: checkQuery, variables: { businessId: resolvedBizId } })
    });
    let checkJson = checkResp.ok ? await checkResp.json() : null;

    if (!checkJson?.data?.business) {
      // 플레이스 페이지에서 bookingId 추출 시도 (/booking 및 /home 모두 확인, \u002F 이스케이프 해제)
      for (const suffix of ['booking', 'home']) {
        try {
          const placeResp = await fetch(`https://m.place.naver.com/place/${resolvedBizId}/${suffix}`, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1',
              'Referer': 'https://m.place.naver.com/'
            }
          });
          if (placeResp.ok) {
            const rawText = await placeResp.text();
            const text = rawText.replace(/\\u002F/gi, '/').replace(/\\\//g, '/');
            const match = text.match(/booking\.naver\.com\/(?:m\/)?booking\/\d+\/bizes\/(\d+)/i) ||
                          text.match(/"bookingBusinessId"\s*:\s*"?(\d+)"?/i) ||
                          text.match(/bizes\/(\d+)/i) ||
                          text.match(/"businessId"\s*:\s*"?(\d+)"?/i);
            if (match && match[1] && match[1] !== resolvedBizId) {
              resolvedBizId = match[1];
              break;
            }
          }
        } catch (e) {}
      }

      if (resolvedBizId !== targetBizId) {
        checkResp = await fetch('https://booking.naver.com/graphql', {
          method: 'POST',
          headers,
          body: JSON.stringify({ query: checkQuery, variables: { businessId: resolvedBizId } })
        });
        checkJson = checkResp.ok ? await checkResp.json() : null;
      }
    }

    // bizItemId가 '1' 등 임시값인 경우 첫 번째 실제 상품 ID로 자동 매핑
    const bizInfo = checkJson?.data?.business || {};
    const bizItemsList = checkJson?.data?.bizItems || [];
    if ((resolvedItemId === '1' || !resolvedItemId) && bizItemsList.length > 0) {
      resolvedItemId = String(bizItemsList[0].id || '').split('_')[0];
    }

    const matchedItem = bizItemsList.find(
      (it) => String(it.id || '').split('_')[0] === String(resolvedItemId)
    ) || bizItemsList[0] || {};

    // 슬롯 조회 기간 계산 (KST 한국 표준시 기준: 기본값 오늘 ~ 35일 후)
    const pad = (n) => String(n).padStart(2, '0');
    const toKstDateStr = (dateObj) => {
      const kst = new Date(dateObj.getTime() + 9 * 3600 * 1000);
      return `${kst.getUTCFullYear()}-${pad(kst.getUTCMonth() + 1)}-${pad(kst.getUTCDate())}`;
    };

    const currentEpoch = Date.now();
    // 알림 수신 후 접속 및 선택 시간까지 고려한 5분 안전 버퍼 적용
    const SAFETY_BUFFER_MS = 5 * 60 * 1000;
    const effectiveNowEpoch = currentEpoch + SAFETY_BUFFER_MS;

    const todayKstStr = toKstDateStr(new Date(effectiveNowEpoch));
    const startOfTodayKstEpoch = new Date(`${todayKstStr}T00:00:00+09:00`).getTime();
    const endOfTodayKstEpoch = new Date(`${todayKstStr}T23:59:59.999+09:00`).getTime();

    // 매장별 예약 접수 마감 규칙 계산 (네이버 공식 프론트엔드 KK / Yg 로직 반영)
    // - RI01 (INSTANTLY): 즉시 예약 가능 (현재 시각 + 5분 버퍼 이후)
    // - RI02 (UNAVAILABLE): 당일 예약 불가 / N일 전 마감 (오늘 00:00 + N일 이후만 가능)
    // - RI03 (AVAILABLE): 예약 N시간 전 마감 (현재 시각 + 5분 버퍼 + N시간 이후만 가능)
    const availCode = (bizInfo.bookingAvailableCode && bizInfo.bookingAvailableCode !== 'RI01')
      ? bizInfo.bookingAvailableCode
      : (matchedItem.bookingAvailableCode || bizInfo.bookingAvailableCode || 'RI01');
    const availVal = (bizInfo.bookingAvailableCode && bizInfo.bookingAvailableCode !== 'RI01')
      ? (Number(bizInfo.bookingAvailableValue) || 0)
      : (Number(matchedItem.bookingAvailableValue ?? bizInfo.bookingAvailableValue) || 0);

    let minBookableEpoch = effectiveNowEpoch;
    if (availCode === 'RI02') {
      const daysAhead = Math.max(availVal, 1);
      minBookableEpoch = Math.max(effectiveNowEpoch, startOfTodayKstEpoch + daysAhead * 24 * 3600 * 1000);
    } else if (availCode === 'RI03') {
      const rawCutoff = effectiveNowEpoch + availVal * 3600 * 1000;
      const cappedCutoff = rawCutoff > endOfTodayKstEpoch ? endOfTodayKstEpoch : rawCutoff;
      minBookableEpoch = Math.max(effectiveNowEpoch, cappedCutoff);
    }

    const bookableSetting = matchedItem.bookableSettingJson || {};
    const isItemOpened = bookableSetting.isOpened !== false && bookableSetting.isPaused !== true;
    const itemMinBookingCount = Number(matchedItem.minBookingCount) || 1;
    const itemMinBookingTime = Number(matchedItem.minBookingTime) || 0;
    const timeUnitCode = matchedItem.bookingTimeUnitCode || bizInfo.bookingTimeUnitCode || 'RT02';
    const defaultSlotDuration = timeUnitCode === 'RT01' ? 30 : 60;

    const startStr = startDate ? startDate.slice(0, 10) : toKstDateStr(new Date(currentEpoch));
    const endStr = endDate ? endDate.slice(0, 10) : toKstDateStr(new Date(currentEpoch + 35 * 24 * 3600 * 1000));

    const query = `
      query hourlySchedule($scheduleParams: ScheduleParams) {
        schedule(input: $scheduleParams) {
          bizItemSchedule {
            hourly {
              unitStartTime
              isBusinessDay
              isUnitBusinessDay
              isSaleDay
              isUnitSaleDay
              isHoliday
              unitStock
              unitBookingCount
              stock
              bookingCount
              occupiedBookingCount
              duration
              minBookingCount
              maxBookingCount
            }
          }
        }
      }
    `;

    const variables = {
      scheduleParams: {
        businessTypeId: targetTypeId,
        businessId: resolvedBizId,
        bizItemId: resolvedItemId,
        startDateTime: `${startStr}T00:00:00`,
        endDateTime: `${endStr}T23:59:59`,
        fixedTime: true,
        includesHolidaySchedules: true
      }
    };

    const resp = await fetch('https://booking.naver.com/graphql', {
      method: 'POST',
      headers: {
        ...headers,
        'Origin': 'https://booking.naver.com',
        'Referer': `https://booking.naver.com/booking/${targetTypeId}/bizes/${resolvedBizId}/items/${resolvedItemId}`
      },
      body: JSON.stringify({ query, variables })
    });

    if (!resp.ok) {
      return res.status(resp.status).json({ error: `Naver GraphQL error: ${resp.statusText}` });
    }

    const data = await resp.json();
    const rawHourly = isItemOpened ? (data?.data?.schedule?.bizItemSchedule?.hourly || []) : [];

    // 1단계: 시간 마감 규칙(minBookableEpoch + bookableSettingJson) 및 슬롯별 실재고(Ft/nX) 1차 판정
    const byDate = {};
    for (const slot of rawHourly) {
      if (!slot.unitStartTime) continue;

      const slotEpoch = new Date(slot.unitStartTime.replace(' ', 'T') + '+09:00').getTime();
      if (isNaN(slotEpoch) || slotEpoch < minBookableEpoch) continue;

      const [datePart, timePart] = slot.unitStartTime.split(' ');

      // bookableSettingJson.isUseClose (N일 전 N시 마감 설정) 확인
      if (bookableSetting.isUseClose) {
        const closeDays = Number(bookableSetting.closeDays) || 0;
        const closeHours = Number(bookableSetting.closeHours) || 0;
        const slotDayStart = new Date(`${datePart}T00:00:00+09:00`).getTime();
        const closeDeadline = slotDayStart - closeDays * 24 * 3600 * 1000 + closeHours * 3600 * 1000;
        if (effectiveNowEpoch >= closeDeadline) continue;
      }

      const isOpen = Boolean(
        slot.isBusinessDay &&
        slot.isUnitBusinessDay &&
        slot.isSaleDay &&
        slot.isUnitSaleDay &&
        !slot.isHoliday
      );
      const unitStock = slot.unitStock != null ? Number(slot.unitStock) : (Number(slot.stock) || 0);
      const unitBooked = Number(slot.unitBookingCount) || 0;
      const unitRemain = unitStock - unitBooked;
      const totalRemain = slot.stock != null
        ? Number(slot.stock) - (Number(slot.bookingCount) || 0) - (Number(slot.occupiedBookingCount) || 0)
        : unitRemain;
      const maxAllowed = Number(slot.maxBookingCount) || unitStock;
      const remain = Math.min(unitRemain, totalRemain, maxAllowed);
      const minRequired = Math.max(1, Number(slot.minBookingCount) || itemMinBookingCount);
      const isBookable = isOpen && remain >= minRequired;
      const duration = Number(slot.duration) || defaultSlotDuration;

      if (!byDate[datePart]) byDate[datePart] = [];
      byDate[datePart].push({
        slot,
        datePart,
        timePart,
        remain,
        duration,
        isBookable,
        isUnitBusinessDay: Boolean(slot.isUnitBusinessDay),
        isHoliday: Boolean(slot.isHoliday)
      });
    }

    // 2단계: 날짜별 연속 가능 시간(maxBookingTime) 역산 후 minBookingTime 조건 검증
    const availableSlots = [];
    const weekdayKr = ['일', '월', '화', '수', '목', '금', '토'];

    for (const datePart of Object.keys(byDate).sort()) {
      const daySlots = byDate[datePart];
      let accMinutes = 0;
      for (let i = daySlots.length - 1; i >= 0; i--) {
        const entry = daySlots[i];
        if (entry.isBookable) {
          accMinutes += entry.duration;
        } else {
          accMinutes = 0;
        }
        entry.maxBookingTime = accMinutes;
      }

      for (const entry of daySlots) {
        if (!entry.isBookable) continue;
        if (itemMinBookingTime > 0 && entry.maxBookingTime < itemMinBookingTime) continue;

        const [year, month, day] = entry.datePart.split('-');
        const [hour, min] = (entry.timePart || '00:00').split(':');
        const dayOfWeekIdx = new Date(Number(year), Number(month) - 1, Number(day)).getDay();
        const wk = weekdayKr[dayOfWeekIdx];
        const formatted = `${year}년 ${month}월 ${day}일 (${wk}) ${hour}:${min} (잔여: ${entry.remain}자리)`;
        availableSlots.push({
          startTime: entry.slot.unitStartTime,
          remain: entry.remain,
          formatted
        });
      }
    }

    return res.status(200).json({
      businessId: resolvedBizId,
      bizItemId: targetItemId,
      totalAvailable: availableSlots.length,
      availableSlots: availableSlots.slice(0, 10),
      topSlot: availableSlots.length > 0 ? availableSlots[0].formatted : null
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
