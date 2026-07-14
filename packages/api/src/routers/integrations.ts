// ADR-055 / DESIGN-028 (PLAN-044 — Goodreads requests MVP) — the Integrations tab tRPC surface. Link an
// external account, sync (shelf mirror + coverage), the requests/Missing wall, and the manual re-search.
// Every procedure is gated by `integrationsProcedure` (the `integrations` section, ships Admin-only) —
// server-authoritative (AC-13), never client-hidden only. Linking is PER-USER: a user only ever reads /
// mutates their OWN integration + requests (ownership re-checked server-side on the mutating search).
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import {
  computeCoverage,
  getBookRequestById,
  getBookRequestsForIntegration,
  getIntegrationById,
  getUserIntegration,
  InvalidGoodreadsProfileError,
  linkIntegration,
  runComicVolumeSearch,
  runManualBookSearch,
  unlinkIntegration,
  type BookRequestView,
} from '@hnet/domain';
import type { UserIntegrationRow } from '@hnet/db';
import { router } from '../trpc';
import {
  mapDomainErrors,
  resolveGoodreadsRssClient,
  resolveKapowarrBundle,
  resolveLazyLibrarianBundle,
} from '../trpc';
import { integrationsProcedure } from '../middleware/role';

const PROVIDER = 'goodreads' as const;

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

function isSearchable(view: BookRequestView): boolean {
  // ADR-056 — a COMIC is searchable once routed to Kapowarr (has a volume id) and not yet fully landed; a
  // BOOK is searchable once pushed to LL (has a GB/LL id) and not both-format-landed. A PARKED comic
  // (no volume id yet — Kapowarr unreachable / no ComicVine match) is not force-searchable.
  if (view.comicStatus != null) {
    return view.kapowarrVolumeId != null && view.comicStatus !== 'landed';
  }
  if (view.unroutableReason) return false;
  if (!view.llBookId) return false;
  return view.ebookStatus !== 'landed' || view.audioStatus !== 'landed';
}

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
    .input(z.object({ requestId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const request = await getBookRequestById({ db: ctx.db, id: input.requestId });
      if (!request) throw new TRPCError({ code: 'NOT_FOUND' });
      const integration = await getIntegrationById({ db: ctx.db, id: request.integrationId });
      if (!integration || integration.userId !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN' });
      }
      return mapDomainErrors(async () => {
        if (request.comicStatus != null) {
          // A comic → Kapowarr's own sources (the auto_search task).
          const result = await runComicVolumeSearch({
            db: ctx.db,
            requestId: input.requestId,
            userId: ctx.user.id,
            actorId: ctx.user.id,
            kapowarr: resolveKapowarrBundle(ctx),
          });
          return { target: 'kapowarr' as const, ...result };
        }
        const result = await runManualBookSearch({
          db: ctx.db,
          requestId: input.requestId,
          userId: ctx.user.id,
          actorId: ctx.user.id,
          ll: resolveLazyLibrarianBundle(ctx),
        });
        return { target: 'lazylibrarian' as const, ...result };
      });
    }),
});
