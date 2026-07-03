'use client';

// Measured available height for a box (ADR-005 / DESIGN-004 D-05; ported from
// demo-console). Tracks the ref element's content-box height via ResizeObserver
// so a section can derive an explicit pixel budget for panes that need one.
// Returns 0 until first measured.
//
// Port note: the ref parameter is `RefObject<HTMLElement | null>` (donor said
// `RefObject<HTMLElement>`) — under the React 19 types, `useRef<T>(null)` yields
// `RefObject<T | null>`, so this is the shape every caller actually holds.

import { useEffect, useState } from 'react';
import type { RefObject } from 'react';

export function useAvailableHeight(ref: RefObject<HTMLElement | null>): number {
  const [height, setHeight] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        // Prefer the content-box measurement when available.
        const box = entry.contentBoxSize?.[0];
        if (box) {
          setHeight(box.blockSize);
        } else {
          setHeight(entry.contentRect.height);
        }
      }
    });

    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);

  return height;
}
