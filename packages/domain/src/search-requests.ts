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
import {
  FixRateLimitError,
  FixTargetRequiredError,
  LedgerItemTombstonedError,
  NotFoundError,
} from './errors';
import { inTransaction } from './db-client';
import { countRecentFixBudget, FIX_RATE_LIMIT_PER_HOUR } from './fix-requests';

export interface CreateSearchRequestInput {
  db?: DbClient;
  requesterId: string;
  /** Admins bypass the hourly budget (shared with Fix, D-17). */
  requesterIsAdmin?: boolean;
  mediaItemId: string;
  /**
   * Episode id (sonarr) / album id (lidarr). Optional for sonarr (absent = a
   * whole-series search); required for lidarr; forbidden for radarr (the movie is
   * the target).
   */
  targetArrChildId?: number | null;
  /** Display-durable label, e.g. 'S01E10 · Chapter 10' / album title (audit copy). */
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
  const targetArrChildId = input.targetArrChildId ?? null;
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

    // Target rules (D-17): radarr searches the movie (no child); lidarr an album
    // (child required); sonarr allows a whole-series search OR a single episode.
    if (item.arrKind === 'radarr') {
      if (targetArrChildId !== null) {
        throw new FixTargetRequiredError(
          'radarr force-search targets the movie itself — no child target allowed',
        );
      }
    } else if (item.arrKind === 'lidarr' && targetArrChildId === null) {
      throw new FixTargetRequiredError('lidarr force-search requires an album target');
    }

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
          targetArrChildId,
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
