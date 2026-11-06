'use client';

import { useLayoutEffect, useState } from 'react';

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
 * Push notification subscription component.
 * Button is always visible - on tap it requests permission and subscribes.
 */
export function PushSubscribe() {
  const [mounted, setMounted] = useState(false);

  useLayoutEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, []);

  if (!mounted) return null;

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
      onClick={async () => {
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
          return;
        }

        const perm = await Notification.requestPermission();
        if (perm === 'granted') {
          await doSubscribe();
        }
        // Button stays visible - user can tap again if needed
      }}
    >
      Get notified of new deals
    </div>
  );
}
