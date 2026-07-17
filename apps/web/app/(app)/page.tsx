// DESIGN-004 D-23 (owner-directed 2026-07-17) — HOME, the calm landing screen the topbar
// logo/wordmark links to. Exactly four things, no app cards: the MOTD banner (D-15/D-17 —
// the estate-wide broadcast, kept on the landing screen so every login sees it), the
// time-of-day greeting, the estate play scoreboard (ADR-068 / DESIGN-040), and the inverted
// About tile above its perforated rule (ADR-063 / DESIGN-034). The app catalog grid moved
// to /portal (D-23); post-login landing stays `/`.
import { headers } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getServerSession } from '@hnet/auth';
import { getServerCaller } from '@/lib/trpc-server';
import { MotdBanner } from '@/components/motd-banner';
import { Scoreboard } from '@/components/scoreboard';
import { InfoGlyph } from './about/glyphs';
import { Greeting } from './greeting';

export default async function HomePage() {
  // The (app) layout gates too; this re-check keeps the page self-sufficient (the
  // caller would otherwise throw UNAUTHORIZED before the layout redirect settles).
  const session = await getServerSession(await headers());
  if (!session) redirect('/login');

  const caller = await getServerCaller();
  // DESIGN-004 D-15 — the active MOTD (or null) is server-fetched so the banner renders with
  // no loading flash, anchored ABOVE the greeting (D-07 neighbor).
  // ADR-068 / DESIGN-040 D-04/D-06 — the play scoreboard rides the same server fetch (the
  // ~10-min in-process memo makes it cheap); numbers are baked at SSR, zero client fetch.
  const [motd, plays] = await Promise.all([
    caller.motd.getActive(),
    caller.metrics.playScoreboard(),
  ]);

  return (
    <>
      <MotdBanner motd={motd} />
      <Greeting displayName={session.user.displayName} />
      {/* DESIGN-040 D-06/D-07 (R-221) — the estate play scoreboard badge row, above the About
          tile; renders NOTHING when no Tautulli answered (no empty chrome). */}
      <Scoreboard totals={plays} />
      {/* DESIGN-034 D-01/D-02 (R-206) — the About/Help entry: a full-width INVERTED tile
          (accent fill, internal link — no new tab; hover deepens color only, ADR-015) above
          the perforated rule. On Home it is the one destination card — the launcher grid
          lives on /portal (D-23). */}
      <Link href="/about" className="tile tile--inverted tile--about">
        <span className="tile__top">
          <InfoGlyph className="tile__icon" width={28} height={28} />
          <span className="tile__ext" aria-hidden="true">
            →
          </span>
        </span>
        <span className="tile__name">About haynesnetwork.com</span>
        <span className="tile__desc">
          How it all works: the Plex servers, Fix, Trash, requests, books, and more.
        </span>
      </Link>
      <hr className="tile-rule" />
    </>
  );
}
