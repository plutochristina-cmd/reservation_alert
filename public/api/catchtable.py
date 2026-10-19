from http.server import BaseHTTPRequestHandler
import json
import urllib.parse
import requests

HEADERS = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Origin': 'https://app.catchtable.co.kr',
    'Referer': 'https://app.catchtable.co.kr/'
}

class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)

        q = qs.get('q', [None])[0]
        alias = qs.get('alias', [None])[0]
        shop_ref = qs.get('shopRef', [None])[0]
        action = qs.get('action', [None])[0]

        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()

        # 1. 예약 슬롯 조회
        if shop_ref and action == 'slots':
            try:
                url = f"https://ct-api.catchtable.co.kr/api/reservation/v1/dining/day-slots?shopRef={shop_ref}&tableSeqs=&personCounts="
                r = requests.get(url, headers=HEADERS, timeout=8)
                if r.status_code == 200:
                    data = r.json().get('data', [])
                    avail = [d for d in data if d.get('availableStatus') == 'AVAILABLE']
                    self.wfile.write(json.dumps({'ok': True, 'availableDates': avail, 'allDates': data}, ensure_ascii=False).encode('utf-8'))
                    return
                else:
                    self.wfile.write(json.dumps({'ok': False, 'error': f'HTTP {r.status_code}'}, ensure_ascii=False).encode('utf-8'))
                    return
            except Exception as e:
                self.wfile.write(json.dumps({'ok': False, 'error': str(e)}, ensure_ascii=False).encode('utf-8'))
                return

        # 2. 매장 상세 조회 (alias)
        if alias:
            clean_alias = alias.replace('https://app.catchtable.co.kr/ct/shop/', '').replace('https://catchtable.co.kr/', '').strip('/')
            try:
                url = f"https://ct-api.catchtable.co.kr/api/v4/shops/{clean_alias}"
                r = requests.get(url, headers=HEADERS, timeout=8)
                if r.status_code == 200:
                    data = r.json().get('data', {})
                    vo = data.get('shopDetailVO', data)
                    self.wfile.write(json.dumps({
                        'ok': True,
                        'shopRef': vo.get('shopRef'),
                        'shopName': vo.get('shopName'),
                        'shopUrl': vo.get('shopUrl', clean_alias),
                        'category': vo.get('foodKindName') or vo.get('shopTypeName') or '식당',
                        'address': vo.get('roadAddress') or vo.get('lotAddress') or '',
                        'rating': vo.get('avgRating'),
                        'reviewCount': vo.get('reviewCount'),
                        'imageUrl': (vo.get('images', [{}])[0].get('imageUrl') if vo.get('images') else '') or vo.get('bannerImageUrl', '')
                    }, ensure_ascii=False).encode('utf-8'))
                    return
                else:
                    self.wfile.write(json.dumps({'ok': False, 'error': f'HTTP {r.status_code}'}, ensure_ascii=False).encode('utf-8'))
                    return
            except Exception as e:
                self.wfile.write(json.dumps({'ok': False, 'error': str(e)}, ensure_ascii=False).encode('utf-8'))
                return

        # 3. 키워드 검색
        if q:
            try:
                url = "https://ct-api.catchtable.co.kr/api/v6/search/list"
                body = {"keyword": q.strip(), "paging": {"page": 1, "size": 10, "offset": 0}}
                r = requests.post(url, headers=HEADERS, json=body, timeout=8)
                if r.status_code == 200:
                    raw_shops = r.json().get('data', {}).get('shopResults', {}).get('shops', [])
                    results = []
                    for s in raw_shops:
                        meta = s.get('shopMeta', {})
                        results.append({
                            'shopRef': meta.get('shopRef'),
                            'shopName': meta.get('shopName'),
                            'shopUrl': meta.get('shopUrl'),
                            'category': meta.get('foodKindName') or meta.get('categoryName') or '식당',
                            'address': meta.get('roadAddress') or meta.get('areaName') or '',
                            'rating': meta.get('avgRating') or meta.get('avgScore'),
                            'reviewCount': meta.get('reviewCount')
                        })
                    self.wfile.write(json.dumps({'ok': True, 'results': results}, ensure_ascii=False).encode('utf-8'))
                    return
                else:
                    self.wfile.write(json.dumps({'ok': False, 'results': []}, ensure_ascii=False).encode('utf-8'))
                    return
            except Exception as e:
                self.wfile.write(json.dumps({'ok': False, 'error': str(e), 'results': []}, ensure_ascii=False).encode('utf-8'))
                return

        self.wfile.write(json.dumps({'ok': False, 'message': 'Missing query parameter'}).encode('utf-8'))
