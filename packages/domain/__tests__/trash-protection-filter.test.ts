// DESIGN-052 D-10 amendment (2026-11-13, story 832) — Wall Protection is one definition.
// The default pending view (`includeWatchlisted: false`) holds no title the guardian would keep,
// and the protected view returns each title with that reason. Embedded PostgreSQL 16 only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEEDED_PLEX_SERVER_IDS, mediaItems, plexLibraries } from '@hnet/db/schema';
import {
  classifyForExpedite,
  listTrashPendingPage,
  openSaveIntent,
  refreshTrashCandidates,
  syncPlexMatches,
  trashWallProtection,
  upsertMediaMetadataBatch,
  upsertPlexLibraries,
  type ExpediteVerdict,
  type ExpediteVerdictInput,
  type TrashWallProtectionReason,
} from '../src/index';
import { inTransaction } from '../src/db-client';
import { baseState, makeMaintainerr, movieCollection, type StubItem } from './maintainerr-stub';
import { bootMigratedDb, createUser, seedVerifiedWatchlistRegistry, type TestDb , upsertDeletableMediaItems } from './helpers';

const LISTED = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const UNMAPPED = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const COLD = 'cccccccccccccccccccccccc';
const RULES = 'dddddddddddddddddddddddd';
const LIVE = 'eeeeeeeeeeeeeeeeeeeeeeee';
const UNDATED = 'ffffffffffffffffffffffff';
const RECENT = '111111111111111111111111';

const common = {
  monitored: true,
  qualityProfileId: 1,
  qualityProfileName: 'Any',
  rootFolder: '/movies',
};

function verdictFor(reason: TrashWallProtectionReason | null): ExpediteVerdict {
  if (reason === null) return 'deletable';
  if (reason === 'saved') return 'protected_saved';
  if (reason === 'tag') return 'protected_tag';
  if (reason === 'recently_watched') return 'protected_watched';
  if (reason === 'watchlisted') return 'protected_watchlist';
  if (reason === 'recently_added') return 'protected_recent';
  return 'unverifiable';
}

describe('trashWallProtection agrees with classifyForExpedite', () => {
  const base: ExpediteVerdictInput = {
    maintainerrMediaId: 'ms',
    mediaItemId: 'ledger',
    protectedByTag: false,
    recentlyWatched: false,
    onWatchlist: false,
    watchlistEvaluable: true,
    ruleEvaluationFailed: false,
    ageGuard: 'clear',
    saveIntent: false,
  };
  const cases: Array<[string, Partial<ExpediteVerdictInput>, TrashWallProtectionReason | null]> = [
    ['a cleared title', {}, null],
    ['no Maintainerr id', { maintainerrMediaId: null }, 'unactionable'],
    ['an open save', { saveIntent: true }, 'saved'],
    ['the dnd tag', { protectedByTag: true }, 'tag'],
    ['a recent watch', { recentlyWatched: true }, 'recently_watched'],
    ['a watchlist', { onWatchlist: true }, 'watchlisted'],
    ['the Age Guard', { ageGuard: 'recent' }, 'recently_added'],
    ['no ledger row', { mediaItemId: null }, 'not_in_ledger'],
    ['a watchlist that cannot be decided', { watchlistEvaluable: false }, 'watchlist_unknown'],
    ['a failed rule read', { ruleEvaluationFailed: true }, 'rules_unknown'],
    ['an undated add', { ageGuard: 'unknown' }, 'age_unknown'],
    [
      'a save ahead of later keeps',
      { saveIntent: true, onWatchlist: true, ageGuard: 'recent' },
      'saved',
    ],
    [
      'no ledger row ahead of the later unevaluable checks',
      { mediaItemId: null, watchlistEvaluable: false, ageGuard: 'unknown' },
      'not_in_ledger',
    ],
  ];

  it.each(cases)('%s', (_label, over, reason) => {
    const item = { ...base, ...over };
    expect(trashWallProtection(item)).toBe(reason);
    expect(classifyForExpedite(item)).toBe(verdictFor(reason));
  });

  // The cases above are samples. This walks every combination of the nine inputs, so the wall can
  // never offer a title Expedite would keep, or hide one Expedite would delete, whatever is added
  // to either function later.
  it('offers a title exactly when Expedite would delete it, for every combination of inputs', () => {
    const flags = [false, true] as const;
    let checked = 0;
    for (const maintainerrMediaId of ['ms', null])
      for (const mediaItemId of ['ledger', null])
        for (const saveIntent of flags)
          for (const protectedByTag of flags)
            for (const recentlyWatched of flags)
              for (const onWatchlist of flags)
                for (const watchlistEvaluable of flags)
                  for (const ruleEvaluationFailed of flags)
                    for (const ageGuard of ['clear', 'recent', 'unknown'] as const) {
                      const item: ExpediteVerdictInput = {
                        maintainerrMediaId,
                        mediaItemId,
                        saveIntent,
                        protectedByTag,
                        recentlyWatched,
                        onWatchlist,
                        watchlistEvaluable,
                        ruleEvaluationFailed,
                        ageGuard,
                      };
                      const reason = trashWallProtection(item);
                      const verdict = classifyForExpedite(item);
                      expect(verdict, JSON.stringify(item)).toBe(verdictFor(reason));
                      expect(reason === null, JSON.stringify(item)).toBe(verdict === 'deletable');
                      checked += 1;
                    }
    // Eight two-valued inputs and the three Age Guard verdicts.
    expect(checked).toBe(2 ** 8 * 3);
  });
});

describe('the pending views follow Wall Protection (DESIGN-052 D-10, story 832)', () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await bootMigratedDb();
    const actor = await createUser(t.db, {
      email: 'wall-protection@example.com',
      displayName: 'Wall Protection',
    });
    await upsertPlexLibraries({
      db: t.db,
      slug: 'haynesops',
      libraries: [{ sectionKey: '1', name: 'HOps Movies', mediaType: 'movie' }],
    });
    const libs = await t.db.select().from(plexLibraries);
    const plexLibraryId = libs.find(
      (l) => l.serverId === SEEDED_PLEX_SERVER_IDS.haynesops && l.sectionKey === '1',
    )!.id;

    await upsertDeletableMediaItems({
      db: t.db,
      arrKind: 'radarr',
      items: [
        { ...common, arrItemId: 1, tmdbId: 9201, title: 'Cold Title', sortTitle: 'cold' },
        { ...common, arrItemId: 2, tmdbId: 9202, title: 'Saved Title', sortTitle: 'saved' },
        {
          ...common,
          arrItemId: 3,
          tmdbId: 9203,
          title: 'Tagged Title',
          sortTitle: 'tagged',
          arrTags: ['dnd'],
        },
        { ...common, arrItemId: 4, tmdbId: 9204, title: 'Watched Title', sortTitle: 'watched' },
        { ...common, arrItemId: 5, tmdbId: 9205, title: 'Listed Title', sortTitle: 'listed' },
        { ...common, arrItemId: 6, tmdbId: 9206, title: 'Recent Title', sortTitle: 'recent' },
        { ...common, arrItemId: 8, tmdbId: 9208, title: 'Blind Title', sortTitle: 'blind' },
        { ...common, arrItemId: 9, tmdbId: 9209, title: 'Rules Title', sortTitle: 'rules' },
        { ...common, arrItemId: 10, tmdbId: 9210, title: 'Undated Title', sortTitle: 'undated' },
        { ...common, arrItemId: 11, tmdbId: 9211, title: 'Live Title', sortTitle: 'live' },
      ],
    });
    const rows = await t.db.select().from(mediaItems);
    const idOf = (tmdbId: number) => rows.find((r) => r.tmdbId === tmdbId)!.id;
    await upsertMediaMetadataBatch({
      db: t.db,
      rows: [
        {
          mediaItemId: idOf(9204),
          lastViewedAt: new Date(Date.now() - 2 * 86_400_000),
        },
      ],
    });
    await syncPlexMatches({
      db: t.db,
      matches: [
        {
          mediaItemId: idOf(9206),
          plexLibraryId,
          ratingKey: '9206',
          matchedVia: 'tmdb',
          plexAddedAt: new Date(),
        },
        {
          mediaItemId: idOf(9210),
          plexLibraryId,
          ratingKey: '9210',
          matchedVia: 'tmdb',
          plexAddedAt: null,
        },
      ],
      scopedLibraryIds: [plexLibraryId],
    });
    await inTransaction(t.db, (tx) =>
      openSaveIntent(tx, {
        mediaItemId: idOf(9202),
        maintainerrMediaId: 'ms-saved',
        origin: 'user',
        actorId: actor.id,
        exclusionConfirmed: false,
      }),
    );
    await seedVerifiedWatchlistRegistry(t.db, {
      ownerId: '1',
      owner: [
        { discoverId: LISTED, kind: 'movie', tmdbId: 9205 },
        { discoverId: UNMAPPED, kind: 'movie' },
      ],
      discover: {
        [LISTED]: { kind: 'movie', ids: { tmdbId: 9205, tvdbId: null, imdbId: null } },
        [UNMAPPED]: null,
      },
    });
  }, 120_000);

  afterAll(async () => t?.stop());

  function pool(): ReturnType<typeof movieCollection> {
    const dated = '2026-01-01T00:00:00Z';
    const items: StubItem[] = [
      {
        mediaServerId: 'ms-cold',
        tmdbId: 9201,
        sizeBytes: 100,
        addDate: dated,
        mediaData: { guid: `plex://movie/${COLD}` },
      },
      { mediaServerId: 'ms-saved', tmdbId: 9202, sizeBytes: 200, addDate: dated },
      { mediaServerId: 'ms-tag', tmdbId: 9203, sizeBytes: 300, addDate: dated },
      { mediaServerId: 'ms-watched', tmdbId: 9204, sizeBytes: 400, addDate: dated },
      {
        mediaServerId: 'ms-listed',
        tmdbId: 9205,
        sizeBytes: 500,
        addDate: dated,
        mediaData: { guid: `plex://movie/${LISTED}` },
      },
      {
        mediaServerId: 'ms-recent',
        tmdbId: 9206,
        sizeBytes: 600,
        addDate: dated,
        mediaData: { guid: `plex://movie/${RECENT}` },
      },
      { mediaServerId: 'ms-missing', tmdbId: 9207, sizeBytes: 700, addDate: dated },
      { mediaServerId: 'ms-blind', tmdbId: 9208, sizeBytes: 800, addDate: dated },
      {
        mediaServerId: 'ms-rules',
        tmdbId: 9209,
        sizeBytes: 900,
        addDate: dated,
        mediaData: { guid: `plex://movie/${RULES}` },
        ruleEvaluationFailed: true,
      },
      {
        mediaServerId: 'ms-undated',
        tmdbId: 9210,
        sizeBytes: 1000,
        addDate: dated,
        mediaData: { guid: `plex://movie/${UNDATED}` },
      },
      {
        mediaServerId: 'ms-live',
        tmdbId: 9211,
        sizeBytes: 1100,
        addDate: dated,
        mediaData: { guid: `plex://movie/${LIVE}` },
      },
      { tmdbId: 9212, sizeBytes: 1200, addDate: dated } as StubItem,
    ];
    return movieCollection({ items });
  }

  it('hides every held title by default and returns its reason when protected', async () => {
    const state = baseState({ collections: [pool()] });
    state.exclusions.add('ms-live');
    const { bundle } = makeMaintainerr(state);
    await refreshTrashCandidates({ db: t.db, maintainerr: bundle });

    const hidden = await listTrashPendingPage({
      db: t.db,
      maintainerr: bundle,
      media: 'movie',
      limit: 20,
      offset: 0,
      filters: { includeWatchlisted: false },
    });
    expect(hidden.total).toBe(12);
    expect(hidden.items.map((i) => i.tmdbId)).toEqual([9201]);
    expect(hidden.items[0]!.protectionReason).toBeNull();
    expect(hidden.filteredCount).toBe(1);
    expect(hidden.filteredSizeBytes).toBe(100);
    // Live exclusion is a page fact, not an Expedite verdict: the preview still counts that title deletable.
    expect(hidden.expeditePreview).toMatchObject({ deletable: 2, protected: 5, unverifiable: 5 });

    const shown = await listTrashPendingPage({
      db: t.db,
      maintainerr: bundle,
      media: 'movie',
      limit: 20,
      offset: 0,
      filters: { includeWatchlisted: true },
    });
    expect(shown.filteredCount).toBe(12);
    expect(shown.filteredSizeBytes).toBe(hidden.totalSizeBytes);
    const reason = new Map(shown.items.map((i) => [i.tmdbId, i.protectionReason]));
    expect(reason).toEqual(
      new Map<number, TrashWallProtectionReason | null>([
        [9201, null],
        [9202, 'saved'],
        [9203, 'tag'],
        [9204, 'recently_watched'],
        [9205, 'watchlisted'],
        [9206, 'recently_added'],
        [9207, 'not_in_ledger'],
        [9208, 'watchlist_unknown'],
        [9209, 'rules_unknown'],
        [9210, 'age_unknown'],
        [9211, 'live_excluded'],
        [9212, 'unactionable'],
      ]),
    );

    const omitted = await listTrashPendingPage({
      db: t.db,
      maintainerr: bundle,
      media: 'movie',
      limit: 20,
      offset: 0,
    });
    expect(omitted.items).toHaveLength(12);
    expect(omitted.filteredCount).toBe(12);
  });

  it('drops a live exclusion from the default page without skipping the next deletable title', async () => {
    const state = baseState({ collections: [pool()] });
    state.exclusions.add('ms-live');
    const { bundle } = makeMaintainerr(state);
    await refreshTrashCandidates({ db: t.db, maintainerr: bundle });
    const sort = { field: 'title' as const, dir: 'asc' as const };
    const first = await listTrashPendingPage({
      db: t.db,
      maintainerr: bundle,
      media: 'movie',
      limit: 1,
      offset: 0,
      sort,
      filters: { includeWatchlisted: false },
    });
    expect(first.items.map((i) => i.title)).toEqual(['Cold Title']);
    expect(first.nextCursor).toBe(1);
    // The live-excluded title is the next row of the pre-drop list, so the count on this page
    // still includes it (DESIGN-052 Q-15). The following page drops it.
    expect(first.filteredCount).toBe(2);
    const second = await listTrashPendingPage({
      db: t.db,
      maintainerr: bundle,
      media: 'movie',
      limit: 1,
      offset: first.nextCursor!,
      sort,
      filters: { includeWatchlisted: false },
    });
    expect(second.items).toEqual([]);
    expect(second.filteredCount).toBe(1);
    expect(second.nextCursor).toBeNull();
  });
});
