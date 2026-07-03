'use client';

// DESIGN-004 D-08 — chrome: brand block, theme toggle, user menu. Ported from the
// demo-console TopBar (inline currentColor SVGs, token styling) minus i18n and
// notifications; plus the theme toggle and the user menu popover. No theme-dependent
// JSX on first render (labels resolve post-mount) so hydration never mismatches the
// pre-stamped `data-theme` (D-03). Under 480px the user-menu name collapses to the
// avatar initial via CSS (D-06).

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTheme } from '@hnet/ui';
import { BrandMark } from '@/components/brand-mark';
import { authClient } from '@/lib/auth-client';
import { initialFor } from '@/lib/initials';

export interface TopBarUser {
  displayName: string;
  email: string;
  role: string;
}

const emptySubscribe = () => () => {};

function ThemeToggle() {
  const { current, setTheme } = useTheme();
  // Hydration-safe labeling: the server snapshot keeps SSR and the first client
  // render on the neutral label; the theme-specific label lands right after
  // hydration (the glyphs themselves are CSS-driven off [data-theme]).
  const mounted = useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );
  const label = !mounted
    ? 'Toggle theme'
    : current === 'hnet-dark'
      ? 'Switch to light theme'
      : 'Switch to dark theme';

  return (
    <button
      type="button"
      className="iconbtn"
      aria-label={label}
      aria-pressed={mounted ? current === 'hnet-light' : false}
      onClick={() => setTheme(current === 'hnet-dark' ? 'hnet-light' : 'hnet-dark')}
    >
      {/* Both glyphs stay in the DOM; [data-theme] CSS shows exactly one (D-08). */}
      <svg
        className="icon-sun"
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4m11.4-11.4 1.4-1.4" />
      </svg>
      <svg
        className="icon-moon"
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
      </svg>
    </button>
  );
}

function UserMenu({ user }: { user: TopBarUser }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Esc closes and returns focus to the trigger; click-outside closes (D-08).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  async function signOut() {
    setSigningOut(true);
    try {
      await authClient.signOut();
    } finally {
      // Refresh re-runs the server layouts, whose session gate lands on /login.
      router.push('/login');
      router.refresh();
    }
  }

  return (
    <div className="usermenu" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className="usermenu__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="avatar" aria-hidden="true">
          {initialFor(user.displayName)}
        </span>
        <span className="usermenu__name">{user.displayName}</span>
        <svg
          className="usermenu__caret"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-9" transform="translate(0 -1.5)" />
        </svg>
      </button>
      {open ? (
        <div className="usermenu__popover" role="menu" aria-label="Account">
          <div className="usermenu__header">
            <span className="usermenu__display">{user.displayName}</span>
            <span className="usermenu__email">{user.email}</span>
          </div>
          {user.role === 'Admin' ? (
            <Link
              href="/admin"
              role="menuitem"
              className="usermenu__item"
              onClick={() => setOpen(false)}
            >
              Admin
            </Link>
          ) : null}
          <button
            type="button"
            role="menuitem"
            className="usermenu__item"
            disabled={signingOut}
            onClick={() => void signOut()}
          >
            {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function TopBar({ user }: { user: TopBarUser }) {
  return (
    <header className="topbar">
      <div className="brand">
        {/* DESIGN-006 D-01: the hub-and-spoke brand mark (Q-01 resolved); the
            wordmark text comes from the --brand-name token via CSS content, so a
            rebrand stays a tokens.css-only edit (R-61). */}
        <BrandMark className="brand__mark" />
        <span className="brand__name" aria-hidden="true" />
        <span className="sr-only">haynesnetwork</span>
      </div>
      <div className="topbar__spacer" />
      <div className="topbar__actions">
        <ThemeToggle />
        <UserMenu user={user} />
      </div>
    </header>
  );
}
