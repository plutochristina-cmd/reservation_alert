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

    // Place ID인 경우 booking businessId 역추적 (items.js와 동일한 로직)
    const checkQuery = `
      query getBiz($businessId: String!) {
        business(input: {businessId: $businessId, lang: "ko"}) {
          name
        }
      }
    `;
    const checkResp = await fetch('https://booking.naver.com/graphql', {
      method: 'POST',
      headers,
      body: JSON.stringify({ query: checkQuery, variables: { businessId: resolvedBizId } })
    });
    const checkJson = checkResp.ok ? await checkResp.json() : null;

    if (!checkJson?.data?.business) {
      // 플레이스 페이지에서 bookingId 추출 시도
      try {
        const placeResp = await fetch(`https://m.place.naver.com/place/${resolvedBizId}/booking`, {
          headers: { 'User-Agent': headers['User-Agent'] }
        });
        if (placeResp.ok) {
          const text = await placeResp.text();
          const match = text.match(/booking\.naver\.com\/booking\/\d+\/bizes\/(\d+)/i) ||
                        text.match(/bizes\/(\d+)/i) ||
                        text.match(/"businessId":\s*"?(\d+)"?/i);
          if (match && match[1] && match[1] !== resolvedBizId) {
            resolvedBizId = match[1];
          }
        }
      } catch (e) {}
    }

    // 슬롯 조회 기간 계산 (기본값: 오늘 ~ 35일 후)
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const toDateStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

    const startStr = startDate ? startDate.slice(0, 10) : toDateStr(now);
    const endStr = endDate ? endDate.slice(0, 10) : toDateStr(new Date(now.getTime() + 35 * 24 * 3600 * 1000));

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
        bizItemId: targetItemId,
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
        'Referer': `https://booking.naver.com/booking/${targetTypeId}/bizes/${resolvedBizId}/items/${targetItemId}`
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
      const slotTime = new Date(slot.unitStartTime.replace(' ', 'T'));
      if (slotTime <= now) continue;

      const isOpen = slot.isBusinessDay && slot.isUnitBusinessDay && slot.isSaleDay && slot.isUnitSaleDay;
      const stock = slot.unitStock != null ? slot.unitStock : (slot.stock || 0);
      const booked = slot.unitBookingCount || 0;
      const remain = stock - booked;

      if (isOpen && remain > 0) {
        const wk = weekdayKr[slotTime.getDay()];
        const formatted = `${slotTime.getFullYear()}년 ${pad(slotTime.getMonth()+1)}월 ${pad(slotTime.getDate())}일 (${wk}) ${pad(slotTime.getHours())}:${pad(slotTime.getMinutes())} (잔여: ${remain}자리)`;
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
