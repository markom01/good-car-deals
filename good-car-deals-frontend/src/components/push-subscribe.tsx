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
 * "Get notified" button back — tapping it is the gesture WebKit requires.
 * Once permission is granted, subscribe() needs no gesture, so a granted-but-
 * unsubscribed device resubscribes silently on mount.
 * DEBUG: force show iOS button locally for testing.
 */
export function PushSubscribe() {
  // DEBUG: set to true to force-show the button locally
  const [showIosButton, setShowIosButton] = useState(
    process.env.NODE_ENV === 'development' ? true : false,
  );

  if (!showIosButton) return null;

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
            if (perm === 'granted') return doSubscribe();
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
