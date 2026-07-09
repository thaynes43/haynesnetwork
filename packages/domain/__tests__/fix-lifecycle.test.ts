import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixRequests, ledgerEvents, mediaItems } from '@hnet/db/schema';
import {
  FIX_RATE_LIMIT_PER_HOUR,
  FixAlreadyOpenError,
  FixRateLimitError,
  FixTargetRequiredError,
  InvalidFixTransitionError,
  LedgerItemTombstonedError,
  NotFoundError,
  closeFixManually,
  completeFixRequests,
  createFixRequest,
  expireStaleFixRequests,
  ingestLedgerEvents,
  isPostgresCheckViolation,
  recordFixAction,
  tombstoneMissingItems,
  upsertMediaItemsBatch,
} from '../src/index';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

describe('fix lifecycle single-writers (DESIGN-005 D-09/D-12, ADR-007)', () => {
  let t: TestDb;
  let memberId: string;
  let sonarrItemId: string;
  let radarrItemId: string;
  let lidarrItemId: string;
  let tombstonedItemId: string;

  const eventsFor = (
    mediaItemId: string,
    eventType: (typeof ledgerEvents.$inferSelect)['eventType'],
  ) =>
    t.db
      .select()
      .from(ledgerEvents)
      .where(and(eq(ledgerEvents.mediaItemId, mediaItemId), eq(ledgerEvents.eventType, eventType)));

  beforeAll(async () => {
    t = await bootMigratedDb();
    memberId = (await createUser(t.db, { email: 'fixer@example.com', displayName: 'Fixer' })).id;

    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'sonarr',
      items: [
        {
          arrItemId: 1,
          tvdbId: 121361,
          title: 'Game of Thrones',
          sortTitle: 'game of thrones',
          monitored: true,
          qualityProfileId: 1,
          qualityProfileName: 'Any',
          rootFolder: '/tv',
        },
      ],
    });
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'radarr',
      items: [
        {
          arrItemId: 1,
          tmdbId: 550,
          title: 'Fight Club',
          sortTitle: 'fight club',
          monitored: true,
          qualityProfileId: 1,
          qualityProfileName: 'Any',
          rootFolder: '/movies',
        },
        {
          arrItemId: 2,
          tmdbId: 551,
          title: 'Doomed Movie',
          sortTitle: 'doomed movie',
          monitored: true,
          qualityProfileId: 1,
          qualityProfileName: 'Any',
          rootFolder: '/movies',
        },
      ],
    });
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'lidarr',
      items: [
        {
          arrItemId: 1,
          musicbrainzArtistId: '5b11f4ce-a62d-471e-81fc-a69a8278c7da',
          title: 'Nirvana',
          sortTitle: 'nirvana',
          monitored: true,
          qualityProfileId: 1,
          qualityProfileName: 'Lossless',
          rootFolder: '/music',
        },
      ],
    });
    // Tombstone 'Doomed Movie' (radarr arr_item_id 2): only item 1 is still seen.
    await tombstoneMissingItems({ db: t.db, arrKind: 'radarr', seenArrItemIds: [1] });

    const items = await t.db.select().from(mediaItems);
    sonarrItemId = items.find((i) => i.arrKind === 'sonarr')!.id;
    radarrItemId = items.find((i) => i.arrKind === 'radarr' && i.arrItemId === 1)!.id;
    lidarrItemId = items.find((i) => i.arrKind === 'lidarr')!.id;
    tombstonedItemId = items.find((i) => i.arrKind === 'radarr' && i.arrItemId === 2)!.id;
  });

  afterAll(async () => {
    await t?.stop();
  });

  describe('createFixRequest', () => {
    it('writes the pending row + fix_requested event in one tx, with the requester snapshot', async () => {
      const { fixRequestId, status } = await createFixRequest({
        db: t.db,
        requesterId: memberId,
        mediaItemId: sonarrItemId,
        targetArrChildId: 42,
        targetLabel: 'S06E02 · Rich',
        reason: 'wont_play_corrupt',
      });
      expect(status).toBe('pending');

      const [row] = await t.db.select().from(fixRequests).where(eq(fixRequests.id, fixRequestId));
      expect(row).toMatchObject({
        requesterId: memberId,
        mediaItemId: sonarrItemId,
        targetArrChildId: 42,
        targetLabel: 'S06E02 · Rich',
        reason: 'wont_play_corrupt',
        status: 'pending',
        pathTaken: null,
      });
      // D-09: audit-grade row outlives the user — snapshot in actionsTaken[0]
      expect(row!.actionsTaken[0]).toMatchObject({
        step: 'created',
        requester: { email: 'fixer@example.com', displayName: 'Fixer' },
      });

      const events = await eventsFor(sonarrItemId, 'fix_requested');
      expect(events).toHaveLength(1);
      expect(events[0]!.source).toBe('app');
      expect(events[0]!.payload).toMatchObject({ fixRequestId, reason: 'wont_play_corrupt' });
    });

    it('validates targets per kind (D-15): sonarr/lidarr need a child, radarr forbids one', async () => {
      await expect(
        createFixRequest({
          db: t.db,
          requesterId: memberId,
          mediaItemId: sonarrItemId,
          reason: 'wrong_language',
        }),
      ).rejects.toThrow(FixTargetRequiredError);
      await expect(
        createFixRequest({
          db: t.db,
          requesterId: memberId,
          mediaItemId: lidarrItemId,
          reason: 'wrong_language',
        }),
      ).rejects.toThrow(FixTargetRequiredError);
      await expect(
        createFixRequest({
          db: t.db,
          requesterId: memberId,
          mediaItemId: radarrItemId,
          targetArrChildId: 7,
          reason: 'wrong_language',
        }),
      ).rejects.toThrow(FixTargetRequiredError);
    });

    it('rejects fixes on tombstoned items (LEDGER_ITEM_TOMBSTONED)', async () => {
      await expect(
        createFixRequest({
          db: t.db,
          requesterId: memberId,
          mediaItemId: tombstonedItemId,
          reason: 'wont_play_corrupt',
        }),
      ).rejects.toThrow(LedgerItemTombstonedError);
    });

    it('one open fix per (item, child): duplicate → FixAlreadyOpenError, other child OK', async () => {
      await expect(
        createFixRequest({
          db: t.db,
          requesterId: memberId,
          mediaItemId: sonarrItemId,
          targetArrChildId: 42,
          reason: 'wrong_language',
        }),
      ).rejects.toThrow(FixAlreadyOpenError);

      const other = await createFixRequest({
        db: t.db,
        requesterId: memberId,
        mediaItemId: sonarrItemId,
        targetArrChildId: 43,
        reason: 'wrong_language',
      });
      expect(other.status).toBe('pending');
    });

    it('season scope: persists target_scope/target_season, and two seasons do not collide', async () => {
      // A dedicated requester so this doesn't draw down memberId's shared hourly budget.
      const seasonUser = (await createUser(t.db, { email: 'seasons@example.com' })).id;
      const s6 = await createFixRequest({
        db: t.db,
        requesterId: seasonUser,
        mediaItemId: sonarrItemId,
        scope: 'season',
        seasonNumber: 6,
        targetLabel: 'Season 6',
        reason: 'wrong_version_quality',
      });
      const [row] = await t.db.select().from(fixRequests).where(eq(fixRequests.id, s6.fixRequestId));
      expect(row).toMatchObject({
        targetScope: 'season',
        targetSeason: 6,
        targetArrChildId: null,
        targetLabel: 'Season 6',
      });

      // A DIFFERENT season is allowed (both carry a null child id — scope+season split them).
      const s7 = await createFixRequest({
        db: t.db,
        requesterId: seasonUser,
        mediaItemId: sonarrItemId,
        scope: 'season',
        seasonNumber: 7,
        targetLabel: 'Season 7',
        reason: 'wrong_version_quality',
      });
      expect(s7.status).toBe('pending');

      // The SAME open season is deduped.
      await expect(
        createFixRequest({
          db: t.db,
          requesterId: seasonUser,
          mediaItemId: sonarrItemId,
          scope: 'season',
          seasonNumber: 6,
          targetLabel: 'Season 6',
          reason: 'wrong_content',
        }),
      ).rejects.toThrow(FixAlreadyOpenError);
    });

    it('enforces the DB CHECK backstop: reason "other" without text → SQLSTATE 23514', async () => {
      await expect(
        createFixRequest({
          db: t.db,
          requesterId: memberId,
          mediaItemId: sonarrItemId,
          targetArrChildId: 44,
          reason: 'other',
        }),
      ).rejects.toSatisfy(isPostgresCheckViolation);
    });

    it(`rate-limits at ${FIX_RATE_LIMIT_PER_HOUR}/hour per requester; admins bypass (R-47)`, async () => {
      const limited = (await createUser(t.db, { email: 'limited@example.com' })).id;
      for (let i = 0; i < FIX_RATE_LIMIT_PER_HOUR; i++) {
        await createFixRequest({
          db: t.db,
          requesterId: limited,
          mediaItemId: sonarrItemId,
          targetArrChildId: 100 + i,
          reason: 'wrong_version_quality',
        });
      }
      await expect(
        createFixRequest({
          db: t.db,
          requesterId: limited,
          mediaItemId: sonarrItemId,
          targetArrChildId: 199,
          reason: 'wrong_version_quality',
        }),
      ).rejects.toThrow(FixRateLimitError);

      // The same submission with the admin bypass goes through.
      const bypass = await createFixRequest({
        db: t.db,
        requesterId: limited,
        requesterIsAdmin: true,
        mediaItemId: sonarrItemId,
        targetArrChildId: 199,
        reason: 'wrong_version_quality',
      });
      expect(bypass.status).toBe('pending');
    });
  });

  describe('recordFixAction — the T-43 lifecycle', () => {
    let fixId: string;

    beforeAll(async () => {
      ({ fixRequestId: fixId } = await createFixRequest({
        db: t.db,
        requesterId: memberId,
        mediaItemId: radarrItemId,
        reason: 'wont_play_corrupt',
      }));
    });

    it('pending → actioned records path_taken, appends actions, writes fix_actioned', async () => {
      const result = await recordFixAction({
        db: t.db,
        fixRequestId: fixId,
        transition: 'actioned',
        pathTaken: 'blocklist_search',
        actions: [
          { step: 'resolve_grab', at: new Date().toISOString(), ok: true, historyId: 123 },
          {
            step: 'mark_failed',
            at: new Date().toISOString(),
            endpoint: 'POST /api/v3/history/failed/123',
            ok: true,
            status: 200,
          },
        ],
      });
      expect(result).toEqual({ status: 'actioned' });

      const [row] = await t.db.select().from(fixRequests).where(eq(fixRequests.id, fixId));
      expect(row).toMatchObject({ status: 'actioned', pathTaken: 'blocklist_search' });
      expect(row!.actionsTaken).toHaveLength(3); // created + 2 steps
      expect(row!.actionsTaken[2]).toMatchObject({ step: 'mark_failed', status: 200 });

      const events = await eventsFor(radarrItemId, 'fix_actioned');
      expect(events).toHaveLength(1);
      expect(events[0]!.payload).toMatchObject({
        fixRequestId: fixId,
        pathTaken: 'blocklist_search',
      });
    });

    it('actioned → search_triggered records the command id, no extra ledger event type exists for it', async () => {
      await recordFixAction({
        db: t.db,
        fixRequestId: fixId,
        transition: 'search_triggered',
        actions: [
          { step: 'trigger_search', at: new Date().toISOString(), ok: true, commandId: 77 },
        ],
      });
      const [row] = await t.db.select().from(fixRequests).where(eq(fixRequests.id, fixId));
      expect(row!.status).toBe('search_triggered');
      expect(row!.actionsTaken).toHaveLength(4);
    });

    it('illegal transitions throw InvalidFixTransitionError (search_triggered is past actioning)', async () => {
      await expect(
        recordFixAction({
          db: t.db,
          fixRequestId: fixId,
          transition: 'actioned',
          pathTaken: 'delete_search',
        }),
      ).rejects.toThrow(InvalidFixTransitionError);
      await expect(
        recordFixAction({ db: t.db, fixRequestId: fixId, transition: 'failed' }),
      ).rejects.toThrow(InvalidFixTransitionError);
    });

    it('the failure path lands failed + fix_failed with the response captured (R-46)', async () => {
      const { fixRequestId: failing } = await createFixRequest({
        db: t.db,
        requesterId: memberId,
        mediaItemId: lidarrItemId,
        targetArrChildId: 9,
        targetLabel: 'Nevermind',
        reason: 'missing_subtitles',
      });
      await recordFixAction({
        db: t.db,
        fixRequestId: failing,
        transition: 'failed',
        actions: [
          {
            step: 'mark_failed',
            at: new Date().toISOString(),
            endpoint: 'POST /api/v1/history/failed/9',
            ok: false,
            status: 502,
            response: { message: 'upstream unavailable' },
          },
        ],
      });
      const [row] = await t.db.select().from(fixRequests).where(eq(fixRequests.id, failing));
      expect(row!.status).toBe('failed');
      expect(row!.actionsTaken[1]).toMatchObject({ ok: false, status: 502 });
      expect(await eventsFor(lidarrItemId, 'fix_failed')).toHaveLength(1);

      // failed is terminal: users re-raise rather than retry in place (D-09)
      await expect(
        recordFixAction({
          db: t.db,
          fixRequestId: failing,
          transition: 'actioned',
          pathTaken: 'delete_search',
        }),
      ).rejects.toThrow(InvalidFixTransitionError);
    });
  });

  describe('completeFixRequests — sync closes the loop (ADR-007 C-06)', () => {
    it('flips search_triggered → completed when the replacement import lands for the same target', async () => {
      // Open a sonarr fix for episode 42 and walk it to search_triggered.
      const requester = (await createUser(t.db, { email: 'closer@example.com' })).id;
      // (episode 42 already has a completed-out pending fix from earlier? no — earlier 42 fix
      //  is still pending; use a fresh episode id to keep this test self-contained)
      const { fixRequestId } = await createFixRequest({
        db: t.db,
        requesterId: requester,
        mediaItemId: sonarrItemId,
        targetArrChildId: 4242,
        targetLabel: 'S01E01',
        reason: 'wont_play_corrupt',
      });
      await recordFixAction({
        db: t.db,
        fixRequestId,
        transition: 'actioned',
        pathTaken: 'blocklist_search',
      });
      await recordFixAction({ db: t.db, fixRequestId, transition: 'search_triggered' });

      // Nothing to match yet: an import for a DIFFERENT episode must not complete it.
      await ingestLedgerEvents({
        db: t.db,
        source: 'sonarr',
        events: [
          {
            mediaItemId: sonarrItemId,
            eventType: 'imported',
            source: 'sonarr',
            sourceEventId: 'hist-other-episode',
            occurredAt: new Date(Date.now() + 60_000),
            payload: { rawEventType: 'downloadFolderImported', episodeId: 9999 },
          },
        ],
      });
      expect((await completeFixRequests({ db: t.db })).completed).toEqual([]);

      // The replacement import for episode 4242 closes the loop.
      await ingestLedgerEvents({
        db: t.db,
        source: 'sonarr',
        events: [
          {
            mediaItemId: sonarrItemId,
            eventType: 'imported',
            source: 'sonarr',
            sourceEventId: 'hist-replacement',
            occurredAt: new Date(Date.now() + 120_000),
            payload: { rawEventType: 'downloadFolderImported', episodeId: 4242 },
          },
        ],
      });
      const { completed } = await completeFixRequests({ db: t.db });
      expect(completed).toHaveLength(1);
      expect(completed[0]!.fixRequestId).toBe(fixRequestId);

      const [row] = await t.db.select().from(fixRequests).where(eq(fixRequests.id, fixRequestId));
      expect(row!.status).toBe('completed');
      expect(row!.completedEventId).toBe(completed[0]!.completedEventId);

      const events = await eventsFor(sonarrItemId, 'fix_completed');
      expect(events).toHaveLength(1);
      expect(events[0]!.payload).toMatchObject({ fixRequestId });

      // completed is terminal
      await expect(
        recordFixAction({ db: t.db, fixRequestId, transition: 'failed' }),
      ).rejects.toThrow(InvalidFixTransitionError);
    });
  });

  describe('expireStaleFixRequests — the never-stuck safety net (timeouts)', () => {
    it('times out an OPEN fix past the horizon and STOPS it blocking a new fix on the same target', async () => {
      const requester = (await createUser(t.db, { email: 'timeout@example.com' })).id;
      const child = 55501;
      const { fixRequestId } = await createFixRequest({
        db: t.db,
        requesterId: requester,
        requesterIsAdmin: true,
        mediaItemId: sonarrItemId,
        targetArrChildId: child,
        reason: 'wont_play_corrupt',
      });
      // Still open ⇒ a duplicate is blocked.
      await expect(
        createFixRequest({
          db: t.db,
          requesterId: requester,
          requesterIsAdmin: true,
          mediaItemId: sonarrItemId,
          targetArrChildId: child,
          reason: 'wrong_language',
        }),
      ).rejects.toThrow(FixAlreadyOpenError);

      // Inside the horizon ⇒ no-op.
      const early = await expireStaleFixRequests({ db: t.db, horizonMs: 48 * 3_600_000 });
      expect(early.timedOut.map((f) => f.fixRequestId)).not.toContain(fixRequestId);

      // 49h later (asOf) ⇒ closes to 'timed_out' with an audit note.
      const { timedOut } = await expireStaleFixRequests({
        db: t.db,
        horizonMs: 48 * 3_600_000,
        asOf: new Date(Date.now() + 49 * 3_600_000),
      });
      expect(timedOut.map((f) => f.fixRequestId)).toContain(fixRequestId);
      const [row] = await t.db.select().from(fixRequests).where(eq(fixRequests.id, fixRequestId));
      expect(row!.status).toBe('timed_out');
      expect(row!.actionsTaken.at(-1)).toMatchObject({ step: 'timed_out' });

      // The block is released — a fresh fix on the SAME target is now allowed.
      const reopened = await createFixRequest({
        db: t.db,
        requesterId: requester,
        requesterIsAdmin: true,
        mediaItemId: sonarrItemId,
        targetArrChildId: child,
        reason: 'wrong_language',
      });
      expect(reopened.status).toBe('pending');
    });

    it('times out a fire-and-forget bazarr_subtitle fix (completeFixRequests never would)', async () => {
      const requester = (await createUser(t.db, { email: 'sub-timeout@example.com' })).id;
      const child = 55510;
      const { fixRequestId } = await createFixRequest({
        db: t.db,
        requesterId: requester,
        requesterIsAdmin: true,
        mediaItemId: sonarrItemId,
        targetArrChildId: child,
        reason: 'missing_subtitles',
      });
      await recordFixAction({
        db: t.db,
        fixRequestId,
        transition: 'actioned',
        pathTaken: 'bazarr_subtitle',
      });
      await recordFixAction({ db: t.db, fixRequestId, transition: 'search_triggered' });
      // completeFixRequests deliberately excludes bazarr_subtitle → it never closes here.
      expect((await completeFixRequests({ db: t.db })).completed.map((c) => c.fixRequestId)).not.toContain(
        fixRequestId,
      );
      // The timeout is the ONLY path that closes it.
      const { timedOut } = await expireStaleFixRequests({
        db: t.db,
        horizonMs: 48 * 3_600_000,
        asOf: new Date(Date.now() + 49 * 3_600_000),
      });
      expect(timedOut.map((f) => f.fixRequestId)).toContain(fixRequestId);
    });
  });

  describe('closeFixManually — the manual unblock', () => {
    it('owner or admin closes an OPEN fix; a stranger gets NOT_FOUND; terminal is guarded', async () => {
      const owner = (await createUser(t.db, { email: 'closer-owner@example.com' })).id;
      const stranger = (await createUser(t.db, { email: 'closer-stranger@example.com' })).id;
      const child = 55601;
      const { fixRequestId } = await createFixRequest({
        db: t.db,
        requesterId: owner,
        requesterIsAdmin: true,
        mediaItemId: sonarrItemId,
        targetArrChildId: child,
        reason: 'wont_play_corrupt',
      });

      // A non-owner, non-admin sees NOT_FOUND (never reveal another member's fix).
      await expect(
        closeFixManually({ db: t.db, fixRequestId, actorId: stranger }),
      ).rejects.toThrow(NotFoundError);

      // The owner closes it.
      expect(await closeFixManually({ db: t.db, fixRequestId, actorId: owner })).toEqual({
        status: 'closed_manually',
      });
      const [row] = await t.db.select().from(fixRequests).where(eq(fixRequests.id, fixRequestId));
      expect(row!.status).toBe('closed_manually');
      expect(row!.actionsTaken.at(-1)).toMatchObject({ step: 'closed_manually', by: owner });

      // Already terminal ⇒ InvalidFixTransitionError.
      await expect(
        closeFixManually({ db: t.db, fixRequestId, actorId: owner }),
      ).rejects.toThrow(InvalidFixTransitionError);

      // The block is released.
      const reopened = await createFixRequest({
        db: t.db,
        requesterId: owner,
        requesterIsAdmin: true,
        mediaItemId: sonarrItemId,
        targetArrChildId: child,
        reason: 'wrong_language',
      });
      expect(reopened.status).toBe('pending');

      // An admin may close a fix they did not open.
      const { fixRequestId: adminTarget } = await createFixRequest({
        db: t.db,
        requesterId: owner,
        requesterIsAdmin: true,
        mediaItemId: sonarrItemId,
        targetArrChildId: 55602,
        reason: 'wont_play_corrupt',
      });
      expect(
        await closeFixManually({ db: t.db, fixRequestId: adminTarget, actorId: stranger, actorIsAdmin: true }),
      ).toEqual({ status: 'closed_manually' });
    });
  });
});
