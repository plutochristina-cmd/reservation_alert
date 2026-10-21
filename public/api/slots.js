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

    // Place ID인 경우 booking businessId 역추적 및 기본 itemId('1') 자동 보정
    const checkQuery = `
      query getBiz($businessId: String!) {
        business(input: {businessId: $businessId, lang: "ko"}) {
          name
        }
        bizItems(input: {businessId: $businessId, lang: "ko"}) {
          id
          name
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
    const bizItemsList = checkJson?.data?.bizItems || [];
    if ((resolvedItemId === '1' || !resolvedItemId) && bizItemsList.length > 0) {
      resolvedItemId = String(bizItemsList[0].id || '').split('_')[0];
    }

    // 슬롯 조회 기간 계산 (KST 한국 표준시 기준: 기본값 오늘 ~ 35일 후)
    const pad = (n) => String(n).padStart(2, '0');
    const toKstDateStr = (dateObj) => {
      const kst = new Date(dateObj.getTime() + 9 * 3600 * 1000);
      return `${kst.getUTCFullYear()}-${pad(kst.getUTCMonth() + 1)}-${pad(kst.getUTCDate())}`;
    };

    const currentEpoch = Date.now();
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
              unitStock
              unitBookingCount
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
    const rawHourly = data?.data?.schedule?.bizItemSchedule?.hourly || [];

    const availableSlots = [];
    const weekdayKr = ['일', '월', '화', '수', '목', '금', '토'];

    for (const slot of rawHourly) {
      if (!slot.unitStartTime) continue;

      // 네이버 슬롯은 KST(한국 표준시, UTC+9) 기준 문자열 (예: "2026-10-20 14:00:00")
      // Vercel 서버(UTC)에서도 한국 시각 기준으로 정확히 비교할 수 있도록 +09:00 오프셋을 적용
      const slotEpoch = new Date(slot.unitStartTime.replace(' ', 'T') + '+09:00').getTime();
      
      // 현재 한국 시각 기준으로 이미 지나간 과거 슬롯 제외
      if (isNaN(slotEpoch) || slotEpoch <= currentEpoch) continue;

      const isOpen = slot.isBusinessDay && slot.isUnitBusinessDay && slot.isSaleDay && slot.isUnitSaleDay;
      const stock = slot.unitStock != null ? slot.unitStock : (slot.stock || 0);
      const booked = slot.unitBookingCount || 0;
      const remain = stock - booked;

      if (isOpen && remain > 0) {
        // 날짜/시간 포맷: 문자열 직접 파싱으로 서버 타임존 왜곡 방지
        const [datePart, timePart] = slot.unitStartTime.split(' ');
        const [year, month, day] = datePart.split('-');
        const [hour, min] = (timePart || '00:00').split(':');
        const dayOfWeekIdx = new Date(Number(year), Number(month) - 1, Number(day)).getDay();
        const wk = weekdayKr[dayOfWeekIdx];
        const formatted = `${year}년 ${month}월 ${day}일 (${wk}) ${hour}:${min} (잔여: ${remain}자리)`;
        availableSlots.push({
          startTime: slot.unitStartTime,
          remain,
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
