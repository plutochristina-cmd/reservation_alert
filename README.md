# 🚀 네이버 예약 알리미 - 다중 사용자 PWA 웹앱 & 자동 감지 봇

누구나 스마트폰(안드로이드 / 아이폰)으로 접속하여 원하는 네이버 예약 URL을 등록하면, **최단 빈자리(취소표) 발생 시 스마트폰 잠금화면으로 실시간 푸시 알림**을 보내주는 서비스입니다.

---

## ✨ 핵심 기능 및 특징

1. **무로그인 기기 식별 & SHA-256 단방향 암호화 인증**
   - 회원가입/비밀번호/개인정보 입력 **전혀 없음 (0초 진입장벽)**
   - 각 스마트폰 내부에서 64자리 난수 비밀키를 생성하고, DB에는 역추적이 불가능한 **`SHA-256(비밀키)` 해시값만 저장**
   - 타인이 내 예약 목록을 보거나 조작하는 것을 암호학적으로 원천 차단
2. **아이폰(iOS 16.4+) & 안드로이드 100% 범용 지원**
   - **안드로이드:** 크롬/삼성인터넷에서 바로 알림 켜기 가능
   - **아이폰:** 사파리 하단 공유 버튼 ➡️ **[홈 화면에 추가]** 후 앱처럼 실행하여 잠금화면 푸시 알림 수신
3. **물리 서버 0원 (완전 무료 서버리스 운영)**
   - **웹 호스팅:** Vercel (무료 PWA 배포)
   - **데이터베이스:** Supabase (무료 클라우드 DB)
   - **스케줄러:** GitHub Actions (매시간 정각 무료 가상머신 자동 실행)

---

## 📁 프로젝트 구조

```text
reservation/
├── public/                  # Vercel 배포용 PWA 프론트엔드
│   ├── index.html           # 모바일 퍼스트 반응형 웹 대시보드
│   ├── style.css            # 프리미엄 다크 글래스모피즘 스타일
│   ├── app.js               # WebCrypto SHA-256 해시, Web Push 매니저, URL 파서
│   ├── sw.js                # 백그라운드 푸시 수신 서비스 워커
│   ├── manifest.json        # 안드로이드/아이폰 홈 화면 앱 설치 매니페스트
│   ├── icon-192.png         # 앱 아이콘 (192x192)
│   └── icon-512.png         # 앱 아이콘 (512x512)
├── .github/
│   └── workflows/
│       └── check.yml        # GitHub Actions 매시간 정각 자동 스케줄러
├── supabase_schema.sql      # Supabase DB 테이블 DDL 및 SHA-256 보안 함수
├── scheduler.py             # 다중 사용자 통합 스케줄러 (네이버 스캔 & Web Push 발송)
├── monitor.py               # 단일 사용자 로컬 모니터링 스크립트 (폴백용)
├── generate_vapid_keys.py   # Web Push VAPID 키 생성기
├── requirements.txt         # 파이썬 의존성 패키지
└── README.md                # 사용 및 배포 가이드
```

---

## 🚀 실시간 운영 및 배포 가이드

### 🌐 현재 배포 완료된 주소
- **웹 대시보드 (PWA):** [https://naver-reserve-alert.vercel.app](https://naver-reserve-alert.vercel.app)
- **클라우드 데이터베이스:** Supabase 연동 완료 (`devices`, `reservations`, SHA-256 RPC 함수 작동 중)

---

### 💻 스케줄러 실행 방법 (선택 1 또는 2)

#### [방식 1] 내 PC에서 백그라운드 자동 감지 (가장 간편한 방법)
- **콘솔 창 띄워서 실행:** [`run_background.bat`](file:///c:/Users/SamsungLife/Desktop/reservation/run_background.bat) 더블 클릭 (10분마다 자동 감지)
- **창 없이 백그라운드 숨김 실행:** [`start_scheduler_hidden.vbs`](file:///c:/Users/SamsungLife/Desktop/reservation/start_scheduler_hidden.vbs) 더블 클릭
- **백그라운드 스케줄러 중단:** [`stop_scheduler.bat`](file:///c:/Users/SamsungLife/Desktop/reservation/stop_scheduler.bat) 더블 클릭

#### [방식 2] GitHub Actions 완전 자동 스케줄러 (서버 0원, PC 꺼져도 동작)
1. 현재 폴더 코드를 본인의 **GitHub 저장소**로 푸시합니다.
2. GitHub 저장소의 **Settings ➡️ Secrets and variables ➡️ Actions** 메뉴로 이동합니다.
3. **New repository secret** 버튼을 눌러 아래 시크릿들을 등록합니다:
   - `SUPABASE_URL`: `https://hevkkauplkjfdwqjppmy.supabase.co`
   - `SUPABASE_SERVICE_ROLE_KEY` 또는 `SUPABASE_ANON_KEY`: `sb_publishable_CuWc_mAtXO2r7gxofe94Lg_E6Apy02A`
   - `VAPID_PRIVATE_KEY`: `PBSoenIWJRdlY2YSY3lSsiFV43WGHdaRh6MRMz9094c`
   - `VAPID_CLAIMS_SUB`: `mailto:admin@example.com`
4. 이제 **매시간 정각마다 GitHub Actions가 자동으로 깨어나** 등록된 사용자의 네이버 예약 빈자리를 감시하고 스마트폰으로 푸시 알림을 발송합니다.


---

### 3단계: GitHub Actions 자동 스케줄러 활성화
1. GitHub 저장소의 **Settings ➡️ Secrets and variables ➡️ Actions** 메뉴로 이동합니다.
2. **New repository secret** 버튼을 눌러 아래 시크릿들을 등록합니다:
   - `SUPABASE_URL`: (Supabase Project URL)
   - `SUPABASE_SERVICE_ROLE_KEY`: (Supabase service_role secret key)
   - `VAPID_PRIVATE_KEY`: `PBSoenIWJRdlY2YSY3lSsiFV43WGHdaRh6MRMz9094c`
   - `VAPID_CLAIMS_SUB`: `mailto:admin@example.com`
3. 이제 **매시간 정각마다 GitHub Actions가 자동으로 깨어나** 등록된 모든 사용자의 네이버 예약 빈자리를 확인하고, 빈자리가 난 사람의 스마트폰으로만 푸시 알림을 발송합니다!

---

## 📱 스마트폰 사용 방법

### 안드로이드 (Galaxy 등)
1. 배포된 Vercel 웹사이트 링크를 크롬이나 삼성인터넷으로 엽니다.
2. 상단의 **[🔔 알림 켜기]**를 눌러 푸시 권한을 허용합니다.
3. 원하는 네이버 예약 페이지 링크를 붙여넣고 **[+ 예약 모니터링 추가]**를 누릅니다.
4. (선택) 브라우저 메뉴에서 **[홈 화면에 추가]**를 누르면 스마트폰 앱처럼 설치됩니다.

### 아이폰 (iPhone / iOS 16.4 이상)
1. 배포된 웹사이트 링크를 **사파리(Safari)**로 엽니다.
2. 하단 중앙의 **공유 버튼(사각형 위 화살표)**을 누릅니다.
3. 메뉴에서 **[홈 화면에 추가]**를 누릅니다.
4. 홈 화면에 생성된 **"예약알리미" 아이콘을 터치하여 실행**합니다.
5. 상단의 **[🔔 알림 켜기]**를 누르면 이제 앱스토어 앱과 똑같이 **아이폰 잠금화면에 푸시 알림**이 도착합니다!
