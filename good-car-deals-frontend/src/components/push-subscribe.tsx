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

async function doSubscribe(): Promise<void> {
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
}

/**
 * Push bootstrap with platform-differentiated prompting.
 * iOS Safari/WebKit refuses requestPermission() outside a user gesture,
 * so iOS devices always get the floating "Get notified" button.
 * Chrome/Android/Firefox/macOS request permission automatically; button stays hidden.
 */
export function PushSubscribe() {
  // State determines if button should be visible
  const [showButton, setShowButton] = useState(true);

  useEffect(() => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      return;
    }

    let cleanup: (() => void) | undefined;
    const detach = () => {
      cleanup?.();
      cleanup = undefined;
    };

    const subscribeAndDone = async () => {
      await doSubscribe();
      setShowButton(false);
    };

    const attachFirstTapHandler = () => {
      if (cleanup) return;
      const onFirstTap = () => {
        detach();
        Notification.requestPermission()
          .then((perm) => {
            if (perm === 'granted') return subscribeAndDone();
            setShowButton(false);
            return undefined;
          })
          .catch(() => {
            setShowButton(false);
            return undefined;
          });
      };
      document.addEventListener('click', onFirstTap, true);
      cleanup = () => document.removeEventListener('click', onFirstTap, true);
    };

    const run = async () => {
      await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      const registration = await navigator.serviceWorker.ready;
      if (await registration.pushManager.getSubscription()) return;

      if (Notification.permission === 'granted') {
        await subscribeAndDone();
        return;
      }
      if (Notification.permission === 'denied') return;

      // Try auto-prompt; on iOS this will fail but Safari doesn't throw.
      // If permission remains default, attach first-tap handler.
      try {
        const perm = await Notification.requestPermission();
        if (perm === 'granted') {
          await subscribeAndDone();
        } else if (perm === 'default') {
          attachFirstTapHandler();
        } else {
          setShowButton(false);
        }
      } catch {
        // Permission request threw or silently failed (likely iOS)
        // Button stays visible; first tap will trigger it
      }
    };

    run().catch((err) => console.error('Push setup failed:', err));
    return () => detach();
  }, []);

  if (!showButton) return null;

  return (
    <div
      data-pw-btn
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
        Notification.requestPermission()
          .then((perm) => {
            if (perm === 'granted') {
              return doSubscribe().then(() => setShowButton(false));
            }
            setShowButton(false);
            return undefined;
          })
          .catch(() => setShowButton(false));
      }}
    >
      Get notified of new deals
    </div>
  );
}
