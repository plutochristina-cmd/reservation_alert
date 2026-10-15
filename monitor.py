"""
네이버 예약 빈자리 실시간 감지 및 텔레그램 알림 봇 (monitor.py)
- 대상: 네이버 예약 (루시타로&사주 - 대표 루시쌤)
- 대상 URL: https://booking.naver.com/booking/13/bizes/1474503/items/6971667?tab=book
- 기능: 현재 시점부터 미래 1년(365일) 내 예약 가능한 가장 빠른 날짜/시간 상위 3개를 조회하여 텔레그램 알림 발송
"""

import os
import sys
import json
import logging
from datetime import datetime, timedelta
import requests
from dotenv import load_dotenv

# UTF-8 콘솔 인코딩 설정 (Windows 호환)
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

# 환경변수 로드 (.env 지원)
load_dotenv()

# 로깅 설정
logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(levelname)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S"
)
logger = logging.getLogger("NaverBookingMonitor")

# 네이버 예약 기본 정보
BUSINESS_ID = os.environ.get("NAVER_BUSINESS_ID", "1474503")
BIZ_ITEM_ID = os.environ.get("NAVER_BIZ_ITEM_ID", "6971667")
BUSINESS_TYPE_ID = int(os.environ.get("NAVER_BUSINESS_TYPE_ID", "13"))
BOOKING_PAGE_URL = f"https://booking.naver.com/booking/{BUSINESS_TYPE_ID}/bizes/{BUSINESS_ID}/items/{BIZ_ITEM_ID}?tab=book"
GRAPHQL_ENDPOINT = "https://booking.naver.com/graphql"

DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Referer": BOOKING_PAGE_URL,
    "Origin": "https://booking.naver.com",
    "Content-Type": "application/json",
    "Accept": "*/*"
}

STATE_FILE = ".last_state.json"
WEEKDAY_KR = ["월", "화", "수", "목", "금", "토", "일"]


def get_business_info(business_id: str, biz_item_id: str) -> tuple[str, str]:
    """업체명 및 예약 상품명을 네이버 GraphQL API로 조회합니다."""
    query = """
    query getBusinessInfo($businessId: String!, $bizItemId: String!) {
      business(input: {businessId: $businessId, lang: "ko"}) {
        name
      }
      bizItem(input: {businessId: $businessId, bizItemId: $bizItemId, lang: "ko"}) {
        name
      }
    }
    """
    try:
        resp = requests.post(
            GRAPHQL_ENDPOINT,
            headers=DEFAULT_HEADERS,
            json={"query": query, "variables": {"businessId": business_id, "bizItemId": biz_item_id}},
            timeout=10
        )
        if resp.status_code == 200:
            data = resp.json().get("data", {})
            biz_name = data.get("business", {}).get("name", "루시타로&사주")
            item_name = data.get("bizItem", {}).get("name", "대표 루시쌤")
            return biz_name, item_name
    except Exception as e:
        logger.warning(f"업체 정보 조회 중 경고 발생: {e}")
    
    return "루시타로&사주", "대표 루시쌤"


def fetch_hourly_schedule(start_dt: datetime, end_dt: datetime) -> list:
    """지정된 기간 동안의 시간별 슬롯 데이터를 네이버 GraphQL API로 조회합니다."""
    query = """
    query hourlySchedule($scheduleParams: ScheduleParams) {
      schedule(input: $scheduleParams) {
        bizItemSchedule {
          hourly {
            id
            unitStartDateTime
            unitStartTime
            unitBookingCount
            unitStock
            isBusinessDay
            isSaleDay
            isUnitSaleDay
            isUnitBusinessDay
            isHoliday
          }
        }
      }
    }
    """
    variables = {
        "scheduleParams": {
            "businessTypeId": BUSINESS_TYPE_ID,
            "businessId": BUSINESS_ID,
            "bizItemId": BIZ_ITEM_ID,
            "startDateTime": start_dt.strftime("%Y-%m-%dT00:00:00"),
            "endDateTime": end_dt.strftime("%Y-%m-%dT23:59:59"),
            "fixedTime": True,
            "includesHolidaySchedules": True
        }
    }

    try:
        resp = requests.post(
            GRAPHQL_ENDPOINT,
            headers=DEFAULT_HEADERS,
            json={"query": query, "variables": variables},
            timeout=15
        )
        if resp.status_code == 200:
            data = resp.json().get("data", {})
            sched = data.get("schedule") if data else None
            biz_sched = sched.get("bizItemSchedule") if sched else None
            hourly = biz_sched.get("hourly") if biz_sched else []
            return hourly or []
        else:
            logger.error(f"GraphQL 요청 실패 (HTTP {resp.status_code}): {resp.text[:200]}")
            return []
    except Exception as e:
        logger.error(f"스케줄 API 요청 중 예외 발생: {e}")
        return []


def find_earliest_available_slots(days_ahead: int = 365, max_results: int = 3) -> list:
    """현재 시점부터 미래 days_ahead 일 동안 예약 가능한 가장 빠른 슬롯을 max_results 개까지 검색합니다."""
    now = datetime.now()
    chunk_size = 60  # 60일 단위로 분할 조회
    current_start = now
    end_limit = now + timedelta(days=days_ahead)

    all_available = []

    logger.info(f"📅 예약 슬롯 검색 시작: {now.strftime('%Y-%m-%d %H:%M:%S')} ~ {end_limit.strftime('%Y-%m-%d')} (향후 {days_ahead}일)")

    while current_start < end_limit:
        current_end = min(current_start + timedelta(days=chunk_size), end_limit)
        start_str = current_start.strftime("%Y-%m-%d")
        end_str = current_end.strftime("%Y-%m-%d")

        hourly_slots = fetch_hourly_schedule(current_start, current_end)

        for slot in hourly_slots:
            slot_time_str = slot.get("unitStartTime")
            if not slot_time_str:
                continue

            try:
                slot_time = datetime.strptime(slot_time_str, "%Y-%m-%d %H:%M:%S")
            except ValueError:
                continue

            # 과거 시점 슬롯 제외
            if slot_time <= now:
                continue

            # 영업일 및 판매일 확인
            is_open = (
                slot.get("isBusinessDay", False)
                and slot.get("isUnitBusinessDay", False)
                and slot.get("isSaleDay", False)
                and slot.get("isUnitSaleDay", False)
            )

            if not is_open:
                continue

            # 재고 잔여 여부 확인
            stock = slot.get("unitStock") or 0
            booked = slot.get("unitBookingCount") or 0
            remain = stock - booked

            if remain > 0:
                all_available.append({
                    "datetime": slot_time,
                    "datetime_str": slot_time_str,
                    "remain_stock": remain,
                    "raw": slot
                })

        logger.info(f"  - [{start_str} ~ {end_str}] 조회 완료 (현재까지 발견된 빈자리: {len(all_available)}개)")

        # 다음 청크 시작일로 이동
        current_start = current_end + timedelta(days=1)

    # 시간순 정렬
    all_available.sort(key=lambda x: x["datetime"])
    return all_available[:max_results]


def format_slot_korean(dt: datetime, remain: int) -> str:
    """날짜/시간을 보기 좋은 한국어 포맷으로 변환합니다."""
    weekday = WEEKDAY_KR[dt.weekday()]
    return f"{dt.strftime('%Y년 %m월 %d일')} ({weekday}) {dt.strftime('%H:%M')} (잔여: {remain}자리)"


def send_telegram_alert(token: str, chat_id: str, biz_name: str, item_name: str, slots: list) -> bool:
    """텔레그램 봇 API를 통해 알림 메시지를 전송합니다."""
    if not token or not chat_id:
        logger.warning("⚠️ 텔레그램 환경변수(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)가 설정되지 않아 콘솔 출력만 진행합니다.")
        return False

    slots_text = ""
    for idx, s in enumerate(slots, 1):
        number_emoji = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣"][idx - 1] if idx <= 5 else f"[{idx}]"
        korean_time = format_slot_korean(s["datetime"], s["remain_stock"])
        slots_text += f"{number_emoji} <b>{korean_time}</b>\n"

    message = (
        f"🔔 <b>[네이버 예약 빈자리 알림]</b>\n\n"
        f"📍 <b>업체명:</b> {biz_name}\n"
        f"🎯 <b>예약 항목:</b> {item_name}\n"
        f"⏰ <b>확인 일시:</b> {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n\n"
        f"✨ <b>예약 가능한 가장 빠른 일정 (Top {len(slots)}):</b>\n"
        f"{slots_text}\n"
        f"🔗 <b>예약 바로가기:</b>\n"
        f"{BOOKING_PAGE_URL}\n"
    )

    telegram_url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = {
        "chat_id": chat_id,
        "text": message,
        "parse_mode": "HTML",
        "disable_web_page_preview": False
    }

    try:
        resp = requests.post(telegram_url, json=payload, timeout=10)
        if resp.status_code == 200:
            logger.info("✅ 텔레그램 알림 메시지 발송 완료!")
            return True
        else:
            logger.error(f"❌ 텔레그램 발송 실패 (HTTP {resp.status_code}): {resp.text}")
            return False
    except Exception as e:
        logger.error(f"❌ 텔레그램 API 연결 오류: {e}")
        return False


def load_last_state() -> list:
    """이전 실행 시 발견되었던 슬롯 목록을 로드합니다."""
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return []
    return []


def save_current_state(slots: list) -> None:
    """현재 발견된 슬롯 목록을 저장합니다."""
    try:
        data = [s["datetime_str"] for s in slots]
        with open(STATE_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception as e:
        logger.warning(f"상태 파일 저장 실패: {e}")


def main():
    force_notify = "--force" in sys.argv or os.environ.get("NOTIFY_ALWAYS", "false").lower() in ["1", "true", "yes"]
    max_days = int(os.environ.get("TARGET_MAX_DAYS", "365"))

    telegram_token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    telegram_chat_id = os.environ.get("TELEGRAM_CHAT_ID", "").strip()

    print("=" * 60)
    print("🚀 네이버 예약 빈자리 자동 감지 봇 실행")
    print(f"🔗 대상 URL: {BOOKING_PAGE_URL}")
    print("=" * 60)

    # 1. 업체 및 상품명 조회
    biz_name, item_name = get_business_info(BUSINESS_ID, BIZ_ITEM_ID)
    logger.info(f"🏢 대상 업체: {biz_name} | 상품: {item_name}")

    # 2. 미래 1년 예약 가능 슬롯 검색
    top_slots = find_earliest_available_slots(days_ahead=max_days, max_results=3)

    print("\n" + "=" * 60)
    print(f"📊 [조회 결과] {biz_name} - {item_name}")
    print("=" * 60)

    if not top_slots:
        print("❌ 현재 시점부터 1년 내 예약 가능한 빈자리가 없습니다. (모든 스케줄 마감)")
        print(f"🔗 페이지 확인: {BOOKING_PAGE_URL}")
        return

    print(f"✨ 예약 가능한 가장 빠른 날짜/시간 (상위 {len(top_slots)}개):")
    for idx, s in enumerate(top_slots, 1):
        formatted = format_slot_korean(s["datetime"], s["remain_stock"])
        print(f"  {idx}. {formatted}")
    print(f"\n🔗 예약 링크: {BOOKING_PAGE_URL}")
    print("=" * 60)

    # 3. 변경 사항 확인 (도배 방지)
    current_slot_keys = [s["datetime_str"] for s in top_slots]
    last_slot_keys = load_last_state()

    is_changed = (current_slot_keys != last_slot_keys)

    if is_changed:
        logger.info(f"🆕 새로운 빈자리 일정 발견! (이전: {last_slot_keys} -> 현재: {current_slot_keys})")
    else:
        logger.info("ℹ️ 이전 확인 시점과 최단 예약 가능 슬롯 목록(Top 3)이 동일합니다.")

    # 4. 텔레그램 발송 여부 판단
    if is_changed or force_notify:
        if force_notify and not is_changed:
            logger.info("📢 알림 강제 전송 옵션(--force 또는 NOTIFY_ALWAYS=true)이 활성화되어 발송합니다.")
        send_telegram_alert(telegram_token, telegram_chat_id, biz_name, item_name, top_slots)
        save_current_state(top_slots)
    else:
        logger.info("🔕 동일한 슬롯 중복 알림 방지를 위해 이번 회차 전송은 건너뜁니다. (새로운 슬롯 오픈 또는 취소표 발생 시 즉시 전송)")


if __name__ == "__main__":
    main()
