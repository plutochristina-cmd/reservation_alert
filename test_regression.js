/**
 * =========================================================================
 * 사전 검증 및 자동 리그레션 테스트 슈트 (test_regression.js)
 * 배포 전 필수 실행: 문법, DOM 초기화, API 라우트, 스케줄러를 전수 검증합니다.
 * =========================================================================
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

let passedTests = 0;
let failedTests = 0;

function assert(condition, testName) {
  if (condition) {
    console.log(`  ✅ [PASS] ${testName}`);
    passedTests++;
  } else {
    console.error(`  ❌ [FAIL] ${testName}`);
    failedTests++;
  }
}

async function runAllTests() {
  console.log("==================================================");
  console.log("🚀 [리그레션 테스트 시작] 배포 전 자동 전수 검증");
  console.log("==================================================");

  // -------------------------------------------------------------------------
  // 1. 자바스크립트 문법 구문 검증 (Syntax Check)
  // -------------------------------------------------------------------------
  console.log("\n[1/4] JS 파일 문법 구문 검사 (node -c)...");
  const jsFiles = [
    'public/app.js',
    'public/sw.js',
    'public/api/items.js',
    'public/api/search.js',
    'public/api/nol.js',
    'public/api/slots.js',
    'public/api/schedule.js'
  ];

  for (const f of jsFiles) {
    try {
      const fullPath = path.resolve(__dirname, f);
      if (fs.existsSync(fullPath)) {
        execSync(`node -c "${fullPath}"`, { stdio: 'pipe' });
        assert(true, `${f} 문법 검사 통과 (구문 오류 없음)`);
      } else {
        assert(false, `${f} 파일이 존재하지 않음`);
      }
    } catch (e) {
      assert(false, `${f} 구문 오류(SyntaxError) 발견: ${e.message}`);
    }
  }

  // -------------------------------------------------------------------------
  // 2. 파이썬 스케줄러 및 서버리스 문법 검증 (Python Syntax Check)
  // -------------------------------------------------------------------------
  console.log("\n[2/4] 파이썬 스케줄러 및 서버리스 구문 검사 (python -m py_compile)...");
  try {
    execSync('python -m py_compile scheduler.py', { stdio: 'pipe' });
    assert(true, "scheduler.py 컴파일 및 문법 검사 통과");
    execSync('python -m py_compile public/api/catchtable.py', { stdio: 'pipe' });
    assert(true, "public/api/catchtable.py 컴파일 및 문법 검사 통과");
    execSync('python -m py_compile public/api/cron.py', { stdio: 'pipe' });
    assert(true, "public/api/cron.py (Vercel Cron 엔드포인트) 컴파일 및 문법 검사 통과");
    const tzAndVaultCheck = execSync(
      'python -c "import os, vault, scheduler; os.environ[\'TEST_EMPTY_ENV\']=\'\'; assert vault.get_secret(\'TEST_EMPTY_ENV\', \'fallback_ok\') == \'fallback_ok\'; assert \'+09:00\' in scheduler.get_now_kst_iso(); print(\'OK\')"',
      { encoding: 'utf-8' }
    ).trim();
    assert(tzAndVaultCheck === 'OK', "vault 빈 환경변수 폴백 방어 및 scheduler KST(+09:00) ISO 타임스탬프 검증 통과");

    const deadlineFilterCheck = execSync(
      'python -c "from datetime import datetime; import scheduler; now = datetime(2026, 10, 28, 10, 4, 0); rules = {\'business\': {\'bookingAvailableCode\': \'RI03\', \'bookingAvailableValue\': 1, \'bookingTimeUnitCode\': \'RT01\'}, \'bizItem\': {\'minBookingCount\': 1}}; raw = [{\'unitStartTime\': \'2026-10-28 10:30:00\', \'isBusinessDay\': True, \'isUnitBusinessDay\': True, \'isSaleDay\': True, \'isUnitSaleDay\': True, \'unitStock\': 1, \'unitBookingCount\': 0}, {\'unitStartTime\': \'2026-10-28 11:00:00\', \'isBusinessDay\': True, \'isUnitBusinessDay\': True, \'isSaleDay\': True, \'isUnitSaleDay\': True, \'unitStock\': 1, \'unitBookingCount\': 0}, {\'unitStartTime\': \'2026-10-28 11:30:00\', \'isBusinessDay\': True, \'isUnitBusinessDay\': True, \'isSaleDay\': True, \'isUnitSaleDay\': True, \'unitStock\': 1, \'unitBookingCount\': 0}]; res = scheduler.filter_naver_hourly_slots(raw, now, rules, safety_buffer_minutes=5); assert [r[\'datetime_str\'] for r in res] == [\'2026-10-28 11:30:00\']; now2 = datetime(2026, 10, 28, 10, 56, 0); raw2 = [{\'unitStartTime\': \'2026-10-28 12:00:00\', \'isBusinessDay\': True, \'isUnitBusinessDay\': True, \'isSaleDay\': True, \'isUnitSaleDay\': True, \'unitStock\': 1, \'unitBookingCount\': 0}, {\'unitStartTime\': \'2026-10-28 12:30:00\', \'isBusinessDay\': True, \'isUnitBusinessDay\': True, \'isSaleDay\': True, \'isUnitSaleDay\': True, \'unitStock\': 1, \'unitBookingCount\': 0}]; res2 = scheduler.filter_naver_hourly_slots(raw2, now2, rules, safety_buffer_minutes=5); assert [r[\'datetime_str\'] for r in res2] == [\'2026-10-28 12:30:00\']; print(\'FILTER_OK\')"',
      { encoding: 'utf-8' }
    ).trim();
    assert(deadlineFilterCheck === 'FILTER_OK', "네이버 매장별 마감 규칙(RI03 1시간 전 마감) + 5분 안전 버퍼(10:04 -> 10:30/11:00 제외, 10:56 -> 12:00 제외) 검증 통과");

    const ctWaitingCheck = execSync(
      'python -c "import scheduler; s1 = scheduler.parse_catchtable_waiting_spec(\'waiting:hall:2\'); assert s1[\'is_waiting\'] and s1[\'scope\']==\'hall\' and s1[\'min_teams\']==2; mock_under = {\'tableStatus\': {\'totalTeamCount\': 1, \'operationInfo\': {\'isWaitingAvailable\': False, \'waitingDisabledReason\': \'UNDER_AVAILABLE_TEAMS\', \'possibleWaitingAtLeastCount\': 2}, \'tableCurrentStatus\': [{\'tableName\': \'매장 식사\', \'isTakeOut\': False, \'tableOperationStatus\': \'OPEN\', \'teamCount\': 1}]}}; r1 = scheduler.evaluate_catchtable_waiting_data(mock_under, \'hall\', 2); assert not r1[\'is_open\']; mock_open = {\'tableStatus\': {\'totalTeamCount\': 3, \'operationInfo\': {\'isWaitingAvailable\': True, \'waitingDisabledReason\': None, \'possibleWaitingAtLeastCount\': 2}, \'tableCurrentStatus\': [{\'tableName\': \'매장 식사\', \'isTakeOut\': False, \'tableOperationStatus\': \'OPEN\', \'teamCount\': 2}, {\'tableName\': \'포장\', \'isTakeOut\': True, \'tableOperationStatus\': \'OPEN\', \'teamCount\': 1}]}}; r2 = scheduler.evaluate_catchtable_waiting_data(mock_open, \'hall\', 2); assert r2[\'is_open\'] and r2[\'hall_teams\']==2; print(\'WAITING_OK\')"',
      { encoding: 'utf-8' }
    ).trim();
    assert(ctWaitingCheck === 'WAITING_OK', "캐치테이블 원격 웨이팅(홀 2팀 이상 조건 달성 및 UNDER_AVAILABLE_TEAMS 차단) 판별 로직 검증 통과");
  } catch (e) {
    assert(false, `파이썬 구문 오류: ${e.message}`);
  }

  // -------------------------------------------------------------------------
  // 3. Mock DOM 환경 초기화 & 이벤트 리스너 바인딩 테스트
  // -------------------------------------------------------------------------
  console.log("\n[3/4] DOM 로딩 및 이벤트 리스너 등록 테스트 (클릭 무반응 방지)...");
  try {
    global.window = {
      crypto: {
        getRandomValues: (arr) => arr.fill(1),
        subtle: {
          digest: async () => new Uint8Array(16).buffer
        }
      },
      navigator: {
        userAgent: "Mozilla/5.0",
        serviceWorker: {
          register: async () => ({
            pushManager: { getSubscription: async () => null }
          })
        }
      },
      location: { origin: "http://localhost", search: "" },
      matchMedia: () => ({ matches: false }),
      history: { replaceState: () => {} },
      addEventListener: () => {}
    };
    global.navigator = global.window.navigator;
    global.localStorage = { getItem: () => null, setItem: () => {} };
    const OriginalTextEncoder = global.TextEncoder;
    global.TextEncoder = OriginalTextEncoder || class { encode() { return new Uint8Array([1]); } };
    global.Notification = { permission: "default", requestPermission: async () => "granted" };

    const elements = {};
    const listeners = {};
    function mockElement(id) {
      return {
        id,
        style: {},
        classList: { add: () => {}, remove: () => {}, contains: () => false },
        addEventListener: (event, handler) => {
          listeners[`${id}:${event}`] = handler;
        },
        querySelector: () => mockElement("child"),
        querySelectorAll: () => [],
        appendChild: () => {},
        setAttribute: () => {},
        getAttribute: () => null
      };
    }

    let domLoadedHandler = null;
    global.document = {
      getElementById: (id) => elements[id] || (elements[id] = mockElement(id)),
      createElement: (tag) => mockElement(tag),
      querySelectorAll: () => [],
      addEventListener: (event, cb) => {
        if (event === "DOMContentLoaded") domLoadedHandler = cb;
      }
    };

    // app.js 로드 및 DOMContentLoaded 트리거
    delete require.cache[path.resolve(__dirname, 'public/app.js')];
    require('./public/app.js');

    assert(typeof domLoadedHandler === 'function', "DOMContentLoaded 핸들러 등록 확인");
    await domLoadedHandler();

    // 필수 버튼 리스너 바인딩 확인
    assert(typeof listeners["btn-toggle-push:click"] === 'function', "알림 켜기 버튼(btn-toggle-push) 클릭 리스너 정상 바인딩");
    assert(typeof listeners["btn-submit-search:click"] === 'function', "검색 예약 추가 버튼(btn-submit-search) 클릭 리스너 정상 바인딩");
    assert(typeof listeners["btn-submit:click"] === 'function', "URL 예약 추가 버튼(btn-submit) 클릭 리스너 정상 바인딩");
    assert(typeof listeners["tab-search:click"] === 'function', "검색 탭 버튼(tab-search) 클릭 리스너 정상 바인딩");
    assert(typeof listeners["tab-ct:click"] === 'function', "캐치테이블 탭 버튼(tab-ct) 클릭 리스너 정상 바인딩");
    assert(typeof listeners["tab-nol:click"] === 'function', "놀티켓 탭 버튼(tab-nol) 클릭 리스너 정상 바인딩");
    assert(typeof listeners["tab-url:click"] === 'function', "URL 탭 버튼(tab-url) 클릭 리스너 정상 바인딩");
    assert(typeof listeners["ct-search-input:input"] === 'function', "캐치테이블 검색 입력창(ct-search-input) 리스너 정상 바인딩");
    assert(typeof listeners["btn-clear-ct-search:click"] === 'function', "캐치테이블 검색어 삭제(btn-clear-ct-search) 리스너 정상 바인딩");
    assert(typeof listeners["btn-ct-reselect:click"] === 'function', "캐치테이블 다시 검색(btn-ct-reselect) 리스너 정상 바인딩");
    assert(typeof listeners["btn-submit-ct:click"] === 'function', "캐치테이블 모니터링 추가(btn-submit-ct) 리스너 정상 바인딩");
    assert(typeof listeners["nol-search-input:input"] === 'function', "놀티켓 실시간 검색 입력창(nol-search-input) 리스너 정상 바인딩");
    assert(typeof listeners["btn-clear-nol-search:click"] === 'function', "놀티켓 검색어 삭제 버튼(btn-clear-nol-search) 리스너 정상 바인딩");
    assert(typeof listeners["btn-nol-reselect:click"] === 'function', "놀티켓 다시 검색 버튼(btn-nol-reselect) 리스너 정상 바인딩");
    assert(typeof listeners["btn-submit-nol:click"] === 'function', "놀티켓 모니터링 추가 버튼(btn-submit-nol) 클릭 리스너 정상 바인딩");
    assert(typeof listeners["btn-share-dismiss:click"] === 'function', "공유 감시 배너 닫기 버튼(btn-share-dismiss) 리스너 정상 바인딩");
    assert(typeof listeners["btn-share-apply:click"] === 'function', "공유 감시 배너 적용 버튼(btn-share-apply) 리스너 정상 바인딩");
  } catch (err) {
    assert(false, `DOM 초기화 런타임 오류 발생: ${err.message}`);
  } finally {
    delete global.window;
    delete global.document;
    delete global.navigator;
    delete global.Notification;
    delete global.localStorage;
  }

  // -------------------------------------------------------------------------
  // 4. API 서버리스 함수 통합 기능 검증 (Place 역추적, Slots API, 놀티켓 API)
  // -------------------------------------------------------------------------
  console.log("\n[4/4] API 엔드포인트 비즈니스 로직 검증...");

  // (1) 프롭비한의원 Place ID -> 2명 원장님 역추적 검증
  try {
    const itemsHandler = require('./public/api/items.js');
    let itemsResult = null;
    await new Promise((resolve) => {
      const req = { query: { businessId: '1480163218' }, method: 'GET' };
      const res = {
        setHeader: () => {},
        status: () => ({
          json: (data) => { itemsResult = data; resolve(); }
        })
      };
      itemsHandler(req, res);
    });

    const isResolvedBiz = itemsResult && itemsResult.businessId === '587100';
    const hasBothDoctors = itemsResult && itemsResult.items.length === 2 &&
      itemsResult.items.some(d => d.name.includes("김민희")) &&
      itemsResult.items.some(d => d.name.includes("장정현"));

    assert(isResolvedBiz, "프롭비한의원 Place ID(1480163218) -> 예약 비즈니스 ID(587100) 자동 변환 성공");
    assert(hasBothDoctors, `프롭비한의원 두 분의 원장님(김민희진료원장, 장정현대표원장) 목록 정상 추출 (${itemsResult?.items?.length}명)`);

    let lucyResult = null;
    await new Promise((resolve) => {
      const req = { query: { businessId: '2008574666' }, method: 'GET' };
      const res = {
        setHeader: () => {},
        status: () => ({
          json: (data) => { lucyResult = data; resolve(); }
        })
      };
      itemsHandler(req, res);
    });
    assert(lucyResult && lucyResult.businessId === '1474503' && lucyResult.items?.some(i => i.id === '6971667'), "루시타로&사주 Place ID(2008574666) -> 예약 비즈니스 ID(1474503) 및 대표 루시쌤(6971667) 역추적 성공");
  } catch (err) {
    assert(false, `items.js API 테스트 중 오류: ${err.message}`);
  }

  // (2) 슬롯 실시간 스캔 API (slots.js - 지금 확인 버튼 연동) 검증
  try {
    const slotsHandler = require('./public/api/slots.js');
    let slotsResult = null;
    await new Promise((resolve) => {
      const req = { query: { businessId: '587100', bizItemId: '4102569', businessTypeId: '13' }, method: 'GET' };
      const res = {
        setHeader: () => {},
        status: () => ({
          json: (data) => { slotsResult = data; resolve(); }
        })
      };
      slotsHandler(req, res);
    });

    const hasSlotResponse = slotsResult && typeof slotsResult.totalAvailable === 'number' && slotsResult.totalAvailable > 0;
    assert(hasSlotResponse, `네이버 슬롯 실시간 조회(slots.js) 정상 검출 확인 (프롭비 장정현원장 잔여석: ${slotsResult?.totalAvailable}개 발견)`);
  } catch (err) {
    assert(false, `slots.js API 테스트 중 오류: ${err.message}`);
  }

  // (2-1) 광고차단기 우회용 schedule.js 별칭 API 검증
  try {
    const scheduleHandler = require('./public/api/schedule.js');
    let schedResult = null;
    await new Promise((resolve) => {
      const req = { query: { businessId: '587100', bizItemId: '4102569', businessTypeId: '13' }, method: 'GET' };
      const res = {
        setHeader: () => {},
        status: () => ({
          json: (data) => { schedResult = data; resolve(); }
        })
      };
      scheduleHandler(req, res);
    });

    const hasSchedResponse = schedResult && typeof schedResult.totalAvailable === 'number' && schedResult.totalAvailable > 0;
    assert(hasSchedResponse, `광고차단기 우회용 schedule.js 엔드포인트 정상 응답 및 잔여석 검출 확인 (${schedResult?.totalAvailable}개)`);
  } catch (err) {
    assert(false, `schedule.js API 테스트 중 오류: ${err.message}`);
  }

  // (2-2) 클라이언트 직접 CORS 호출 방지 및 중복 함수 선언 방지 검증
  try {
    const appJsContent = fs.readFileSync(path.resolve(__dirname, 'public/app.js'), 'utf-8');
    const hasClientDirectGraphql = appJsContent.includes('fetch("https://booking.naver.com/graphql"') ||
                                   appJsContent.includes("fetch('https://booking.naver.com/graphql'");
    assert(!hasClientDirectGraphql, "public/app.js 내 브라우저 직접 네이버 GraphQL 호출 제거 검증 (CORS 에러 원천 차단)");

    const checkSlotsMatches = appJsContent.match(/async\s+function\s+checkNaverSlotsLive/g) || [];
    assert(checkSlotsMatches.length === 1, `checkNaverSlotsLive 함수 단일 선언 검증 (현재 ${checkSlotsMatches.length}개 발견)`);

    const indexHtmlContent = fs.readFileSync(path.resolve(__dirname, 'public/index.html'), 'utf-8');
    const hasRefreshCycleInHtml = indexHtmlContent.includes("1시간 주기");
    assert(hasRefreshCycleInHtml, "웹 화면(index.html) 알람 갱신 주기(1시간 주기) 정상 표기 검증");

    const hasRefreshCycleInApp = appJsContent.includes("1시간 주기");
    assert(hasRefreshCycleInApp, "예약 카드(app.js) 알람 갱신 주기(1시간 주기) 정상 표기 검증");

    const hasWaitingFastCycleInApp = appJsContent.includes("1분 주기 초고속 감시 중") && appJsContent.includes("/api/cron?only=waiting");
    assert(hasWaitingFastCycleInApp, "원격 웨이팅 전용 1분 주기 초고속 감시(방법 A + 방법 B only=waiting 연동) 검증");
  } catch (err) {
    assert(false, `클라이언트 정적 분석 중 오류: ${err.message}`);
  }

  // (3) 놀티켓 실시간 공연 키워드 검색 API 검증
  try {
    const nolHandler = require('./public/api/nol.js');
    let searchResult = null;
    await new Promise((resolve) => {
      const req = { query: { q: '다이나믹' }, method: 'GET' };
      const res = {
        setHeader: () => {},
        status: () => ({
          json: (data) => { searchResult = data; resolve(); }
        })
      };
      nolHandler(req, res);
    });

    const hasDynamic = searchResult && searchResult.results?.length > 0 &&
      searchResult.results.some(r => r.title.includes("다이나믹"));
    assert(hasDynamic, "놀티켓 실시간 공연 키워드 검색('다이나믹') 결과 정상 매칭");
  } catch (err) {
    assert(false, `nol.js 검색 API 테스트 중 오류: ${err.message}`);
  }

  // (4) 놀티켓 콘서트 상세 조회 및 회차별 잔여석 검증
  try {
    const nolHandler = require('./public/api/nol.js');
    let nolResult = null;
    await new Promise((resolve) => {
      const req = { query: { goodsCode: '26013810' }, method: 'GET' };
      const res = {
        setHeader: () => {},
        status: () => ({
          json: (data) => { nolResult = data; resolve(); }
        })
      };
      nolHandler(req, res);
    });

    const hasGoodsName = nolResult && nolResult.goodsName.includes("다이나믹 듀오");
    const hasThreeSessions = nolResult && nolResult.sessions.length === 3;

    assert(hasGoodsName, "놀티켓 다이나믹 듀오 콘서트 공연명 정상 조회");
    assert(hasThreeSessions, `놀티켓 다이나믹 듀오 콘서트 3개 회차(11/27, 11/28, 11/29) 정상 추출 (${nolResult?.sessions?.length}회차)`);
    assert(Array.isArray(nolResult?.casts), "놀티켓 출연진(캐스트) 추출 필드(casts) 정상 반환 확인");
  } catch (err) {
    assert(false, `nol.js API 테스트 중 오류: ${err.message}`);
  }

  // (5) PWA Web Share Target manifest.json 검증
  try {
    const manifestPath = path.resolve(__dirname, 'public/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const hasShareTarget = manifest && manifest.share_target &&
      manifest.share_target.action === '/' &&
      manifest.share_target.params &&
      manifest.share_target.params.url === 'url';
    assert(hasShareTarget, "PWA Web Share Target(공유하기 연계) manifest.json 설정 정상 검증");
  } catch (err) {
    assert(false, `manifest.json 파싱 오류: ${err.message}`);
  }

  console.log("\n==================================================");
  if (failedTests === 0) {
    console.log(`🎉 [모든 검증 완료] 총 ${passedTests}개 항목 통과! 배포 가능한 안전한 상태입니다.`);
    console.log("==================================================");
    process.exit(0);
  } else {
    console.error(`🚨 [검증 실패] ${failedTests}개 항목 오류 발생! 배포가 중단되어야 합니다.`);
    console.log("==================================================");
    process.exit(1);
  }
}

runAllTests();
