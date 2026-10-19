const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Referer': 'https://nol.yanolja.com/',
  'Accept': 'application/json, text/plain, */*'
};

const POPULAR_CONCERTS = [
  { goodsCode: '26013810', title: '2026 다이나믹 듀오 단독 콘서트', artist: '다이나믹듀오 dynamic duo', placeName: '올림픽공원 올림픽홀', dates: '2026.11.27 ~ 2026.11.29', category: '콘서트' },
  { goodsCode: '24016625', title: '뮤지컬 〈지킬앤하이드〉 20주년 (Jekyll & Hyde)', artist: '지킬앤하이드 조승우 홍광호', placeName: '블루스퀘어 신한카드홀', dates: '2024.11.29 ~ 2025.05.18', category: '뮤지컬' },
  { goodsCode: '26003518', title: '뮤지컬 〈알라딘〉 한국 초연 (Broadway ALADDIN)', artist: '알라딘 김준수 정원영', placeName: '샤롯데씨어터', dates: '2024.11.22 ~ 2025.06.22', category: '뮤지컬' },
  { goodsCode: '24017830', title: '뮤지컬 〈시카고〉 (CHICAGO)', artist: '시카고 최정원 아이비', placeName: '디큐브 링크아트센터', dates: '2024.06.11 ~ 2024.09.29', category: '뮤지컬' },
  { goodsCode: '26014498', title: 'DAY6 3RD WORLD TOUR 〈FOREVER YOUNG〉', artist: '데이식스 DAY6 성진 영케이 원필 도운', placeName: '인스파이어 아레나', dates: '2024.09.20 ~ 2024.09.22', category: '콘서트' },
  { goodsCode: '25013836', title: '2024 IU HEREH WORLD TOUR CONCERT ENCORE', artist: '아이유 IU 이지금', placeName: '서울월드컵경기장', dates: '2024.09.21 ~ 2024.09.22', category: '콘서트' },
  { goodsCode: '24015502', title: '뮤지컬 〈영웅〉 15주년 기념공연 (HERO)', artist: '영웅 정성화 양준모 민우혁', placeName: '세종문화회관 대극장', dates: '2024.05.29 ~ 2024.08.11', category: '뮤지컬' }
];

async function fetchConcertSummary(cleanCode) {
  try {
    const summaryUrl = `https://api-ticketfront.interpark.com/v1/goods/${cleanCode}/summary`;
    const resp = await fetch(summaryUrl, { headers: HEADERS });
    if (!resp.ok) return null;
    const json = await resp.json();
    return json.data || null;
  } catch (e) {
    return null;
  }
}

async function fetchCastCredits(cleanCode) {
  try {
    const url = `https://nol.yanolja.com/ticket/products/${cleanCode}`;
    const resp = await fetch(url, { headers: HEADERS });
    if (!resp.ok) return [];
    const html = await resp.text();
    const idx = html.indexOf('castCredits');
    if (idx === -1) return [];
    const startIdx = html.indexOf('[', idx);
    if (startIdx === -1) return [];
    let depth = 0;
    let endIdx = -1;
    for (let i = startIdx; i < html.length && i < startIdx + 30000; i++) {
      if (html[i] === '[') depth++;
      else if (html[i] === ']') {
        depth--;
        if (depth === 0) {
          endIdx = i;
          break;
        }
      }
    }
    if (endIdx === -1) return [];
    const rawSlice = html.substring(startIdx, endIdx + 1);
    const jsonStr = rawSlice.replace(/\\"/g, '"');
    const casts = JSON.parse(jsonStr);
    const unique = [];
    const seen = new Set();
    casts.forEach(c => {
      if (c.manName && !seen.has(c.manName)) {
        seen.add(c.manName);
        unique.push({
          name: c.manName,
          character: c.characterName || '',
          isLead: Boolean(c.leadActor),
          image: c.manSmallImageUrl || c.manLargeImageUrl || ''
        });
      }
    });
    return unique;
  } catch (e) {
    return [];
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { goodsCode, q } = req.query;

  // 1. 실시간 공연명 검색 모드 (q 파라미터가 넘어오고 goodsCode가 명시되지 않은 경우)
  if (q && !goodsCode) {
    const query = q.trim();
    if (!query) {
      return res.status(200).json({ results: [] });
    }

    // A) 검색어에 7~10자리 상품번호나 URL이 포함된 경우 -> 즉시 단일 결과 반환
    const codeMatch = query.match(/(\d{7,10})/);
    if (codeMatch) {
      const code = codeMatch[1];
      const summary = await fetchConcertSummary(code);
      if (summary && summary.goodsName) {
        return res.status(200).json({
          results: [{
            goodsCode: code,
            title: summary.goodsName,
            placeName: summary.placeName || '공연장',
            dates: `${summary.playStartDate || ''} ~ ${summary.playEndDate || ''}`,
            category: '놀티켓 콘서트'
          }]
        });
      }
    }

    // B) 공연명, 아티스트명 키워드 검색 매칭
    const queryLower = query.toLowerCase().replace(/\s+/g, '');
    const matched = POPULAR_CONCERTS.filter(c => {
      const titleClean = c.title.toLowerCase().replace(/\s+/g, '');
      const artistClean = (c.artist || '').toLowerCase().replace(/\s+/g, '');
      return titleClean.includes(queryLower) || artistClean.includes(queryLower) || queryLower.includes(titleClean);
    });

    return res.status(200).json({ results: matched });
  }

  // 2. 개별 공연 상세 및 실시간 회차 잔여석 조회
  const rawTarget = goodsCode || q;
  if (!rawTarget) {
    return res.status(400).json({ error: 'goodsCode or q is required' });
  }

  const codeMatch = String(rawTarget).match(/(\d{7,10})/);
  const cleanCode = codeMatch ? codeMatch[1] : String(rawTarget).trim();

  try {
    // 1) 기본 요약 정보 및 출연진(캐스트) 정보 조회
    const [summaryData, castsData] = await Promise.all([
      fetchConcertSummary(cleanCode),
      fetchCastCredits(cleanCode)
    ]);

    // 2) 각 회차별 잔여석 실시간 조회 (001, 002, 003...)
    const sessions = [];
    for (let i = 1; i <= 20; i++) {
      const seqStr = String(i).padStart(3, '0');
      const seatUrl = `https://nol.yanolja.com/ticket/products/api/remaining-seats?goodsCode=${cleanCode}&playSeq=${seqStr}`;
      try {
        const sResp = await fetch(seatUrl, { headers: HEADERS });
        if (!sResp.ok) break;
        const sJson = await sResp.json();
        const remainSeats = sJson.remainSeat || [];
        if (remainSeats.length === 0) {
          break; // 회차 끝
        }

        const totalRemain = remainSeats.reduce((acc, curr) => acc + (curr.remainCnt || 0), 0);
        sessions.push({
          playSeq: seqStr,
          seats: remainSeats.map(s => ({
            grade: s.seatGrade,
            name: s.seatGradeName,
            count: s.remainCnt || 0
          })),
          totalRemain
        });
      } catch (err) {
        break;
      }
    }

    // 회차별 날짜 매핑 (summaryData.playTime 파싱)
    const playTimeLines = (summaryData?.playTime || '')
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);

    const enrichedSessions = sessions.map((sess, idx) => {
      const timeLabel = playTimeLines[idx] || `${idx + 1}회차 (${sess.playSeq})`;
      return {
        ...sess,
        label: timeLabel
      };
    });

    return res.status(200).json({
      goodsCode: cleanCode,
      goodsName: summaryData?.goodsName || `놀티켓 공연 (#${cleanCode})`,
      placeCode: summaryData?.placeCode || '',
      placeName: summaryData?.placeName || '',
      playStartDate: summaryData?.playStartDate || '',
      playEndDate: summaryData?.playEndDate || '',
      playTime: summaryData?.playTime || '',
      casts: castsData || [],
      sessions: enrichedSessions
    });
  } catch (error) {
    return res.status(500).json({ error: error.message, sessions: [] });
  }
};
