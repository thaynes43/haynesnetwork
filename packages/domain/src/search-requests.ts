// DESIGN-005 D-07/D-17 — Force Search single-writer. Missing content ("not broken,
// just missing") gets a search-only action: NO blocklist, NO file delete, NO reason.
// This writer records the audited 'search_requested' ledger event (attributed to the
// requester) in one transaction, under the SAME per-requester advisory lock + hourly
// budget as Fix (countRecentFixBudget) so the two actions can't be alternated to
// dodge the rate limit. The actual *arr search command is fired by runForceSearch
// (search-flow.ts) AFTER this audit row commits — the mutating *arr surface stays in
// packages/domain (D-12/D-18).
import { ledgerEvents, mediaItems, users, type ArrKind, type DbClient } from '@hnet/db';
import { eq, sql } from 'drizzle-orm';
import { FixRateLimitError, LedgerItemTombstonedError, NotFoundError } from './errors';
import { inTransaction } from './db-client';
import { countRecentFixBudget, FIX_RATE_LIMIT_PER_HOUR } from './fix-requests';
import { resolveSearchTarget, type SearchScope } from './action-scope';

export interface CreateSearchRequestInput {
  db?: DbClient;
  requesterId: string;
  /** Admins bypass the hourly budget (shared with Fix, D-17). */
  requesterIsAdmin?: boolean;
  mediaItemId: string;
  /**
   * The roll-up scope (media-hierarchy actions): radarr 'item'; sonarr 'show' |
   * 'season' | 'episode'; lidarr 'artist' | 'album'. Omitted ⇒ the legacy per-kind
   * default (sonarr → whole-series when no child, else episode; lidarr → album).
   */
  scope?: SearchScope;
  /**
   * Episode id (sonarr) / album id (lidarr) — for the 'episode'/'album' scopes;
   * forbidden for whole-show/season/artist/movie searches.
   */
  targetArrChildId?: number | null;
  /** Sonarr season number for the 'season' scope. */
  seasonNumber?: number | null;
  /** Display-durable label, e.g. 'S01E10 · Chapter 10' / album title / 'Season 2' (audit copy). */
  targetLabel?: string | null;
}

export interface CreateSearchRequestResult {
  eventId: string;
  arrKind: ArrKind;
}

/**
 * DESIGN-005 D-07/D-12/D-17 — the single writer opening a Force Search: the audited
 * 'search_requested' ledger event commits in ONE transaction BEFORE any *arr call,
 * attributed to the requester. Guards inside the same transaction (advisory lock +
 * shared hourly budget, admins bypass): no search on a tombstoned item, and the
 * kind-specific target rule (radarr forbids a child, lidarr requires one, sonarr
 * allows either — a whole-series search or a single episode).
 */
export async function recordSearchRequest(
  input: CreateSearchRequestInput,
): Promise<CreateSearchRequestResult> {
  return inTransaction(input.db, async (tx) => {
    // Serialize this requester's submissions for the shared budget count (D-17) —
    // the SAME lock key Fix uses, so the two actions draw down one allowance.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('fix_requests'), hashtext(${input.requesterId}))`,
    );

    const [requester] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, input.requesterId));
    if (!requester) {
      throw new NotFoundError(`User ${input.requesterId} not found`);
    }

    const [item] = await tx
      .select({
        id: mediaItems.id,
        arrKind: mediaItems.arrKind,
        deletedFromArrAt: mediaItems.deletedFromArrAt,
      })
      .from(mediaItems)
      .where(eq(mediaItems.id, input.mediaItemId));
    if (!item) {
      throw new NotFoundError(`Media item ${input.mediaItemId} not found`);
    }
    if (item.deletedFromArrAt !== null) {
      throw new LedgerItemTombstonedError(
        `Media item ${input.mediaItemId} is tombstoned — nothing to search in the *arr`,
      );
    }

    // Target rules (D-17 / hierarchy-actions): validate the (kind, scope, child,
    // season) tuple against the shared allow-list — radarr searches the movie; sonarr
    // a whole show / a season / a single episode; lidarr a whole artist / an album.
    const resolved = resolveSearchTarget(item.arrKind, {
      scope: input.scope,
      targetChildId: input.targetArrChildId,
      seasonNumber: input.seasonNumber,
    });

    if (!input.requesterIsAdmin) {
      const used = await countRecentFixBudget(tx, input.requesterId);
      if (used >= FIX_RATE_LIMIT_PER_HOUR) {
        throw new FixRateLimitError(
          `Fix rate limit reached: ${FIX_RATE_LIMIT_PER_HOUR} requests per hour`,
        );
      }
    }

    const [event] = await tx
      .insert(ledgerEvents)
      .values({
        mediaItemId: input.mediaItemId,
        eventType: 'search_requested',
        source: 'app',
        occurredAt: new Date(),
        requestedByUserId: input.requesterId,
        payload: {
          scope: resolved.scope,
          targetArrChildId: resolved.targetChildId,
          seasonNumber: resolved.seasonNumber,
          targetLabel: input.targetLabel ?? null,
          requesterId: input.requesterId,
          arrKind: item.arrKind,
        },
      })
      .returning({ id: ledgerEvents.id });
    if (!event) {
      throw new Error('ledger_events insert returned no row');
    }

    return { eventId: event.id, arrKind: item.arrKind };
  });
}
