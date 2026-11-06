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
 * Push bootstrap with platform-optimized prompting.
 * - Chrome/Android/Firefox/macOS: auto-prompt on mount, button hidden after
 * - iOS Safari/Home Screen PWA: button visible, tap triggers prompt (gesture required)
 */
export function PushSubscribe() {
  // Start with button visible; hide only after grant or when we know auto-prompt worked
  const [showButton, setShowButton] = useState(true);

  useEffect(() => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      return;
    }

    let clickHandler: (() => void) | undefined;

    const detach = () => {
      if (clickHandler) {
        document.removeEventListener('click', clickHandler, true);
        clickHandler = undefined;
      }
    };

    const doSubscribeAndSetDismiss = async () => {
      await doSubscribe();
      setShowButton(false);
    };

    const tryAutoPrompt = async () => {
      if (Notification.permission === 'granted') {
        await doSubscribeAndSetDismiss();
        return;
      }
      if (Notification.permission === 'denied') {
        // Already denied, keep button hidden (or don't show it)
        setShowButton(false);
        return;
      }

      try {
        const perm = await Notification.requestPermission();
        if (perm === 'granted') {
          await doSubscribeAndSetDismiss();
        } else if (perm === 'denied') {
          setShowButton(false);
        }
        // If perm === 'default', button stays visible; user must tap
      } catch {
        // Permission request failed; button stays for tap handler
      }
    };

    const startTapHandler = () => {
      // On the first tap, try requesting permission (valid gesture context)
      clickHandler = () => {
        detach();
        Notification.requestPermission()
          .then((perm) => {
            if (perm === 'granted') {
              return doSubscribeAndSetDismiss();
            }
            // Denied or default - hide button, user may retry later
            setShowButton(false);
            return undefined;
          })
          .catch(() => setShowButton(false));
      };
      document.addEventListener('click', clickHandler, true);
    };

    const run = async () => {
      await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      const registration = await navigator.serviceWorker.ready;

      // Already subscribed - dismiss button
      if (await registration.pushManager.getSubscription()) {
        setShowButton(false);
        return;
      }

      await tryAutoPrompt();

      // If button still visible and permission is 'default', we need a tap
      if (showButton && Notification.permission === 'default') {
        startTapHandler();
      }
    };

    run().catch((err) => console.error('Push setup failed:', err));
    return detach;
  }, [showButton]);

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
