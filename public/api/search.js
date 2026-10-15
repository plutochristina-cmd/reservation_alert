module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const query = req.query.q;
  if (!query || query.trim().length === 0) {
    return res.status(200).json({ results: [] });
  }

  try {
    const encoded = encodeURIComponent(query.trim());
    const naverUrl = `https://map.naver.com/p/api/search/instant-search?query=${encoded}&coords=37.5665,126.9780`;

    const resp = await fetch(naverUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://map.naver.com/'
      }
    });

    if (!resp.ok) {
      return res.status(200).json({ results: [] });
    }

    const data = await resp.json();
    const places = (data.place || []).map(p => ({
      id: p.id || p.sid,
      title: (p.title || '').replace(/<[^>]+>/g, ''),
      category: p.ctg || '',
      address: p.roadAddress || p.jibunAddress || '',
      businessId: p.id || p.sid
    }));

    return res.status(200).json({ results: places });
  } catch (error) {
    return res.status(500).json({ error: error.message, results: [] });
  }
};
