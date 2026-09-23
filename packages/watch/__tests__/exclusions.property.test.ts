// AC-21 / DESIGN-049 D-18 — `recommend` never returns an Ever Watched, started, dismissed or not-mine
// title. Property-tested over generated histories, marks and candidate sets with a seeded PRNG
// (mulberry32, inlined: no new dependency). Each "real" title is seen by several sources that know
// random subsets of its ids, so matching has to work across sources that know different ids.
import { describe, expect, it } from 'vitest';
import { keysOf, titleKeyFor } from '../src/identity';
import { isKidsTitle } from '../src/progress';
import {
  buildExclusions,
  excludeCandidates,
  pickRecommendations,
  type Exclusions,
  type HistoryFacts,
  type LiveMark,
  type RecoCandidate,
} from '../src/recommend';
import type { TitleIds, WatchKind } from '../src/types';

const ITERATIONS = 600;
const DAY = 86_400;
const NOW = Date.parse('2026-09-23T16:00:00Z') / 1000;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

interface RealTitle {
  kind: WatchKind;
  title: string;
  year: number;
  index: number;
  kids: boolean;
  genres: string[];
}

const NAMES = [
  'Dune',
  'Silo',
  'The Office',
  'Severance',
  'Foundation',
  'Dark',
  'Home',
  'Bluey',
  'Heat',
  'Up',
];
const GENRES = [
  'Drama',
  'Comedy',
  'Science Fiction',
  'Horror',
  'Documentary',
  'Crime',
  'Animation',
  'Family',
];
const ACTIONS = ['watched', 'not_interested', 'not_mine'] as const;

interface World {
  history: HistoryFacts[];
  marks: LiveMark[];
  candidates: RecoCandidate[];
  kids: boolean;
}

function generate(rng: () => number): World {
  const chance = (p: number) => rng() < p;
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)] as T;
  const reals: RealTitle[] = Array.from({ length: 5 + Math.floor(rng() * 36) }, (_, index) => {
    const kids = chance(0.2);
    return {
      kind: chance(0.5) ? 'show' : 'movie',
      // Few names and a narrow year range, so unrelated titles sometimes share a name key.
      title: chance(0.6) ? pick(NAMES) : `${pick(NAMES)} ${index}`,
      year: 2015 + Math.floor(rng() * 8),
      index,
      kids,
      genres: kids ? ['Kids', pick(GENRES)] : [pick(GENRES), pick(GENRES)],
    };
  });

  // One source's view of a real title: a random subset of its ids, sometimes a tagged title or no year.
  const view = (r: RealTitle): TitleIds & { titleKey: string } => {
    const ids: TitleIds = {
      kind: r.kind,
      title: chance(0.1) ? `${r.title} (US)` : r.title,
      year: chance(0.15) ? null : r.year,
      plexGuid: chance(0.5)
        ? chance(0.15)
          ? `local://${r.index}`
          : `plex://${r.kind}/g${r.index}`
        : null,
      tvdbId: chance(0.5) ? 1000 + r.index : null,
      tmdbId: chance(0.5) ? 5000 + r.index : null,
      imdbId: chance(0.4) ? `tt${9000 + r.index}` : null,
    };
    return { ...ids, titleKey: titleKeyFor(ids) };
  };

  const history: HistoryFacts[] = reals
    .filter(() => chance(0.6))
    .map((r) => ({
      ...view(r),
      episodesWatched: r.kind === 'show' && chance(0.4) ? Math.floor(rng() * 12) : 0,
      plexWatched: chance(0.15),
      eventWatched: chance(0.2),
      resumePercent: r.kind === 'movie' && chance(0.3) ? Math.floor(rng() * 101) : null,
      nextResume: r.kind === 'show' && chance(0.1),
    }));

  const marks: LiveMark[] = reals
    .filter(() => chance(0.2))
    .map((r) => ({ ...view(r), action: pick(ACTIONS) }));

  const candidates: RecoCandidate[] = reals.flatMap((r) =>
    Array.from({ length: Math.floor(rng() * 4) }, () => {
      const v = view(r);
      return {
        ...v,
        year: v.year ?? null,
        genres: chance(0.8) ? r.genres : [],
        contentRating: r.kids && chance(0.3) ? 'TV-Y' : null,
        isKids: r.kids && chance(0.5) ? true : null,
        onPlex: chance(0.7),
        watchlist: chance(0.2),
        seeds: chance(0.2)
          ? [
              {
                titleKey: `seed:${Math.floor(rng() * 5)}`,
                title: 'A Seed',
                lastWatchedAt: NOW - DAY,
              },
            ]
          : [],
        ratings: chance(0.6) ? { imdb: Math.round(rng() * 100) / 10 } : null,
        addedAt: chance(0.3) ? NOW - Math.floor(rng() * 60) * DAY : null,
      };
    }),
  );

  return { history, marks, candidates, kids: chance(0.3) };
}

const intersects = (a: readonly string[], b: readonly string[]) => a.some((k) => b.includes(k));

// An independent oracle for what must never be recommended: connected components of history rows and
// marks (same kind, shared key — a plain BFS, not the implementation's union-find), each judged by the
// D-10/D-18 rules. Returns the keys of every component that is Ever Watched, started or dismissed.
function forbiddenKeys(history: HistoryFacts[], marks: LiveMark[]): string[][] {
  type Node = { keys: string[]; kind: WatchKind; facts?: HistoryFacts; mark?: LiveMark };
  const nodes: Node[] = [
    ...history.map((h) => ({ keys: keysOf(h), kind: h.kind, facts: h })),
    ...marks.map((m) => ({ keys: keysOf(m), kind: m.kind, mark: m })),
  ];
  const seen = new Set<number>();
  const out: string[][] = [];
  nodes.forEach((_, start) => {
    if (seen.has(start)) return;
    const component: Node[] = [];
    const queue = [start];
    seen.add(start);
    while (queue.length > 0) {
      const node = nodes[queue.pop() as number] as Node;
      component.push(node);
      nodes.forEach((other, j) => {
        if (!seen.has(j) && other.kind === node.kind && intersects(other.keys, node.keys)) {
          seen.add(j);
          queue.push(j);
        }
      });
    }
    const actions = component.flatMap((n) => (n.mark ? [n.mark.action] : []));
    const facts = component.flatMap((n) => (n.facts ? [n.facts] : []));
    const notMine = actions.includes('not_mine');
    const watched =
      actions.includes('watched') ||
      facts.some(
        (f) => (f.episodesWatched ?? 0) > 0 || f.plexWatched === true || f.eventWatched === true,
      );
    const started = facts.some((f) =>
      f.kind === 'show'
        ? (f.episodesWatched ?? 0) > 0 || f.nextResume === true
        : (f.resumePercent ?? 0) > 0,
    );
    const dismissed = actions.includes('not_interested') || notMine;
    if ((watched && !notMine) || started || dismissed) out.push(component.flatMap((n) => n.keys));
  });
  return out;
}

function assertNeverRecommended(
  world: World,
  ex: Exclusions,
  returned: readonly RecoCandidate[],
  seed: number,
) {
  const sets = [ex.everWatched, ex.started, ex.notInterested, ex.notMine];
  const forbidden = forbiddenKeys(world.history, world.marks);
  for (const c of returned) {
    const keys = keysOf(c);
    const hit = keys.find((k) => sets.some((s) => s.has(k)));
    expect(hit, `seed ${seed}: ${c.title} shares ${hit} with an exclusion set`).toBeUndefined();
    const oracle = forbidden.find((f) => intersects(keys, f));
    expect(
      oracle,
      `seed ${seed}: ${c.title} is the same title as an excluded history`,
    ).toBeUndefined();
    for (const m of world.marks) {
      expect(intersects(keys, keysOf(m)), `seed ${seed}: ${c.title} carries a live mark`).toBe(
        false,
      );
    }
  }
}

describe('AC-21: the D-18 exclusions over generated histories', () => {
  it(`never returns an excluded title or the wrong audience (${ITERATIONS} seeded worlds)`, () => {
    let checked = 0;
    let survived = 0;
    for (let seed = 1; seed <= ITERATIONS; seed++) {
      const world = generate(mulberry32(seed * 7919));
      const ex = buildExclusions(world.history, world.marks);
      const survivors = excludeCandidates(world.candidates, ex, { kids: world.kids });
      checked += world.candidates.length;
      survived += survivors.length;

      assertNeverRecommended(world, ex, survivors, seed);

      // The wrong audience never gets through: grown-up picks carry no children's signal.
      if (!world.kids) {
        for (const c of survivors)
          expect(c.isKids === true || isKidsTitle(c), `seed ${seed}: ${c.title}`).toBe(false);
      }

      // Group closure: nothing that survives shares a key with a candidate that did not (same kind).
      const kept = new Set(survivors);
      const dropped = world.candidates.filter((c) => !kept.has(c));
      for (const c of survivors) {
        for (const d of dropped) {
          if (c.kind === d.kind)
            expect(intersects(keysOf(c), keysOf(d)), `seed ${seed}`).toBe(false);
        }
      }

      // The whole pipeline holds the same guarantees, merged: every pick has a reason, the on-Plex
      // list holds only on-Plex titles, and a kids request returns only children's titles.
      const recs = pickRecommendations({
        candidates: world.candidates,
        exclusions: ex,
        profile: { adult: { drama: 0.6, comedy: 0.4 }, kids: { kids: 1 } },
        kids: world.kids,
        now: NOW,
      });
      const picks = [...recs.onPlex, ...recs.notOnPlex];
      assertNeverRecommended(
        world,
        ex,
        picks.map((p) => p.candidate),
        seed,
      );
      for (const p of picks) {
        expect(p.reason.length).toBeGreaterThan(0);
        expect(p.candidate.isKids === true || isKidsTitle(p.candidate)).toBe(world.kids);
      }
      expect(recs.onPlex.every((p) => p.candidate.onPlex)).toBe(true);
      expect(recs.notOnPlex.every((p) => !p.candidate.onPlex)).toBe(true);
    }
    // The generator must exercise both outcomes, or the property proves nothing.
    expect(checked).toBeGreaterThan(ITERATIONS * 10);
    expect(survived).toBeGreaterThan(0);
    expect(survived).toBeLessThan(checked);
  });
});
