'use client';

// DESIGN-004 D-07 — time-of-day greeting, computed client-side (the server clock may
// live in another timezone). Hydration-safe: SSR and the first client render show the
// neutral fallback; the local-clock greeting lands after mount.

import { useSyncExternalStore } from 'react';
import { GREETING_FALLBACK, greetingForHour } from '@/lib/greeting';

const emptySubscribe = () => () => {};

export function Greeting({ displayName }: { displayName: string }) {
  // Server snapshot = neutral fallback; client snapshot = local-clock greeting
  // (stable string within the hour, so no re-render churn).
  const greeting = useSyncExternalStore(
    emptySubscribe,
    () => greetingForHour(new Date().getHours()),
    () => GREETING_FALLBACK,
  );
  return (
    <h1 className="greeting">
      {greeting}, {displayName}
    </h1>
  );
}
