'use client';

// DESIGN-004 D-08/D-16 — chrome: brand block, universal primary nav, theme toggle, user
// menu. Ported from the demo-console TopBar (inline currentColor SVGs, token styling)
// minus i18n and notifications; plus the theme toggle and the user menu popover. No
// theme-dependent JSX on first render (labels resolve post-mount) so hydration never
// mismatches the pre-stamped `data-theme` (D-03). Under 600px the user-menu name
// collapses to the avatar initial via CSS (D-06).
//
// ADR-032 (2026-07-07, owner-directed IA): the top row is the UNIVERSAL section nav, and the
// personal + role-gated tooling destinations live in the user menu. The menu is an overlay
// popover — opening it never reflows the page (ADR-015-sanctioned).
//
// NAV RESTRUCTURE (2026-07-14, owner-ratified from an approved mockup — DESIGN-004 D-22): the top
// row slims to FOUR entries — Home · Library · Tickets · Trash — the same candidate set for every
// role (a Disabled section still hides its entry; every route stays server-gated). "Tickets" is the
// `bulletin` section under its ratified name (HELPDESK_NAME — a LABEL change only; the route stays
// `/bulletin`, the section id / grants stay `bulletin`). Metrics and Integrations LEFT the top row
// and MOVED INTO the user menu (above the tooling separator), each gated exactly like its former
// tab. Four labels fit 320px without the rail scrolling; the v0.46.3 scroll-rail stays as a
// safety net. User-menu destinations, top → bottom: My Plex (everyone — the user's own Plex
// account), Integrations + Metrics (each when its section ≠ Disabled), then the tooling group —
// Ledger (when ≠ Disabled — the shipped default is Disabled for members), Trash settings
// (/settings/trash, only at Trash Edit level), Admin settings (admin) — then Sign out. Navigating
// from a menu item is a `<Link>` push (D-19).

import Link from 'next/link';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTheme } from '@hnet/ui';
import { BrandMark } from '@/components/brand-mark';
import { EmailUpdatesToggle } from '@/components/email-updates-toggle';
import { initialFor } from '@/lib/initials';
import { HELPDESK_NAME } from '@/lib/bulletin';

/** ADR-021 — the session-carried section levels (SessionRole.sectionPermissions) the nav
 *  gates on. Typed structurally so this client component needs no server-package import. */
type SectionLevel = 'edit' | 'read_only' | 'disabled';

export interface TopBarUser {
  displayName: string;
  email: string;
  role: {
    isAdmin: boolean;
    sectionPermissions?: Partial<
      Record<'ledger' | 'trash' | 'bulletin' | 'metrics' | 'integrations', SectionLevel>
    >;
  };
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
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // ADR-032 / DESIGN-004 D-16/D-22 — the role-gated menu destinations. Hiding here is courtesy:
  // every destination is additionally server-gated.
  //
  // Integrations + Metrics (the two entries the 2026-07-14 restructure moved OUT of the top row):
  // gated EXACTLY like their former tabs — the no-row default is `disabled` for both, so a role
  // without the section sees no menu entry (a member without `metrics` gets no Metrics item). They
  // sit with My Plex in the top group (no separator) so a user gated to just these two sees the
  // approved mockup verbatim: My Plex · Integrations · Metrics · ─── · Sign out.
  const showMetrics = (user.role.sectionPermissions?.metrics ?? 'disabled') !== 'disabled';
  const showIntegrations =
    (user.role.sectionPermissions?.integrations ?? 'disabled') !== 'disabled';
  // Ledger's no-row default is DISABLED (members see no Ledger anywhere unless a role opts them in);
  // Trash settings shows only at the Edit level (admin sessions carry 'edit' everywhere, so admins
  // pass implicitly — ADR-021 C-03).
  const showLedger = (user.role.sectionPermissions?.ledger ?? 'disabled') !== 'disabled';
  const showTrashSettings = (user.role.sectionPermissions?.trash ?? 'disabled') === 'edit';

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

  function signOut() {
    setSigningOut(true);
    // DESIGN-002 D-15 — RP-initiated logout: a full-page navigation to the server
    // logout route (NOT router.push), so the browser follows the cross-origin
    // Authentik end-session redirect chain. The route clears the local session and,
    // when the issuer supports it, ends the Authentik SSO session before landing on
    // /login — otherwise the next "Log In" silently re-authenticates.
    window.location.assign('/api/auth/logout');
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
          {/* ADR-060 / DESIGN-031 D-07 (PLAN-035) — the personal email opt-in (R-196). Lives with
              the identity header (it is ABOUT this account), before the destination items. */}
          <EmailUpdatesToggle />
          {/* Personal + the relocated section views (everyone / role-gated) — one group, no
              separator, so a metrics+integrations user matches the approved mockup exactly. */}
          <Link
            href="/library/plex"
            role="menuitem"
            className="usermenu__item"
            onClick={() => setOpen(false)}
          >
            My Plex
          </Link>
          {/* DESIGN-004 D-22 (PLAN-044 / ADR-055): Integrations — moved from the top row, gated
              like its former tab; navigating pushes a history entry (D-19). */}
          {showIntegrations ? (
            <Link
              href="/integrations"
              role="menuitem"
              className="usermenu__item"
              onClick={() => setOpen(false)}
            >
              Integrations
            </Link>
          ) : null}
          {/* DESIGN-004 D-22 (PLAN-017 / ADR-037): Metrics — moved from the top row, gated like its
              former tab. */}
          {showMetrics ? (
            <Link
              href="/metrics"
              role="menuitem"
              className="usermenu__item"
              onClick={() => setOpen(false)}
            >
              Metrics
            </Link>
          ) : null}
          {/* Tooling — role-gated destinations (subtle separator, D-16). */}
          {showLedger || showTrashSettings || user.role.isAdmin ? (
            <div className="usermenu__sep" role="separator" aria-hidden="true" />
          ) : null}
          {showLedger ? (
            <Link
              href="/ledger"
              role="menuitem"
              className="usermenu__item"
              onClick={() => setOpen(false)}
            >
              Ledger
            </Link>
          ) : null}
          {showTrashSettings ? (
            <Link
              href="/settings/trash"
              role="menuitem"
              className="usermenu__item"
              onClick={() => setOpen(false)}
            >
              Trash settings
            </Link>
          ) : null}
          {user.role.isAdmin ? (
            <Link
              href="/admin"
              role="menuitem"
              className="usermenu__item"
              onClick={() => setOpen(false)}
            >
              Admin settings
            </Link>
          ) : null}
          <div className="usermenu__sep" role="separator" aria-hidden="true" />
          <button
            type="button"
            role="menuitem"
            className="usermenu__item"
            disabled={signingOut}
            onClick={() => signOut()}
          >
            {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function TopBar({ user }: { user: TopBarUser }) {
  // ADR-023 / DESIGN-010 D-09 — the Trash entry: the no-row DEFAULT for trash is disabled
  // (ADR-021), so a missing map falls CLOSED; the /trash route is additionally server-gated.
  const showTrash = (user.role.sectionPermissions?.trash ?? 'disabled') !== 'disabled';
  // ADR-026 / DESIGN-012 D-08 — the Bulletin entry: the no-row DEFAULT for bulletin is
  // read_only (C-02 — the Feed is for everyone), so a missing map falls OPEN;
  // the /bulletin route is additionally server-gated.
  const showBulletin = (user.role.sectionPermissions?.bulletin ?? 'read_only') !== 'disabled';
  // NAV RESTRUCTURE (DESIGN-004 D-22): Metrics + Integrations no longer ride the top row — they
  // moved into the user menu (see UserMenu). The row is exactly four candidates now.
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
      {/* DESIGN-004 D-22 — the UNIVERSAL primary nav, slimmed to FOUR: Home · Library · Tickets ·
          Trash, the same candidate set for every role (a Disabled section still hides its entry).
          Metrics + Integrations moved to the user menu; four labels fit 320px without the rail
          scrolling. Shown at all widths. */}
      <nav className="topbar__nav" aria-label="Primary">
        <Link href="/">Home</Link>
        <Link href="/library">Library</Link>
        {/* PLAN-009 (DESIGN-012 D-08): the `bulletin` section under its ratified name (HELPDESK_NAME
            = "Tickets"); the route/section id stay `bulletin`. Level-gated (see showBulletin). */}
        {showBulletin ? <Link href="/bulletin">{HELPDESK_NAME}</Link> : null}
        {/* PLAN-006 (DESIGN-010 D-09): the Trash section, level-gated (see showTrash). */}
        {showTrash ? <Link href="/trash">Trash</Link> : null}
      </nav>
      <div className="topbar__spacer" />
      <div className="topbar__actions">
        <ThemeToggle />
        <UserMenu user={user} />
      </div>
    </header>
  );
}
