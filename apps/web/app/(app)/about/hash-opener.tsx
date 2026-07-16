'use client';

// DESIGN-034 D-04 — the deep-link leaf: /about#fix (and a same-page hash change) opens the
// matching <details> so a shared link never lands on a collapsed page. The only client code
// on the About page — everything else is static server TSX. Opening the target section can't
// re-orient it: every section above stays collapsed, so the anchor's position is unchanged
// (ADR-015); scrollIntoView then brings it to the top of the internally-scrolled <main>.
import { useEffect } from 'react';

export function HashOpener() {
  useEffect(() => {
    const openFromHash = () => {
      const id = window.location.hash.slice(1);
      if (!id) return;
      const el = document.getElementById(id);
      if (el instanceof HTMLDetailsElement) {
        el.open = true;
        el.scrollIntoView({ block: 'start' });
      }
    };
    openFromHash();
    window.addEventListener('hashchange', openFromHash);
    return () => window.removeEventListener('hashchange', openFromHash);
  }, []);
  return null;
}
