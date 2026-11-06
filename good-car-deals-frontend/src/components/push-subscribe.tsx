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
 * Headless push bootstrap: nothing is rendered. On mount it registers the
 * service worker and tries to ask for notification permission right away
 * (Chromium/Firefox allow this without a click). iOS Safari refuses to show
 * the prompt outside a user gesture, so when the automatic attempt fails the
 * request is re-run inside the first tap anywhere on the page instead.
 * Denied permission or a missing push API (iOS Safari outside the installed
 * Home-Screen app) stays silent.
 */
export function PushSubscribe() {
  useEffect(() => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      return;
    }

    let cleanup: (() => void) | undefined;

    const subscribe = async () => {
      const registration = await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      if (existing) return;

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

    const askOrWaitForGesture = async () => {
      if (Notification.permission === 'denied') return;
      if (Notification.permission === 'granted') {
        await subscribe();
        return;
      }

      // iOS requires requestPermission() to run inside a user gesture, so the
      // bare call either throws or resolves 'default'. A failure now is not
      // final: retry inside the first tap (a real gesture) instead.
      try {
        const perm = await Notification.requestPermission();
        if (perm === 'granted') {
          await subscribe();
        } else {
          attachFirstTapListener();
        }
      } catch {
        attachFirstTapListener();
      }
    };

    const attachFirstTapListener = () => {
      if (cleanup) return;
      const onFirstTap = () => {
        detach();
        Notification.requestPermission()
          .then((perm) => {
            if (perm === 'granted') return subscribe();
            return undefined;
          })
          .catch(() => undefined);
      };
      // Capture so nav taps of links that leave the page still have the
      // gesture-attached prompt started before unloading.
      document.addEventListener('click', onFirstTap, true);
      cleanup = () => document.removeEventListener('click', onFirstTap, true);
    };
    const detach = () => {
      cleanup?.();
      cleanup = undefined;
    };

    const run = async () => {
      await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      await askOrWaitForGesture();
    };

    run().catch((err) => console.error('Push setup failed:', err));
    return () => detach();
  }, []);

  return null;
}
