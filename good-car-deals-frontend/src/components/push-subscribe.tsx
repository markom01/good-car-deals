'use client';

import { useEffect, useState } from 'react';

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
 * iPadOS reports a desktop Mac user agent, so the plain UA test misses it.
 * `maxTouchPoints > 1` on a Mac UA is the established iPadOS tell.
 */
function isIosDevice(): boolean {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
  );
}

/**
 * Push bootstrap with platform-differentiated prompting. The component stays
 * invisible on Chrome/Android/Firefox, where the notification prompt is
 * requested automatically on mount (no UI). iOS Safari/WebKit refuses
 * requestPermission() outside a user gesture, so iOS devices get the floating
 * "Get notified" button back — tapping it is the gesture WebKit requires and
 * clicking it requests permission synchronously (any preceding await would
 * consume the gesture). Once permission is granted, subscribe() needs no
 * gesture, so a granted-but-unsubscribed device resubscribes silently
 * re-enabled on mount. Engines that reject the mount-time prompt without
 * being iOS (macOS Safari) fall back to requesting on the first tap.
 */
export function PushSubscribe() {
  const [showIosButton, setShowIosButton] = useState(false);

  useEffect(() => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      return;
    }

    let cleanup: (() => void) | undefined;
    const detach = () => {
      cleanup?.();
      cleanup = undefined;
    };

    const subscribe = async () => {
      const registration = await navigator.serviceWorker.ready;
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
      document.addEventListener('click', onFirstTap, true);
      cleanup = () => document.removeEventListener('click', onFirstTap, true);
    };

    const run = async () => {
      await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      const registration = await navigator.serviceWorker.ready;
      if (await registration.pushManager.getSubscription()) return;

      if (Notification.permission === 'granted') {
        await subscribe();
        return;
      }
      if (Notification.permission === 'denied') return;

      if (isIosDevice()) {
        setShowIosButton(true);
        return;
      }

      // Non-Apple engines permit a load-time prompt without a gesture.
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

    run().catch((err) => console.error('Push setup failed:', err));
    return () => detach();
  }, []);

  if (!showIosButton) return null;

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 24,
        right: 24,
        zIndex: 1000,
        background: '#14b8a6',
        color: '#ffffff',
        padding: '12px 20px',
        borderRadius: 32,
        fontFamily: 'system-ui, sans-serif',
        fontSize: 14,
        fontWeight: 600,
        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
        cursor: 'pointer',
      }}
      onClick={() => {
        // Must be the first await-free statement of the gesture handler.
        Notification.requestPermission()
          .then((perm) => {
            if (perm === 'granted') return subscribe();
            return undefined;
          })
          .catch(() => undefined)
          .finally(() => setShowIosButton(false));
      }}
    >
      Get notified of new deals
    </div>
  );
}
