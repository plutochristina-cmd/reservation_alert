-- =========================================================================
-- 네이버 예약 감지 봇: Supabase DB 스키마 및 보안 RPC 함수 (supabase_schema.sql)
-- Supabase 대시보드 -> SQL Editor에 붙여넣고 [RUN]을 누르면 즉시 생성됩니다.
-- =========================================================================

-- 1. 기기 테이블 (기기 비밀키의 SHA-256 해시값과 Web Push 구독 정보만 저장)
CREATE TABLE IF NOT EXISTS public.devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    secret_hash TEXT NOT NULL UNIQUE,       -- SHA-256(device_secret) 단방향 해시값
    push_subscription JSONB,                -- Web Push 브라우저 수신 토큰
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- 2. 예약 모니터링 목록 테이블
CREATE TABLE IF NOT EXISTS public.reservations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id UUID NOT NULL REFERENCES public.devices(id) ON DELETE CASCADE,
    naver_url TEXT NOT NULL,
    business_type_id INT NOT NULL,
    business_id TEXT NOT NULL,
    biz_item_id TEXT NOT NULL,
    biz_name TEXT NOT NULL,
    item_name TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    last_slots JSONB DEFAULT '[]'::jsonb,   -- 마지막 감지된 상위 3개 슬롯
    start_date DATE,                        -- 감시 시작 희망일 (선택, 기본: 현재 시점)
    end_date DATE,                          -- 감시 종료 희망일 (선택, 기본: +365일)
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- 인덱스 생성
CREATE INDEX IF NOT EXISTS idx_devices_secret_hash ON public.devices(secret_hash);
CREATE INDEX IF NOT EXISTS idx_reservations_device_id ON public.reservations(device_id);
CREATE INDEX IF NOT EXISTS idx_reservations_is_active ON public.reservations(is_active);

-- =========================================================================
-- 보안 RPC 함수 (SHA-256 해시 기반 무로그인 인증)
-- 각 사용자는 자신의 secret_hash와 일치하는 데이터만 접근 가능 (타인 간섭 100% 차단)
-- =========================================================================

-- (1) 기기 등록 및 Web Push 구독 갱신
CREATE OR REPLACE FUNCTION register_device(
    p_secret_hash TEXT,
    p_push_subscription JSONB DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_device_id UUID;
BEGIN
    INSERT INTO public.devices (secret_hash, push_subscription, updated_at)
    VALUES (p_secret_hash, p_push_subscription, now())
    ON CONFLICT (secret_hash)
    DO UPDATE SET
        push_subscription = COALESCE(p_push_subscription, devices.push_subscription),
        updated_at = now()
    RETURNING id INTO v_device_id;

    RETURN v_device_id;
END;
$$;

-- (2) 내 예약 목록 조회 (내 해시값과 일치하는 데이터만 반환)
CREATE OR REPLACE FUNCTION get_my_reservations(p_secret_hash TEXT)
RETURNS TABLE (
    id UUID,
    naver_url TEXT,
    business_type_id INT,
    business_id TEXT,
    biz_item_id TEXT,
    biz_name TEXT,
    item_name TEXT,
    is_active BOOLEAN,
    last_slots JSONB,
    created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        r.id,
        r.naver_url,
        r.business_type_id,
        r.business_id,
        r.biz_item_id,
        r.biz_name,
        r.item_name,
        r.is_active,
        r.last_slots,
        r.created_at
    FROM public.reservations r
    JOIN public.devices d ON r.device_id = d.id
    WHERE d.secret_hash = p_secret_hash
    ORDER BY r.created_at DESC;
END;
$$;

-- (3) 새 예약 등록
CREATE OR REPLACE FUNCTION add_reservation(
    p_secret_hash TEXT,
    p_naver_url TEXT,
    p_business_type_id INT,
    p_business_id TEXT,
    p_biz_item_id TEXT,
    p_biz_name TEXT,
    p_item_name TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_device_id UUID;
    v_res_id UUID;
BEGIN
    -- 기기 확인 또는 자동 등록
    SELECT id INTO v_device_id FROM public.devices WHERE secret_hash = p_secret_hash;
    IF v_device_id IS NULL THEN
        INSERT INTO public.devices (secret_hash) VALUES (p_secret_hash) RETURNING id INTO v_device_id;
    END IF;

    -- 예약 추가
    INSERT INTO public.reservations (
        device_id,
        naver_url,
        business_type_id,
        business_id,
        biz_item_id,
        biz_name,
        item_name,
        is_active
    ) VALUES (
        v_device_id,
        p_naver_url,
        p_business_type_id,
        p_business_id,
        p_biz_item_id,
        p_biz_name,
        p_item_name,
        true
    ) RETURNING id INTO v_res_id;

    RETURN v_res_id;
END;
$$;

-- (4) 예약 활성/비활성 토글 (본인 소유 검증)
CREATE OR REPLACE FUNCTION toggle_reservation(
    p_secret_hash TEXT,
    p_reservation_id UUID,
    p_is_active BOOLEAN
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    UPDATE public.reservations r
    SET is_active = p_is_active, updated_at = now()
    FROM public.devices d
    WHERE r.device_id = d.id
      AND r.id = p_reservation_id
      AND d.secret_hash = p_secret_hash;

    RETURN FOUND;
END;
$$;

-- (5) 예약 삭제 (본인 소유 검증)
CREATE OR REPLACE FUNCTION delete_reservation(
    p_secret_hash TEXT,
    p_reservation_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    DELETE FROM public.reservations r
    USING public.devices d
    WHERE r.device_id = d.id
      AND r.id = p_reservation_id
      AND d.secret_hash = p_secret_hash;

    RETURN FOUND;
END;
$$;

-- =========================================================================
-- (6) 클라우드 무인 크론 자동 트리거 (pg_cron + pg_net)
-- 매시 22분, 39분마다 Vercel 서버리스 크론(/api/cron)을 오차 없이 호출합니다.
-- =========================================================================
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'vercel-reservation-cron-22-39') THEN
        PERFORM cron.unschedule('vercel-reservation-cron-22-39');
    END IF;
EXCEPTION WHEN OTHERS THEN
    NULL;
END $$;

SELECT cron.schedule(
    'vercel-reservation-cron-22-39',
    '22,39 * * * *',
    $$SELECT net.http_get('https://naver-reserve-alert.vercel.app/api/cron');$$
);
