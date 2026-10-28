"""
다중 사용자 통합 백그라운드 스케줄러 (scheduler.py)
- GitHub Actions에서 매시간 정각마다 실행
- Supabase DB에 등록된 모든 사용자의 활성 네이버 예약 URL을 조회
- 네이버 GraphQL API로 365일 치 스케줄을 고속 스캔하여 빈자리 감지
- 새로운 빈자리 발견 시 해당 사용자의 스마트폰으로 Web Push(VAPID) 직접 발송
- Supabase 미연결 시 로컬 단일 모니터링 모드(monitor.py)로 자동 폴백
"""

import os
import sys
import json
import logging
from datetime import datetime, timedelta, timezone
import requests
from dotenv import load_dotenv
from pywebpush import webpush, WebPushException

# 한국 표준시(KST, UTC+9) 고정 정의 (GitHub Actions UTC 환경 대응)
KST = timezone(timedelta(hours=9))

def get_now_kst() -> datetime:
    """한국 표준시(KST, UTC+9) 기준의 현재 시각(tz-naive)을 반환합니다.
    GitHub Actions(Ubuntu UTC 환경)에서도 네이버 예약 시각과 9시간 오차 없이 정확히 일치하도록 보정합니다.
    """
    return datetime.now(KST).replace(tzinfo=None)


def get_now_kst_iso() -> str:
    """Supabase TIMESTAMPTZ 컬럼 저장용 KST(+09:00) 오프셋 포함 ISO-8601 문자열을 반환합니다.
    타임존 오프셋(+09:00)을 명시하여 DB(UTC) 저장 후 브라우저 조회 시 +9시간이 중복 가산되는 문제를 방지합니다.
    """
    return datetime.now(KST).isoformat()


if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(levelname)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S"
)
logger = logging.getLogger("MultiUserScheduler")

# 암호화 보안 금고(vault) 모듈 임포트
import vault

# 환경변수 / 볼트에서 복호화하여 취득 (GitHub Actions 등 무인 클라우드 러너 폴백 포함)
SUPABASE_URL = vault.get_secret("SUPABASE_URL", "https://hevkkauplkjfdwqjppmy.supabase.co").strip()
SUPABASE_KEY = vault.get_secret("SUPABASE_SERVICE_ROLE_KEY", vault.get_secret("SUPABASE_ANON_KEY", "sb_publishable_CuWc_mAtXO2r7gxofe94Lg_E6Apy02A")).strip()

VAPID_PRIVATE_KEY = vault.get_secret("VAPID_PRIVATE_KEY", "PBSoenIWJRdlY2YSY3lSsiFV43WGHdaRh6MRMz9094c").strip()
VAPID_CLAIMS_SUB = vault.get_secret("VAPID_CLAIMS_SUB", "mailto:admin@example.com").strip()

TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "").strip()

GRAPHQL_ENDPOINT = "https://booking.naver.com/graphql"
WEEKDAY_KR = ["월", "화", "수", "목", "금", "토", "일"]


def format_slot_korean(dt: datetime, remain: int) -> str:
    weekday = WEEKDAY_KR[dt.weekday()]
    return f"{dt.strftime('%Y년 %m월 %d일')} ({weekday}) {dt.strftime('%H:%M')} (잔여: {remain}자리)"


def resolve_naver_booking_ids(biz_id: str, item_id: str) -> tuple[str, str, str]:
    """네이버 플레이스 ID 또는 임시 상품 ID('1')가 저장된 경우 실제 예약 businessId, bizItemId, itemName으로 역추적합니다."""
    import re
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
        r = requests.post(GRAPHQL_ENDPOINT, headers=headers, json={"query": query, "variables": {"businessId": resolved_biz}}, timeout=8)
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
                        timeout=8
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
                r2 = requests.post(GRAPHQL_ENDPOINT, headers=headers, json={"query": query, "variables": {"businessId": resolved_biz}}, timeout=8)
                data2 = r2.json().get("data", {}) if r2.status_code == 200 else {}
                items = data2.get("bizItems") or []

        if (resolved_item == "1" or not resolved_item) and items:
            resolved_item = str(items[0].get("id") or "").split("_")[0]
            resolved_item_name = str(items[0].get("name") or "")
    except Exception as e:
        logger.warning(f"Place ID 역추적 실패 ({biz_id}/{item_id}): {e}")

    return resolved_biz, resolved_item, resolved_item_name


def fetch_booking_rules(biz_id: str, item_id: str) -> dict:
    """네이버 GraphQL API에서 매장 및 상품별 예약 마감 규칙(RI01/RI02/RI03), 최소 인원/이용시간, 마감 설정을 조회합니다."""
    query = """
    query getBookingRules($businessId: String!, $bizItemId: String!) {
      business(input: {businessId: $businessId, lang: "ko"}) {
        bookingAvailableCode
        bookingAvailableValue
        bookingTimeUnitCode
      }
      bizItem(input: {businessId: $businessId, bizItemId: $bizItemId, lang: "ko"}) {
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
    """
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Referer": "https://booking.naver.com/",
        "Origin": "https://booking.naver.com",
        "Content-Type": "application/json"
    }
    try:
        resp = requests.post(
            GRAPHQL_ENDPOINT,
            headers=headers,
            json={"query": query, "variables": {"businessId": str(biz_id), "bizItemId": str(item_id)}},
            timeout=10
        )
        if resp.status_code == 200:
            data = resp.json().get("data") or {}
            return {
                "business": data.get("business") or {},
                "bizItem": data.get("bizItem") or {}
            }
    except Exception as e:
        logger.debug(f"예약 마감 규칙 조회 경고 ({biz_id}/{item_id}): {e}")
    return {"business": {}, "bizItem": {}}


def compute_min_bookable_dt(now: datetime, rules: dict, safety_buffer_minutes: int = 5) -> datetime:
    """네이버 예약 공식 마감 규칙(RI01/RI02/RI03) + 안전 버퍼(기본 5분)를 결합하여 최소 예약 가능 시각을 계산합니다."""
    effective_now = now + timedelta(minutes=safety_buffer_minutes)
    biz = (rules or {}).get("business") or {}
    item = (rules or {}).get("bizItem") or {}

    biz_code = biz.get("bookingAvailableCode")
    item_code = item.get("bookingAvailableCode")
    if biz_code and biz_code != "RI01":
        avail_code = biz_code
        avail_val = int(biz.get("bookingAvailableValue") or 0)
    else:
        avail_code = item_code or biz_code or "RI01"
        raw_val = item.get("bookingAvailableValue") if item.get("bookingAvailableValue") is not None else biz.get("bookingAvailableValue")
        avail_val = int(raw_val or 0)

    if avail_code == "RI02":
        days_ahead = max(avail_val, 1)
        start_of_today = effective_now.replace(hour=0, minute=0, second=0, microsecond=0)
        return max(effective_now, start_of_today + timedelta(days=days_ahead))
    elif avail_code == "RI03":
        raw_cutoff = effective_now + timedelta(hours=avail_val)
        end_of_today = effective_now.replace(hour=23, minute=59, second=59, microsecond=999999)
        capped_cutoff = end_of_today if raw_cutoff.date() > effective_now.date() else raw_cutoff
        return max(effective_now, capped_cutoff)
    return effective_now


def filter_naver_hourly_slots(slots: list, now: datetime, rules: dict = None, start_dt: datetime = None, end_dt: datetime = None, safety_buffer_minutes: int = 5) -> list:
    """네이버 예약 프론트엔드(KK/Yg/Ft/nX/maxBookingTime)와 동일한 조건 + 5분 안전 버퍼로 유효 슬롯만 필터링합니다."""
    effective_now = now + timedelta(minutes=safety_buffer_minutes)
    min_bookable_dt = compute_min_bookable_dt(now, rules or {}, safety_buffer_minutes=safety_buffer_minutes)

    biz = (rules or {}).get("business") or {}
    item = (rules or {}).get("bizItem") or {}
    bookable_setting = item.get("bookableSettingJson") or {}
    if bookable_setting.get("isOpened") is False or bookable_setting.get("isPaused") is True:
        return []

    item_min_cnt = int(item.get("minBookingCount") or 1)
    item_min_time = int(item.get("minBookingTime") or 0)
    time_unit_code = item.get("bookingTimeUnitCode") or biz.get("bookingTimeUnitCode") or "RT02"
    default_duration = 30 if time_unit_code == "RT01" else 60

    by_date = {}
    for s in (slots or []):
        slot_str = s.get("unitStartTime")
        if not slot_str:
            continue
        try:
            slot_time = datetime.strptime(slot_str, "%Y-%m-%d %H:%M:%S")
        except ValueError:
            continue

        if slot_time < min_bookable_dt:
            continue
        if start_dt and slot_time < start_dt:
            continue
        if end_dt and slot_time > end_dt:
            continue

        date_key = slot_time.strftime("%Y-%m-%d")

        if bookable_setting.get("isUseClose"):
            close_days = int(bookable_setting.get("closeDays") or 0)
            close_hours = int(bookable_setting.get("closeHours") or 0)
            slot_day_start = slot_time.replace(hour=0, minute=0, second=0, microsecond=0)
            close_deadline = slot_day_start - timedelta(days=close_days) + timedelta(hours=close_hours)
            if effective_now >= close_deadline:
                continue

        is_open = bool(
            s.get("isBusinessDay")
            and s.get("isUnitBusinessDay")
            and s.get("isSaleDay")
            and s.get("isUnitSaleDay")
            and not s.get("isHoliday")
        )
        unit_stock = int(s.get("unitStock") if s.get("unitStock") is not None else (s.get("stock") or 0))
        unit_booked = int(s.get("unitBookingCount") or 0)
        unit_remain = unit_stock - unit_booked
        if s.get("stock") is not None:
            total_remain = int(s.get("stock")) - int(s.get("bookingCount") or 0) - int(s.get("occupiedBookingCount") or 0)
        else:
            total_remain = unit_remain
        max_allowed = int(s.get("maxBookingCount") or unit_stock)
        remain = min(unit_remain, total_remain, max_allowed)
        min_req = max(1, int(s.get("minBookingCount") or item_min_cnt))
        is_bookable = is_open and (remain >= min_req)
        duration = int(s.get("duration") or default_duration)

        by_date.setdefault(date_key, []).append({
            "datetime": slot_time,
            "datetime_str": slot_str,
            "remain_stock": remain,
            "duration": duration,
            "is_bookable": is_bookable,
            "raw": s
        })

    valid_slots = []
    for date_key in sorted(by_date.keys()):
        day_entries = by_date[date_key]
        acc_minutes = 0
        for entry in reversed(day_entries):
            if entry["is_bookable"]:
                acc_minutes += entry["duration"]
            else:
                acc_minutes = 0
            entry["max_booking_time"] = acc_minutes

        for entry in day_entries:
            if not entry["is_bookable"]:
                continue
            if item_min_time > 0 and entry["max_booking_time"] < item_min_time:
                continue
            valid_slots.append({
                "datetime": entry["datetime"],
                "datetime_str": entry["datetime_str"],
                "remain_stock": entry["remain_stock"],
                "korean_text": format_slot_korean(entry["datetime"], entry["remain_stock"]),
                "raw": entry["raw"]
            })

    return valid_slots


def fetch_hourly_schedule(biz_type_id: int, biz_id: str, item_id: str, start_dt: datetime, end_dt: datetime) -> list:
    """네이버 GraphQL API를 통해 시간별 슬롯 데이터를 조회합니다."""
    query = """
    query hourlySchedule($scheduleParams: ScheduleParams) {
      schedule(input: $scheduleParams) {
        bizItemSchedule {
          hourly {
            unitStartTime
            unitBookingCount
            unitStock
            bookingCount
            occupiedBookingCount
            stock
            isBusinessDay
            isSaleDay
            isUnitSaleDay
            isUnitBusinessDay
            isHoliday
            duration
            minBookingCount
            maxBookingCount
          }
        }
      }
    }
    """
    variables = {
        "scheduleParams": {
            "businessTypeId": biz_type_id,
            "businessId": biz_id,
            "bizItemId": item_id,
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
        resp = requests.post(GRAPHQL_ENDPOINT, headers=headers, json={"query": query, "variables": variables}, timeout=15)
        if resp.status_code == 200:
            data = resp.json().get("data", {})
            sched = data.get("schedule") if data else None
            biz_sched = sched.get("bizItemSchedule") if sched else None
            return (biz_sched.get("hourly") if biz_sched else []) or []
    except Exception as e:
        logger.error(f"GraphQL 요청 중 오류 ({biz_id}/{item_id}): {e}")
    return []


from urllib.parse import urlparse, parse_qs


def parse_date_range_from_url(naver_url: str):
    """네이버 예약 URL 쿼리스트링에서 startDate, endDate를 추출합니다."""
    now = get_now_kst()
    default_end = now + timedelta(days=365)
    try:
        parsed = urlparse(naver_url)
        params = parse_qs(parsed.query)
        start_str = params.get("startDate", [None])[0]
        end_str = params.get("endDate", [None])[0]

        start_dt = datetime.strptime(start_str, "%Y-%m-%d") if start_str else now
        end_dt = datetime.strptime(end_str, "%Y-%m-%d") if end_str else default_end

        # 시작일이 과거인 경우 현재 시점으로 보정
        start_dt = max(start_dt, now)
        # 종료일은 당일 23:59:59까지 포함
        end_dt = end_dt.replace(hour=23, minute=59, second=59)
        return start_dt, end_dt
    except Exception as e:
        logger.debug(f"날짜 파싱 실패 (기본 365일 적용): {e}")
        return now, default_end


def scan_available_slots(biz_type_id: int, biz_id: str, item_id: str, start_dt: datetime = None, end_dt: datetime = None, max_results: int = 3) -> list:
    """지정된 기간(start_dt ~ end_dt) 동안 예약 가능한 가장 빠른 슬롯을 검색합니다."""
    now = get_now_kst()
    if start_dt is None:
        start_dt = now
    if end_dt is None:
        end_dt = now + timedelta(days=365)

    rules = fetch_booking_rules(biz_id, item_id)
    chunk_size = 60
    current_start = max(now, start_dt)
    end_limit = end_dt

    all_available = []

    while current_start < end_limit:
        current_end = min(current_start + timedelta(days=chunk_size), end_limit)
        slots = fetch_hourly_schedule(biz_type_id, biz_id, item_id, current_start, current_end)
        filtered = filter_naver_hourly_slots(slots, now=now, rules=rules, start_dt=start_dt, end_dt=end_dt, safety_buffer_minutes=5)
        all_available.extend(filtered)

        if len(all_available) >= max_results:
            break

        current_start = current_end + timedelta(days=1)

    all_available.sort(key=lambda x: x["datetime"])
    return all_available[:max_results]



def scan_nol_ticket_seats(goods_code: str, play_seq: str = "all") -> list:
    """놀티켓 / 인터파크 티켓의 실시간 회차별 잔여석을 스캔합니다."""
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        "Referer": "https://nol.yanolja.com/",
        "Accept": "application/json, text/plain, */*"
    }
    available = []

    seqs_to_check = []
    if play_seq and play_seq != "all":
        seqs_to_check.append(play_seq)
    else:
        for i in range(1, 21):
            seqs_to_check.append(f"{i:03d}")

    for seq in seqs_to_check:
        url = f"https://nol.yanolja.com/ticket/products/api/remaining-seats?goodsCode={goods_code}&playSeq={seq}"
        try:
            resp = requests.get(url, headers=headers, timeout=6)
            if resp.status_code != 200:
                break
            data = resp.json()
            seats = data.get("remainSeat", [])
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
        except Exception as e:
            logger.warning(f"놀티켓 조회 오류 ({goods_code}/{seq}): {e}")
            break

    return available


def get_catchtable_shop_ref(shop_ref_or_alias: str) -> str:
    """캐치테이블 식당 alias(영문명)를 고유 shopRef로 변환합니다."""
    if not shop_ref_or_alias:
        return ""
    # 이미 20자 이상의 shopRef인 경우 바로 반환
    if len(shop_ref_or_alias) >= 20 and '-' not in shop_ref_or_alias and '/' not in shop_ref_or_alias:
        return shop_ref_or_alias
    clean_alias = shop_ref_or_alias.replace('https://app.catchtable.co.kr/ct/shop/', '').replace('https://catchtable.co.kr/', '').strip('/')
    try:
        url = f"https://ct-api.catchtable.co.kr/api/v4/shops/{clean_alias}"
        headers = {
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
        resp = requests.get(url, headers=headers, timeout=6)
        if resp.status_code == 200:
            vo = resp.json().get('data', {}).get('shopDetailVO', {})
            resolved = vo.get('shopRef')
            if resolved:
                return resolved
    except Exception as e:
        logger.warning(f"캐치테이블 shopRef 변환 실패 ({shop_ref_or_alias}): {e}")
    return clean_alias


def parse_catchtable_waiting_spec(biz_item_id: str) -> dict:
    """biz_item_id('waiting:hall:2' 등)에서 원격 웨이팅 감시 조건을 파싱합니다."""
    raw = str(biz_item_id or "").strip().lower()
    if not raw.startswith("waiting"):
        return {"is_waiting": False}
    parts = raw.split(":")
    scope = "hall"
    min_teams = 2
    if len(parts) >= 2 and parts[1] in ("hall", "total", "takeout"):
        scope = parts[1]
    if len(parts) >= 3:
        try:
            min_teams = max(0, int(parts[2]))
        except ValueError:
            min_teams = 2
    elif len(parts) == 2 and parts[1].isdigit():
        min_teams = max(0, int(parts[1]))
    return {"is_waiting": True, "scope": scope, "min_teams": min_teams}


def evaluate_catchtable_waiting_data(data: dict, scope: str = "hall", min_teams: int = 2) -> dict:
    """캐치테이블 waiting-shops API 응답 데이터를 기반으로 원격 웨이팅 가능 여부 및 최소 대기 팀 수 조건을 판별합니다."""
    if not data or not isinstance(data, dict):
        return {"is_open": False, "korean_text": "웨이팅 미지원 매장", "state_key": ""}

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
    hall_open = False
    takeout_open = False

    for t in current_tables:
        t_cnt = int(t.get("teamCount") or 0)
        is_takeout = bool(t.get("isTakeOut"))
        is_t_open = (t.get("tableOperationStatus") == "OPEN")
        if is_takeout:
            takeout_teams += t_cnt
            if is_t_open:
                takeout_open = True
        else:
            hall_teams += t_cnt
            if is_t_open:
                hall_open = True

    if not current_tables:
        hall_teams = total_teams
        hall_open = is_waiting_avail

    target_teams = hall_teams if scope == "hall" else (takeout_teams if scope == "takeout" else total_teams)
    scope_label = "홀" if scope == "hall" else ("포장" if scope == "takeout" else "전체")
    effective_min = max(min_teams, at_least_cnt)

    is_remote_ready = (
        is_waiting_avail
        and (disabled_reason is None)
        and (hall_open if scope == "hall" else (takeout_open if scope == "takeout" else True))
        and (target_teams >= effective_min)
    )

    if is_remote_ready:
        cond_desc = f"{effective_min}팀 이상 조건 달성" if effective_min > 0 else "즉시 등록 가능"
        kor_text = f"원격 웨이팅 가능! (현재 {scope_label} {target_teams}팀 대기 · {cond_desc})"
        state_key = f"OPEN:{scope}:{effective_min}"
        return {
            "is_open": True,
            "scope": scope,
            "scope_label": scope_label,
            "target_teams": target_teams,
            "total_teams": total_teams,
            "hall_teams": hall_teams,
            "takeout_teams": takeout_teams,
            "effective_min": effective_min,
            "korean_text": kor_text,
            "state_key": state_key
        }

    reason_map = {
        "UNDER_AVAILABLE_TEAMS": f"대기 팀 부족 (현재 {scope_label} {target_teams}팀 / 최소 {max(effective_min, 2)}팀 필요)",
        "NON_OPERATING_HOURS": "영업시간 외 (웨이팅 오픈 전/마감)",
        "CLOSED_DAY": "오늘 휴무일",
        "CLOSED_MANUALLY": "매장 웨이팅 마감",
        "PAUSED": "웨이팅 일시 중지",
        "AUTO_PAUSED_TIME": "브레이크 타임 (일시 중지)",
        "BY_PASS": f"대기 없음 (현재 {scope_label} {target_teams}팀 · 바로 입장 상태)",
        "OFFLINE_ONLY": "현장 웨이팅만 가능",
        "ONLY_OFFLINE_OPERATION_HOURS": "현재 현장 웨이팅만 가능 시간대",
        "NOT_OPEN_WAITING_OPERATION": "현장 웨이팅만 가능"
    }
    if disabled_reason is None and target_teams < effective_min:
        reason_text = f"현재 {scope_label} {target_teams}팀 대기 ({effective_min}팀 이상 시 알림)"
    else:
        reason_text = reason_map.get(disabled_reason, f"원격 웨이팅 대기 중 (현재 {scope_label} {target_teams}팀)")

    return {
        "is_open": False,
        "scope": scope,
        "scope_label": scope_label,
        "target_teams": target_teams,
        "total_teams": total_teams,
        "hall_teams": hall_teams,
        "takeout_teams": takeout_teams,
        "effective_min": effective_min,
        "disabled_reason": disabled_reason,
        "korean_text": reason_text,
        "state_key": ""
    }


def scan_catchtable_waiting(shop_ref: str, biz_item_id: str = "waiting:hall:2") -> dict:
    """캐치테이블 실시간 웨이팅 현황을 스캔합니다."""
    spec = parse_catchtable_waiting_spec(biz_item_id)
    resolved_ref = get_catchtable_shop_ref(shop_ref)
    headers = {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Origin': 'https://app.catchtable.co.kr',
        'Referer': 'https://app.catchtable.co.kr/'
    }
    url = f"https://ct-api.catchtable.co.kr/reservation-api/v1/waiting-shops/{resolved_ref}"
    params = {"withTable": "true", "withWaitingsStatus": "true", "withPersonOption": "true"}
    try:
        resp = requests.get(url, params=params, headers=headers, timeout=8)
        if resp.status_code == 200:
            data = (resp.json() or {}).get("data") or {}
            return evaluate_catchtable_waiting_data(data, scope=spec.get("scope", "hall"), min_teams=spec.get("min_teams", 2))
    except Exception as e:
        logger.warning(f"캐치테이블 웨이팅 조회 오류 ({shop_ref}): {e}")
    return {"is_open": False, "korean_text": "웨이팅 정보 조회 실패", "state_key": ""}


def scan_catchtable_slots(shop_ref: str, max_results: int = 5, target_date: str = "all") -> list:
    """캐치테이블 실시간 예약 가능 날짜 및 인원 수를 스캔합니다."""
    resolved_ref = get_catchtable_shop_ref(shop_ref)
    headers = {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Origin': 'https://app.catchtable.co.kr',
        'Referer': 'https://app.catchtable.co.kr/'
    }
    url = f"https://ct-api.catchtable.co.kr/api/reservation/v1/dining/day-slots?shopRef={resolved_ref}&tableSeqs=&personCounts="
    available = []
    try:
        resp = requests.get(url, headers=headers, timeout=10)
        if resp.status_code == 200:
            data = resp.json().get("data", [])
            for item in data:
                if item.get("availableStatus") == "AVAILABLE":
                    dt_str = item.get("date")  # e.g. "2026-10-28"
                    if target_date and target_date != "all" and not str(target_date).startswith("waiting") and dt_str != target_date:
                        continue
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
    except Exception as e:
        logger.warning(f"캐치테이블 슬롯 조회 오류 ({shop_ref}): {e}")

    return available[:max_results]


def send_web_push(subscription_info: dict, title: str, body: str, url: str) -> bool:
    """W3C VAPID 표준 Web Push를 통해 스마트폰 잠금화면으로 푸시 알림을 전송합니다."""
    if not subscription_info or "endpoint" not in subscription_info:
        logger.warning("푸시 구독 정보가 올바르지 않습니다.")
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
        logger.info(f"📱 스마트폰 Web Push 전송 성공! -> {subscription_info['endpoint'][:45]}...")
        return True
    except WebPushException as ex:
        logger.error(f"❌ Web Push 전송 실패: {ex}")
        if ex.response and ex.response.status_code in [404, 410]:
            logger.info("ℹ️ 만료된 푸시 구독 토큰입니다.")
        return False
    except Exception as e:
        logger.error(f"❌ Web Push 발송 중 일반 예외: {e}")
        return False


def fetch_active_reservations_secure(headers: dict) -> list:
    """RLS 활성화 환경에서도 안전하게 동작하도록 보안 RPC(scheduler_get_active_reservations)를 우선 호출하고, 미생성 시 REST로 폴백합니다."""
    rpc_url = f"{SUPABASE_URL}/rest/v1/rpc/scheduler_get_active_reservations"
    try:
        r = requests.post(rpc_url, headers=headers, json={"p_scheduler_key": VAPID_PRIVATE_KEY}, timeout=10)
        if r.status_code == 200:
            return r.json()
    except Exception:
        pass

    url = f"{SUPABASE_URL}/rest/v1/reservations?select=id,device_id,naver_url,business_type_id,business_id,biz_item_id,biz_name,item_name,last_slots,devices(push_subscription)&is_active=eq.true"
    resp = requests.get(url, headers=headers, timeout=10)
    if resp.status_code == 200:
        return resp.json()
    logger.error(f"Supabase 조회 실패 ({resp.status_code}): {resp.text}")
    return []


def update_reservation_secure(headers: dict, res_id: str, payload: dict) -> None:
    """RLS 활성화 환경에서도 안전하게 업데이트하도록 보안 RPC(scheduler_update_reservation)를 우선 호출합니다."""
    rpc_url = f"{SUPABASE_URL}/rest/v1/rpc/scheduler_update_reservation"
    rpc_body = {
        "p_scheduler_key": VAPID_PRIVATE_KEY,
        "p_reservation_id": res_id,
        "p_last_slots": payload.get("last_slots"),
        "p_updated_at": payload.get("updated_at"),
        "p_business_id": payload.get("business_id"),
        "p_biz_item_id": payload.get("biz_item_id"),
        "p_item_name": payload.get("item_name"),
        "p_naver_url": payload.get("naver_url")
    }
    try:
        r = requests.post(rpc_url, headers=headers, json=rpc_body, timeout=8)
        if r.status_code == 200:
            return
    except Exception:
        pass

    update_url = f"{SUPABASE_URL}/rest/v1/reservations?id=eq.{res_id}"
    requests.patch(update_url, headers=headers, json=payload, timeout=8)


def run_supabase_multi_user(only_mode: str = None):
    """Supabase에서 모든 활성 예약을 조회하여 개별 사용자 기기로 알림을 발송합니다."""
    logger.info("🌐 [Supabase 연동 모드] 다중 사용자 예약 목록 로드 중...")

    force_notify = os.environ.get("NOTIFY_ALWAYS", "false").lower() in ["1", "true", "yes"] or "--force" in sys.argv
    if force_notify:
        logger.info("📢 알림 강제 전송 옵션(NOTIFY_ALWAYS=true / --force)이 활성화되었습니다.")
    
    # Supabase 보안 RPC (또는 REST 폴백)로 active 예약과 기기 push_subscription 조회
    headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json"
    }

    try:
        reservations = fetch_active_reservations_secure(headers)
        logger.info(f"📋 총 {len(reservations)}개의 활성 예약 건을 모니터링합니다.")

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
            push_sub = res.get("push_subscription") or device_info.get("push_subscription")
            now_iso = get_now_kst_iso()

            if only_mode == "waiting":
                if biz_type != 88 or not parse_catchtable_waiting_spec(item_id).get("is_waiting"):
                    continue

            if biz_type == 99:
                # 놀티켓 / 인터파크 콘서트 취켓팅 모니터링
                logger.info(f"🔎 [놀티켓 취켓팅] 스캔 시작: [{biz_name}] - {item_name} (goodsCode: {biz_id})")
                top_seats = scan_nol_ticket_seats(biz_id, item_id)
                current_seat_keys = [s["korean_text"] for s in top_seats]
                is_changed = (current_seat_keys != last_slots)

                if top_seats and (is_changed or force_notify):
                    logger.info(f"🎉 [놀티켓 취소표 발견!] [{biz_name}] {top_seats[0]['korean_text']}")
                    title = f"🎫 [취소표 발생!] {biz_name}"
                    cast_prefix = ""
                    if "[캐스트:" in item_name:
                        import re
                        m_cast = re.search(r'\[캐스트:[^\]]+\]', item_name)
                        if m_cast:
                            cast_prefix = f"🎭 {m_cast.group(0)}\n"
                    body = f"{cast_prefix}{top_seats[0]['korean_text']}\n지금 즉시 예매하세요!"
                    if len(top_seats) > 1:
                        body += f"\n외 {len(top_seats)-1}개 좌석 오픈"

                    if push_sub:
                        send_web_push(push_sub, title, body, naver_url)
                    else:
                        logger.warning(f"⚠️ [{biz_name}] 푸시 구독 토큰이 등록되지 않은 기기입니다.")

                    update_reservation_secure(headers, res_id, {
                        "last_slots": current_seat_keys,
                        "updated_at": now_iso
                    })
                elif not top_seats:
                    logger.info(f"❌ [놀티켓] [{biz_name}] 현재 잔여 취소표가 없습니다. (전석 매진)")
                    payload = {"updated_at": now_iso}
                    if last_slots:
                        logger.info(f"🔄 [놀티켓] [{biz_name}] 이전 슬롯이 매진되어 상태를 리셋합니다. (다음 취소표 발생 시 즉시 감지)")
                        payload["last_slots"] = []
                    update_reservation_secure(headers, res_id, payload)
                else:
                    logger.info(f"ℹ️ [놀티켓] [{biz_name}] 이전 확인 시점과 동일합니다. (중복 알림 방지)")
                    update_reservation_secure(headers, res_id, {
                        "updated_at": now_iso
                    })
                continue

            if biz_type == 88:
                wait_spec = parse_catchtable_waiting_spec(item_id)
                if wait_spec.get("is_waiting"):
                    logger.info(f"🔎 [캐치테이블 원격 웨이팅] 스캔 시작: [{biz_name}] - {item_name} (shopRef: {biz_id})")
                    w_res = scan_catchtable_waiting(biz_id, item_id)
                    is_open = w_res.get("is_open", False)
                    current_keys = [w_res["korean_text"]] if is_open else []
                    was_open = len(last_slots) > 0

                    if is_open and (not was_open or force_notify):
                        logger.info(f"🎉 [캐치테이블 원격 웨이팅 오픈!] [{biz_name}] {w_res['korean_text']}")
                        title = f"🏃 [원격 웨이팅 오픈!] {biz_name}"
                        body = f"{w_res['korean_text']}\n지금 즉시 캐치테이블 앱에서 웨이팅을 등록하세요!"
                        if push_sub:
                            send_web_push(push_sub, title, body, naver_url)
                        else:
                            logger.warning(f"⚠️ [{biz_name}] 푸시 구독 토큰이 등록되지 않은 기기입니다.")
                        update_reservation_secure(headers, res_id, {
                            "last_slots": current_keys,
                            "updated_at": now_iso
                        })
                    elif is_open:
                        logger.info(f"ℹ️ [캐치테이블 원격 웨이팅] [{biz_name}] 원격 웨이팅 가능 상태 유지 중 ({w_res['korean_text']})")
                        update_reservation_secure(headers, res_id, {
                            "last_slots": current_keys,
                            "updated_at": now_iso
                        })
                    else:
                        logger.info(f"❌ [캐치테이블 원격 웨이팅] [{biz_name}] {w_res.get('korean_text')}")
                        payload = {"updated_at": now_iso}
                        if last_slots:
                            logger.info(f"🔄 [캐치테이블 원격 웨이팅] [{biz_name}] 원격 웨이팅이 비활성화되어 상태를 리셋합니다.")
                            payload["last_slots"] = []
                        update_reservation_secure(headers, res_id, payload)
                    continue

                # 캐치테이블 레스토랑 예약 모니터링
                logger.info(f"🔎 [캐치테이블] 스캔 시작: [{biz_name}] (shopRef: {biz_id})")
                top_slots = scan_catchtable_slots(biz_id, max_results=3, target_date=item_id)
                current_slot_keys = [s["korean_text"] for s in top_slots]
                is_changed = (current_slot_keys != last_slots)

                if top_slots and (is_changed or force_notify):
                    logger.info(f"🎉 [캐치테이블 빈자리 발견!] [{biz_name}] {top_slots[0]['korean_text']}")
                    title = f"🍽️ [빈자리 오픈!] {biz_name}"
                    body = f"{top_slots[0]['korean_text']}\n지금 즉시 예약하세요!"
                    if len(top_slots) > 1:
                        body += f"\n외 {len(top_slots)-1}개 날짜 오픈"

                    if push_sub:
                        send_web_push(push_sub, title, body, naver_url)
                    else:
                        logger.warning(f"⚠️ [{biz_name}] 푸시 구독 토큰이 등록되지 않은 기기입니다.")

                    update_reservation_secure(headers, res_id, {
                        "last_slots": current_slot_keys,
                        "updated_at": now_iso
                    })
                elif not top_slots:
                    logger.info(f"❌ [캐치테이블] [{biz_name}] 현재 예약 가능한 일정이 없습니다. (전석 마감)")
                    payload = {"updated_at": now_iso}
                    if last_slots:
                        logger.info(f"🔄 [캐치테이블] [{biz_name}] 이전 슬롯이 마감되어 상태를 리셋합니다. (다음 취소표 발생 시 즉시 감지)")
                        payload["last_slots"] = []
                    update_reservation_secure(headers, res_id, payload)
                else:
                    logger.info(f"ℹ️ [캐치테이블] [{biz_name}] 이전 확인 시점과 동일합니다. (중복 알림 방지)")
                    update_reservation_secure(headers, res_id, {
                        "updated_at": now_iso
                    })
                continue

            # 일반 네이버 예약 모니터링
            extra_patch = {}
            if str(item_id) == "1" or len(str(biz_id)) >= 8:
                r_biz, r_item, r_item_name = resolve_naver_booking_ids(biz_id, item_id)
                if r_biz != str(biz_id) or r_item != str(item_id):
                    logger.info(f"🔧 [{biz_name}] 플레이스 ID 자동 보정: {biz_id}/{item_id} -> {r_biz}/{r_item} ({r_item_name})")
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

            logger.info(f"🔎 스캔 시작: [{biz_name}] - {item_name} (기간: {date_range_desc})")
            top_slots = scan_available_slots(biz_type, biz_id, item_id, start_dt=start_dt, end_dt=end_dt, max_results=3)

            current_slot_keys = [s["datetime_str"] for s in top_slots]
            is_changed = (current_slot_keys != last_slots)

            if top_slots and (is_changed or force_notify):
                logger.info(f"🎉 [{biz_name}] 새로운 빈자리 발견! (최단: {top_slots[0]['datetime_str']})")
                
                # 1) 해당 사용자의 스마트폰으로 Web Push 전송
                title = f"🔔 [{biz_name}] 빈자리 발견!"
                body = f"가장 빠른 일정: {top_slots[0]['korean_text']}\n(희망기간: {date_range_desc})"
                if len(top_slots) > 1:
                    body += f"\n외 {len(top_slots)-1}개 슬롯 가능"

                if push_sub:
                    send_web_push(push_sub, title, body, naver_url)
                else:
                    logger.warning(f"⚠️ [{biz_name}] 푸시 구독 토큰이 등록되지 않은 기기입니다.")

                # 2) Supabase last_slots 상태 업데이트
                update_reservation_secure(headers, res_id, {
                    **extra_patch,
                    "last_slots": current_slot_keys,
                    "updated_at": now_iso
                })
            elif not top_slots:
                logger.info(f"❌ [{biz_name}] 지정 기간({date_range_desc}) 내 빈자리가 없습니다.")
                payload = {**extra_patch, "updated_at": now_iso}
                if last_slots:
                    logger.info(f"🔄 [{biz_name}] 이전 슬롯이 마감되어 상태를 리셋합니다. (다음 취소표 발생 시 즉시 감지)")
                    payload["last_slots"] = []
                update_reservation_secure(headers, res_id, payload)
            else:
                logger.info(f"ℹ️ [{biz_name}] 이전 확인 시점과 최단 빈자리가 동일합니다. (중복 알림 방지)")
                update_reservation_secure(headers, res_id, {
                    **extra_patch,
                    "updated_at": now_iso
                })

    except Exception as e:
        logger.error(f"다중 사용자 스케줄러 실행 중 오류: {e}")


def main():
    import argparse
    import time

    parser = argparse.ArgumentParser(description="네이버 예약 다중 사용자 자동 감지 스케줄러")
    parser.add_argument("--daemon", "--loop", action="store_true", help="지정된 주기마다 무한 반복 실행하는 백그라운드 데몬 모드")
    parser.add_argument("--interval", type=int, default=600, help="반복 주기 (초 단위, 기본값: 600초 / 10분)")
    parser.add_argument("--only", type=str, default=None, help="특정 모드만 스캔 (예: waiting)")
    args = parser.parse_args()

    if args.daemon:
        logger.info(f"🔄 [데몬 모드 가동] {args.interval}초({args.interval // 60}분) 간격으로 지속 감시를 시작합니다. (중단: Ctrl+C)")
        while True:
            try:
                if SUPABASE_URL and SUPABASE_KEY:
                    run_supabase_multi_user(only_mode=args.only)
                else:
                    logger.info("⚠️ SUPABASE_URL/KEY가 설정되지 않아 기본 단일 모니터링(monitor.py) 모드로 실행합니다.")
                    import monitor
                    monitor.main()
            except KeyboardInterrupt:
                logger.info("🛑 사용자에 의해 스케줄러가 중단되었습니다.")
                break
            except Exception as e:
                logger.error(f"⚠️ 주기 실행 중 예외 발생: {e}")
            
            logger.info(f"⏳ 다음 감시 주기까지 {args.interval}초 대기 중...")
            try:
                time.sleep(args.interval)
            except KeyboardInterrupt:
                logger.info("🛑 사용자에 의해 스케줄러가 중단되었습니다.")
                break
    else:
        if SUPABASE_URL and SUPABASE_KEY:
            run_supabase_multi_user(only_mode=args.only)
        else:
            logger.info("⚠️ SUPABASE_URL/KEY가 설정되지 않아 기본 단일 모니터링(monitor.py) 모드로 실행합니다.")
            import monitor
            monitor.main()


if __name__ == "__main__":
    main()

