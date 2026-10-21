"""
Vercel Serverless Cron Endpoint (/api/cron)
- 외부 스케줄러(GitHub Actions, Supabase pg_cron, cron-job.org) 및 웹 앱 자동 트리거용 엔드포인트
- 호출 즉시 Supabase 활성 예약 전체를 스캔하고 Web Push 발송 및 updated_at(+09:00 KST)을 갱신합니다.
"""

from http.server import BaseHTTPRequestHandler
import os
import json
import re
import urllib.parse
from datetime import datetime, timedelta, timezone
import requests

try:
    from pywebpush import webpush, WebPushException
except ImportError:
    webpush = None
    WebPushException = Exception

KST = timezone(timedelta(hours=9))
WEEKDAY_KR = ["월", "화", "수", "목", "금", "토", "일"]
GRAPHQL_ENDPOINT = "https://booking.naver.com/graphql"


def get_env_or_default(key: str, default: str) -> str:
    val = (os.environ.get(key) or "").strip()
    return val if val else default


SUPABASE_URL = get_env_or_default("SUPABASE_URL", "https://hevkkauplkjfdwqjppmy.supabase.co")
SUPABASE_KEY = get_env_or_default(
    "SUPABASE_SERVICE_ROLE_KEY",
    get_env_or_default("SUPABASE_ANON_KEY", "sb_publishable_CuWc_mAtXO2r7gxofe94Lg_E6Apy02A")
)
VAPID_PRIVATE_KEY = get_env_or_default("VAPID_PRIVATE_KEY", "PBSoenIWJRdlY2YSY3lSsiFV43WGHdaRh6MRMz9094c")
VAPID_CLAIMS_SUB = get_env_or_default("VAPID_CLAIMS_SUB", "mailto:admin@example.com")


def get_now_kst() -> datetime:
    return datetime.now(KST).replace(tzinfo=None)


def get_now_kst_iso() -> str:
    return datetime.now(KST).isoformat()


def format_slot_korean(dt: datetime, remain: int) -> str:
    weekday = WEEKDAY_KR[dt.weekday()]
    return f"{dt.strftime('%Y년 %m월 %d일')} ({weekday}) {dt.strftime('%H:%M')} (잔여: {remain}자리)"


def resolve_naver_booking_ids(biz_id: str, item_id: str) -> tuple:
    resolved_biz = str(biz_id).strip()
    resolved_item = str(item_id or "1").strip()
    resolved_item_name = ""

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Referer": "https://booking.naver.com/",
        "Content-Type": "application/json"
    }
    query = """
    query getBusinessBooking($businessId: String!) {
      business(input: {businessId: $businessId, lang: "ko"}) {
        name
      }
      bizItems(input: {businessId: $businessId, lang: "ko"}) {
        id
        name
      }
    }
    """
    try:
        r = requests.post(GRAPHQL_ENDPOINT, headers=headers, json={"query": query, "variables": {"businessId": resolved_biz}}, timeout=6)
        data = r.json().get("data", {}) if r.status_code == 200 else {}
        biz = data.get("business")
        items = data.get("bizItems") or []

        if not biz or not items:
            for suffix in ["booking", "home"]:
                try:
                    pr = requests.get(
                        f"https://m.place.naver.com/place/{resolved_biz}/{suffix}",
                        headers={
                            "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1",
                            "Referer": "https://m.place.naver.com/"
                        },
                        timeout=6
                    )
                    if pr.status_code == 200:
                        txt = pr.text.replace("\\u002F", "/").replace("\\u002f", "/").replace("\\/", "/")
                        m = (
                            re.search(r'booking\.naver\.com/(?:m/)?booking/\d+/bizes/(\d+)', txt, re.I)
                            or re.search(r'"bookingBusinessId"\s*:\s*"?(\d+)"?', txt, re.I)
                            or re.search(r'bizes/(\d+)', txt, re.I)
                        )
                        if m and m.group(1) != resolved_biz:
                            resolved_biz = m.group(1)
                            break
                except Exception:
                    pass

            if resolved_biz != str(biz_id).strip():
                r2 = requests.post(GRAPHQL_ENDPOINT, headers=headers, json={"query": query, "variables": {"businessId": resolved_biz}}, timeout=6)
                data2 = r2.json().get("data", {}) if r2.status_code == 200 else {}
                items = data2.get("bizItems") or []

        if (resolved_item == "1" or not resolved_item) and items:
            resolved_item = str(items[0].get("id") or "").split("_")[0]
            resolved_item_name = str(items[0].get("name") or "")
    except Exception:
        pass

    return resolved_biz, resolved_item, resolved_item_name


def fetch_hourly_schedule(biz_type_id: int, biz_id: str, item_id: str, start_dt: datetime, end_dt: datetime) -> list:
    query = """
    query hourlySchedule($scheduleParams: ScheduleParams) {
      schedule(input: $scheduleParams) {
        bizItemSchedule {
          hourly {
            unitStartTime
            unitBookingCount
            unitStock
            isBusinessDay
            isSaleDay
            isUnitSaleDay
            isUnitBusinessDay
          }
        }
      }
    }
    """
    variables = {
        "scheduleParams": {
            "businessTypeId": biz_type_id,
            "businessId": str(biz_id),
            "bizItemId": str(item_id),
            "startDateTime": start_dt.strftime("%Y-%m-%dT00:00:00"),
            "endDateTime": end_dt.strftime("%Y-%m-%dT23:59:59"),
            "fixedTime": True,
            "includesHolidaySchedules": True
        }
    }
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Referer": f"https://booking.naver.com/booking/{biz_type_id}/bizes/{biz_id}/items/{item_id}",
        "Origin": "https://booking.naver.com",
        "Content-Type": "application/json"
    }
    try:
        resp = requests.post(GRAPHQL_ENDPOINT, headers=headers, json={"query": query, "variables": variables}, timeout=10)
        if resp.status_code == 200:
            data = resp.json().get("data", {})
            sched = data.get("schedule") if data else None
            biz_sched = sched.get("bizItemSchedule") if sched else None
            return (biz_sched.get("hourly") if biz_sched else []) or []
    except Exception:
        pass
    return []


def parse_date_range_from_url(naver_url: str):
    now = get_now_kst()
    default_end = now + timedelta(days=90)
    try:
        parsed = urllib.parse.urlparse(naver_url)
        params = urllib.parse.parse_qs(parsed.query)
        start_str = params.get("startDate", [None])[0]
        end_str = params.get("endDate", [None])[0]
        start_dt = datetime.strptime(start_str, "%Y-%m-%d") if start_str else now
        end_dt = datetime.strptime(end_str, "%Y-%m-%d") if end_str else default_end
        start_dt = max(start_dt, now)
        end_dt = end_dt.replace(hour=23, minute=59, second=59)
        return start_dt, end_dt
    except Exception:
        return now, default_end


def scan_available_slots(biz_type_id: int, biz_id: str, item_id: str, start_dt: datetime, end_dt: datetime, max_results: int = 3) -> list:
    now = get_now_kst()
    chunk_size = 60
    current_start = max(now, start_dt)
    end_limit = end_dt
    all_available = []

    while current_start < end_limit:
        current_end = min(current_start + timedelta(days=chunk_size), end_limit)
        slots = fetch_hourly_schedule(biz_type_id, biz_id, item_id, current_start, current_end)
        for s in slots:
            slot_str = s.get("unitStartTime")
            if not slot_str:
                continue
            try:
                slot_time = datetime.strptime(slot_str, "%Y-%m-%d %H:%M:%S")
            except ValueError:
                continue
            if slot_time <= now or slot_time < start_dt or slot_time > end_dt:
                continue
            is_open = s.get("isBusinessDay") and s.get("isUnitBusinessDay") and s.get("isSaleDay") and s.get("isUnitSaleDay")
            if not is_open:
                continue
            stock = s.get("unitStock") or 0
            booked = s.get("unitBookingCount") or 0
            remain = stock - booked
            if remain > 0:
                all_available.append({
                    "datetime": slot_time,
                    "datetime_str": slot_str,
                    "remain_stock": remain,
                    "korean_text": format_slot_korean(slot_time, remain)
                })
        if len(all_available) >= max_results:
            break
        current_start = current_end + timedelta(days=1)

    all_available.sort(key=lambda x: x["datetime"])
    return all_available[:max_results]


def scan_nol_ticket_seats(goods_code: str, play_seq: str = "all") -> list:
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        "Referer": "https://nol.yanolja.com/",
        "Accept": "application/json, text/plain, */*"
    }
    available = []
    seqs_to_check = [play_seq] if (play_seq and play_seq != "all") else [f"{i:03d}" for i in range(1, 15)]
    for seq in seqs_to_check:
        url = f"https://nol.yanolja.com/ticket/products/api/remaining-seats?goodsCode={goods_code}&playSeq={seq}"
        try:
            resp = requests.get(url, headers=headers, timeout=5)
            if resp.status_code != 200:
                break
            seats = resp.json().get("remainSeat", [])
            if not seats:
                if play_seq == "all":
                    break
                continue
            for s in seats:
                remain_cnt = s.get("remainCnt", 0)
                if remain_cnt > 0:
                    grade_name = s.get("seatGradeName", "좌석")
                    available.append({
                        "session": seq,
                        "grade": grade_name,
                        "remain_stock": remain_cnt,
                        "korean_text": f"[{seq}회차] {grade_name} {remain_cnt}석 발생"
                    })
        except Exception:
            break
    return available


def get_catchtable_shop_ref(shop_ref_or_alias: str) -> str:
    if not shop_ref_or_alias:
        return ""
    if len(shop_ref_or_alias) >= 20 and '-' not in shop_ref_or_alias and '/' not in shop_ref_or_alias:
        return shop_ref_or_alias
    clean_alias = shop_ref_or_alias.replace('https://app.catchtable.co.kr/ct/shop/', '').replace('https://catchtable.co.kr/', '').strip('/')
    try:
        url = f"https://ct-api.catchtable.co.kr/api/v4/shops/{clean_alias}"
        resp = requests.get(url, headers={'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0'}, timeout=5)
        if resp.status_code == 200:
            resolved = resp.json().get('data', {}).get('shopDetailVO', {}).get('shopRef')
            if resolved:
                return resolved
    except Exception:
        pass
    return clean_alias


def scan_catchtable_slots(shop_ref: str, max_results: int = 3) -> list:
    resolved_ref = get_catchtable_shop_ref(shop_ref)
    headers = {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Origin': 'https://app.catchtable.co.kr',
        'Referer': 'https://app.catchtable.co.kr/'
    }
    url = f"https://ct-api.catchtable.co.kr/api/reservation/v1/dining/day-slots?shopRef={resolved_ref}&tableSeqs=&personCounts="
    available = []
    try:
        resp = requests.get(url, headers=headers, timeout=8)
        if resp.status_code == 200:
            for item in resp.json().get("data", []):
                if item.get("availableStatus") == "AVAILABLE":
                    dt_str = item.get("date")
                    p_counts = item.get("availablePersonCounts") or []
                    p_text = f"가능 인원: {min(p_counts)}~{max(p_counts)}명" if p_counts else "예약 가능"
                    try:
                        dt = datetime.strptime(dt_str, "%Y-%m-%d")
                        weekday = WEEKDAY_KR[dt.weekday()]
                        kor_text = f"{dt.strftime('%m월 %d일')}({weekday}) ({p_text})"
                    except Exception:
                        kor_text = f"{dt_str} ({p_text})"
                    available.append({
                        "date": dt_str,
                        "person_counts": p_counts,
                        "korean_text": kor_text
                    })
    except Exception:
        pass
    return available[:max_results]


def send_web_push(subscription_info: dict, title: str, body: str, url: str) -> bool:
    if not webpush or not subscription_info or "endpoint" not in subscription_info:
        return False
    payload = json.dumps({
        "title": title,
        "body": body,
        "url": url,
        "icon": "/icon-192.png",
        "tag": "naver-slot-found"
    })
    try:
        webpush(
            subscription_info=subscription_info,
            data=payload,
            vapid_private_key=VAPID_PRIVATE_KEY,
            vapid_claims={"sub": VAPID_CLAIMS_SUB}
        )
        return True
    except Exception:
        return False


def execute_multi_user_scan(force_notify: bool = False) -> dict:
    headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json"
    }
    url = f"{SUPABASE_URL}/rest/v1/reservations?select=id,device_id,naver_url,business_type_id,business_id,biz_item_id,biz_name,item_name,last_slots,devices(push_subscription)&is_active=eq.true"

    resp = requests.get(url, headers=headers, timeout=10)
    if resp.status_code != 200:
        return {"ok": False, "error": f"Supabase query failed ({resp.status_code})", "details": resp.text}

    reservations = resp.json()
    summary = []

    for res in reservations:
        res_id = res["id"]
        biz_name = res["biz_name"]
        item_name = res["item_name"]
        biz_type = res["business_type_id"]
        biz_id = res["business_id"]
        item_id = res["biz_item_id"]
        naver_url = res["naver_url"]
        last_slots = res.get("last_slots") or []
        device_info = res.get("devices") or {}
        push_sub = device_info.get("push_subscription")
        now_iso = get_now_kst_iso()
        update_url = f"{SUPABASE_URL}/rest/v1/reservations?id=eq.{res_id}"
        pushed = False

        if biz_type == 99:
            top_seats = scan_nol_ticket_seats(biz_id, item_id)
            current_keys = [s["korean_text"] for s in top_seats]
            is_changed = (current_keys != last_slots)
            if top_seats and (is_changed or force_notify):
                title = f"🎫 [취소표 발생!] {biz_name}"
                cast_prefix = ""
                if "[캐스트:" in item_name:
                    m_cast = re.search(r'\[캐스트:[^\]]+\]', item_name)
                    if m_cast:
                        cast_prefix = f"🎭 {m_cast.group(0)}\n"
                body = f"{cast_prefix}{top_seats[0]['korean_text']}\n지금 즉시 예매하세요!"
                if len(top_seats) > 1:
                    body += f"\n외 {len(top_seats)-1}개 좌석 오픈"
                if push_sub:
                    pushed = send_web_push(push_sub, title, body, naver_url)
                requests.patch(update_url, headers=headers, json={"last_slots": current_keys, "updated_at": now_iso}, timeout=8)
            elif not top_seats:
                payload = {"updated_at": now_iso}
                if last_slots:
                    payload["last_slots"] = []
                requests.patch(update_url, headers=headers, json=payload, timeout=8)
            else:
                requests.patch(update_url, headers=headers, json={"updated_at": now_iso}, timeout=8)

            summary.append({"id": res_id, "biz_name": biz_name, "found": len(top_seats), "pushed": pushed, "updated_at": now_iso})
            continue

        if biz_type == 88:
            top_slots = scan_catchtable_slots(biz_id, max_results=3)
            current_keys = [s["korean_text"] for s in top_slots]
            is_changed = (current_keys != last_slots)
            if top_slots and (is_changed or force_notify):
                title = f"🍽️ [빈자리 오픈!] {biz_name}"
                body = f"{top_slots[0]['korean_text']}\n지금 즉시 예약하세요!"
                if len(top_slots) > 1:
                    body += f"\n외 {len(top_slots)-1}개 날짜 오픈"
                if push_sub:
                    pushed = send_web_push(push_sub, title, body, naver_url)
                requests.patch(update_url, headers=headers, json={"last_slots": current_keys, "updated_at": now_iso}, timeout=8)
            elif not top_slots:
                payload = {"updated_at": now_iso}
                if last_slots:
                    payload["last_slots"] = []
                requests.patch(update_url, headers=headers, json=payload, timeout=8)
            else:
                requests.patch(update_url, headers=headers, json={"updated_at": now_iso}, timeout=8)

            summary.append({"id": res_id, "biz_name": biz_name, "found": len(top_slots), "pushed": pushed, "updated_at": now_iso})
            continue

        extra_patch = {}
        if str(item_id) == "1" or len(str(biz_id)) >= 8:
            r_biz, r_item, r_item_name = resolve_naver_booking_ids(biz_id, item_id)
            if r_biz != str(biz_id) or r_item != str(item_id):
                naver_url = naver_url.replace(f"/bizes/{biz_id}/items/{item_id}", f"/bizes/{r_biz}/items/{r_item}")
                biz_id, item_id = r_biz, r_item
                extra_patch = {
                    "business_id": biz_id,
                    "biz_item_id": item_id,
                    "naver_url": naver_url
                }
                if r_item_name and item_name == "기본 예약":
                    item_name = r_item_name
                    extra_patch["item_name"] = item_name

        start_dt, end_dt = parse_date_range_from_url(naver_url)
        days_span = (end_dt - start_dt).days + 1
        date_range_desc = f"{start_dt.strftime('%m/%d')}~{end_dt.strftime('%m/%d')} ({days_span}일간)"
        top_slots = scan_available_slots(biz_type, biz_id, item_id, start_dt=start_dt, end_dt=end_dt, max_results=3)
        current_keys = [s["datetime_str"] for s in top_slots]
        is_changed = (current_keys != last_slots)

        if top_slots and (is_changed or force_notify):
            title = f"🔔 [{biz_name}] 빈자리 발견!"
            body = f"가장 빠른 일정: {top_slots[0]['korean_text']}\n(희망기간: {date_range_desc})"
            if len(top_slots) > 1:
                body += f"\n외 {len(top_slots)-1}개 슬롯 가능"
            if push_sub:
                pushed = send_web_push(push_sub, title, body, naver_url)
            requests.patch(update_url, headers=headers, json={**extra_patch, "last_slots": current_keys, "updated_at": now_iso}, timeout=8)
        elif not top_slots:
            payload = {**extra_patch, "updated_at": now_iso}
            if last_slots:
                payload["last_slots"] = []
            requests.patch(update_url, headers=headers, json=payload, timeout=8)
        else:
            requests.patch(update_url, headers=headers, json={**extra_patch, "updated_at": now_iso}, timeout=8)

        summary.append({"id": res_id, "biz_name": biz_name, "found": len(top_slots), "pushed": pushed, "updated_at": now_iso})

    return {
        "ok": True,
        "checked_at_kst": get_now_kst_iso(),
        "total_checked": len(summary),
        "results": summary
    }


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        force = qs.get('force', ['false'])[0].lower() in ['1', 'true', 'yes']

        try:
            result = execute_multi_user_scan(force_notify=force)
            status = 200 if result.get("ok") else 500
        except Exception as e:
            result = {"ok": False, "error": str(e)}
            status = 500

        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-store, max-age=0')
        self.end_headers()
        self.wfile.write(json.dumps(result, ensure_ascii=False).encode('utf-8'))

    def do_POST(self):
        self.do_GET()
