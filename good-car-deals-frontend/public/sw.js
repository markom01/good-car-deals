function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = self.atob(base64String);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const details = [];
  if (data.price) details.push(`€${data.price}`);
  if (typeof data.dealScore === 'number') {
    details.push(`Score ${data.dealScore}/100`);
  }
  if (typeof data.deviationPct === 'number') {
    const pct = Math.round(Math.abs(data.deviationPct));
    const direction =
      data.deviationPct > 0
        ? 'below typical'
        : data.deviationPct < 0
          ? 'above typical'
          : 'at typical';
    details.push(`${pct}% ${direction}`);
  }
  const options = {
    body: details.join(' · '),
    tag: data.id || 'new-ad',
    badge: '/wheelrank-logo.svg',
    icon: '/wheelrank-logo.svg',
    data: { link: data.link || '/' },
    requireInteraction: true,
  };
  event.waitUntil(
    self.registration.showNotification(data.title || 'Good Car Deals', options),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = event.notification.data && event.notification.data.link;
  event.waitUntil(clients.openWindow(link || '/'));
});
