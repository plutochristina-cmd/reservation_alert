// =========================================================================
// 네이버 예약 알리미 PWA 서비스 워커 (public/sw.js)
// 백그라운드 푸시 수신 및 알림 터치 시 네이버 예약 페이지 연결
// =========================================================================

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// 1. 백그라운드 푸시 알림 수신 이벤트
self.addEventListener("push", (event) => {
  let data = {
    title: "🔔 네이버 예약 빈자리 알림!",
    body: "새로운 예약 가능한 슬롯이 감지되었습니다.",
    url: "https://booking.naver.com/",
    icon: "/icon-192.png",
    badge: "/icon-192.png"
  };

  if (event.data) {
    try {
      const parsed = event.data.json();
      data = Object.assign(data, parsed);
    } catch (e) {
      data.body = event.data.text();
    }
  }

  const options = {
    body: data.body,
    icon: data.icon || "/icon-192.png",
    badge: data.badge || "/icon-192.png",
    vibrate: [200, 100, 200, 100, 200],
    tag: data.tag || "naver-booking-alert",
    renotify: true,
    requireInteraction: true,
    data: {
      url: data.url
    }
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// 2. 푸시 알림 터치 시 해당 네이버 예약 페이지로 열기
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const targetUrl = event.notification.data?.url || "https://m.booking.naver.com/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      // 이미 열려 있는 탭이 있으면 해당 탭에서 targetUrl로 이동 및 포커스
      for (const client of clientList) {
        if ("focus" in client) {
          client.focus();
          if ("navigate" in client) {
            return client.navigate(targetUrl);
          }
          return;
        }
      }
      // 열려 있는 창이 없으면 새 창으로 네이버 예약 페이지 열기
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
