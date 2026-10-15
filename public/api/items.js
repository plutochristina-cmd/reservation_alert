module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const targetId = req.query.businessId;
  if (!targetId) {
    return res.status(400).json({ error: 'businessId is required' });
  }

  try {
    const query = `
      query getBusinessBooking($businessId: String!) {
        business(input: {businessId: $businessId, lang: "ko"}) {
          name
          businessTypeId
          bookingUrl
        }
        bizItems(input: {businessId: $businessId, lang: "ko"}) {
          id
          name
          desc
        }
      }
    `;

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://booking.naver.com/',
      'Content-Type': 'application/json'
    };

    let resolvedBizId = String(targetId).trim();
    let resolvedTypeId = 13;

    // 1차: 직접 businessId로 조회
    let resp = await fetch('https://booking.naver.com/graphql', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query,
        variables: { businessId: resolvedBizId }
      })
    });

    let result = resp.ok ? await resp.json() : null;
    let biz = result?.data?.business || null;
    let rawItems = result?.data?.bizItems || null;

    // 2차: 플레이스 ID인 경우 (직접 조회 결과가 없을 때) 모바일 플레이스 페이지에서 booking businessId 역추적
    if (!biz || !rawItems || rawItems.length === 0) {
      const placeCandidates = [
        `https://m.place.naver.com/place/${resolvedBizId}/booking`,
        `https://m.place.naver.com/hospital/${resolvedBizId}/booking`,
        `https://m.place.naver.com/place/${resolvedBizId}/home`
      ];

      for (const placeUrl of placeCandidates) {
        try {
          const pResp = await fetch(placeUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1',
              'Referer': 'https://m.place.naver.com/'
            }
          });
          if (pResp.ok) {
            const pText = await pResp.text();
            const match = pText.match(/booking\.naver\.com\/(?:m\/)?booking\/(\d+)\/bizes\/(\d+)/) || pText.match(/bizes\/(\d+)/);
            if (match) {
              if (match[2]) {
                resolvedTypeId = parseInt(match[1], 10);
                resolvedBizId = match[2];
              } else {
                resolvedBizId = match[1];
              }
              break;
            }
          }
        } catch (e) {
          // ignore candidate error
        }
      }

      // 역추적된 실제 businessId로 GraphQL 재조회
      if (resolvedBizId !== targetId) {
        resp = await fetch('https://booking.naver.com/graphql', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            query,
            variables: { businessId: resolvedBizId }
          })
        });
        if (resp.ok) {
          result = await resp.json();
          biz = result?.data?.business || null;
          rawItems = result?.data?.bizItems || null;
        }
      }
    }

    const items = (rawItems || []).map(item => {
      const rawId = String(item.id || '');
      const cleanId = rawId.split('_')[0];
      return {
        id: cleanId,
        name: item.name,
        desc: item.desc || ''
      };
    });

    return res.status(200).json({
      businessId: resolvedBizId,
      businessTypeId: biz?.businessTypeId || resolvedTypeId,
      business: biz,
      items
    });
  } catch (error) {
    return res.status(500).json({ error: error.message, items: [] });
  }
};
