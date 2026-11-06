'use client';

import { useEffect } from 'react';

const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? 'https://good-car-deals-api.onrender.com';
const VAPID_PUBLIC_KEY =
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ??
  'BD5OuOzLU9inVkJlOLWC4uP6SiNXTEbO7XDKa2Gnj1B4gN5a-igOa6Tu32zgGpOIT9r80Hsuabr9Ko0Ba3EMbyE';

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const bytes = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    bytes[i] = rawData.charCodeAt(i);
  }
  return bytes;
}

/**
 * Headless push bootstrap: nothing is rendered. On mount, registers the
 * service worker and — if push is supported — asks for notification
 * permission as soon as the app starts, then sends the subscription to the
 * API. Denied permission or a missing push API (iOS Safari before the app is
 * installed) stays silent and retries nothing.
 */
export function PushSubscribe() {
  useEffect(() => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      return;
    }

    const run = async () => {
      await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      const registration = await navigator.serviceWorker.ready;

      const existing = await registration.pushManager.getSubscription();
      if (existing) return;

      if (Notification.permission === 'denied') return;
      if (Notification.permission !== 'granted') {
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') return;
      }

      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(
          VAPID_PUBLIC_KEY,
        ) as unknown as BufferSource,
      });

      const res = await fetch(`${API_URL}/push/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(subscription),
      });
      if (!res.ok) {
        console.error('Push subscribe failed:', res.status);
      }
    };

    run().catch((err) => console.error('Push setup failed:', err));
  }, []);

  return null;
}
