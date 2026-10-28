# 프로젝트 필수 규칙 및 아키텍처 가이드 (GEMINI.md)

이 파일은 Git 저장소에 포함되어 있으므로 어느 PC에서 접속하든 AI 에이전트가 항상 자동으로 읽고 준수합니다.

## 1. Supabase 보안 및 권한 정책 (2026년 10월 30일 정책 변경 완벽 대응)
1. **신규 테이블 생성 시 명시적 GRANT 필수 (2026-10-30 Supabase 정책 변경 반영)**
   - 2026년 10월 30일부터 Supabase는 `public` 스키마에 새로 생성되는 테이블에 대해 `anon`, `authenticated`, `service_role` 권한(GRANT)을 자동으로 부여하지 않습니다.
   - 따라서 새로운 테이블이나 뷰, 함수를 추가하거나 마이그레이션(`supabase_schema.sql`)을 작성할 때는 반드시 아래 `GRANT` 문을 함께 명시해야 합니다:
     - RLS + `SECURITY DEFINER` RPC 전용 테이블인 경우:
       ```sql
       ALTER TABLE public.<table_name> ENABLE ROW LEVEL SECURITY;
       GRANT ALL ON TABLE public.<table_name> TO postgres, service_role;
       ```
     - 클라이언트 Data API 직접 접근이 필요한 테이블인 경우(반드시 RLS 정책과 함께):
       ```sql
       ALTER TABLE public.<table_name> ENABLE ROW LEVEL SECURITY;
       GRANT SELECT ON TABLE public.<table_name> TO anon;
       GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.<table_name> TO authenticated;
       GRANT ALL ON TABLE public.<table_name> TO service_role;
       ```
     - 보안 RPC 함수(`SECURITY DEFINER`) 생성 시:
       ```sql
       GRANT EXECUTE ON FUNCTION public.<function_name>(...) TO anon, authenticated, service_role;
       ```
2. **RLS(Row-Level Security) 항상 활성화 유지**
   - `public.devices`, `public.reservations` 및 향후 추가되는 모든 테이블은 `ENABLE ROW LEVEL SECURITY`를 유지합니다.
   - 모든 함수(`SECURITY DEFINER`)에는 `SET search_path = public`을 명시합니다.

## 2. 스케줄러 및 타임존 규칙
1. **타임존 (`+09:00` KST)**
   - DB(`TIMESTAMPTZ`)에 시각(`updated_at` 등)을 저장할 때는 반드시 타임존 오프셋(`+09:00`)이 포함된 ISO-8601 문자열(`datetime.now(KST).isoformat()`)을 사용합니다.
2. **스케줄러 주기 (`37 * * * *` 전체 스캔 + `* * * * *` 원격 웨이팅 조건부 1분 스캔)**
   - **전체 예약 스캔:** 클라우드 크론(Supabase `pg_cron`, GitHub Actions `check.yml`)은 트래픽이 몰리는 정각/30분/5분 배수를 피해 소수 단위인 **매시 37분(`37 * * * *`)** 1시간 1회 주기로 동작합니다 (`https://naver-reserve-alert.vercel.app/api/cron`).
   - **캐치테이블 원격 웨이팅 전용 1분 스캔:** 원격 웨이팅(`business_type_id = 88`, `biz_item_id LIKE 'waiting%'`)은 실시간성이 중요하므로 웹 앱 실행 중 1분 타이머(방법 A) 및 Supabase `pg_cron`의 `public.trigger_waiting_cron_if_active()` 함수(`* * * * *`, 활성 원격 웨이팅이 DB에 존재할 때만 `https://naver-reserve-alert.vercel.app/api/cron?only=waiting` 호출, 방법 B)로 1분 간격 감시를 수행합니다.
3. **배포 전 검증 필수 및 타 PC 이관용 파일(ZIP/메일 본문) 점검**
   - 수정 사항 배포 시 반드시 `python deploy.py` (`node test_regression.js` 포함)를 실행하여 전수 테스트를 통과한 후 배포합니다.
   - 작업 완료 시마다 메일에 첨부한 ZIP 파일(`other_pc_setup.zip` / `.env`) 및 메일 본문(`OTHER_PC_GUIDE.md`)의 보완 필요 여부를 항상 함께 확인하여 안내합니다.
