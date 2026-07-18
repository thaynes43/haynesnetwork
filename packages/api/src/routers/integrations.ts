// ADR-055 / DESIGN-028 (PLAN-044 — Goodreads requests MVP) — the Integrations tab tRPC surface. Link an
// external account, sync (shelf mirror + coverage), the requests/Missing wall, and the manual re-search.
// Every procedure is gated by `integrationsProcedure` (the `integrations` section, ships Admin-only) —
// server-authoritative (AC-13), never client-hidden only. Linking is PER-USER: a user only ever reads /
// mutates their OWN integration + requests (ownership re-checked server-side on the mutating search).
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import {
  computeCoverage,
  computeShelfStats,
  getBookRequestById,
  getBookRequestsForIntegration,
  getIntegrationById,
  getShelfWallItems,
  getUserIntegration,
  InvalidGoodreadsProfileError,
  isRequestSearchable,
  linkIntegration,
  markIntegrationSynced,
  requestPhase,
  runComicVolumeSearch,
  runManualBookSearch,
  syncGoodreadsIntegration,
  unlinkIntegration,
  type BookRequestView,
  type EnrichedShelfItem,
  type ShelfWallItem,
} from '@hnet/domain';
import { isAbsentCustomShelfError, isComicText, type GoodreadsShelfItem } from '@hnet/goodreads';
import { booksCoverUrlFor } from '../books-query';
import type { UserIntegrationRow } from '@hnet/db';
import { router } from '../trpc';
import {
  mapDomainErrors,
  resolveGoodreadsRssClient,
  resolveGoogleBooksClient,
  resolveKapowarrBundle,
  resolveLazyLibrarianBundle,
  type TRPCContext,
} from '../trpc';
import { integrationsProcedure } from '../middleware/role';

const PROVIDER = 'goodreads' as const;

/**
 * Fresh-link fast path (PLAN-044 live-acceptance fix): run the FIRST shelf sync for a just-linked integration
 * inline so the coverage card shows real data (or a pending state) instead of a "0% / 0 of 0 / not synced
 * yet" dead-end until the hourly CronJob. Fired-and-forgotten from the `link` mutation — the link is already
 * committed, so a sync failure never fails the link (the pending UI + the CronJob are the safety net). This
 * mirrors the per-integration read+enrich of `@hnet/sync` runGoodreadsSync for a SINGLE integration (kept
 * here to avoid pulling the heavy @hnet/sync barrel into the web request path). External LL calls stay out of
 * any DB transaction — the orchestrator's fix-flow discipline.
 */
async function runFirstGoodreadsSync(
  ctx: TRPCContext,
  integration: UserIntegrationRow,
): Promise<void> {
  const rss = resolveGoodreadsRssClient(ctx);
  const googleBooks = resolveGoogleBooksClient(ctx);
  // LazyLibrarian is optional — absent config ⇒ a mirror+mint run (no push), same as the CronJob's degraded mode.
  let ll: ReturnType<typeof resolveLazyLibrarianBundle> | undefined;
  try {
    ll = resolveLazyLibrarianBundle(ctx);
  } catch {
    ll = undefined;
  }
  // ADR-056 (PLAN-046) — Kapowarr is optional too. When configured, route comics to Kapowarr in this first
  // sync exactly as the CronJob does (classifier decides comic-vs-book below); absent config ⇒ comics stay
  // parked (unroutable_reason='comic') and the hourly CronJob routes them on its next run.
  let kapowarr: ReturnType<typeof resolveKapowarrBundle> | undefined;
  try {
    kapowarr = resolveKapowarrBundle(ctx);
  } catch {
    kapowarr = undefined;
  }

  const enriched: EnrichedShelfItem[] = [];
  const syncedShelves: string[] = [];
  for (const shelf of integration.shelves) {
    // ADR-057 / A3 — an absent CUSTOM shelf (404 on e.g. 'did-not-finish') reads as EMPTY, not an error;
    // a built-in shelf failure still throws (private/unreachable — the sync-error path).
    let items: GoodreadsShelfItem[];
    try {
      items = await rss.fetchShelf(integration.externalUserId, shelf);
    } catch (error) {
      if (!isAbsentCustomShelfError(shelf, error)) throw error;
      items = [];
    }
    for (const item of items) {
      const gb = await googleBooks
        .resolveVolume({ isbn: item.isbn, title: item.title, author: item.author })
        .catch(() => null);
      enriched.push({
        shelf,
        externalBookId: item.externalBookId,
        title: item.title,
        author: item.author,
        isbn: gb?.isbn13 ?? item.isbn,
        gbVolumeId: gb?.volumeId ?? null,
        coverUrl: item.coverUrl,
        shelvedAt: item.shelvedAt,
        isComic: (gb?.isComic ?? false) || isComicText(item.title, item.author),
      });
    }
    syncedShelves.push(shelf);
  }

  await syncGoodreadsIntegration({
    db: ctx.db,
    integrationId: integration.id,
    items: enriched,
    syncedShelves,
    ...(ll ? { ll } : {}),
    ...(kapowarr ? { kapowarr } : {}),
  });
}

// NOTE: the wire shapes are intentionally NOT exported named interfaces — the helper functions return
// inferred object literals so the router's output types stay ANONYMOUS (nameable everywhere, incl. the web
// app's server caller — a named exported interface at this deep path is a non-portable reference).
function toIntegrationWire(row: UserIntegrationRow | null) {
  return {
    provider: PROVIDER,
    status: row?.status ?? 'unlinked',
    linked: row?.status === 'linked',
    profileRef: row?.profileRef ?? null,
    externalUserId: row?.externalUserId ?? null,
    shelves: row?.shelves ?? ['to-read'],
    lastSyncedAt: row?.lastSyncedAt ? row.lastSyncedAt.toISOString() : null,
    lastSyncError: row?.lastSyncError ?? null,
  };
}

// ADR-056/ADR-057 — the shared force-searchability rule now lives in @hnet/domain (isRequestSearchable):
// one definition for this wall, the Goodreads items wall, and the Library composed-Wanted tiles.
const isSearchable = (view: BookRequestView): boolean => isRequestSearchable(view);

function toRequestWire(view: BookRequestView) {
  return {
    id: view.id,
    title: view.title,
    author: view.author,
    shelf: view.shelf,
    ebookStatus: view.ebookStatus,
    audioStatus: view.audioStatus,
    // ADR-056 — the comic leg: `comicStatus` non-null ⇒ this request is a COMIC (routed via Kapowarr, not
    // LL). PLAN-045's Comics wall renders it from comicStatus; the force-search button hits the same
    // `integrations.search` endpoint, which dispatches to Kapowarr for a comic.
    comicStatus: view.comicStatus,
    isComic: view.comicStatus != null,
    unroutableReason: view.unroutableReason,
    inLibrary: view.matchedBooksItemId !== null,
    searchable: isSearchable(view),
    lastSearchedAt: view.lastSearchedAt ? view.lastSearchedAt.toISOString() : null,
  };
}

/** ADR-057 (PLAN-045) — one Goodreads ITEMS-wall tile (a distinct shelf book, shelves aggregated). */
function toItemWire(item: ShelfWallItem) {
  const ebookStatus = item.ebookStatus ?? 'requested';
  const audioStatus = item.audioStatus ?? 'requested';
  return {
    /** The Goodreads book id — the stable tile key. */
    key: item.externalBookId,
    title: item.title,
    author: item.author,
    shelves: item.shelves,
    shelvedAt: item.shelvedAt ? item.shelvedAt.toISOString() : null,
    requestId: item.requestId,
    /** The cover-proxy URL when the want matched a books_items row; null ⇒ the designed fallback tile. */
    posterUrl: item.matched
      ? booksCoverUrlFor(item.matched.source, item.matched.externalId, item.matched.coverRef)
      : null,
    inLibrary: item.matched !== null,
    /** ADR-057 amendment (PLAN-047) — the "Have it" card's click-through target (`/library/books/[id]`). */
    matchedBooksItemId: item.matchedBooksItemId,
    ebookStatus,
    audioStatus,
    comicStatus: item.comicStatus,
    isComic: item.comicStatus != null,
    unroutableReason: item.unroutableReason,
    /** The corner-puck phase: have · searching · missing · parked. */
    phase: item.requestId
      ? requestPhase({
          matchedBooksItemId: item.matched ? 'matched' : null,
          ebookStatus,
          audioStatus,
          comicStatus: item.comicStatus,
          unroutableReason: item.unroutableReason,
        })
      : ('searching' as const),
    searchable: item.requestId
      ? isRequestSearchable({
          ebookStatus,
          audioStatus,
          comicStatus: item.comicStatus,
          kapowarrVolumeId: item.kapowarrVolumeId,
          llBookId: item.llBookId,
          unroutableReason: item.unroutableReason,
        })
      : false,
    lastSearchedAt: item.lastSearchedAt ? item.lastSearchedAt.toISOString() : null,
    // fix/live-status-precedence — the live in-flight wall-badge join keys (the Library-Wanted wall idiom):
    // a book/audiobook want joins `activity.wallStages` by its LL/GB book id; a comic by its Kapowarr volume
    // id. The items wall overlays the live stage badge (searching / downloading % / importing) over the
    // reconciled snapshot so it can't read "Missing" while a grab is actively in flight.
    llBookId: item.llBookId,
    kapowarrVolumeId: item.kapowarrVolumeId,
  };
}

export const integrationsRouter = router({
  /** The caller's Goodreads link status (the tab's link card). */
  status: integrationsProcedure.query(async ({ ctx }) => {
    const row = await getUserIntegration({ db: ctx.db, userId: ctx.user.id, provider: PROVIDER });
    return { integration: toIntegrationWire(row) };
  }),

  /**
   * Link (or re-link) the caller's PUBLIC Goodreads profile. Resolves a vanity URL → numeric id (following
   * the redirect server-side) and PROBES the public want shelf is reachable BEFORE persisting — so a
   * private / mistyped profile is rejected with an actionable message, not linked into a broken state.
   */
  link: integrationsProcedure
    .input(z.object({ profileRef: z.string().trim().min(1).max(500) }))
    .mutation(async ({ ctx, input }) => {
      return mapDomainErrors(async () => {
        const rss = resolveGoodreadsRssClient(ctx);
        let externalUserId: string;
        try {
          externalUserId = await rss.resolveUserId(input.profileRef);
        } catch {
          throw new InvalidGoodreadsProfileError(
            'Could not find a Goodreads user for that profile. Paste your profile URL ' +
              '(e.g. https://www.goodreads.com/haynesnetwork or .../user/show/12345-name) or your numeric id.',
          );
        }
        // Reachability probe: the want shelf RSS must be PUBLIC + parseable.
        try {
          await rss.fetchShelf(externalUserId, 'to-read');
        } catch {
          throw new InvalidGoodreadsProfileError(
            'We found your profile but could not read your "to-read" shelf. Make sure your Goodreads ' +
              'shelves are PUBLIC (Settings → Privacy), then try linking again.',
          );
        }
        const { integration } = await linkIntegration({
          db: ctx.db,
          userId: ctx.user.id,
          provider: PROVIDER,
          externalUserId,
          profileRef: input.profileRef,
          actorId: ctx.user.id,
        });
        // Kick off the FIRST shelf sync in the background so the coverage card shows real data (or a "first
        // sync in progress" pending state — D-06) rather than a "0% / 0 of 0" dead-end until the hourly
        // CronJob. Fire-and-forget: the link is already committed, the response returns immediately, and the
        // pending UI + CronJob cover any failure. A floating promise is fine on the persistent Next server.
        void runFirstGoodreadsSync(ctx, integration).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          console.error('integrations.link: first sync failed (CronJob will retry)', {
            integrationId: integration.id,
            error: message,
          });
          // Record the failure so the card leaves the "first sync in progress" state (which polls) instead
          // of spinning forever — the CronJob retries. Guarded not to resurrect an already-unlinked row.
          void markIntegrationSynced({
            db: ctx.db,
            integrationId: integration.id,
            error: message,
          }).catch(() => {});
        });
        return { integration: toIntegrationWire(integration) };
      });
    }),

  /** Unlink the caller's Goodreads account (soft — retained for audit; a re-link restores it). */
  unlink: integrationsProcedure.mutation(async ({ ctx }) => {
    const { changed } = await unlinkIntegration({
      db: ctx.db,
      userId: ctx.user.id,
      provider: PROVIDER,
      actorId: ctx.user.id,
    });
    return { changed };
  }),

  /**
   * ADR-057 (PLAN-045) — the hub-card + stats-page read: link state, the WANT-SHELF headline coverage
   * (Q-02 ruling — the headline stays to-read), the per-shelf breakdown, and the request phase rollup
   * (the Trash-Overview summary-tile idiom). Unlinked ⇒ the wire carries zeros (the hub card renders the
   * not-linked state).
   */
  overview: integrationsProcedure.query(async ({ ctx }) => {
    const row = await getUserIntegration({ db: ctx.db, userId: ctx.user.id, provider: PROVIDER });
    if (!row || row.status === 'unlinked') {
      return {
        integration: toIntegrationWire(row && row.status !== 'unlinked' ? row : null),
        headline: { total: 0, covered: 0, pct: 0 },
        shelves: [] as Array<{ shelf: string; total: number; covered: number; pct: number }>,
        phases: { have: 0, searching: 0, missing: 0, parked: 0 },
      };
    }
    const stats = await computeShelfStats({ db: ctx.db, integrationId: row.id });
    const want = stats.shelves.find((s) => s.shelf === 'to-read');
    return {
      integration: toIntegrationWire(row),
      headline: want
        ? { total: want.total, covered: want.covered, pct: want.pct }
        : { total: 0, covered: 0, pct: 0 },
      shelves: stats.shelves,
      phases: stats.phases,
    };
  }),

  /**
   * ADR-057 (PLAN-045) — the Goodreads ITEMS wall: one tile per distinct shelved book (shelf memberships
   * aggregated — the shelf chips filter on them), with the library-match cover-proxy art where matched and
   * the request state riding along (phase → the corner puck; per-format statuses → the focus card chips).
   */
  items: integrationsProcedure.query(async ({ ctx }) => {
    const row = await getUserIntegration({ db: ctx.db, userId: ctx.user.id, provider: PROVIDER });
    if (!row || row.status === 'unlinked') return { items: [] as ReturnType<typeof toItemWire>[] };
    const items = await getShelfWallItems({ db: ctx.db, integrationId: row.id });
    return { items: items.map(toItemWire) };
  }),

  /** The shelf summary + coverage % for the caller's integration. */
  shelf: integrationsProcedure.query(async ({ ctx }) => {
    const row = await getUserIntegration({ db: ctx.db, userId: ctx.user.id, provider: PROVIDER });
    if (!row) {
      return { integration: toIntegrationWire(null), coverage: { total: 0, covered: 0, pct: 0 } };
    }
    const coverage = await computeCoverage({ db: ctx.db, integrationId: row.id });
    return { integration: toIntegrationWire(row), coverage };
  }),

  /** The requests / Missing wall for the caller's integration. */
  requests: integrationsProcedure.query(async ({ ctx }) => {
    const row = await getUserIntegration({ db: ctx.db, userId: ctx.user.id, provider: PROVIDER });
    if (!row) return { requests: [] as ReturnType<typeof toRequestWire>[] };
    const views = await getBookRequestsForIntegration({ db: ctx.db, integrationId: row.id });
    return { requests: views.map(toRequestWire) };
  }),

  /**
   * Manual "Search again" / Force-Search on a Missing request — the audited user action (request_book_search),
   * then a real acquisition search. DISPATCHES by format (ADR-056): a COMIC fires Kapowarr's `auto_search`
   * task; a book/audiobook fires LazyLibrarian's `searchBook`. THIS is the endpoint PLAN-045's Library
   * "Force Search" button calls for every book-wall format. Ownership re-checked server-side. Non-destructive.
   */
  search: integrationsProcedure
    .input(
      z.object({
        requestId: z.string().uuid(),
        // ADR-057 amendment (PLAN-047 — the Wanted DETAIL page) — the per-format leg the detail page's
        // "Force Search" button targets (ebook / audiobook, the Movies/TV per-grain idiom). Omitted ⇒ the
        // whole request's not-yet-landed formats (the wall puck's existing behaviour). Ignored for a comic
        // (Kapowarr searches the volume, which covers every issue).
        format: z.enum(['ebook', 'audiobook']).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const request = await getBookRequestById({ db: ctx.db, id: input.requestId });
      if (!request) throw new TRPCError({ code: 'NOT_FOUND' });
      // ADR-065 C-05 — a PAIRING (system) want has no integration/owner: it is not this surface's
      // request (its search is the books-gated `books.searchPairingWant`). Ownership stays load-bearing
      // for every goodreads want below.
      if (request.integrationId === null) throw new TRPCError({ code: 'FORBIDDEN' });
      const integration = await getIntegrationById({ db: ctx.db, id: request.integrationId });
      // Owner directive 2026-07-18 — an ADMIN may force-search ANY user's want (the owner couldn't
      // fire another household member's shelf). The owner still fires their own; a non-owner non-admin
      // is FORBIDDEN. The audit records actor=the acting user, subject=the request OWNER (below), so an
      // admin-on-behalf search is attributed honestly.
      if (!integration || (integration.userId !== ctx.user.id && !ctx.user.role.isAdmin)) {
        throw new TRPCError({ code: 'FORBIDDEN' });
      }
      // subject = the want's OWNER (integration.userId); actor = the acting user (owner or admin). For
      // the owner acting on self these coincide; for an admin-on-behalf they split (actor=admin,
      // subject=requester) — exactly the audit shape recordManualSearch writes.
      const subjectUserId = integration.userId;
      return mapDomainErrors(async () => {
        if (request.comicStatus != null) {
          // A comic → Kapowarr's own sources (the auto_search task). The per-format `format` is N/A here.
          const result = await runComicVolumeSearch({
            db: ctx.db,
            requestId: input.requestId,
            userId: subjectUserId,
            actorId: ctx.user.id,
            kapowarr: resolveKapowarrBundle(ctx),
          });
          return { target: 'kapowarr' as const, ...result };
        }
        const result = await runManualBookSearch({
          db: ctx.db,
          requestId: input.requestId,
          userId: subjectUserId,
          actorId: ctx.user.id,
          ll: resolveLazyLibrarianBundle(ctx),
          ...(input.format ? { format: input.format } : {}),
        });
        return { target: 'lazylibrarian' as const, ...result };
      });
    }),
});
