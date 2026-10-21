// =========================================================================
// 네이버 예약 알리미 - 클라이언트 앱 로직 (public/app.js)
// SHA-256 단방향 암호화 인증, Web Push 매니저, 네이버 URL 동적 파서
// =========================================================================

// VAPID 공개키 (Web Push 표준)
const VAPID_PUBLIC_KEY = "BAs4Ci--YpiZP6eCpNdqOmIEWZ2OMev-7azeI-kdoTjBlA_dkkfV-rb9xHP2XOisewsPMo6wZpEFKz5qHEa8c54";

// Supabase 연동 설정
const SUPABASE_URL = "https://hevkkauplkjfdwqjppmy.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_CuWc_mAtXO2r7gxofe94Lg_E6Apy02A";

// API 기본 주소 (file:// 또는 로컬호스트 실행 시 Vercel 프로덕션 API로 자동 연결)
const API_BASE_URL = (typeof window !== "undefined" && window.location && (window.location.protocol === "file:" || window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"))
  ? "https://naver-reserve-alert.vercel.app"
  : "";


let deviceSecret = "";
let deviceSecretHash = "";
let swRegistration = null;
let currentPushSubscription = null;
let parsedCurrentTarget = null;

// =========================================================================
// 1. SHA-256 단방향 해시 기기 식별 엔진 (WebCrypto)
// =========================================================================

async function initDeviceIdentity() {
  // 1) 기기 비밀키 로드 또는 생성 (64자리 난수)
  deviceSecret = localStorage.getItem("naver_device_secret");
  if (!deviceSecret) {
    const array = new Uint8Array(32);
    window.crypto.getRandomValues(array);
    deviceSecret = Array.from(array, b => b.toString(16).padStart(2, "0")).join("");
    localStorage.setItem("naver_device_secret", deviceSecret);
  }

  // 2) 브라우저 내부에서 SHA-256 해시 계산 (원본 비밀키는 외부 노출 안 됨)
  const encoder = new TextEncoder();
  const data = encoder.encode(deviceSecret);
  const hashBuffer = await window.crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  deviceSecretHash = hashArray.map(b => b.toString(16).padStart(2, "0")).join("");

  console.log("🔒 [보안 엔진 가동] 기기 식별 해시(SHA-256):", deviceSecretHash.slice(0, 12) + "...");
}

// =========================================================================
// 2. Web Push 및 서비스 워커 매니저 (안드로이드 & 아이폰 iOS 16.4+ 호환)
// =========================================================================

async function initServiceWorker() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    console.warn("이 브라우저는 Web Push를 지원하지 않습니다.");
    updatePushUI("unsupported");
    return;
  }

  try {
    swRegistration = await navigator.serviceWorker.register("/sw.js");
    console.log("✅ 서비스 워커 등록 완료");

    // 기존 푸시 구독 여부 확인
    currentPushSubscription = await swRegistration.pushManager.getSubscription();
    if (currentPushSubscription) {
      updatePushUI("granted");
      syncPushSubscriptionWithServer(currentPushSubscription);
    } else if (Notification.permission === "granted") {
      updatePushUI("granted");
    } else if (Notification.permission === "denied") {
      updatePushUI("denied");
    } else {
      updatePushUI("prompt");
    }
  } catch (error) {
    console.error("서비스 워커 등록 실패:", error);
  }
}

function urlB64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/\-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

async function requestPushPermission() {
  if (!swRegistration) {
    showToast("⚠️ 서비스 워커가 준비되지 않았습니다.");
    return;
  }

  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      showToast("❌ 푸시 알림 권한이 거부되었습니다.");
      updatePushUI("denied");
      return;
    }

    const applicationServerKey = urlB64ToUint8Array(VAPID_PUBLIC_KEY);
    const subscription = await swRegistration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey
    });

    currentPushSubscription = subscription;
    updatePushUI("granted");
    showToast("🔔 푸시 알림이 성공적으로 활성화되었습니다!");

    // Supabase에 익명 구독 토큰 동기화
    await syncPushSubscriptionWithServer(subscription);
  } catch (error) {
    console.error("푸시 알림 구독 실패:", error);
    showToast("❌ 푸시 구독 중 오류가 발생했습니다: " + error.message);
  }
}

function updatePushUI(state) {
  const btn = document.getElementById("btn-toggle-push");
  const textTitle = document.getElementById("push-card-title");
  const textDesc = document.getElementById("push-card-desc");

  if (state === "granted") {
    btn.textContent = "알림 켜짐";
    btn.classList.add("active");
    textTitle.textContent = "푸시 알림 활성화됨";
    textDesc.textContent = "빈자리 발생 시 스마트폰 잠금화면으로 즉시 전송됩니다.";
  } else if (state === "denied") {
    btn.textContent = "권한 차단됨";
    btn.classList.remove("active");
    textTitle.textContent = "푸시 알림이 차단됨";
    textDesc.textContent = "브라우저 설정에서 알림 권한을 허용해 주세요.";
  } else if (state === "unsupported") {
    btn.textContent = "미지원";
    btn.disabled = true;
    textTitle.textContent = "푸시 알림 미지원 브라우저";
    textDesc.textContent = "안드로이드 크롬 또는 아이폰 사파리(홈 화면 추가)를 이용하세요.";
  } else {
    btn.textContent = "알림 켜기";
    btn.classList.remove("active");
    textTitle.textContent = "스마트폰 푸시 알림";
    textDesc.textContent = "빈자리 발생 시 휴대폰 진동/소리로 즉시 알려드립니다.";
  }
}

// =========================================================================
// 3. 통합 예약 URL 동적 파서 & 실시간 미리보기 (네이버 + 놀티켓/인터파크)
// =========================================================================

function parseAnyBookingUrl(urlStr) {
  if (!urlStr) return null;

  // 1) 캐치테이블 식당 (예: https://app.catchtable.co.kr/ct/shop/sushikoji 또는 https://catchtable.co.kr/sushikoji)
  const mCt = urlStr.match(/catchtable\.co\.kr\/(?:ct\/shop\/)?([a-zA-Z0-9_\-]+)/);
  if (mCt) {
    const alias = mCt[1];
    return {
      platform: "catchtable",
      type: 88,
      shopRef: alias,
      businessId: alias,
      bizItemId: "all",
      bizName: "",
      itemName: "전체 예약 일정 (빈자리 감시)"
    };
  }

  // 2) 놀티켓 / 인터파크 티켓 콘서트 (예: https://nol.yanolja.com/ticket/products/26013810)
  const mNol = urlStr.match(/nol\.yanolja\.com\/ticket\/products\/(\d+)/) ||
               urlStr.match(/tickets?\.interpark\.com\/(?:goods\/|contents\/goods\/)?(\d+)/);
  if (mNol) {
    return {
      platform: "nol_ticket",
      type: 99,
      goodsCode: mNol[1],
      businessId: mNol[1],
      bizItemId: "all",
      bizName: "",
      itemName: "전체 회차 (취켓팅)"
    };
  }

  // 3) 네이버 예약: /booking/{type}/bizes/{bizId}/items/{itemId}
  const m1 = urlStr.match(/\/booking\/(\d+)\/bizes\/(\d+)\/items\/(\d+)/);
  if (m1) {
    return {
      platform: "naver",
      type: parseInt(m1[1], 10),
      businessId: m1[2],
      bizItemId: m1[3]
    };
  }

  // 4) 네이버 예약: /booking/{type}/bizes/{bizId} (단일 비즈니스, 상세 항목 미포함)
  const m2 = urlStr.match(/\/booking\/(\d+)\/bizes\/(\d+)/);
  if (m2) {
    return {
      platform: "naver",
      type: parseInt(m2[1], 10),
      businessId: m2[2],
      bizItemId: null
    };
  }

  // 5) 네이버 플레이스: /hospital/{id} 또는 /place/{id}
  const m3 = urlStr.match(/place\.naver\.com\/(?:hospital|place|restaurant)\/(\d+)/);
  if (m3) {
    return {
      platform: "naver",
      type: 13,
      businessId: m3[1],
      bizItemId: null
    };
  }

  return null;
}

async function fetchPreviewInfo(parsed) {
  if (parsed.platform === "catchtable") {
    try {
      const resp = await fetch(`${API_BASE_URL}/api/catchtable?alias=${encodeURIComponent(parsed.shopRef)}`);
      if (resp.ok) {
        const data = await resp.json();
        let slotDates = [];
        const shopRef = data.shopRef || parsed.shopRef;
        if (shopRef) {
          const sResp = await fetch(`${API_BASE_URL}/api/catchtable?shopRef=${encodeURIComponent(shopRef)}&action=slots`);
          if (sResp.ok) {
            const sData = await sResp.json();
            slotDates = sData.availableDates || [];
          }
        }
        return {
          platform: "catchtable",
          bizName: data.shopName || `캐치테이블 (${parsed.shopRef})`,
          address: data.address || "",
          category: data.category || "식당",
          shopRef: shopRef,
          availableDates: slotDates
        };
      }
    } catch (e) {
      console.warn("캐치테이블 정보 조회 실패:", e);
    }
    return {
      platform: "catchtable",
      bizName: `캐치테이블 (${parsed.shopRef})`,
      address: "",
      category: "식당",
      shopRef: parsed.shopRef,
      availableDates: []
    };
  }

  if (parsed.platform === "nol_ticket") {
    try {
      const resp = await fetch(`${API_BASE_URL}/api/nol?goodsCode=${encodeURIComponent(parsed.goodsCode)}`);
      if (resp.ok) {
        const data = await resp.json();
        return {
          platform: "nol_ticket",
          bizName: data.goodsName || `놀티켓 콘서트 (#${parsed.goodsCode})`,
          venue: data.placeName || "공연장",
          casts: data.casts || [],
          sessions: data.sessions || []
        };
      }
    } catch (e) {
      console.warn("놀티켓 정보 조회 실패:", e);
    }
    return {
      platform: "nol_ticket",
      bizName: `놀티켓 콘서트 (#${parsed.goodsCode})`,
      venue: "공연장 정보 확인 중",
      casts: [],
      sessions: []
    };
  }

  // 네이버 예약의 경우: 서버리스 items.js 호출 (클라이언트 직접 GraphQL 호출 시 CORS 차단 방지)
  try {
    const resp = await fetch(`${API_BASE_URL}/api/items?businessId=${encodeURIComponent(parsed.businessId)}`);
    if (resp.ok) {
      const data = await resp.json();
      let matchedItemName = "기본 항목";
      if (parsed.bizItemId && data.items && data.items.length > 0) {
        const found = data.items.find(it => String(it.id) === String(parsed.bizItemId));
        if (found) matchedItemName = found.name;
      }
      return {
        platform: "naver",
        bizName: data.business?.name || `네이버 예약 (#${data.businessId || parsed.businessId})`,
        businessId: data.businessId || parsed.businessId,
        businessTypeId: data.businessTypeId || parsed.type,
        itemName: matchedItemName,
        items: data.items || []
      };
    }
  } catch (e) {
    console.warn("네이버 상세 항목 역추적 실패:", e);
  }

  return {
    platform: "naver",
    bizName: `네이버 예약 (${parsed.businessId})`,
    itemName: parsed.bizItemId ? `항목 #${parsed.bizItemId}` : "기본 항목"
  };
}

// =========================================================================
// 4. Supabase DB 통신 및 로컬 폴백 (SHA-256 인증 적용)
// =========================================================================

async function syncPushSubscriptionWithServer(subscription) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.log("Supabase 설정 전 - 로컬 모드로 작동 중");
    return;
  }

  try {
    await fetch(`${SUPABASE_URL}/rest/v1/rpc/register_device`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": `Bearer ${SUPABASE_ANON_KEY}`
      },
      body: JSON.stringify({
        p_secret_hash: deviceSecretHash,
        p_push_subscription: subscription ? subscription.toJSON() : null
      })
    });
  } catch (e) {
    console.error("기기 등록 RPC 오류:", e);
  }
}

async function loadReservations() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    // 로컬 스토리지 폴백 (Supabase 미연결 시에도 즉시 체험 가능)
    const local = localStorage.getItem("my_local_reservations_" + deviceSecretHash);
    return local ? JSON.parse(local) : [];
  }

  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_my_reservations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": `Bearer ${SUPABASE_ANON_KEY}`
      },
      body: JSON.stringify({
        p_secret_hash: deviceSecretHash
      })
    });

    if (resp.ok) {
      const items = await resp.json();
      // get_my_reservations RPC에 updated_at이 이미 포함되어 있으면 별도 테이블 조회 불필요 (RLS 완벽 호환)
      const needsFallbackQuery = items.length > 0 && items.some(it => typeof it.updated_at === "undefined");
      if (needsFallbackQuery) {
        try {
          const uResp = await fetch(`${SUPABASE_URL}/rest/v1/reservations?select=id,updated_at`, {
            headers: {
              "apikey": SUPABASE_ANON_KEY,
              "Authorization": `Bearer ${SUPABASE_ANON_KEY}`
            }
          });
          if (uResp.ok) {
            const uData = await uResp.json();
            const uMap = {};
            uData.forEach(u => { uMap[u.id] = u.updated_at; });
            items.forEach(it => {
              if (uMap[it.id]) it.updated_at = uMap[it.id];
            });
          }
        } catch (err) {}
      }
      return items;
    }
  } catch (e) {
    console.error("예약 목록 로드 오류:", e);
  }

  const local = localStorage.getItem("my_local_reservations_" + deviceSecretHash);
  return local ? JSON.parse(local) : [];
}

async function saveNewReservation(item) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    // 로컬 스토리지에 저장
    const current = await loadReservations();
    current.unshift(item);
    localStorage.setItem("my_local_reservations_" + deviceSecretHash, JSON.stringify(current));
    return item;
  }

  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/add_reservation`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": `Bearer ${SUPABASE_ANON_KEY}`
      },
      body: JSON.stringify({
        p_secret_hash: deviceSecretHash,
        p_naver_url: item.naver_url,
        p_business_type_id: item.business_type_id,
        p_business_id: item.business_id,
        p_biz_item_id: item.biz_item_id,
        p_biz_name: item.biz_name,
        p_item_name: item.item_name
      })
    });

    if (resp.ok) {
      const newId = await resp.json();
      item.id = newId;
      return item;
    }
  } catch (e) {
    console.error("예약 등록 RPC 오류:", e);
  }

  const current = await loadReservations();
  current.unshift(item);
  localStorage.setItem("my_local_reservations_" + deviceSecretHash, JSON.stringify(current));
  return item;
}

async function toggleReservationState(id, isActive) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    const list = await loadReservations();
    const target = list.find(r => r.id === id);
    if (target) target.is_active = isActive;
    localStorage.setItem("my_local_reservations_" + deviceSecretHash, JSON.stringify(list));
    return;
  }

  try {
    await fetch(`${SUPABASE_URL}/rest/v1/rpc/toggle_reservation`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": `Bearer ${SUPABASE_ANON_KEY}`
      },
      body: JSON.stringify({
        p_secret_hash: deviceSecretHash,
        p_reservation_id: id,
        p_is_active: isActive
      })
    });
  } catch (e) {
    console.error("상태 토글 오류:", e);
  }
}

async function deleteReservationItem(id) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    let list = await loadReservations();
    list = list.filter(r => r.id !== id);
    localStorage.setItem("my_local_reservations_" + deviceSecretHash, JSON.stringify(list));
    return;
  }

  try {
    await fetch(`${SUPABASE_URL}/rest/v1/rpc/delete_reservation`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": `Bearer ${SUPABASE_ANON_KEY}`
      },
      body: JSON.stringify({
        p_secret_hash: deviceSecretHash,
        p_reservation_id: id
      })
    });
  } catch (e) {
    console.error("예약 삭제 오류:", e);
  }
}

// =========================================================================
// 5. UI 렌더링 및 인터랙션
// =========================================================================

async function checkNaverSlotsLive(bizTypeId, bizId, itemId, sDate, eDate) {
  const params = new URLSearchParams({
    businessId: String(bizId),
    bizItemId: String(itemId || '1'),
    businessTypeId: String(bizTypeId || '13')
  });
  if (sDate) params.append("startDate", sDate);
  if (eDate) params.append("endDate", eDate);

  // 1) 광고 차단기(uBlock Origin, AdBlock 등)가 'slots' 단어를 카지노로 오인 차단(ERR_BLOCKED_BY_CLIENT)하는 문제를 방지하기 위해 /api/schedule 우선 시도
  let resp = null;
  let lastError = null;

  try {
    resp = await fetch(`${API_BASE_URL}/api/schedule?${params.toString()}`);
  } catch (err) {
    lastError = err;
    console.warn("API schedule 호출 실패, slots 폴백 시도:", err);
  }

  // 2) 실패 시 /api/slots 폴백 시도
  if (!resp || !resp.ok) {
    try {
      resp = await fetch(`${API_BASE_URL}/api/slots?${params.toString()}`);
    } catch (err) {
      lastError = err;
      console.warn("API slots 호출 실패:", err);
    }
  }

  if (!resp || !resp.ok) {
    let errMsg = "서버 통신 실패";
    if (resp) {
      const errData = await resp.json().catch(() => ({}));
      errMsg = errData.error || `서버 응답 오류 (${resp.status})`;
    } else if (lastError) {
      errMsg = lastError.message || "네트워크 연결 오류";
    }
    throw new Error(errMsg);
  }

  const data = await resp.json();
  if (data.availableSlots && data.availableSlots.length > 0) {
    return data.availableSlots.map(s => s.formatted);
  }
  return [];
}

function renderReservationCard(res) {
  const card = document.createElement("div");
  card.className = "reservation-card";
  card.id = `card-${res.id}`;

  const isNol = (res.business_type_id === 99);
  const isCatchTable = (res.business_type_id === 88);

  let lastSlotText = "";
  let isNoneState = false;
  if (res.last_slots && res.last_slots.length > 0) {
    const rawSlot = String(res.last_slots[0]);
    const mSlot = rawSlot.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
    if (mSlot) {
      const wkNames = ["일", "월", "화", "수", "목", "금", "토"];
      const dObj = new Date(Number(mSlot[1]), Number(mSlot[2]) - 1, Number(mSlot[3]));
      const wk = wkNames[dObj.getDay()];
      lastSlotText = `${mSlot[1]}년 ${mSlot[2]}월 ${mSlot[3]}일 (${wk}) ${mSlot[4]}:${mSlot[5]} 예약 가능`;
    } else {
      lastSlotText = rawSlot;
    }
  } else if (res.updated_at) {
    isNoneState = true;
    lastSlotText = isCatchTable
      ? "현재 예약 가능한 일정 없음 (실시간 감시 중)"
      : (isNol ? "현재 전석 매진 (취소표 실시간 감시 중)" : "지정 기간 내 빈자리 없음 (자동 감시 중)");
  } else {
    lastSlotText = isCatchTable
      ? "캐치테이블 빈자리 감시 대기 중"
      : (isNol ? "실시간 취켓팅 감시 대기 중" : "아직 확인 전 (스케줄러 대기 중)");
  }

  // URL에서 startDate, endDate 추출
  let periodBadgeHtml = "";
  let sDate = null;
  let eDate = null;
  if (isCatchTable) {
    periodBadgeHtml = `<div class="card-period-badge" style="color: #ff7a59; border-color: rgba(255, 82, 56, 0.3);">🍽️ 실시간 빈자리 예약 감시 중</div>`;
  } else if (isNol) {
    periodBadgeHtml = `<div class="card-period-badge" style="color: #a78bfa; border-color: rgba(167, 139, 250, 0.3);">🎫 취소표 실시간 고속 감시 중</div>`;
  } else {
    try {
      const u = new URL(res.naver_url);
      sDate = u.searchParams.get("startDate");
      eDate = u.searchParams.get("endDate");
      if (sDate && eDate) {
        periodBadgeHtml = `<div class="card-period-badge">📅 감시 기간: ${sDate} ~ ${eDate}</div>`;
      }
    } catch (e) {}
  }

  // 캐스트 뱃지 추출 (예: "[캐스트: 김준수, 정원영] 1회차")
  let castBadgesHtml = "";
  if (res.item_name && res.item_name.includes("[캐스트:")) {
    const m = res.item_name.match(/\[캐스트:\s*([^\]]+)\]/);
    if (m) {
      const actors = m[1].split(",").map(a => a.trim()).filter(Boolean);
      castBadgesHtml = `<div style="margin-top: 3px; display: flex; flex-wrap: wrap; gap: 4px;">` +
        actors.map(a => `<span class="cast-badge">🎭 ${a}</span>`).join("") +
        `</div>`;
    }
  }

  let platformBadge = `<span class="biz-badge" style="margin-bottom: 4px; display: inline-block;">네이버 예약</span>`;
  if (isCatchTable) {
    platformBadge = `<span class="biz-badge" style="background: linear-gradient(135deg, #ff5238, #ff7a59); margin-bottom: 4px; display: inline-block;">🍽️ 캐치테이블</span>`;
  } else if (isNol) {
    platformBadge = `<span class="biz-badge" style="background: linear-gradient(135deg, #8b5cf6, #6366f1); margin-bottom: 4px; display: inline-block;">🎫 놀티켓·인터파크 취켓팅</span>`;
  }

  let lastCheckedDesc = "";
  if (res.updated_at) {
    try {
      const dt = new Date(res.updated_at);
      const now = new Date();
      const diffMin = Math.floor((now - dt) / 60000);
      if (diffMin < 2) {
        lastCheckedDesc = " · 최근 확인: 방금 전";
      } else if (diffMin < 60) {
        lastCheckedDesc = ` · 최근 확인: ${diffMin}분 전`;
      } else {
        const m = dt.getMonth() + 1;
        const d = dt.getDate();
        const h = String(dt.getHours()).padStart(2, '0');
        const min = String(dt.getMinutes()).padStart(2, '0');
        lastCheckedDesc = ` · 최근 확인: ${m}/${d} ${h}:${min}`;
      }
    } catch(e) {}
  }

  let openLinkText = "네이버 예약 열기";
  let openLinkStyle = "";
  if (isCatchTable) {
    openLinkText = "캐치테이블 예약 열기";
    openLinkStyle = "border-color: rgba(255, 82, 56, 0.4); color: #ff7a59;";
  } else if (isNol) {
    openLinkText = "티켓 예매창 열기";
    openLinkStyle = "border-color: rgba(167, 139, 250, 0.4); color: #c4b5fd;";
  }

  card.innerHTML = `
    <div class="card-top">
      <div class="card-titles">
        ${platformBadge}
        <h4>${res.biz_name}</h4>
        <p>${res.item_name}</p>
        ${castBadgesHtml}
        ${periodBadgeHtml}
      </div>
      <div class="switch-container">
        <label class="switch">
          <input type="checkbox" id="toggle-${res.id}" ${res.is_active ? "checked" : ""}>
          <span class="slider"></span>
        </label>
      </div>
    </div>
    
    <div class="slot-badge-box">
      <div class="slot-label-row">
        <span class="slot-label">${isCatchTable ? "캐치테이블 실시간 예약 가능 일자" : (isNol ? "실시간 취소표 잔여석 현황" : "가장 빠른 예약 가능 일시")}</span>
        <span class="cycle-pill">⏱️ 1시간 주기 자동 감시 중${lastCheckedDesc}</span>
      </div>
      <div class="slot-value${isNoneState ? " none" : ""}" id="slot-text-${res.id}">
        ${isNoneState ? "❌" : "✨"} ${lastSlotText}
      </div>
    </div>

    <div class="card-bottom">
      <a href="${res.naver_url}" target="_blank" rel="noopener noreferrer" class="btn-open-naver" style="${openLinkStyle}">
        <span>${openLinkText}</span> ↗
      </a>
      <div class="card-actions">
        <button class="btn-check-now" id="check-btn-${res.id}">지금 확인</button>
        <button class="btn-delete" id="del-btn-${res.id}">삭제</button>
      </div>
    </div>
  `;

  // 이벤트 연결
  card.querySelector(`#toggle-${res.id}`).addEventListener("change", (e) => {
    toggleReservationState(res.id, e.target.checked);
    showToast(e.target.checked ? "🔔 모니터링이 활성화되었습니다." : "⏸️ 모니터링이 일시 정지되었습니다.");
  });

  card.querySelector(`#del-btn-${res.id}`).addEventListener("click", async () => {
    if (confirm(`'${res.biz_name}' 예약을 삭제하시겠습니까?`)) {
      await deleteReservationItem(res.id);
      card.remove();
      updateListCount();
      showToast("🗑️ 예약이 삭제되었습니다.");
    }
  });

  card.querySelector(`#check-btn-${res.id}`).addEventListener("click", async () => {
    const btn = card.querySelector(`#check-btn-${res.id}`);
    btn.disabled = true;
    btn.textContent = "조회 중...";
    showToast(`⏳ '${res.biz_name}' 실시간 스캔 중...`);

    if (isCatchTable) {
      // 캐치테이블 실시간 조회
      try {
        const resp = await fetch(`${API_BASE_URL}/api/catchtable?shopRef=${encodeURIComponent(res.business_id)}&action=slots`);
        const data = await resp.json();
        const avail = data.availableDates || [];
        const slotBox = card.querySelector(`#slot-text-${res.id}`);
        if (avail.length > 0) {
          const first = avail[0];
          const pCounts = first.availablePersonCounts || [];
          const pText = pCounts.length ? `(가능: ${Math.min(...pCounts)}~${Math.max(...pCounts)}명)` : '';
          const extraText = avail.length > 1 ? ` 외 ${avail.length - 1}개 날짜 오픈` : '';
          slotBox.textContent = `🎉 ${first.date} ${pText}${extraText}`;
          slotBox.classList.remove("none");
          showToast(`🎉 캐치테이블 ${avail.length}개 예약 가능 날짜 발견!`);
        } else {
          slotBox.textContent = `❌ 현재 예약 가능한 일정이 없습니다.`;
          slotBox.classList.add("none");
          showToast(`ℹ️ 현재 전 일정 마감 상태입니다. 빈자리 발생 시 알림이 발송됩니다.`);
        }
      } catch (err) {
        showToast("❌ 조회 실패: " + err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = "지금 확인";
      }
      return;
    }

    if (isNol) {
      // 놀티켓/인터파크 실시간 조회
      try {
        const resp = await fetch(`${API_BASE_URL}/api/nol?goodsCode=${encodeURIComponent(res.business_id)}`);
        const data = await resp.json();
        let totalRemain = 0;
        let availSummaries = [];
        (data.sessions || []).forEach(s => {
          if (res.biz_item_id === 'all' || res.biz_item_id === s.playSeq) {
            totalRemain += s.totalRemain || 0;
            if (s.totalRemain > 0) {
              const gradeNames = s.seats.filter(st => st.count > 0).map(st => `${st.name} ${st.count}석`).join(', ');
              availSummaries.push(`[${s.label}] ${gradeNames}`);
            }
          }
        });

        const slotBox = card.querySelector(`#slot-text-${res.id}`);
        if (totalRemain > 0) {
          slotBox.textContent = `🎉 ${availSummaries[0]}`;
          slotBox.classList.remove("none");
          showToast(`🎉 취소표 ${totalRemain}석 발견! 즉시 예매하세요.`);
        } else {
          slotBox.textContent = `❌ 현재 전석 매진 (취소표 대기 중)`;
          slotBox.classList.add("none");
          showToast(`ℹ️ 현재 전 회차 매진 상태입니다. 취소표 발생 시 알림이 발송됩니다.`);
        }
      } catch (err) {
        showToast("❌ 조회 실패: " + err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = "지금 확인";
      }
      return;
    }

    // 네이버 GraphQL 즉시 스캔
    try {
      const topSlots = await checkNaverSlotsLive(res.business_type_id, res.business_id, res.biz_item_id, sDate, eDate);
      const slotBox = card.querySelector(`#slot-text-${res.id}`);
      if (topSlots && topSlots.length > 0) {
        slotBox.textContent = `✨ ${topSlots[0]}`;
        slotBox.classList.remove("none");
        showToast(`🎉 최단 빈자리: ${topSlots[0]}`);
      } else {
        const periodMsg = sDate && eDate ? `지정 기간(${sDate}~${eDate})` : "1년";
        slotBox.textContent = `❌ ${periodMsg} 내 빈자리 없음`;
        slotBox.classList.add("none");
        showToast(`ℹ️ ${periodMsg} 내 모든 일정이 마감 상태입니다.`);
      }
    } catch (err) {
      showToast("❌ 조회 실패: " + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "지금 확인";
    }
  });

  return card;
}

async function renderReservationsList(skipAutoCron = false) {
  const container = document.getElementById("reservations-list");
  const emptyState = document.getElementById("empty-state");
  container.innerHTML = "";

  const list = await loadReservations();
  updateListCount(list.length);

  if (list.length === 0) {
    emptyState.style.display = "flex";
  } else {
    emptyState.style.display = "none";
    list.forEach(res => {
      container.appendChild(renderReservationCard(res));
    });

    // 활성 예약 중 마지막 확인 시각(updated_at)이 35분 이상 경과했으면 백그라운드로 Vercel /api/cron 자동 호출 후 갱신
    if (!skipAutoCron && typeof fetch === "function") {
      const nowMs = Date.now();
      const needsCronSync = list.some(r => {
        if (!r.is_active) return false;
        if (!r.updated_at) return true;
        const diffMin = (nowMs - new Date(r.updated_at).getTime()) / 60000;
        return diffMin >= 35;
      });
      if (needsCronSync) {
        fetch(`${API_BASE_URL}/api/cron`)
          .then(r => r.ok ? r.json() : null)
          .then(data => {
            if (data && data.ok) {
              renderReservationsList(true);
            }
          })
          .catch(() => {});
      }
    }
  }
}

function updateListCount(count = null) {
  const countEl = document.getElementById("list-count");
  if (count === null) {
    count = document.querySelectorAll(".reservation-card").length;
  }
  countEl.textContent = `총 ${count}개 등록됨`;
}

function showToast(msg) {
  const toast = document.getElementById("toast");
  toast.textContent = msg;
  toast.classList.add("show");
  clearTimeout(window.toastTimer);
  window.toastTimer = setTimeout(() => {
    toast.classList.remove("show");
  }, 3200);
}

// =========================================================================
// 6. 이벤트 바인딩 및 앱 초기화
// =========================================================================

let selectedSearchTarget = null;
let searchDebounceTimer = null;

// Date Range 상태 관리
const dateRangeState = {
  search: { days: 30, startDate: "", endDate: "", isCustom: false },
  url: { days: 30, startDate: "", endDate: "", isCustom: false }
};

function formatDateYMD(d) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function initDateRangeBox(mode) {
  const box = document.getElementById(`range-box-${mode}`);
  if (!box) return;
  const presets = document.getElementById(`presets-${mode}`);
  const customInputs = document.getElementById(`custom-inputs-${mode}`);
  const startInput = document.getElementById(`start-date-${mode}`);
  const endInput = document.getElementById(`end-date-${mode}`);
  const badge = document.getElementById(`range-badge-${mode}`);

  const today = new Date();
  const todayStr = formatDateYMD(today);
  startInput.min = todayStr;
  endInput.min = todayStr;

  function updateRange(days, isCustom = false) {
    const s = new Date();
    const e = new Date();
    e.setDate(s.getDate() + (days || 30));

    dateRangeState[mode].days = days;
    dateRangeState[mode].startDate = formatDateYMD(s);
    dateRangeState[mode].endDate = formatDateYMD(e);
    dateRangeState[mode].isCustom = isCustom;

    startInput.value = dateRangeState[mode].startDate;
    endInput.value = dateRangeState[mode].endDate;

    if (!isCustom) {
      customInputs.style.display = "none";
      if (days === 7) badge.textContent = "1주일간";
      else if (days === 30) badge.textContent = "1개월간 (추천)";
      else if (days === 90) badge.textContent = "3개월간";
      else if (days === 365) badge.textContent = "1년 (전체)";
    } else {
      customInputs.style.display = "flex";
      badge.textContent = `${startInput.value.slice(5)} ~ ${endInput.value.slice(5)}`;
    }
  }

  presets.querySelectorAll(".preset-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      presets.querySelectorAll(".preset-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      if (btn.dataset.custom) {
        updateRange(dateRangeState[mode].days, true);
      } else {
        const days = parseInt(btn.dataset.days, 10);
        updateRange(days, false);
      }
    });
  });

  startInput.addEventListener("change", () => {
    dateRangeState[mode].startDate = startInput.value;
    badge.textContent = `${startInput.value.slice(5)} ~ ${endInput.value.slice(5)}`;
  });

  endInput.addEventListener("change", () => {
    dateRangeState[mode].endDate = endInput.value;
    badge.textContent = `${startInput.value.slice(5)} ~ ${endInput.value.slice(5)}`;
  });

  // 초기값 30일(1개월) 설정
  updateRange(30, false);
}

function attachDateRangeToUrl(baseNaverUrl, mode) {
  const state = dateRangeState[mode];
  try {
    const urlObj = new URL(baseNaverUrl);
    if (state.startDate) urlObj.searchParams.set("startDate", state.startDate);
    if (state.endDate) urlObj.searchParams.set("endDate", state.endDate);
    return urlObj.toString();
  } catch (e) {
    const separator = baseNaverUrl.includes("?") ? "&" : "?";
    return `${baseNaverUrl}${separator}startDate=${state.startDate}&endDate=${state.endDate}`;
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  await initDeviceIdentity();
  await initServiceWorker();

  // 날짜 범위 컨트롤러 초기화
  initDateRangeBox("search");
  initDateRangeBox("url");

  // iOS 감지 및 가이드 배너 표시
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  const isStandalone = window.navigator.standalone === true || (typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches);
  const iosBanner = document.getElementById("ios-banner");
  if (isIOS && !isStandalone && iosBanner) {
    iosBanner.style.display = "flex";
  }

  // 푸시 버튼 이벤트
  document.getElementById("btn-toggle-push").addEventListener("click", requestPushPermission);

  // -------------------------------------------------------------------------
  // A. 모드 전환 탭 (네이버 검색 vs 캐치테이블 vs 놀티켓 취켓팅 vs URL 직접입력)
  // -------------------------------------------------------------------------
  const tabSearch = document.getElementById("tab-search");
  const tabCt = document.getElementById("tab-ct");
  const tabNol = document.getElementById("tab-nol");
  const tabUrl = document.getElementById("tab-url");
  const contentSearch = document.getElementById("content-search");
  const contentCt = document.getElementById("content-ct");
  const contentNol = document.getElementById("content-nol");
  const contentUrl = document.getElementById("content-url");

  function switchTab(activeTab) {
    const tabs = [tabSearch, tabCt, tabNol, tabUrl].filter(Boolean);
    tabs.forEach(t => {
      const isActive = (t === activeTab);
      t.classList.toggle("active", isActive);
      t.setAttribute("aria-selected", isActive ? "true" : "false");
    });
    if (contentSearch) contentSearch.style.display = (activeTab === tabSearch ? "flex" : "none");
    if (contentCt) contentCt.style.display = (activeTab === tabCt ? "flex" : "none");
    if (contentNol) contentNol.style.display = (activeTab === tabNol ? "flex" : "none");
    if (contentUrl) contentUrl.style.display = (activeTab === tabUrl ? "flex" : "none");
  }

  if (tabSearch) tabSearch.addEventListener("click", () => switchTab(tabSearch));
  if (tabCt) tabCt.addEventListener("click", () => switchTab(tabCt));
  if (tabNol) tabNol.addEventListener("click", () => switchTab(tabNol));
  if (tabUrl) tabUrl.addEventListener("click", () => switchTab(tabUrl));

  // -------------------------------------------------------------------------
  // A-1. 캐치테이블 실시간 검색 & 매장 선택 컨트롤러
  // -------------------------------------------------------------------------
  let selectedCtTarget = null;
  let ctSearchDebounceTimer = null;
  const ctSearchInput = document.getElementById("ct-search-input");
  const ctSearchSpinner = document.getElementById("ct-search-spinner");
  const btnClearCtSearch = document.getElementById("btn-clear-ct-search");
  const ctSearchResults = document.getElementById("ct-search-results");
  const ctItemPickerCard = document.getElementById("ct-item-picker-card");
  const selectedCtCat = document.getElementById("selected-ct-cat");
  const selectedCtName = document.getElementById("selected-ct-name");
  const selectedCtAddr = document.getElementById("selected-ct-addr");
  const btnCtReselect = document.getElementById("btn-ct-reselect");
  const ctPreviewCard = document.getElementById("ct-preview-card");
  const ctItemsChips = document.getElementById("ct-items-chips");
  const btnSubmitCt = document.getElementById("btn-submit-ct");

  if (ctSearchInput) {
    ctSearchInput.addEventListener("input", (e) => {
      const val = e.target.value.trim();
      if (btnClearCtSearch) btnClearCtSearch.style.display = val ? "flex" : "none";

      clearTimeout(ctSearchDebounceTimer);
      if (!val) {
        if (ctSearchResults) {
          ctSearchResults.style.display = "none";
          ctSearchResults.innerHTML = "";
        }
        return;
      }

      ctSearchDebounceTimer = setTimeout(() => {
        performCtSearch(val);
      }, 280);
    });
  }

  if (btnClearCtSearch) {
    btnClearCtSearch.addEventListener("click", () => {
      if (ctSearchInput) {
        ctSearchInput.value = "";
        ctSearchInput.focus();
      }
      btnClearCtSearch.style.display = "none";
      if (ctSearchResults) {
        ctSearchResults.style.display = "none";
        ctSearchResults.innerHTML = "";
      }
    });
  }

  if (btnCtReselect) {
    btnCtReselect.addEventListener("click", () => {
      selectedCtTarget = null;
      if (ctItemPickerCard) ctItemPickerCard.style.display = "none";
      if (btnSubmitCt) btnSubmitCt.disabled = true;
      if (ctSearchInput) {
        ctSearchInput.value = "";
        ctSearchInput.focus();
      }
      if (btnClearCtSearch) btnClearCtSearch.style.display = "none";
      if (ctSearchResults) {
        ctSearchResults.style.display = "none";
        ctSearchResults.innerHTML = "";
      }
    });
  }

  async function performCtSearch(query) {
    if (ctSearchSpinner) {
      ctSearchSpinner.textContent = "⏳";
      ctSearchSpinner.classList.add("spin");
    }

    try {
      // URL 또는 영문 alias가 입력된 경우 -> alias 단일 조회
      const mUrl = query.match(/catchtable\.co\.kr\/(?:ct\/shop\/)?([a-zA-Z0-9_\-]+)/);
      const isDirectAlias = mUrl || /^[a-zA-Z0-9_\-]+$/.test(query);
      const targetAlias = mUrl ? mUrl[1] : (isDirectAlias ? query : null);

      if (targetAlias && targetAlias.length >= 3) {
        const resp = await fetch(`${API_BASE_URL}/api/catchtable?alias=${encodeURIComponent(targetAlias)}`);
        const data = await resp.json();
        if (data.ok && data.shopName) {
          renderCtSearchResults([{
            shopRef: data.shopRef || targetAlias,
            shopName: data.shopName,
            shopUrl: data.shopUrl || targetAlias,
            category: data.category || '캐치테이블 식당',
            address: data.address || ''
          }], query);
          return;
        }
      }

      // 키워드 검색
      const resp = await fetch(`${API_BASE_URL}/api/catchtable?q=${encodeURIComponent(query)}`);
      const data = await resp.json();
      const list = data.results || [];
      renderCtSearchResults(list, query);
    } catch (err) {
      console.error("캐치테이블 검색 요청 오류:", err);
      if (ctSearchResults) {
        ctSearchResults.style.display = "flex";
        ctSearchResults.innerHTML = `<div class="search-item-empty">검색 중 오류가 발생했습니다: ${err.message}</div>`;
      }
    } finally {
      if (ctSearchSpinner) {
        ctSearchSpinner.textContent = "🔍";
        ctSearchSpinner.classList.remove("spin");
      }
    }
  }

  function renderCtSearchResults(shops, query) {
    if (!ctSearchResults) return;
    ctSearchResults.innerHTML = "";

    if (shops.length === 0) {
      ctSearchResults.style.display = "flex";
      ctSearchResults.innerHTML = `<div class="search-item-empty">'${query}'에 대한 캐치테이블 매장 결과가 없습니다. 식당 영문 ID(예: sushikoji)나 공유 링크를 직접 입력해 보세요.</div>`;
      return;
    }

    shops.forEach(shop => {
      const itemEl = document.createElement("div");
      itemEl.className = "search-item";
      itemEl.innerHTML = `
        <div class="search-item-top">
          <span class="search-item-title">${shop.shopName}</span>
          ${shop.category ? `<span class="search-item-cat" style="background: rgba(255, 82, 56, 0.2); color: #ff7a59;">${shop.category}</span>` : ""}
        </div>
        ${shop.address ? `<span class="search-item-addr">📍 ${shop.address}</span>` : ''}
      `;

      itemEl.addEventListener("click", () => {
        handleShopSelected(shop);
      });

      ctSearchResults.appendChild(itemEl);
    });

    ctSearchResults.style.display = "flex";
  }

  async function handleShopSelected(shop) {
    if (ctSearchResults) ctSearchResults.style.display = "none";
    if (ctSearchInput) ctSearchInput.value = shop.shopName;
    if (btnClearCtSearch) btnClearCtSearch.style.display = "flex";

    if (selectedCtName) selectedCtName.textContent = shop.shopName;
    if (selectedCtCat) selectedCtCat.textContent = shop.category || "캐치테이블";
    if (selectedCtAddr) selectedCtAddr.textContent = shop.address ? `📍 ${shop.address}` : "";
    if (ctPreviewCard) {
      ctPreviewCard.style.display = "flex";
      ctPreviewCard.innerHTML = `<span style="color: #ff7a59;">⏳ 실시간 예약 가능 날짜 조회 중...</span>`;
    }
    if (ctItemsChips) ctItemsChips.innerHTML = `<span>⏳ 슬롯 로딩 중...</span>`;
    if (ctItemPickerCard) ctItemPickerCard.style.display = "flex";
    if (btnSubmitCt) btnSubmitCt.disabled = true;

    try {
      const shopRef = shop.shopRef || shop.shopUrl;
      const resp = await fetch(`${API_BASE_URL}/api/catchtable?shopRef=${encodeURIComponent(shopRef)}&action=slots`);
      const data = await resp.json();
      const avail = data.availableDates || [];

      selectedCtTarget = {
        platform: "catchtable",
        shopRef: shopRef,
        shopName: shop.shopName,
        shopUrl: shop.shopUrl || shopRef,
        address: shop.address || "",
        category: shop.category || "식당",
        availableDates: avail
      };

      const availBadge = avail.length > 0 
        ? `<span style="color: #4ade80; font-weight: 700;">${avail.length}개 날짜 예약 가능!</span>`
        : `<span style="color: #ff7a59; font-weight: 700;">전 일정 마감 (빈자리 감시 대기)</span>`;

      if (ctPreviewCard) {
        ctPreviewCard.innerHTML = `
          <div style="display: flex; flex-direction: column; gap: 4px;">
            <div style="display: flex; align-items: center; gap: 6px;">
              <span class="biz-badge" style="background: linear-gradient(135deg, #ff5238, #ff7a59);">캐치테이블</span>
              <strong style="color: #fff; font-size: 0.9rem;">${shop.shopName}</strong>
            </div>
            <div style="color: var(--text-muted); font-size: 0.74rem;">📍 ${shop.address || '위치 확인 중'} | 🍽️ 실시간 빈자리 푸시 모니터링</div>
          </div>
          ${availBadge}
        `;
      }

      if (ctItemsChips) {
        ctItemsChips.innerHTML = "";
        const allChip = document.createElement("button");
        allChip.type = "button";
        allChip.className = "item-chip selected";
        allChip.innerHTML = `<strong>✨ 전체 빈자리 감시 (추천)</strong><span style="font-size: 0.7rem; opacity: 0.8; display: block; margin-top: 2px;">어느 날짜든 빈자리 오픈 시 즉시 푸시 알림</span>`;
        allChip.addEventListener("click", () => {
          document.querySelectorAll("#ct-items-chips .item-chip").forEach(c => c.classList.remove("selected"));
          allChip.classList.add("selected");
          selectedCtTarget.selectedDate = "all";
        });
        ctItemsChips.appendChild(allChip);

        avail.forEach(item => {
          const chip = document.createElement("button");
          chip.type = "button";
          chip.className = "item-chip";
          const pCounts = item.availablePersonCounts || [];
          const pText = pCounts.length ? `${Math.min(...pCounts)}~${Math.max(...pCounts)}명 가능` : '예약 가능';
          chip.innerHTML = `<strong>${item.date}</strong><span style="font-size: 0.7rem; opacity: 0.8; display: block; margin-top: 2px;">${pText}</span>`;
          chip.addEventListener("click", () => {
            document.querySelectorAll("#ct-items-chips .item-chip").forEach(c => c.classList.remove("selected"));
            chip.classList.add("selected");
            selectedCtTarget.selectedDate = item.date;
          });
          ctItemsChips.appendChild(chip);
        });
      }

      if (btnSubmitCt) btnSubmitCt.disabled = false;
    } catch (err) {
      if (ctPreviewCard) {
        ctPreviewCard.innerHTML = `<span style="color: #ef4444;">❌ 조회 실패: ${err.message}</span>`;
      }
      selectedCtTarget = null;
      if (btnSubmitCt) btnSubmitCt.disabled = true;
    }
  }

  // 캐치테이블 예약 추가 버튼
  if (btnSubmitCt) {
    btnSubmitCt.addEventListener("click", async () => {
      if (!selectedCtTarget) return;

      btnSubmitCt.disabled = true;
      btnSubmitCt.innerHTML = `<span>등록 중...</span>`;

      const shopUrl = selectedCtTarget.shopUrl || selectedCtTarget.shopRef;
      const finalUrl = `https://app.catchtable.co.kr/ct/shop/${shopUrl}`;

      const newRes = {
        id: "res_" + Date.now(),
        naver_url: finalUrl,
        business_type_id: 88,
        business_id: selectedCtTarget.shopRef,
        biz_item_id: selectedCtTarget.selectedDate || "all",
        biz_name: selectedCtTarget.shopName,
        item_name: selectedCtTarget.selectedDate && selectedCtTarget.selectedDate !== 'all' ? `${selectedCtTarget.selectedDate} 예약` : "전체 예약 일정 (빈자리 감시)",
        is_active: true,
        last_slots: []
      };

      await saveNewReservation(newRes);

      if (ctSearchInput) ctSearchInput.value = "";
      if (btnClearCtSearch) btnClearCtSearch.style.display = "none";
      if (ctPreviewCard) ctPreviewCard.style.display = "none";
      if (ctItemPickerCard) ctItemPickerCard.style.display = "none";
      selectedCtTarget = null;
      btnSubmitCt.disabled = false;
      btnSubmitCt.innerHTML = `<span>+ 캐치테이블 빈자리 모니터링 추가</span>`;

      await renderReservationsList();
      showToast(`🎉 [${newRes.biz_name}] 빈자리 모니터링이 추가되었습니다!`);
    });
  }

  // -------------------------------------------------------------------------
  // A-2. 놀티켓 & 콘서트 취켓팅 실시간 검색 컨트롤러 (네이버 검색과 동일한 UX)
  // -------------------------------------------------------------------------
  let selectedNolTarget = null;
  let nolSearchDebounceTimer = null;
  const nolSearchInput = document.getElementById("nol-search-input");
  const nolSearchSpinner = document.getElementById("nol-search-spinner");
  const btnClearNolSearch = document.getElementById("btn-clear-nol-search");
  const nolSearchResults = document.getElementById("nol-search-results");
  const nolItemPickerCard = document.getElementById("nol-item-picker-card");
  const selectedNolCat = document.getElementById("selected-nol-cat");
  const selectedNolName = document.getElementById("selected-nol-name");
  const selectedNolVenue = document.getElementById("selected-nol-venue");
  const btnNolReselect = document.getElementById("btn-nol-reselect");
  const nolPreviewCard = document.getElementById("nol-preview-card");
  const nolSessionsChips = document.getElementById("nol-items-chips");
  const btnSubmitNol = document.getElementById("btn-submit-nol");

  if (nolSearchInput) {
    nolSearchInput.addEventListener("input", (e) => {
      const val = e.target.value.trim();
      if (btnClearNolSearch) btnClearNolSearch.style.display = val ? "flex" : "none";

      clearTimeout(nolSearchDebounceTimer);
      if (!val) {
        if (nolSearchResults) {
          nolSearchResults.style.display = "none";
          nolSearchResults.innerHTML = "";
        }
        return;
      }

      nolSearchDebounceTimer = setTimeout(() => {
        performNolSearch(val);
      }, 280);
    });
  }

  if (btnClearNolSearch) {
    btnClearNolSearch.addEventListener("click", () => {
      if (nolSearchInput) {
        nolSearchInput.value = "";
        nolSearchInput.focus();
      }
      btnClearNolSearch.style.display = "none";
      if (nolSearchResults) {
        nolSearchResults.style.display = "none";
        nolSearchResults.innerHTML = "";
      }
    });
  }

  if (btnNolReselect) {
    btnNolReselect.addEventListener("click", () => {
      selectedNolTarget = null;
      if (nolItemPickerCard) nolItemPickerCard.style.display = "none";
      if (btnSubmitNol) btnSubmitNol.disabled = true;
      if (nolSearchInput) {
        nolSearchInput.value = "";
        nolSearchInput.focus();
      }
      if (btnClearNolSearch) btnClearNolSearch.style.display = "none";
      if (nolSearchResults) {
        nolSearchResults.style.display = "none";
        nolSearchResults.innerHTML = "";
      }
    });
  }

  async function performNolSearch(query) {
    if (nolSearchSpinner) {
      nolSearchSpinner.textContent = "⏳";
      nolSearchSpinner.classList.add("spin");
    }

    try {
      const resp = await fetch(`${API_BASE_URL}/api/nol?q=${encodeURIComponent(query)}`);
      const data = await resp.json();
      const list = data.results || [];
      renderNolSearchResults(list, query);
    } catch (err) {
      console.error("놀티켓 검색 요청 오류:", err);
      if (nolSearchResults) {
        nolSearchResults.style.display = "flex";
        nolSearchResults.innerHTML = `<div class="search-item-empty">검색 중 오류가 발생했습니다: ${err.message}</div>`;
      }
    } finally {
      if (nolSearchSpinner) {
        nolSearchSpinner.textContent = "🔍";
        nolSearchSpinner.classList.remove("spin");
      }
    }
  }

  function renderNolSearchResults(items, query) {
    if (!nolSearchResults) return;
    nolSearchResults.innerHTML = "";

    if (items.length === 0) {
      const codeMatch = query.match(/(\d{7,10})/);
      if (codeMatch) {
        const itemEl = document.createElement("div");
        itemEl.className = "search-item";
        itemEl.innerHTML = `
          <div class="search-item-top">
            <span class="search-item-title">🎫 놀티켓 상품 (#${codeMatch[1]}) 직접 불러오기</span>
            <span class="search-item-cat">놀티켓</span>
          </div>
          <span class="search-item-addr">클릭하여 이 상품의 회차 및 취소표 정보를 조회합니다.</span>
        `;
        itemEl.addEventListener("click", () => {
          handleConcertSelected({ goodsCode: codeMatch[1], title: `놀티켓 공연 (#${codeMatch[1]})`, placeName: '공연장' });
        });
        nolSearchResults.appendChild(itemEl);
        nolSearchResults.style.display = "flex";
        return;
      }

      nolSearchResults.style.display = "flex";
      nolSearchResults.innerHTML = `<div class="search-item-empty">'${query}'에 대한 공연 검색 결과가 없습니다. 상품번호(예: 26013810)를 직접 입력하셔도 됩니다.</div>`;
      return;
    }

    items.forEach(concert => {
      const itemEl = document.createElement("div");
      itemEl.className = "search-item";
      itemEl.innerHTML = `
        <div class="search-item-top">
          <span class="search-item-title">${concert.title}</span>
          ${concert.category ? `<span class="search-item-cat" style="background: rgba(139, 92, 246, 0.2); color: #c4b5fd;">${concert.category}</span>` : ""}
        </div>
        <span class="search-item-addr">${concert.placeName ? `📍 ${concert.placeName}` : ''}${concert.dates ? ` | 📅 ${concert.dates}` : ''}</span>
      `;

      itemEl.addEventListener("click", () => {
        handleConcertSelected(concert);
      });

      nolSearchResults.appendChild(itemEl);
    });

    nolSearchResults.style.display = "flex";
  }

  async function handleConcertSelected(concert) {
    if (nolSearchResults) nolSearchResults.style.display = "none";
    if (nolSearchInput) nolSearchInput.value = concert.title;
    if (btnClearNolSearch) btnClearNolSearch.style.display = "flex";

    if (selectedNolName) selectedNolName.textContent = concert.title;
    if (selectedNolCat) selectedNolCat.textContent = concert.category || "콘서트·뮤지컬";
    if (selectedNolVenue) selectedNolVenue.textContent = concert.placeName ? `📍 ${concert.placeName}` : "";
    if (nolPreviewCard) {
      nolPreviewCard.style.display = "flex";
      nolPreviewCard.innerHTML = `<span style="color: #c4b5fd;">⏳ 회차 및 취소표 실시간 잔여석 조회 중...</span>`;
    }
    if (nolSessionsChips) nolSessionsChips.innerHTML = `<span>⏳ 회차 정보 로딩 중...</span>`;
    if (nolItemPickerCard) nolItemPickerCard.style.display = "flex";
    if (btnSubmitNol) btnSubmitNol.disabled = true;

    try {
      const resp = await fetch(`${API_BASE_URL}/api/nol?goodsCode=${encodeURIComponent(concert.goodsCode)}`);
      const data = await resp.json();
      if (!data || !data.goodsName) {
        throw new Error(data.error || "공연 정보를 불러올 수 없습니다.");
      }

      selectedNolTarget = {
        platform: "nol_ticket",
        goodsCode: data.goodsCode || concert.goodsCode,
        bizName: `[놀티켓] ${data.goodsName}`,
        placeName: data.placeName || concert.placeName || "공연장",
        playPeriod: `${data.playStartDate || ''} ~ ${data.playEndDate || ''}`,
        selectedSessionSeq: "all",
        selectedSessionLabel: "전체 회차 (취소표 발생 즉시 알림)",
        sessions: data.sessions || []
      };

      if (selectedNolName) selectedNolName.textContent = data.goodsName;
      if (selectedNolVenue) selectedNolVenue.textContent = data.placeName ? `📍 ${data.placeName}` : "";

      const totalRemainAll = (data.sessions || []).reduce((acc, s) => acc + (s.totalRemain || 0), 0);
      const remainBadge = totalRemainAll > 0 
        ? `<span style="color: #4ade80; font-weight: 700;">취소표 ${totalRemainAll}석 발견!</span>` 
        : `<span style="color: #f472b6; font-weight: 700;">전석 매진 (취켓팅 대기)</span>`;

      if (nolPreviewCard) {
        nolPreviewCard.innerHTML = `
          <div style="display: flex; flex-direction: column; gap: 4px;">
            <div style="display: flex; align-items: center; gap: 6px;">
              <span class="nol-badge">공연 확인됨</span>
              <strong style="color: #fff; font-size: 0.9rem;">${data.goodsName}</strong>
            </div>
            <div style="color: var(--text-muted); font-size: 0.74rem;">📍 ${data.placeName || '공연장'} | 📅 ${data.playStartDate || ''}~${data.playEndDate || ''}</div>
          </div>
          ${remainBadge}
        `;
      }

      // 캐스트(출연진) 선택 칩 렌더링 (배우 최대 2명 선택)
      const castSection = document.getElementById("nol-cast-section");
      const castChipsGrid = document.getElementById("nol-cast-chips");
      const castCountBadge = document.getElementById("nol-cast-count-badge");
      selectedNolTarget.selectedCasts = [];

      if (castSection && castChipsGrid) {
        if (data.casts && data.casts.length > 0) {
          castSection.style.display = "block";
          castChipsGrid.innerHTML = "";
          if (castCountBadge) castCountBadge.textContent = "0/2명 선택";

          data.casts.forEach(cast => {
            const chip = document.createElement("div");
            chip.className = "cast-chip";
            const avatarHtml = cast.image 
              ? `<img src="${cast.image}" class="cast-avatar" alt="${cast.name}" onerror="this.onerror=null;this.parentElement.innerHTML='<div class=\\'cast-avatar-fallback\\'>🎭</div>';"/>` 
              : `<div class="cast-avatar-fallback">🎭</div>`;

            chip.innerHTML = `
              ${avatarHtml}
              <div class="cast-info">
                <strong class="cast-name">${cast.name}</strong>
                ${cast.character ? `<span class="cast-role">${cast.character} 역</span>` : ''}
              </div>
            `;

            chip.addEventListener("click", () => {
              const isSelected = chip.classList.contains("selected");
              if (isSelected) {
                chip.classList.remove("selected");
                selectedNolTarget.selectedCasts = selectedNolTarget.selectedCasts.filter(c => c.name !== cast.name);
              } else {
                if (selectedNolTarget.selectedCasts.length >= 2) {
                  showToast("선호 배우는 최대 2명까지만 선택하실 수 있습니다.");
                  return;
                }
                chip.classList.add("selected");
                selectedNolTarget.selectedCasts.push(cast);
              }

              const count = selectedNolTarget.selectedCasts.length;
              if (castCountBadge) castCountBadge.textContent = `${count}/2명 선택`;
            });

            castChipsGrid.appendChild(chip);
          });
        } else {
          castSection.style.display = "none";
        }
      }

      // 회차 선택 칩 렌더링
      if (nolSessionsChips) {
        nolSessionsChips.innerHTML = "";

        // 전체 회차 칩 (기본 선택)
        const allChip = document.createElement("button");
        allChip.type = "button";
        allChip.className = "item-chip selected";
        allChip.innerHTML = `<strong>전체 회차 (추천)</strong><span style="font-size: 0.7rem; opacity: 0.8; display: block; margin-top: 2px;">어느 회차든 취소표 발생 시 즉시 푸시</span>`;
        allChip.addEventListener("click", () => {
          document.querySelectorAll("#nol-items-chips .item-chip").forEach(c => c.classList.remove("selected"));
          allChip.classList.add("selected");
          selectedNolTarget.selectedSessionSeq = "all";
          selectedNolTarget.selectedSessionLabel = "전체 회차 (취소표 감시)";
        });
        nolSessionsChips.appendChild(allChip);

        // 개별 회차 칩들
        (data.sessions || []).forEach(sess => {
          const chip = document.createElement("button");
          chip.type = "button";
          chip.className = "item-chip";
          chip.innerHTML = `<strong>${sess.label}</strong><span style="font-size: 0.7rem; opacity: 0.8; display: block; margin-top: 2px;">${sess.totalRemain > 0 ? `잔여 ${sess.totalRemain}석` : '전석 매진'}</span>`;
          chip.addEventListener("click", () => {
            document.querySelectorAll("#nol-items-chips .item-chip").forEach(c => c.classList.remove("selected"));
            chip.classList.add("selected");
            selectedNolTarget.selectedSessionSeq = sess.playSeq;
            selectedNolTarget.selectedSessionLabel = sess.label;
          });
          nolSessionsChips.appendChild(chip);
        });
      }

      if (btnSubmitNol) btnSubmitNol.disabled = false;
    } catch (err) {
      if (nolPreviewCard) {
        nolPreviewCard.innerHTML = `<span style="color: #ef4444;">❌ 조회 실패: ${err.message}</span>`;
      }
      selectedNolTarget = null;
      if (btnSubmitNol) btnSubmitNol.disabled = true;
    }
  }

  // 놀티켓 예약 추가 버튼
  if (btnSubmitNol) {
    btnSubmitNol.addEventListener("click", async () => {
      if (!selectedNolTarget) return;

      btnSubmitNol.disabled = true;
      btnSubmitNol.innerHTML = `<span>등록 중...</span>`;

      let finalItemName = selectedNolTarget.selectedSessionLabel || "전체 회차";
      if (selectedNolTarget.selectedCasts && selectedNolTarget.selectedCasts.length > 0) {
        const castStr = selectedNolTarget.selectedCasts.map(c => c.name).join(", ");
        finalItemName = `[캐스트: ${castStr}] ${finalItemName}`;
      }

      const newRes = {
        id: "res_" + Date.now(),
        naver_url: `https://nol.yanolja.com/ticket/products/${selectedNolTarget.goodsCode}`,
        business_type_id: 99,
        business_id: selectedNolTarget.goodsCode,
        biz_item_id: selectedNolTarget.selectedSessionSeq || "all",
        biz_name: selectedNolTarget.bizName,
        item_name: finalItemName,
        is_active: true,
        last_slots: []
      };

      await saveNewReservation(newRes);

      if (nolSearchInput) nolSearchInput.value = "";
      if (btnClearNolSearch) btnClearNolSearch.style.display = "none";
      if (nolPreviewCard) nolPreviewCard.style.display = "none";
      if (nolItemPickerCard) nolItemPickerCard.style.display = "none";
      selectedNolTarget = null;
      btnSubmitNol.disabled = false;
      btnSubmitNol.innerHTML = `<span>+ 콘서트 취켓팅 모니터링 추가</span>`;

      await renderReservationsList();
      showToast(`🎉 [${newRes.biz_name}] 취켓팅 모니터링이 추가되었습니다!`);
    });
  }

  // -------------------------------------------------------------------------
  // B. 실시간 업체명 검색 (Live Autocomplete Search)
  // -------------------------------------------------------------------------
  const searchInput = document.getElementById("search-input");
  const searchSpinner = document.getElementById("search-spinner");
  const btnClearSearch = document.getElementById("btn-clear-search");
  const searchResults = document.getElementById("search-results");
  const itemPickerCard = document.getElementById("item-picker-card");
  const selectedBizCat = document.getElementById("selected-biz-cat");
  const selectedBizName = document.getElementById("selected-biz-name");
  const selectedBizAddr = document.getElementById("selected-biz-addr");
  const itemsChips = document.getElementById("items-chips");
  const btnReselect = document.getElementById("btn-reselect");
  const btnSubmitSearch = document.getElementById("btn-submit-search");

  searchInput.addEventListener("input", (e) => {
    const val = e.target.value.trim();
    btnClearSearch.style.display = val ? "flex" : "none";

    clearTimeout(searchDebounceTimer);
    if (!val) {
      searchResults.style.display = "none";
      searchResults.innerHTML = "";
      return;
    }

    searchDebounceTimer = setTimeout(() => {
      performLiveSearch(val);
    }, 280);
  });

  btnClearSearch.addEventListener("click", () => {
    searchInput.value = "";
    btnClearSearch.style.display = "none";
    searchResults.style.display = "none";
    searchResults.innerHTML = "";
    searchInput.focus();
  });

  async function performLiveSearch(query) {
    searchSpinner.textContent = "⏳";
    searchSpinner.classList.add("spin");

    try {
      const resp = await fetch(`${API_BASE_URL}/api/search?q=${encodeURIComponent(query)}`);
      const data = await resp.json();
      const list = data.results || [];

      renderSearchResults(list, query);
    } catch (err) {
      console.error("검색 요청 오류:", err);
      searchResults.style.display = "flex";
      searchResults.innerHTML = `<div class="search-item-empty">검색 중 오류가 발생했습니다.</div>`;
    } finally {
      searchSpinner.textContent = "🔍";
      searchSpinner.classList.remove("spin");
    }
  }

  function renderSearchResults(places, query) {
    searchResults.innerHTML = "";

    if (places.length === 0) {
      searchResults.style.display = "flex";
      searchResults.innerHTML = `<div class="search-item-empty">'${query}'에 대한 네이버 검색 결과가 없습니다.</div>`;
      return;
    }

    places.forEach(place => {
      const itemEl = document.createElement("div");
      itemEl.className = "search-item";
      itemEl.innerHTML = `
        <div class="search-item-top">
          <span class="search-item-title">${place.title}</span>
          ${place.category ? `<span class="search-item-cat">${place.category}</span>` : ""}
        </div>
        ${place.address ? `<span class="search-item-addr">📍 ${place.address}</span>` : ""}
      `;

      itemEl.addEventListener("click", () => {
        handlePlaceSelected(place);
      });

      searchResults.appendChild(itemEl);
    });

    searchResults.style.display = "flex";
  }

  async function handlePlaceSelected(place) {
    searchResults.style.display = "none";
    searchInput.value = place.title;
    btnClearSearch.style.display = "flex";

    selectedSearchTarget = {
      businessId: String(place.businessId || place.id),
      businessTypeId: 13,
      bizName: place.title,
      category: place.category || "예약",
      address: place.address || "주소 정보 없음",
      itemId: null,
      itemName: ""
    };

    // UI 표시 갱신
    selectedBizName.textContent = place.title;
    selectedBizCat.textContent = place.category || "네이버 예약";
    selectedBizAddr.textContent = place.address ? `📍 ${place.address}` : "";
    itemsChips.innerHTML = `<span>⏳ 원장님 및 예약 항목 불러오는 중...</span>`;
    itemPickerCard.style.display = "flex";
    btnSubmitSearch.disabled = true;

    // 네이버 예약 상품/원장님 목록 조회 (플레이스 ID 자동 역추적 포함)
    try {
      const resp = await fetch(`${API_BASE_URL}/api/items?businessId=${encodeURIComponent(selectedSearchTarget.businessId)}`);
      const data = await resp.json();
      const items = data.items || [];
      if (data.businessId) {
        selectedSearchTarget.businessId = String(data.businessId);
      }
      if (data.businessTypeId) {
        selectedSearchTarget.businessTypeId = data.businessTypeId;
      }
      if (data.business?.name) {
        selectedSearchTarget.bizName = data.business.name;
        selectedBizName.textContent = data.business.name;
      }

      if (items.length > 0) {
        itemsChips.innerHTML = "";
        const label = document.getElementById("items-wrap")?.querySelector(".items-label");
        if (label) {
          label.textContent = items.length > 1 ? `👨‍⚕️ 원장님 / 예약 항목을 선택해주세요 (${items.length}개):` : "예약 항목 선택:";
        }

        items.forEach((it, idx) => {
          const chip = document.createElement("button");
          chip.type = "button";
          chip.className = "item-chip" + (idx === 0 ? " selected" : "");
          chip.innerHTML = `<strong>${it.name}</strong>${it.desc ? `<span style="font-size: 0.7rem; opacity: 0.8; display: block; margin-top: 2px;">${it.desc.slice(0, 25)}...</span>` : ''}`;
          chip.addEventListener("click", () => {
            document.querySelectorAll("#items-chips .item-chip").forEach(c => c.classList.remove("selected"));
            chip.classList.add("selected");
            selectedSearchTarget.itemId = it.id;
            selectedSearchTarget.itemName = it.name;
            btnSubmitSearch.disabled = false;
          });
          itemsChips.appendChild(chip);
        });

        // 첫 번째 상품 자동 선택
        selectedSearchTarget.itemId = items[0].id;
        selectedSearchTarget.itemName = items[0].name;
        btnSubmitSearch.disabled = false;
      } else {
        itemsChips.innerHTML = `<span style="font-size: 0.8rem; color: var(--text-muted);">기본 예약 항목</span>`;
        selectedSearchTarget.itemId = "1";
        selectedSearchTarget.itemName = "기본 예약";
        btnSubmitSearch.disabled = false;
      }
    } catch (err) {
      console.warn("상품 목록 조회 실패:", err);
      itemsChips.innerHTML = `<span style="font-size: 0.8rem; color: var(--text-muted);">기본 예약 항목</span>`;
      selectedSearchTarget.itemId = "1";
      selectedSearchTarget.itemName = "기본 예약";
      btnSubmitSearch.disabled = false;
    }
  }

  btnReselect.addEventListener("click", () => {
    itemPickerCard.style.display = "none";
    selectedSearchTarget = null;
    btnSubmitSearch.disabled = true;
    searchInput.focus();
    if (searchInput.value.trim()) {
      performLiveSearch(searchInput.value.trim());
    }
  });

  // 검색 모드에서 예약 추가
  btnSubmitSearch.addEventListener("click", async () => {
    if (!selectedSearchTarget) return;

    btnSubmitSearch.disabled = true;
    btnSubmitSearch.innerHTML = `<span>등록 중...</span>`;

    const bizId = selectedSearchTarget.businessId;
    const itemId = selectedSearchTarget.itemId || "1";
    const typeId = selectedSearchTarget.businessTypeId || 13;
    const baseNaverUrl = `https://m.booking.naver.com/booking/${typeId}/bizes/${bizId}/items/${itemId}`;
    const finalNaverUrl = attachDateRangeToUrl(baseNaverUrl, "search");

    const newRes = {
      id: "res_" + Date.now(),
      naver_url: finalNaverUrl,
      business_type_id: typeId,
      business_id: bizId,
      biz_item_id: itemId,
      biz_name: selectedSearchTarget.bizName,
      item_name: selectedSearchTarget.itemName || "기본 예약",
      is_active: true,
      last_slots: []
    };

    await saveNewReservation(newRes);

    // 초기화
    searchInput.value = "";
    btnClearSearch.style.display = "none";
    itemPickerCard.style.display = "none";
    searchResults.style.display = "none";
    selectedSearchTarget = null;
    btnSubmitSearch.disabled = true;
    btnSubmitSearch.innerHTML = `<span>+ 이 예약 모니터링 추가</span>`;

    await renderReservationsList();
    showToast(`🎉 [${newRes.biz_name}] 예약 감시가 등록되었습니다!`);
  });

  // -------------------------------------------------------------------------
  // C. URL 직접 입력 모드 (네이버 + 놀티켓/인터파크 지원)
  // -------------------------------------------------------------------------
  const urlInput = document.getElementById("url-input");
  const btnPaste = document.getElementById("btn-paste");
  const btnSubmit = document.getElementById("btn-submit");
  const previewBox = document.getElementById("preview-card");
  const urlItemPickerCard = document.getElementById("url-item-picker-card");
  const urlItemsChips = document.getElementById("url-items-chips");
  const urlItemsLabel = document.getElementById("url-items-label");

  btnPaste.addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      urlInput.value = text;
      handleUrlInput(text);
    } catch (e) {
      showToast("클립보드 읽기 권한이 필요합니다.");
    }
  });

  urlInput.addEventListener("input", (e) => {
    handleUrlInput(e.target.value.trim());
  });

  async function handleUrlInput(val) {
    const parsed = parseAnyBookingUrl(val);
    if (!parsed) {
      parsedCurrentTarget = null;
      previewBox.style.display = "none";
      if (urlItemPickerCard) urlItemPickerCard.style.display = "none";
      btnSubmit.disabled = true;
      return;
    }

    parsedCurrentTarget = parsed;
    previewBox.style.display = "flex";
    previewBox.innerHTML = `<span>⏳ 예약 정보 조회 중...</span>`;
    if (urlItemPickerCard) urlItemPickerCard.style.display = "none";
    btnSubmit.disabled = true;

    const info = await fetchPreviewInfo(parsed);
    parsedCurrentTarget.bizName = info.bizName;

    if (parsed.platform === "catchtable") {
      parsedCurrentTarget.itemName = "전체 예약 일정 (빈자리 감시)";
      parsedCurrentTarget.bizItemId = "all";
      parsedCurrentTarget.businessId = info.shopRef || parsed.businessId;

      const avail = info.availableDates || [];
      const availText = avail.length > 0 
        ? `<span style="color: #4ade80; font-weight: 700;">${avail.length}개 날짜 예약 가능!</span>`
        : `<span style="color: #ff7a59; font-weight: 700;">전 일정 마감 (빈자리 대기)</span>`;

      previewBox.innerHTML = `
        <div style="display: flex; flex-direction: column; gap: 4px;">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span class="biz-badge" style="background: linear-gradient(135deg, #ff5238, #ff7a59);">캐치테이블</span>
            <strong>${info.bizName}</strong>
          </div>
          <div style="color: var(--text-muted); font-size: 0.75rem;">📍 ${info.address || '위치 확인 중'} | 실시간 빈자리 알림 모드</div>
        </div>
        ${availText}
      `;

      if (urlItemPickerCard && urlItemsChips) {
        urlItemsLabel.textContent = "🍽️ 예약 가능 날짜 현황:";
        urlItemsChips.innerHTML = "";

        const allChip = document.createElement("button");
        allChip.type = "button";
        allChip.className = "item-chip selected";
        allChip.textContent = "✨ 전체 빈자리 감시 (추천)";
        allChip.addEventListener("click", () => {
          document.querySelectorAll("#url-items-chips .item-chip").forEach(c => c.classList.remove("selected"));
          allChip.classList.add("selected");
          parsedCurrentTarget.bizItemId = "all";
          parsedCurrentTarget.itemName = "전체 예약 일정 (빈자리 감시)";
        });
        urlItemsChips.appendChild(allChip);

        avail.forEach(d => {
          const chip = document.createElement("button");
          chip.type = "button";
          chip.className = "item-chip";
          const pCounts = d.availablePersonCounts || [];
          chip.textContent = `${d.date} (${pCounts.join(",")}명)`;
          chip.addEventListener("click", () => {
            document.querySelectorAll("#url-items-chips .item-chip").forEach(c => c.classList.remove("selected"));
            chip.classList.add("selected");
            parsedCurrentTarget.bizItemId = d.date;
            parsedCurrentTarget.itemName = `${d.date} 예약`;
          });
          urlItemsChips.appendChild(chip);
        });

        urlItemPickerCard.style.display = "flex";
      }

      btnSubmit.disabled = false;
      return;
    }

    if (parsed.platform === "nol_ticket") {
      parsedCurrentTarget.itemName = "전체 회차 (취켓팅)";
      parsedCurrentTarget.bizItemId = "all";

      previewBox.innerHTML = `
        <div style="display: flex; flex-direction: column; gap: 4px;">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span class="biz-badge" style="background: linear-gradient(135deg, #8b5cf6, #6366f1);">놀티켓·인터파크</span>
            <strong>${info.bizName}</strong>
          </div>
          <div style="color: var(--text-muted); font-size: 0.75rem;">📍 ${info.venue} | 취켓팅 자동 감지 모드</div>
        </div>
        <span style="color: #a78bfa; font-weight: 700;">인식 완료 ✔</span>
      `;

      // 회차 선택 칩 렌더링
      if (urlItemPickerCard && urlItemsChips) {
        urlItemsLabel.textContent = "🎫 예매 희망 회차 선택:";
        urlItemsChips.innerHTML = "";

        // 전체 회차 옵션
        const allChip = document.createElement("button");
        allChip.type = "button";
        allChip.className = "item-chip selected";
        allChip.textContent = "✨ 전체 회차 모니터링 (취켓팅 강력 추천)";
        allChip.addEventListener("click", () => {
          document.querySelectorAll("#url-items-chips .item-chip").forEach(c => c.classList.remove("selected"));
          allChip.classList.add("selected");
          parsedCurrentTarget.bizItemId = "all";
          parsedCurrentTarget.itemName = "전체 회차 (취켓팅)";
        });
        urlItemsChips.appendChild(allChip);

        // 개별 회차 옵션
        (info.sessions || []).forEach(sess => {
          const chip = document.createElement("button");
          chip.type = "button";
          chip.className = "item-chip";
          chip.textContent = sess.label;
          chip.addEventListener("click", () => {
            document.querySelectorAll("#url-items-chips .item-chip").forEach(c => c.classList.remove("selected"));
            chip.classList.add("selected");
            parsedCurrentTarget.bizItemId = sess.playSeq;
            parsedCurrentTarget.itemName = sess.label;
          });
          urlItemsChips.appendChild(chip);
        });

        urlItemPickerCard.style.display = "flex";
      }

      btnSubmit.disabled = false;
      return;
    }

    // 네이버 예약인 경우
    if (info.items && info.items.length > 0) {
      if (info.businessId) parsedCurrentTarget.businessId = info.businessId;
      if (info.businessTypeId) parsedCurrentTarget.type = info.businessTypeId;

      previewBox.innerHTML = `
        <div style="display: flex; flex-direction: column; gap: 4px;">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span class="biz-badge">네이버 예약</span>
            <strong>${info.bizName}</strong>
          </div>
          <div style="color: var(--text-muted); font-size: 0.75rem;">하단에서 원하시는 원장님 또는 항목을 선택해주세요.</div>
        </div>
        <span style="color: var(--naver-green); font-weight: 700;">인식 완료 ✔</span>
      `;

      if (urlItemPickerCard && urlItemsChips) {
        urlItemsLabel.textContent = `👨‍⚕️ 예약하실 원장님 / 상세 항목을 선택하세요 (${info.items.length}개):`;
        urlItemsChips.innerHTML = "";

        info.items.forEach((it, idx) => {
          const chip = document.createElement("button");
          chip.type = "button";
          chip.className = "item-chip" + (idx === 0 ? " selected" : "");
          chip.innerHTML = `<strong>${it.name}</strong>${it.desc ? `<span style="font-size: 0.7rem; opacity: 0.8; display: block; margin-top: 2px;">${it.desc.slice(0, 25)}...</span>` : ''}`;
          chip.addEventListener("click", () => {
            document.querySelectorAll("#url-items-chips .item-chip").forEach(c => c.classList.remove("selected"));
            chip.classList.add("selected");
            parsedCurrentTarget.bizItemId = it.id;
            parsedCurrentTarget.itemName = it.name;
          });
          urlItemsChips.appendChild(chip);
        });

        parsedCurrentTarget.bizItemId = info.items[0].id;
        parsedCurrentTarget.itemName = info.items[0].name;
        urlItemPickerCard.style.display = "flex";
      }
      btnSubmit.disabled = false;
    } else {
      parsedCurrentTarget.itemName = info.itemName || "기본 항목";
      previewBox.innerHTML = `
        <div>
          <strong>${info.bizName}</strong>
          <div style="color: var(--text-muted); font-size: 0.75rem;">${parsedCurrentTarget.itemName} (ID: ${parsed.businessId})</div>
        </div>
        <span style="color: var(--naver-green); font-weight: 700;">인식 완료 ✔</span>
      `;
      if (urlItemPickerCard) urlItemPickerCard.style.display = "none";
      btnSubmit.disabled = false;
    }
  }

  // URL 모드 예약 추가 버튼
  btnSubmit.addEventListener("click", async () => {
    if (!parsedCurrentTarget) return;

    btnSubmit.disabled = true;
    btnSubmit.innerHTML = `<span>등록 중...</span>`;

    const baseInputUrl = urlInput.value.trim();
    let finalUrl = baseInputUrl;
    if (parsedCurrentTarget.platform === "naver") {
      finalUrl = attachDateRangeToUrl(baseInputUrl, "url");
    } else if (parsedCurrentTarget.platform === "catchtable") {
      finalUrl = baseInputUrl.startsWith("http") ? baseInputUrl : `https://app.catchtable.co.kr/ct/shop/${parsedCurrentTarget.businessId}`;
    }

    const newRes = {
      id: "res_" + Date.now(),
      naver_url: finalUrl,
      business_type_id: parsedCurrentTarget.type,
      business_id: parsedCurrentTarget.businessId,
      biz_item_id: parsedCurrentTarget.bizItemId || "all",
      biz_name: parsedCurrentTarget.bizName,
      item_name: parsedCurrentTarget.itemName || "기본 예약",
      is_active: true,
      last_slots: []
    };

    await saveNewReservation(newRes);

    urlInput.value = "";
    previewBox.style.display = "none";
    if (urlItemPickerCard) urlItemPickerCard.style.display = "none";
    parsedCurrentTarget = null;
    btnSubmit.disabled = false;
    btnSubmit.innerHTML = `<span>+ 예약 모니터링 추가</span>`;

    await renderReservationsList();
    showToast(`🎉 [${newRes.biz_name}] 모니터링이 추가되었습니다!`);
  });

  // -------------------------------------------------------------------------
  // D. Web Share Target (공유하기) & 클립보드 자동 연동 매니저
  // -------------------------------------------------------------------------
  const shareDetectBanner = document.getElementById("share-detect-banner");
  const shareDetectTitle = document.getElementById("share-detect-title");
  const shareDetectUrl = document.getElementById("share-detect-url");
  const btnShareApply = document.getElementById("btn-share-apply");
  const btnShareDismiss = document.getElementById("btn-share-dismiss");

  function extractUrlFromText(text) {
    if (!text) return null;
    const match = text.match(/https?:\/\/[^\s"'<>]+/);
    return match ? match[0] : null;
  }

  function handleSharedUrl(rawUrl) {
    if (!rawUrl) return;
    const cleanUrl = rawUrl.trim();
    const parsed = parseAnyBookingUrl(cleanUrl);
    if (!parsed) return;

    if (parsed.platform === "catchtable") {
      switchTab(tabCt);
      if (ctSearchInput) {
        ctSearchInput.value = cleanUrl;
        if (btnClearCtSearch) btnClearCtSearch.style.display = "flex";
        performCtSearch(cleanUrl);
      }
    } else if (parsed.platform === "nol_ticket") {
      switchTab(tabNol);
      if (nolSearchInput) {
        nolSearchInput.value = cleanUrl;
        if (btnClearNolSearch) btnClearNolSearch.style.display = "flex";
        performNolSearch(cleanUrl);
      }
    } else {
      switchTab(tabUrl);
      if (urlInput) {
        urlInput.value = cleanUrl;
        handleUrlInput(cleanUrl);
      }
    }

    showToast("🔗 공유된 링크가 자동으로 인식되었습니다!");
  }

  // 1) Web Share Target 쿼리 파라미터 확인 (?url=... 또는 ?text=...)
  try {
    const urlParams = new URLSearchParams(window.location.search);
    const paramUrl = urlParams.get("url") || extractUrlFromText(urlParams.get("text")) || extractUrlFromText(urlParams.get("title"));
    if (paramUrl) {
      handleSharedUrl(paramUrl);
      if (window.history && window.history.replaceState) {
        window.history.replaceState({}, document.title, window.location.pathname);
      }
    }
  } catch (e) {}

  // 2) 공유/클립보드 감지 배너 제어
  if (btnShareDismiss && shareDetectBanner) {
    btnShareDismiss.addEventListener("click", () => {
      shareDetectBanner.style.display = "none";
    });
  }

  if (btnShareApply && shareDetectBanner) {
    btnShareApply.addEventListener("click", () => {
      const targetUrl = shareDetectBanner.dataset.targetUrl;
      shareDetectBanner.style.display = "none";
      if (targetUrl) {
        handleSharedUrl(targetUrl);
      }
    });
  }

  // 3) 앱 화면 복귀(Focus) 시 클립보드 자동 확인 (지원 브라우저)
  async function checkClipboardOnFocus() {
    if (!navigator.clipboard || !navigator.clipboard.readText) return;
    try {
      const clipText = await navigator.clipboard.readText();
      if (!clipText || clipText.length < 10) return;
      const detectedUrl = extractUrlFromText(clipText) || clipText;
      const parsed = parseAnyBookingUrl(detectedUrl);
      if (parsed && shareDetectBanner && shareDetectUrl && shareDetectTitle) {
        if (shareDetectBanner.dataset.lastChecked === detectedUrl) return;
        shareDetectBanner.dataset.targetUrl = detectedUrl;
        shareDetectBanner.dataset.lastChecked = detectedUrl;
        shareDetectTitle.textContent = parsed.platform === "catchtable" 
          ? "🍽️ 캐치테이블 공유 링크 감지" 
          : (parsed.platform === "nol_ticket" ? "🎫 놀티켓 공유 링크 감지" : "🔍 네이버 예약 링크 감지");
        shareDetectUrl.textContent = detectedUrl;
        shareDetectBanner.style.display = "flex";
      }
    } catch (e) {
      // 클립보드 권한 거부 시 무시
    }
  }

  if (typeof window !== "undefined") {
    window.addEventListener("focus", () => {
      setTimeout(checkClipboardOnFocus, 300);
    });
  }

  // 초기 예약 목록 렌더링
  await renderReservationsList();
});

