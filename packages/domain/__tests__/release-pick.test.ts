// ADR-109 C-02, C-04, C-06 / DESIGN-055 D-06 (PLAN-077 P5) — the Release Pick. Pure: the plain words for the *arr's
// rejections and the row states on the live Regular Show: The Lost Tapes S01 lists (Case A: E11 "Spice It Up" and E13
// "Terror Tales" had only profile-rejected releases; the hand fix grabbed OldT's release numbered for E10 that held
// E11, and a 720p one for E13). Then over the embedded Postgres harness and a stub Sonarr and Radarr: the Release List
// and its budget unit, the grab bodies pinned to each UI, the refusals, a failed download settling the pick, the
// follow-through import, and completion.
import { readFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { arrReleaseSchema, type ArrRelease } from '@hnet/arr';
import { ledgerEvents, releasePickLists, repairRequests } from '@hnet/db/schema';
import {
  FixAlreadyOpenError,
  FixRateLimitError,
  FixRefusedError,
  RELEASE_PICK_GRAB_WINDOW_MS,
  buildArrClientBundle,
  classifyReleases,
  completeRepairRequests,
  createRepairRequest,
  describeRejection,
  grabFromReleaseList,
  openReleaseList,
  plainQuality,
  releaseKey,
  resetReleaseSearchState,
  setRepairGuideRemedies,
  settleReleasePicks,
  upsertMediaItemsBatch,
  type ArrClientBundle,
  type ReleasePickTarget,
} from '../src/index';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

interface LostTapes {
  seriesId: number;
  seriesYear: number;
  episodes: Array<{ id: number; seasonNumber: number; episodeNumber: number; title: string }>;
  releases: Array<Record<string, unknown>>;
}
const lostTapes = JSON.parse(
  readFileSync(new URL('./fixtures/release-pick-lost-tapes-s01.json', import.meta.url), 'utf8'),
) as LostTapes;
const arrFixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../arr/__fixtures__/${name}.json`, import.meta.url), 'utf8'));

const E11 = lostTapes.episodes.find((e) => e.episodeNumber === 11)!;
const E13 = lostTapes.episodes.find((e) => e.episodeNumber === 13)!;
const releases = (): ArrRelease[] => lostTapes.releases.map((r) => arrReleaseSchema.parse(r));
const episodeTarget = (e: typeof E11): ReleasePickTarget => ({
  kind: 'sonarr',
  seriesId: lostTapes.seriesId,
  seriesYear: lostTapes.seriesYear,
  episodeId: e.id,
  seasonNumber: 1,
  episodeNumber: e.episodeNumber,
  label: `S01E${e.episodeNumber} · ${e.title}`,
  seasonEpisodes: lostTapes.episodes,
});

describe('describeRejection: the *arr reasons in plain words (RELEASE_REASONS_VERSION 1)', () => {
  const sonarr = { kind: 'sonarr' as const };
  it('puts the Q-01 overridable reasons in words anyone can read', () => {
    expect(describeRejection('Custom Formats HMAX, x265 (HD) have score -9925 below Series profile minimum 0', sonarr)).toEqual({
      code: 'score_below_minimum',
      class: 'overridable',
      text: 'Lower quality than the library usually keeps',
      arrText: 'Custom Formats HMAX, x265 (HD) have score -9925 below Series profile minimum 0',
    });
    expect(describeRejection('WEBDL-720p is not wanted in profile', sonarr)).toMatchObject({
      code: 'quality_not_wanted',
      class: 'overridable',
      text: 'Not a quality the library usually keeps (720p)',
    });
    expect(describeRejection('Original Language (Japanese) is wanted, but found English', { kind: 'radarr' })).toMatchObject({
      code: 'language_not_wanted',
      class: 'overridable',
      text: "In a language the library doesn't usually keep (English)",
    });
  });

  it('refuses the D-06 hard reasons for everyone', () => {
    for (const [text, code] of [
      ['Release is blocklisted', 'blocklisted'],
      ['Contains these ignored terms: /\\bDUAL[ ._-]BiOMA\\b/i', 'blocked_term'],
      ['Sample', 'sample'],
      ['24.1 GB is larger than maximum allowed 12.3 GB (for 45min)', 'too_big'],
      ['Release in queue already meets cutoff: WEBDL-1080p', 'in_queue'],
    ] as const) {
      expect(describeRejection(text, sonarr)).toMatchObject({ code, class: 'hard' });
    }
  });

  it('drops what does not apply to a pick for one episode, and keeps unknown words verbatim', () => {
    expect(describeRejection('Last episode in this season aired more than 14 days ago, season pack required.', sonarr)).toBeNull();
    expect(describeRejection("Episode wasn't requested: 1x10", { kind: 'sonarr', mislabeled: true })).toBeNull();
    expect(describeRejection('Existing file on disk has a equal or higher Custom Format score: 75', { kind: 'sonarr', mislabeled: true })).toBeNull();
    expect(describeRejection("Episode wasn't requested: 1x10", sonarr)).toMatchObject({ code: 'not_this_episode', class: 'other' });
    expect(describeRejection('Episode is not monitored', sonarr)).toMatchObject({ class: 'other', text: 'This episode is turned off for downloads' });
    expect(describeRejection('Something new the *arr says', sonarr)).toEqual({
      code: 'unknown',
      class: 'other',
      text: 'Something new the *arr says',
      arrText: 'Something new the *arr says',
    });
    expect(plainQuality('Bluray-1080p Remux')).toBe('1080p');
    expect(plainQuality('SDTV')).toBe('standard definition');
  });
});

describe('classifyReleases on the live Lost Tapes S01 lists (Case A, AC-40 release half)', () => {
  it('E11: the only pick is OldT’s release numbered for E10 that is titled "Spice It Up" (the hand fix)', () => {
    const { rows, offers, recommendedKey, counts } = classifyReleases(releases(), episodeTarget(E11));
    const best = rows.find((r) => r.recommended)!;
    expect(best).toMatchObject({
      title: 'Regular.Show.The.Lost.Tapes.S01E10.Spice.It.Up.1080p.HMAX.WEB-DL.DDP2.0.H.265-OldT',
      state: 'override',
      numberedAs: 'S01E10 · Stilt Walkers',
      evidence: { verdict: 'agrees' },
    });
    // Its season-search and other-episode rejections do not apply; what is left is overridable.
    expect(best.reasons.map((r) => r.code).sort()).toEqual(['numbered_other_episode', 'score_below_minimum']);
    expect(recommendedKey).toBe(best.key);
    // Everything else on E11 is refused for everyone: the hand-blocked groups, the blocklisted AURORA posting, and the
    // OldT release numbered E11 whose title is E12's.
    const others = rows.filter((r) => r !== best);
    expect(others.every((r) => r.state === 'not_allowed')).toBe(true);
    const secretMenu = rows.find((r) => r.title.includes('S01E11.Secret.Menu.Item'))!;
    expect(secretMenu.reasons.map((r) => r.code)).toEqual(expect.arrayContaining(['title_names_other_episode', 'blocked_term']));
    expect(secretMenu.reasons.find((r) => r.code === 'title_names_other_episode')!.text).toBe(
      "Its name says it's a different episode (S01E12 · Secret Menu Item)",
    );
    expect(rows.find((r) => r.title.includes('Beyond.Underdome'))!.reasons[0]!.code).toBe('blocklisted');
    // The four BiOMA postings are one row found on four sites.
    const bioma = rows.filter((r) => r.title.includes('BiOMA'));
    expect(bioma).toHaveLength(1);
    expect(bioma[0]!.keys).toHaveLength(4);
    // E13's rows and the E09 row whose name says nothing about E11 are dropped.
    expect(rows.some((r) => /S01E13|S01E09/.test(r.title))).toBe(false);
    expect(counts.dropped).toBeGreaterThan(0);
    // Only the pick can be grabbed, and its grab overrides (the row is pinned to E11).
    expect(offers).toEqual([expect.objectContaining({ key: best.key, state: 'override', overrideBody: true, indexerId: 3 })]);
    // The guid never reaches the rows the person sees.
    expect(JSON.stringify(rows)).not.toContain('lost-tapes-s01-pick');
  });

  it('E13: the 720p release titled for E13 is the pick; the H.265 one titled for E14 is refused', () => {
    const { rows } = classifyReleases(releases(), episodeTarget(E13));
    const best = rows.find((r) => r.recommended)!;
    expect(best).toMatchObject({ state: 'override', qualityPlain: '720p', evidence: { verdict: 'agrees' } });
    expect(best.title).toContain('Terror.Tales.of.the.Park.VII.Halloween.Special.MULTI.720p');
    expect(best.reasons.map((r) => r.text)).toEqual(['Not a quality the library usually keeps (720p)']);
    expect(best.languages).toEqual(expect.arrayContaining(['English', 'Portuguese', 'Spanish']));
    const smokeAlarm = rows.find((r) => r.title.includes('Smoke.Alarm') && r.releaseGroup === 'AKARi')!;
    expect(smokeAlarm.state).toBe('not_allowed');
    expect(smokeAlarm.reasons.map((r) => r.code)).toContain('title_names_other_episode');
    // The two-episode file holds E13 and E14: shown, never picked.
    const pack = rows.find((r) => r.title.includes('S01E13E14'))!;
    expect(pack.state).toBe('not_allowed');
    expect(pack.reasons.map((r) => r.code)).toContain('pack');
  });

  it('an approved row is a Grab with the plain body, unless a hard reason refuses it (hard refusals win)', () => {
    const base = releases().find((r) => r.title.includes('S01E10.Spice.It.Up'))!;
    const approved: ArrRelease = {
      ...base,
      guid: 'approved-e11',
      title: 'Regular.Show.The.Lost.Tapes.S01E11.Spice.It.Up.1080p.AMZN.WEB-DL.DDP5.1.H.264-GOOD',
      episodeNumbers: [11],
      approved: true,
      rejections: [],
    };
    const wrongTitle: ArrRelease = { ...approved, guid: 'approved-wrong', title: approved.title.replace('Spice.It.Up', 'Secret.Menu.Item') };
    const { rows, offers } = classifyReleases([wrongTitle, approved, ...releases()], episodeTarget(E11));
    expect(rows[0]).toMatchObject({ state: 'grab', recommended: true, title: approved.title });
    expect(offers.find((o) => o.key === releaseKey(approved))).toMatchObject({ state: 'grab', overrideBody: false });
    expect(rows.find((r) => r.title === wrongTitle.title)).toMatchObject({ state: 'not_allowed' });
    // With a Grab on the list it is recommended over any Override.
    expect(rows.filter((r) => r.recommended)).toHaveLength(1);
  });

  it('a movie: early copies, unknown quality and an oversize release are refused; an unmatched row is dropped', () => {
    const movie = (o: Partial<ArrRelease>): ArrRelease => ({
      ...releases()[0]!,
      seasonNumber: null,
      episodeNumbers: [],
      title: 'Winner.Takes.the.Cake.2025.1080p.WEB-DL.DDP5.1.H.264-GRP',
      rejections: ['WEBDL-1080p is not wanted in profile'],
      ...o,
    });
    const target: ReleasePickTarget = { kind: 'radarr', movieId: 1, label: 'Winner Takes the Cake', titles: ['Winner Takes the Cake'], year: 2025 };
    const { rows } = classifyReleases(
      [
        movie({ guid: 'm1' }),
        movie({ guid: 'm2', title: 'Winner.Takes.the.Cake.2025.CAM.x264-RIP', qualityName: 'CAM' }),
        movie({ guid: 'm3', title: 'Winner.Takes.the.Cake.2025.XviD-UNK', qualityName: 'Unknown' }),
        movie({ guid: 'm4', title: 'Winner.Takes.the.Cake.2025.2160p.REMUX-BIG', size: 140 * 1024 ** 3 }),
        movie({ guid: 'm5', title: 'Another.Film.2025.1080p.WEB-DL-X', rejections: ['Wrong movie'] }),
      ],
      target,
    );
    expect(rows.map((r) => [r.title.split('.')[5], r.state])).toEqual([
      ['1080p', 'override'],
      ['CAM', 'not_allowed'],
      ['XviD-UNK', 'not_allowed'],
      ['2160p', 'not_allowed'],
    ]);
    expect(rows[1]!.reasons[0]).toMatchObject({ code: 'early_copy', class: 'hard' });
    expect(rows[2]!.reasons[0]).toMatchObject({ code: 'unknown_quality' });
    expect(rows[3]!.reasons[0]).toMatchObject({ code: 'too_big' });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// I/O: the list, the grab, the refusals, the settling.
// ---------------------------------------------------------------------------------------------------------------------

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

function stubArr() {
  const state = {
    hasFile: new Set<number>(lostTapes.episodes.map((e) => e.id).filter((id) => id !== E11.id && id !== E13.id)),
    queue: [] as Array<Record<string, unknown>>,
    radarrQueue: [] as Array<Record<string, unknown>>,
    movieHasFile: false,
    grabStatus: new Map<string, number>(),
    movieReleases: [] as Array<Record<string, unknown>>,
    calls: [] as Call[],
  };
  const json = (body: unknown, status = 200) =>
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const page = (records: unknown[]) => ({ page: 1, pageSize: 200, totalRecords: records.length, records });
  const fetchImpl = (async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    state.calls.push({ method, path: url.pathname, query: url.searchParams, body });
    const sonarr = url.host.startsWith('sonarr');
    const p = url.pathname;
    if (method === 'GET' && p === '/api/v3/queue') return json(page(sonarr ? state.queue : state.radarrQueue));
    if (sonarr && method === 'GET' && p === '/api/v3/episode') {
      return json(
        lostTapes.episodes.map((e) => ({
          ...e,
          seriesId: lostTapes.seriesId,
          hasFile: state.hasFile.has(e.id),
          monitored: true,
          ...(state.hasFile.has(e.id) ? { episodeFileId: 70_000 + e.episodeNumber } : {}),
        })),
      );
    }
    if (sonarr && method === 'GET' && p === `/api/v3/series/${lostTapes.seriesId}`) {
      return json({
        ...(arrFixture('sonarr.series-byid') as Record<string, unknown>),
        id: lostTapes.seriesId,
        title: 'Regular Show: The Lost Tapes',
        year: lostTapes.seriesYear,
      });
    }
    if (!sonarr && method === 'GET' && p === '/api/v3/movie/1') {
      return json({ ...(arrFixture('radarr.movie-byid') as Record<string, unknown>), hasFile: state.movieHasFile, monitored: true });
    }
    if (method === 'GET' && p === '/api/v3/release') return json(sonarr ? lostTapes.releases : state.movieReleases);
    if (method === 'POST' && p === '/api/v3/release') {
      const guid = (body as { guid: string }).guid;
      const status = state.grabStatus.get(guid) ?? 200;
      if (status !== 200) return json({ message: status === 404 ? "Couldn't find requested release in cache, try searching again" : 'Getting release from indexer failed' }, status);
      if (sonarr) {
        const episodeId = (body as { episodeIds?: number[] }).episodeIds?.[0] ?? E11.id;
        state.queue.push({
          id: 5000 + state.queue.length, seriesId: lostTapes.seriesId, episodeId, seasonNumber: 1, downloadId: `dl-${guid}`,
          title: 'grabbed', status: 'downloading', trackedDownloadStatus: 'ok', trackedDownloadState: 'downloading',
          size: 1e9, sizeleft: 5e8, added: new Date().toISOString(),
        });
      }
      return json(body);
    }
    return json({ message: `no stub for ${method} ${p}` }, 404);
  }) as typeof fetch;
  const opts = { apiKey: 'k', retryDelayMs: 0, fetchImpl } as const;
  const bundle: ArrClientBundle = buildArrClientBundle({
    sonarr: { baseUrl: 'http://sonarr.test:8989', ...opts },
    radarr: { baseUrl: 'http://radarr.test:7878', ...opts },
    lidarr: { baseUrl: 'http://lidarr.test:8686', ...opts },
    bazarr: { baseUrl: 'http://bazarr.test:6767', ...opts },
  });
  const releaseSearches = () => state.calls.filter((c) => c.method === 'GET' && c.path === '/api/v3/release');
  const grabs = () => state.calls.filter((c) => c.method === 'POST' && c.path === '/api/v3/release').map((c) => c.body);
  return { state, bundle, releaseSearches, grabs };
}

describe('the Release Pick over embedded Postgres (DESIGN-055 D-06)', () => {
  let t: TestDb;
  let memberId: string;
  let showId: string;
  let movieId: string;
  const e11 = () => ({ mediaItemId: showId, scope: 'episode' as const, targetChildId: E11.id });
  const e13 = () => ({ mediaItemId: showId, scope: 'episode' as const, targetChildId: E13.id });
  const listEvents = async (requester: string) =>
    t.db
      .select()
      .from(ledgerEvents)
      .where(and(eq(ledgerEvents.eventType, 'release_list_requested'), eq(ledgerEvents.requestedByUserId, requester)));

  beforeAll(async () => {
    t = await bootMigratedDb();
    memberId = (await createUser(t.db, { email: 'tapes@example.com', displayName: 'Tapes Viewer' })).id;
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'sonarr',
      items: [{ arrItemId: lostTapes.seriesId, tvdbId: 475718, title: 'Regular Show: The Lost Tapes', sortTitle: 'regular show the lost tapes', monitored: true, qualityProfileId: 1, qualityProfileName: 'HD', rootFolder: '/tv' }],
    });
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'radarr',
      items: [{ arrItemId: 1, tmdbId: 1233620, title: 'Winner Takes the Cake', sortTitle: 'winner takes the cake', monitored: true, qualityProfileId: 1, qualityProfileName: 'HD', rootFolder: '/movies' }],
    });
    showId = (await t.db.query.mediaItems.findMany({ where: (m, { eq: e }) => e(m.arrItemId, lostTapes.seriesId) }))[0]!.id;
    movieId = (await t.db.query.mediaItems.findMany({ where: (m, { and: a, eq: e }) => a(e(m.arrItemId, 1), e(m.arrKind, 'radarr')) }))[0]!.id;
  }, 240_000);

  afterAll(async () => {
    await t.stop();
  });

  beforeEach(async () => {
    resetReleaseSearchState();
    await setRepairGuideRemedies({ db: t.db, remedies: { release_pick: true }, actorId: null });
    await t.db.delete(repairRequests);
    await t.db.delete(releasePickLists);
    await t.db.delete(ledgerEvents).where(eq(ledgerEvents.mediaItemId, showId));
    await t.db.delete(ledgerEvents).where(eq(ledgerEvents.mediaItemId, movieId));
    await t.db.delete(ledgerEvents).where(eq(ledgerEvents.requestedByUserId, memberId));
  });

  it('is refused while the remedy is off, before any search', async () => {
    await setRepairGuideRemedies({ db: t.db, remedies: { release_pick: false }, actorId: null });
    const arr = stubArr();
    await expect(openReleaseList({ db: t.db, arr: arr.bundle, ...e11(), requesterId: memberId })).rejects.toBeInstanceOf(FixRefusedError);
    expect(arr.releaseSearches()).toHaveLength(0);
  });

  it('Case A end to end: one season search, a list per episode, the E10-numbered override grabbed for E11', async () => {
    const arr = stubArr();
    const list = await openReleaseList({ db: t.db, arr: arr.bundle, ...e11(), requesterId: memberId });
    expect(list).toMatchObject({ status: 'list', kind: 'sonarr', targetLabel: 'S01E11 · Spice It Up', canPick: true });
    expect(list.budget).toMatchObject({ limit: 25, used: 1, left: 24 });
    // Sonarr's season list (finds the E10-numbered release an episode search never returns).
    expect(Object.fromEntries(arr.releaseSearches()[0]!.query)).toEqual({ seriesId: String(lostTapes.seriesId), seasonNumber: '1' });
    expect((await listEvents(memberId)).map((e) => e.payload)).toEqual([
      expect.objectContaining({ releaseListId: list.listId, scope: 'episode', targetArrChildId: E11.id, seasonNumber: 1 }),
    ]);
    const [stored] = await t.db.select().from(releasePickLists).where(eq(releasePickLists.id, list.listId!));
    expect(stored!.offers).toHaveLength(1);
    expect(JSON.stringify(stored!.rows)).not.toContain('lost-tapes-s01-pick');

    // Reopening the same list within 5 minutes shows it again and costs nothing (even on another web pod).
    resetReleaseSearchState();
    const again = await openReleaseList({ db: t.db, arr: arr.bundle, ...e11(), requesterId: memberId });
    expect(again.listId).toBe(list.listId);
    expect(arr.releaseSearches()).toHaveLength(1);
    expect(await listEvents(memberId)).toHaveLength(1);

    const pick = list.rows.find((r) => r.recommended)!;
    const result = await grabFromReleaseList({ db: t.db, arr: arr.bundle, listId: list.listId!, key: pick.key, requesterId: memberId });
    expect(result).toMatchObject({ outcome: 'grabbed', override: true, targetLabel: 'S01E11 · Spice It Up' });
    // The override body exactly as Sonarr 4.0.20.3012's OverrideMatchModalContent sends it.
    const oldT = lostTapes.releases.find((r) => String(r.title).includes('S01E10.Spice.It.Up'))!;
    expect(arr.grabs()).toEqual([
      {
        guid: oldT.guid,
        indexerId: 3,
        seriesId: lostTapes.seriesId,
        episodeIds: [E11.id],
        quality: oldT.quality,
        languages: oldT.languages,
        downloadClientId: null,
        shouldOverride: true,
      },
    ]);
    const [repair] = await t.db.select().from(repairRequests).where(eq(repairRequests.id, result.repairRequestId!));
    expect(repair).toMatchObject({ kind: 'release_pick', scope: 'episode', seasonNumber: 1, targetChildIds: [E11.id], status: 'actioned' });
    expect(repair!.actionsTaken.map((a) => a.step)).toEqual(['created', 'grab']);
    expect(repair!.preview).toMatchObject({ releaseListId: list.listId, state: 'override', numberedAs: 'S01E10 · Stilt Walkers' });

    // E11 now has a download on its way: its list shows that, costs nothing and does not search.
    const busy = await openReleaseList({ db: t.db, arr: arr.bundle, ...e11(), requesterId: memberId });
    expect(busy).toMatchObject({ status: 'on_its_way', listId: null, rows: [] });

    // E13 of the same season: a grab makes the cached season list stale (the *arr's decisions changed: a release is in
    // the queue, and a failed one will be blocklisted), so it searches again; the open pick on E11 does not hold it up.
    const list13 = await openReleaseList({ db: t.db, arr: arr.bundle, ...e13(), requesterId: memberId });
    expect(arr.releaseSearches()).toHaveLength(2);
    const pick13 = list13.rows.find((r) => r.recommended)!;
    const grab13 = await grabFromReleaseList({ db: t.db, arr: arr.bundle, listId: list13.listId!, key: pick13.key, requesterId: memberId });
    expect(grab13.outcome).toBe('grabbed');
    expect(list13.budget.used).toBe(3); // E11 list, E11 grab, E13 list

    // The follow-through: an import onto E11 (Force Search's Import Check) is not held up by E11's open pick; a second
    // pick on E11 is.
    await expect(
      createRepairRequest({ db: t.db, requesterId: memberId, mediaItemId: showId, kind: 'release_pick', scope: 'episode', seasonNumber: 1, targetChildIds: [E11.id], preview: {} }),
    ).rejects.toBeInstanceOf(FixAlreadyOpenError);
    const { repairRequestId: importId } = await createRepairRequest({
      db: t.db, requesterId: memberId, mediaItemId: showId, kind: 'import_download', scope: 'episode', seasonNumber: 1, targetChildIds: [E11.id], preview: {},
    });
    expect(importId).toBeTruthy();

    // An import of E13 lands (ingested `imported`): the E13 pick completes. E11's download fails: its pick closes failed.
    await t.db.update(repairRequests).set({ status: 'actioned' }).where(eq(repairRequests.id, importId));
    await t.db.insert(ledgerEvents).values([
      { mediaItemId: showId, eventType: 'imported', source: 'sonarr', occurredAt: new Date(Date.now() + 1000), payload: { episodeId: E13.id } },
      { mediaItemId: showId, eventType: 'download_failed', source: 'sonarr', occurredAt: new Date(Date.now() + 1000), payload: { episodeId: E11.id } },
    ]);
    const { completed } = await completeRepairRequests({ db: t.db });
    expect(completed).toContain(grab13.repairRequestId);
    const { failed } = await settleReleasePicks({ db: t.db });
    expect(failed).toEqual([result.repairRequestId]);
    const [closed] = await t.db.select().from(repairRequests).where(eq(repairRequests.id, result.repairRequestId!));
    expect(closed!.status).toBe('failed');
    const failedEvents = await t.db
      .select()
      .from(ledgerEvents)
      .where(and(eq(ledgerEvents.mediaItemId, showId), eq(ledgerEvents.eventType, 'repair_failed')));
    expect(failedEvents).toHaveLength(1);
  });

  it('refuses without sending: a stale list, a row that is not offered, an episode that has a file now', async () => {
    const arr = stubArr();
    const list = await openReleaseList({ db: t.db, arr: arr.bundle, ...e11(), requesterId: memberId });
    const pick = list.rows.find((r) => r.recommended)!;
    const refused = list.rows.find((r) => r.state === 'not_allowed')!;
    const late = () => Date.now() + RELEASE_PICK_GRAB_WINDOW_MS + 60_000;
    expect(
      await grabFromReleaseList({ db: t.db, arr: arr.bundle, listId: list.listId!, key: pick.key, requesterId: memberId, now: late }),
    ).toMatchObject({ outcome: 'list_stale', repairRequestId: null });
    expect(
      await grabFromReleaseList({ db: t.db, arr: arr.bundle, listId: list.listId!, key: refused.key, requesterId: memberId }),
    ).toMatchObject({ outcome: 'not_allowed' });
    arr.state.hasFile.add(E11.id);
    expect(
      await grabFromReleaseList({ db: t.db, arr: arr.bundle, listId: list.listId!, key: pick.key, requesterId: memberId }),
    ).toMatchObject({ outcome: 'has_file' });
    expect(arr.grabs()).toEqual([]);
    expect(await t.db.select().from(repairRequests)).toEqual([]);
    // Another person cannot grab from this list.
    const other = (await createUser(t.db)).id;
    await expect(
      grabFromReleaseList({ db: t.db, arr: arr.bundle, listId: list.listId!, key: pick.key, requesterId: other }),
    ).rejects.toThrow(/not found/);
    // An episode with a file gets no list, and opening it costs nothing.
    const hasFile = await openReleaseList({ db: t.db, arr: arr.bundle, ...e11(), requesterId: other });
    expect(hasFile.status).toBe('has_file');
    expect(await listEvents(other)).toHaveLength(0);
  });

  it('a site that refuses the release (409) or a cache that dropped it (404) closes the pick as failed and keeps the list', async () => {
    const arr = stubArr();
    const list = await openReleaseList({ db: t.db, arr: arr.bundle, ...e11(), requesterId: memberId });
    const pick = list.rows.find((r) => r.recommended)!;
    const guid = String(lostTapes.releases.find((r) => String(r.title).includes('S01E10.Spice.It.Up'))!.guid);
    arr.state.grabStatus.set(guid, 409);
    const refused = await grabFromReleaseList({ db: t.db, arr: arr.bundle, listId: list.listId!, key: pick.key, requesterId: memberId });
    expect(refused).toMatchObject({ outcome: 'grab_failed', message: expect.stringContaining('Pick another one') });
    const [row] = await t.db.select().from(repairRequests).where(eq(repairRequests.id, refused.repairRequestId!));
    expect(row!.status).toBe('failed');
    arr.state.grabStatus.set(guid, 404);
    expect(
      await grabFromReleaseList({ db: t.db, arr: arr.bundle, listId: list.listId!, key: pick.key, requesterId: memberId }),
    ).toMatchObject({ outcome: 'list_stale' });
  });

  it('over the hourly budget the list is refused before any search', async () => {
    const arr = stubArr();
    await t.db.insert(ledgerEvents).values(
      Array.from({ length: 25 }, () => ({
        mediaItemId: showId, eventType: 'search_requested' as const, source: 'app' as const, occurredAt: new Date(), requestedByUserId: memberId, payload: {},
      })),
    );
    await expect(openReleaseList({ db: t.db, arr: arr.bundle, ...e11(), requesterId: memberId })).rejects.toBeInstanceOf(FixRateLimitError);
    expect(arr.releaseSearches()).toHaveLength(0);
  });

  it('a movie: an approved release is grabbed with the plain body Radarr 6.4.4.10685 sends', async () => {
    const arr = stubArr();
    const base = { indexerId: 2, indexer: 'NZBgeek (Prowlarr)', size: 6e9, languages: [{ id: 1, name: 'English' }], protocol: 'usenet', downloadAllowed: true };
    arr.state.movieReleases = [
      { ...base, guid: 'movie-good', title: 'Winner.Takes.the.Cake.2025.1080p.WEB-DL.DDP5.1.H.264-GRP', quality: { quality: { id: 3, name: 'WEBDL-1080p', resolution: 1080 }, revision: { version: 1 } }, approved: true, rejections: [] },
      { ...base, guid: 'movie-cam', title: 'Winner.Takes.the.Cake.2025.CAM.x264-RIP', quality: { quality: { id: 1, name: 'CAM', resolution: 480 } }, approved: false, rejections: ['CAM is not wanted in profile'] },
    ];
    const list = await openReleaseList({ db: t.db, arr: arr.bundle, mediaItemId: movieId, requesterId: memberId });
    expect(list.rows.map((r) => r.state)).toEqual(['grab', 'not_allowed']);
    const result = await grabFromReleaseList({ db: t.db, arr: arr.bundle, listId: list.listId!, key: list.recommendedKey!, requesterId: memberId });
    expect(result).toMatchObject({ outcome: 'grabbed', override: false });
    expect(arr.grabs()).toEqual([{ guid: 'movie-good', indexerId: 2 }]);
    const [repair] = await t.db.select().from(repairRequests).where(eq(repairRequests.id, result.repairRequestId!));
    expect(repair).toMatchObject({ kind: 'release_pick', scope: 'item', seasonNumber: null, targetChildIds: [] });
  });
});
