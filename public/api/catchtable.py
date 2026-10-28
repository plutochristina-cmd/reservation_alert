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

def resolve_shop_ref(shop_ref_or_alias: str) -> str:
    if not shop_ref_or_alias:
        return ""
    clean = shop_ref_or_alias.replace('https://app.catchtable.co.kr/ct/shop/', '').replace('https://catchtable.co.kr/', '').strip('/')
    if len(clean) >= 20 and '/' not in clean:
        try:
            url = f"https://ct-api.catchtable.co.kr/api/v4/shops/{clean}"
            r = requests.get(url, headers=HEADERS, timeout=5)
            if r.status_code == 200:
                vo = r.json().get('data', {}).get('shopDetailVO', {})
                if vo.get('shopRef'):
                    return vo.get('shopRef')
        except Exception:
            pass
        return clean
    try:
        url = f"https://ct-api.catchtable.co.kr/api/v4/shops/{clean}"
        r = requests.get(url, headers=HEADERS, timeout=5)
        if r.status_code == 200:
            vo = r.json().get('data', {}).get('shopDetailVO', {})
            if vo.get('shopRef'):
                return vo.get('shopRef')
    except Exception:
        pass
    return clean


def fetch_waiting_info(shop_ref: str) -> dict:
    resolved_ref = resolve_shop_ref(shop_ref)
    if not resolved_ref:
        return {"isSupported": False}
    try:
        url = f"https://ct-api.catchtable.co.kr/reservation-api/v1/waiting-shops/{resolved_ref}"
        params = {"withTable": "true", "withWaitingsStatus": "true", "withPersonOption": "true"}
        r = requests.get(url, params=params, headers=HEADERS, timeout=7)
        if r.status_code != 200:
            return {"isSupported": False, "shopRef": resolved_ref}

        data = (r.json() or {}).get("data")
        if not data or not isinstance(data, dict):
            return {"isSupported": False, "shopRef": resolved_ref}

        table_status = data.get("tableStatus") or {}
        op_info = table_status.get("operationInfo") or {}
        current_tables = table_status.get("tableCurrentStatus") or []

        is_waiting_avail = bool(op_info.get("isWaitingAvailable"))
        disabled_reason = op_info.get("waitingDisabledReason")
        total_teams = int(table_status.get("totalTeamCount") or 0)
        at_least_cnt = int(
            op_info.get("possibleWaitingAtLeastCount")
            or op_info.get("possibleRemoteWaitingAtLeastCount")
            or 0
        )

        hall_teams = 0
        takeout_teams = 0
        tables_summary = []
        for t in current_tables:
            t_cnt = int(t.get("teamCount") or 0)
            is_takeout = bool(t.get("isTakeOut"))
            t_status = t.get("tableOperationStatus") or "OPEN"
            if is_takeout:
                takeout_teams += t_cnt
            else:
                hall_teams += t_cnt
            tables_summary.append({
                "tableId": t.get("tableId"),
                "tableName": t.get("tableName") or ("포장" if is_takeout else "홀"),
                "isTakeOut": is_takeout,
                "status": t_status,
                "teamCount": t_cnt,
                "expectedWaitingTime": t.get("expectedWaitingTime")
            })

        reason_map = {
            None: "원격 웨이팅 등록 가능",
            "UNDER_AVAILABLE_TEAMS": f"{max(at_least_cnt, 2)}팀 이상 대기 중일 때 원격 웨이팅 가능",
            "NON_OPERATING_HOURS": "영업시간 외 (웨이팅 마감)",
            "CLOSED_DAY": "오늘 휴무일",
            "CLOSED_MANUALLY": "매장 사정으로 웨이팅 마감",
            "PAUSED": "웨이팅 일시 중지",
            "AUTO_PAUSED_TIME": "브레이크 타임 (일시 중지)",
            "BY_PASS": "현재 대기 없이 바로 입장 가능 (원격 웨이팅 비활성)",
            "OFFLINE_ONLY": "현장 웨이팅만 가능",
            "ONLY_OFFLINE_OPERATION_HOURS": "현재 현장 웨이팅만 가능 시간대",
            "NOT_OPEN_WAITING_OPERATION": "현장 웨이팅만 가능"
        }
        status_text = reason_map.get(disabled_reason, f"웨이팅 대기 ({disabled_reason})")
        is_remote_open = is_waiting_avail and (disabled_reason is None)

        return {
            "isSupported": True,
            "shopRef": resolved_ref,
            "isWaitingAvailable": is_waiting_avail,
            "isRemoteOpen": is_remote_open,
            "waitingDisabledReason": disabled_reason,
            "statusText": status_text,
            "totalTeamCount": total_teams,
            "hallTeamCount": hall_teams,
            "takeoutTeamCount": takeout_teams,
            "possibleWaitingAtLeastCount": at_least_cnt,
            "tables": tables_summary
        }
    except Exception as e:
        return {"isSupported": False, "shopRef": resolved_ref, "error": str(e)}


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

        # 1. 실시간 웨이팅 단독 조회 (action=waiting)
        if shop_ref and action == 'waiting':
            w_info = fetch_waiting_info(shop_ref)
            self.wfile.write(json.dumps({'ok': True, 'waiting': w_info}, ensure_ascii=False).encode('utf-8'))
            return

        # 2. 예약 슬롯 + 실시간 웨이팅 통합 조회 (action=slots)
        if shop_ref and action == 'slots':
            try:
                resolved_ref = resolve_shop_ref(shop_ref)
                url = f"https://ct-api.catchtable.co.kr/api/reservation/v1/dining/day-slots?shopRef={resolved_ref}&tableSeqs=&personCounts="
                r = requests.get(url, headers=HEADERS, timeout=8)
                avail = []
                all_dates = []
                if r.status_code == 200:
                    all_dates = r.json().get('data', []) or []
                    avail = [d for d in all_dates if d.get('availableStatus') == 'AVAILABLE']
                w_info = fetch_waiting_info(resolved_ref)
                self.wfile.write(json.dumps({
                    'ok': True,
                    'shopRef': resolved_ref,
                    'availableDates': avail,
                    'allDates': all_dates,
                    'waiting': w_info
                }, ensure_ascii=False).encode('utf-8'))
                return
            except Exception as e:
                self.wfile.write(json.dumps({'ok': False, 'error': str(e)}, ensure_ascii=False).encode('utf-8'))
                return

        # 3. 매장 상세 조회 (alias)
        if alias:
            clean_alias = alias.replace('https://app.catchtable.co.kr/ct/shop/', '').replace('https://catchtable.co.kr/', '').strip('/')
            try:
                url = f"https://ct-api.catchtable.co.kr/api/v4/shops/{clean_alias}"
                r = requests.get(url, headers=HEADERS, timeout=8)
                if r.status_code == 200:
                    data = r.json().get('data', {})
                    vo = data.get('shopDetailVO', data)
                    resolved_ref = vo.get('shopRef') or clean_alias
                    svc_list = vo.get('serviceTypeList') or []
                    main_svc = vo.get('mainService') or ''
                    self.wfile.write(json.dumps({
                        'ok': True,
                        'shopRef': resolved_ref,
                        'shopName': vo.get('shopName'),
                        'shopUrl': vo.get('shopUrl', clean_alias),
                        'category': vo.get('foodKindName') or vo.get('shopTypeName') or '식당',
                        'address': vo.get('roadAddress') or vo.get('lotAddress') or '',
                        'rating': vo.get('avgRating'),
                        'reviewCount': vo.get('reviewCount'),
                        'mainService': main_svc,
                        'serviceTypeList': svc_list,
                        'imageUrl': (vo.get('images', [{}])[0].get('imageUrl') if vo.get('images') else '') or vo.get('bannerImageUrl', '')
                    }, ensure_ascii=False).encode('utf-8'))
                    return
                else:
                    self.wfile.write(json.dumps({'ok': False, 'error': f'HTTP {r.status_code}'}, ensure_ascii=False).encode('utf-8'))
                    return
            except Exception as e:
                self.wfile.write(json.dumps({'ok': False, 'error': str(e)}, ensure_ascii=False).encode('utf-8'))
                return

        # 4. 키워드 자동완성 검색 (/api/v5/autocomplete/_list 우선 + /api/v6/search/list 폴백)
        if q:
            try:
                results = []
                seen_refs = set()
                ac_url = "https://ct-api.catchtable.co.kr/api/v5/autocomplete/_list"
                r_ac = requests.post(ac_url, headers=HEADERS, json={"query": q.strip()}, timeout=6)
                if r_ac.status_code == 200:
                    ac_shops = (r_ac.json().get('data') or {}).get('shops') or []
                    for s in ac_shops:
                        s_ref = s.get('primaryCode') or s.get('code')
                        s_url = s.get('code') or s_ref
                        if not s_ref or s_ref in seen_refs:
                            continue
                        seen_refs.add(s_ref)
                        results.append({
                            'shopRef': s_ref,
                            'shopName': s.get('label'),
                            'shopUrl': s_url,
                            'category': s.get('foodKind') or '식당',
                            'address': s.get('subLabel') or s.get('landName') or '',
                            'rating': (s.get('stats') or {}).get('avgScore'),
                            'reviewCount': (s.get('stats') or {}).get('reviewCount')
                        })

                if not results:
                    url = "https://ct-api.catchtable.co.kr/api/v6/search/list"
                    body = {"keyword": q.strip(), "paging": {"page": 1, "size": 10, "offset": 0}}
                    r = requests.post(url, headers=HEADERS, json=body, timeout=6)
                    if r.status_code == 200:
                        raw_shops = r.json().get('data', {}).get('shopResults', {}).get('shops', [])
                        for s in raw_shops:
                            meta = s.get('shopMeta', {})
                            s_ref = meta.get('shopRef')
                            if not s_ref or s_ref in seen_refs:
                                continue
                            seen_refs.add(s_ref)
                            results.append({
                                'shopRef': s_ref,
                                'shopName': meta.get('shopName'),
                                'shopUrl': meta.get('urlPathAlias') or meta.get('shopUrl') or s_ref,
                                'category': meta.get('foodKind') or meta.get('foodKindName') or meta.get('categoryName') or '식당',
                                'address': meta.get('landName') or meta.get('roadAddress') or meta.get('areaName') or '',
                                'rating': meta.get('avgRating') or meta.get('avgScore'),
                                'reviewCount': meta.get('reviewCount')
                            })

                self.wfile.write(json.dumps({'ok': True, 'results': results}, ensure_ascii=False).encode('utf-8'))
                return
            except Exception as e:
                self.wfile.write(json.dumps({'ok': False, 'error': str(e), 'results': []}, ensure_ascii=False).encode('utf-8'))
                return

        self.wfile.write(json.dumps({'ok': False, 'message': 'Missing query parameter'}).encode('utf-8'))
