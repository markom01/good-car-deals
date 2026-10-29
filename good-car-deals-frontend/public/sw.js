const VAPID_PUBLIC_KEY =
  'BD5OuOzLU9inVkJlOLWC4uP6SiNXTEbO7XDKa2Gnj1B4gN5a-igOa6Tu32zgGpOIT9r80Hsuabr9Ko0Ba3EMbyE';

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
  const options = {
    body: data.price
      ? `${data.title} — €${data.price}`
      : data.title || 'New car listing',
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
