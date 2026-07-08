'use client';

// DESIGN-005 D-17 amendment (2026-07-07) — the context-aware "← <Label>" back affordance for
// /library/[id]. The label + fallback href come from the FIXED `?from=` dictionary (lib/back-link,
// never a raw URL — no open-redirect surface). Behaviour: when the previous history entry is in-app
// (Next App Router keeps an `idx` on history.state — 0 only for a fresh/deep-linked entry), a click
// calls history.back() so scroll position and the origin's filters/tab are preserved; otherwise it
// navigates to the mapped target. Renders a real <Link href> so it works without JS and for
// middle-click / open-in-new-tab.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { MouseEvent } from 'react';
import { resolveBackLink } from '@/lib/back-link';

interface NavigationLike {
  canGoBack?: boolean;
}

/**
 * True when history.back() would stay inside the app (a soft nav landed us here), so going back
 * preserves the origin's scroll/filters. The Navigation API's `canGoBack` (Chromium) is the
 * authoritative same-origin back signal; older engines fall back to Next's history.state.idx,
 * then a same-origin referrer (covers a hard load from an in-app page). A fresh/deep-linked tab
 * has none of these ⇒ we navigate to the mapped target instead.
 */
function previousEntryIsInApp(): boolean {
  const nav = (window as unknown as { navigation?: NavigationLike }).navigation;
  if (nav !== undefined && typeof nav.canGoBack === 'boolean') return nav.canGoBack;
  try {
    const idx = (window.history.state as { idx?: unknown } | null)?.idx;
    if (typeof idx === 'number') return idx > 0;
  } catch {
    // history.state read can throw in locked-down embeds — fall through to the referrer check.
  }
  try {
    return (
      document.referrer !== '' && new URL(document.referrer).origin === window.location.origin
    );
  } catch {
    return false;
  }
}

export function BackLink({ from }: { from: string | null }) {
  const router = useRouter();
  const target = resolveBackLink(from);

  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    // Respect new-tab / modified clicks — let the browser handle the real href.
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) {
      return;
    }
    if (previousEntryIsInApp()) {
      e.preventDefault();
      router.back();
    }
    // else: fall through to the <Link> navigation to target.href.
  };

  return (
    <p className="crumbs">
      <Link href={target.href} data-testid="back-link" onClick={onClick}>
        ← {target.label}
      </Link>
    </p>
  );
}
