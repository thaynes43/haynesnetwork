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
  markIntegrationSynced,
  runManualBookSearch,
  syncGoodreadsIntegration,
  unlinkIntegration,
  type BookRequestView,
  type EnrichedShelfItem,
} from '@hnet/domain';
import { isComicText } from '@hnet/goodreads';
import type { UserIntegrationRow } from '@hnet/db';
import { router } from '../trpc';
import {
  mapDomainErrors,
  resolveGoodreadsRssClient,
  resolveGoogleBooksClient,
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
async function runFirstGoodreadsSync(ctx: TRPCContext, integration: UserIntegrationRow): Promise<void> {
  const rss = resolveGoodreadsRssClient(ctx);
  const googleBooks = resolveGoogleBooksClient(ctx);
  // LazyLibrarian is optional — absent config ⇒ a mirror+mint run (no push), same as the CronJob's degraded mode.
  let ll: ReturnType<typeof resolveLazyLibrarianBundle> | undefined;
  try {
    ll = resolveLazyLibrarianBundle(ctx);
  } catch {
    ll = undefined;
  }

  const enriched: EnrichedShelfItem[] = [];
  const syncedShelves: string[] = [];
  for (const shelf of integration.shelves) {
    const items = await rss.fetchShelf(integration.externalUserId, shelf);
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

function isSearchable(view: BookRequestView): boolean {
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
          void markIntegrationSynced({ db: ctx.db, integrationId: integration.id, error: message }).catch(
            () => {},
          );
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
   * Manual "Search again" on a Missing request — the audited user action, then a real LazyLibrarian
   * searchBook (R3 / AC-04). Ownership re-checked server-side. Non-destructive (no ConfirmButton needed).
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
        const result = await runManualBookSearch({
          db: ctx.db,
          requestId: input.requestId,
          userId: ctx.user.id,
          actorId: ctx.user.id,
          ll: resolveLazyLibrarianBundle(ctx),
        });
        return result;
      });
    }),
});
