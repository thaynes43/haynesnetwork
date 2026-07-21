// PLAN-029 (ADR-051 / DESIGN-026 D-02/D-03) — the registry-ASYMMETRY battery: each view level
// exposes EXACTLY its answerable sort/filter dimensions (the owner's R5 ruling — "Episodes ≠
// Shows"). These tests pin the D-03 contents table, so a future edit that leaks a dead dimension
// (Resolution on a Season, Runtime on Music, Genre on Kavita) fails here first.
import { describe, expect, it } from 'vitest';
import {
  CATEGORY_CHIP_HINT_ORDER,
  orderCollectionCategories,
  LIBRARY_VIEW_REGISTRY,
  WALL_VIEWS,
  registryFor,
  type ViewLevelKey,
} from '../library-view-registry';
import { WALL_VIEW_DEFAULTS, LIBRARY_WALL_IDS } from '../library-views';

const sortKeys = (key: ViewLevelKey) => registryFor(key).sorts.map((s) => s.key);
const facetKeys = (key: ViewLevelKey) => registryFor(key).facets.map((f) => f.key);

describe('registry shape invariants', () => {
  it('every level’s default sort is one of its own declared keys', () => {
    for (const [key, entry] of Object.entries(LIBRARY_VIEW_REGISTRY)) {
      expect(sortKeys(key as ViewLevelKey), key).toContain(entry.defaultSort.field);
    }
  });

  it('every azSort is one of the level’s declared sort keys', () => {
    for (const [key, entry] of Object.entries(LIBRARY_VIEW_REGISTRY)) {
      for (const az of entry.azSorts) expect(sortKeys(key as ViewLevelKey), key).toContain(az);
    }
  });

  it('every wall’s R2/R6 default (the domain store fallback) is valid in its default level', () => {
    for (const wall of LIBRARY_WALL_IDS) {
      const d = WALL_VIEW_DEFAULTS[wall];
      const spec = WALL_VIEWS[wall];
      // The default view's level: grouped-with-alternative walls resolve to the :grouped entry;
      // everything else (flat / hierarchy / natural-grouped) is the :wall entry.
      const level =
        d.view === 'grouped' && spec.offers.length > 1
          ? (`${wall}:grouped` as ViewLevelKey)
          : (`${wall}:wall` as ViewLevelKey);
      expect(sortKeys(level), wall).toContain(d.sortField);
    }
  });

  it('grouped-capable walls declare their dimensions (default first) with the D-04 art source', () => {
    // PLAN-051 (ADR-066 / DESIGN-038 D-07): the book walls gain `collection` as a SIBLING
    // dimension — always LAST in selector order, defaults untouched (author/genre/series first).
    // ADR-075 (PLAN-060): the unified Books wall carries the retired Audiobooks wall's Genre
    // grouping too — the abstract slice renders the designed GLYPH tile, never fake imagery.
    expect(WALL_VIEWS.books.groupings?.map((g) => `${g.dimension}:${g.art}`)).toEqual([
      'author:covers',
      'genre:glyph',
      'collection:covers',
    ]);
    expect(WALL_VIEWS.comics.groupings?.map((g) => g.dimension)).toEqual(['series', 'collection']);
    // Comics stays single-SHAPE (no flat) — the selector renders by dimensions (D-07 rule).
    expect(WALL_VIEWS.comics.offers).toEqual(['grouped']);
    expect(WALL_VIEWS.peloton.groupings?.[0]?.dimension).toBe('exercise');
    expect(WALL_VIEWS.youtube.groupings?.[0]?.dimension).toBe('channel');
  });

  it('every aggregate-card grouping binds a registry level whose default sort it can answer', () => {
    // movies/tv — the PLAN-037 Collections grouped levels ride the same contract.
    for (const wall of ['books', 'movies', 'tv'] as const) {
      for (const grouping of WALL_VIEWS[wall].groupings ?? []) {
        expect(grouping.level, `${wall}:${grouping.dimension}`).toBeDefined();
        const entry = registryFor(grouping.level!);
        expect(sortKeys(grouping.level!)).toContain(entry.defaultSort.field);
      }
    }
  });

  it("the Movies/TV Collections grouped levels sort the CARDS (label/count) and declare ONLY the category facet (PLAN-037 + D-11')", () => {
    for (const level of ['movies:grouped-collection', 'tv:grouped-collection'] as const) {
      expect(sortKeys(level)).toEqual(['label', 'count']);
      // DESIGN-035 D-11' / R-214 — exactly ONE facet: the category chip row. Item facets
      // (genre/decade/resolution/…) must never leak onto a card grid (the D-09 asymmetry).
      expect(facetKeys(level)).toEqual(['category']);
      const typeFacet = registryFor(level).facets[0]!;
      expect(typeFacet).toMatchObject({ label: 'Type', kind: 'select', param: 'ctype' });
      // Owner ruling — the chip FILTERS, never hides: no per-user gate, no data gating.
      expect(typeFacet.gate).toBeUndefined();
      expect(typeFacet.dataGated).toBeUndefined();
      expect(registryFor(level).azSorts).toEqual([]);
    }
    // The chip vocabulary is DYNAMIC (supplied at request time from the present categories), so the
    // registry declares NO static options. The ordering HINT pins the familiar categories first;
    // anything else sorts alphabetically after them, and both walls order identically.
    // ADR-076 C-06 / R-233 (PLAN-060) — 'Authors' (the seeded famous-author program's chip) is
    // pinned right after Universe/Sequels.
    expect(CATEGORY_CHIP_HINT_ORDER).toEqual([
      'Universe',
      'Sequels',
      'Authors',
      'Director',
      'Actor',
      'List',
      'Studio',
      'Audio',
    ]);
    // Hint-listed categories come first in hint order; unknowns append alphabetically (case-insensitive).
    expect(orderCollectionCategories(['List', 'Universe', 'Zephyr', 'Director', 'anime'])).toEqual([
      'Universe',
      'Director',
      'List',
      'anime',
      'Zephyr',
    ]);
    // Only present categories are ordered (no phantom hint entries), and the result is deterministic.
    expect(orderCollectionCategories(['Sequels'])).toEqual(['Sequels']);
    expect(orderCollectionCategories([])).toEqual([]);
    expect(WALL_VIEWS.movies.groupings?.map((g) => `${g.dimension}:${g.art}`)).toEqual([
      'collection:covers',
    ]);
    expect(WALL_VIEWS.tv.groupings?.map((g) => `${g.dimension}:${g.art}`)).toEqual([
      'collection:covers',
    ]);
    // The DEFAULT shapes are unchanged (opt-in Collections — ADR-064): flat / hierarchy first.
    expect(WALL_VIEWS.movies.offers).toEqual(['flat', 'grouped']);
    expect(WALL_VIEWS.tv.offers).toEqual(['hierarchy', 'grouped']);
    expect(WALL_VIEW_DEFAULTS.movies.view).toBe('flat');
    expect(WALL_VIEW_DEFAULTS.tv.view).toBe('hierarchy');
  });

  it('the books Collections levels: card sorts + the shared category facet (grouped) and the position-first drill contract (PLAN-051)', () => {
    for (const level of ['books:grouped-collection', 'comics:grouped-collection'] as const) {
      // Card levels sort the CARDS only. DESIGN-038 D-12 (2026-07-17) — the grouped level now carries
      // the SAME dynamic category chip the Movies/TV Collections walls do (the old "no facets" honest
      // gap was closed when the label-driven category program extended to books).
      expect(sortKeys(level)).toEqual(['label', 'count']);
      expect(facetKeys(level)).toEqual(['category']);
      const categoryFacet = registryFor(level).facets[0]!;
      expect(categoryFacet).toMatchObject({ key: 'category', kind: 'select', param: 'ctype' });
      expect(registryFor(level).azSorts).toEqual([]);
    }
    for (const level of ['books:collection-items', 'comics:collection-items'] as const) {
      // The drilled grid: 'position' ("List order") is the FIRST sort and the level DEFAULT
      // (ordered collections drill into reading order — DESIGN-038 D-06; the client drops the
      // key for unordered collections, the ordered-flag data gate). asc-first.
      expect(sortKeys(level)[0]).toBe('position');
      expect(registryFor(level).defaultSort).toEqual({ field: 'position', dir: 'asc' });
      expect(registryFor(level).sorts[0]?.firstDir).toBe('asc');
    }
    // DESIGN-038 D-13 (SUPERSEDES D-07) — the books/audiobooks collection drill DOES carry the `wanted`
    // facet now: a collection that is not full renders its MISSING members as Wanted tiles (minted from
    // Libretto's missing set as origin='collection' book_requests). Comics stay held-only (Kapowarr's
    // domain — no Libretto recipe), so their collection drill keeps no wanted facet.
    expect(facetKeys('books:collection-items')).toContain('wanted');
    expect(facetKeys('comics:collection-items')).not.toContain('wanted');
    // The drilled levels offer the WALL's own item sorts alongside position (the 037 rule —
    // a drilled grid keeps the wall's dimensions; the unified drill spans BOTH formats' sorts).
    expect(sortKeys('books:collection-items')).toEqual(
      expect.arrayContaining(['title', 'author', 'added', 'year', 'duration', 'pages']),
    );
    expect(sortKeys('comics:collection-items')).toEqual(
      expect.arrayContaining(['title', 'added', 'pages']),
    );
    // …but never a dimension the wall itself cannot answer (the R5 asymmetry holds in the drill).
    expect(sortKeys('comics:collection-items')).not.toContain('author');
    expect(sortKeys('comics:collection-items')).not.toContain('duration');
    // Every collection grouping binds its grouped-card level (comics included — its Series
    // sibling is the item grid and deliberately binds none).
    for (const wall of ['books', 'comics'] as const) {
      const collection = WALL_VIEWS[wall].groupings?.find((g) => g.dimension === 'collection');
      expect(collection?.level).toBe(`${wall}:grouped-collection`);
      expect(collection?.art).toBe('covers');
      expect(collection?.allLabel).toBe('All collections');
    }
    // Wall DEFAULTS are untouched — Collections is opt-in (ADR-066 / R-216); the unified Books
    // wall keeps the grouped-by-Author default both retiring walls shared (ADR-075 C-04).
    expect(WALL_VIEW_DEFAULTS.books).toMatchObject({ view: 'grouped', groupBy: 'author' });
    expect(WALL_VIEW_DEFAULTS.comics).toMatchObject({ view: 'grouped', groupBy: 'series' });
  });
});

describe('per-view asymmetry (R5 — a level offers ONLY what it can answer)', () => {
  it('Movies carries the two must-have dates + year/decade/released facets', () => {
    expect(sortKeys('movies:wall')).toEqual(
      expect.arrayContaining(['added_at', 'released_at', 'year', 'title', 'runtime']),
    );
    expect(facetKeys('movies:wall')).toEqual(
      expect.arrayContaining(['genres', 'decade', 'released', 'resolutions', 'rating', 'watch']),
    );
  });

  it('TV Shows: no Runtime sort, no Resolution facet (a show has no single value)', () => {
    expect(sortKeys('tv:wall')).not.toContain('runtime');
    expect(facetKeys('tv:wall')).not.toContain('resolutions');
    expect(sortKeys('tv:wall')).toContain('released_at'); // First Aired (D-05)
  });

  it('TV Seasons: no Duration/Resolution/Release-Date — Date Added + number + title only', () => {
    expect(sortKeys('tv:season')).toEqual(['index', 'added_at', 'title']);
    expect(sortKeys('tv:season')).not.toContain('duration');
    expect(facetKeys('tv:season')).toEqual([]);
  });

  it('TV Episodes ≠ Shows: air date + duration live HERE, not on the shows wall', () => {
    expect(sortKeys('tv:episode')).toEqual(
      expect.arrayContaining(['air_date', 'duration', 'index']),
    );
    expect(sortKeys('tv:wall')).not.toContain('air_date');
    expect(sortKeys('tv:wall')).not.toContain('duration');
  });

  it('Music: no Runtime/Year/Release-Date (lidarr artists carry none — live-verified 0%)', () => {
    expect(sortKeys('music:wall')).toEqual(['added_at', 'title', 'play_count', 'last_viewed']);
    for (const absent of ['runtime', 'year', 'released_at']) {
      expect(sortKeys('music:wall')).not.toContain(absent);
    }
    // Genre ONLY (owner ruling 2026-07-20, DESIGN-026 D-03 amended): the Collection facet is removed —
    // no music collections exist or are planned (the label-driven program never spanned Music), so the
    // chip's values came back permanently empty. An empty filter is worse than an absent one (ADR-047 /
    // ADR-051 empty-state philosophy — no dead chip). This locks Music to Genre-only.
    expect(facetKeys('music:wall')).toEqual(['genres']);
    expect(facetKeys('music:wall')).not.toContain('sourceCollections');
  });

  it('Peloton/YouTube walls (discipline/channel cards) answer title + date-added ONLY; the class/video dimensions live at episode level', () => {
    for (const wall of ['peloton', 'youtube'] as const) {
      expect(sortKeys(`${wall}:wall`)).toEqual(['added_at', 'title']);
      expect(sortKeys(`${wall}:episode`)).toEqual(
        expect.arrayContaining(['air_date', 'duration', 'index', 'title']),
      );
    }
  });

  it('the unified Books wall (ADR-075): the facet UNION with format-side data gates + the union sorts', () => {
    // Sorts are the two retired walls' union: Length sorts audio-carrying works, Pages
    // ebook-carrying ones (C-09 — honest partial sorts, never a fabricated cross-format metric).
    expect(sortKeys('books:wall')).toEqual([
      'title',
      'author',
      'added',
      'year',
      'duration',
      'pages',
    ]);
    // The facet union in chip order: the Format axis leads (the wall's defining seg), then the
    // universal + gated chips; the old Books `fmt` facet relabels File and KEEPS its param.
    expect(facetKeys('books:wall')).toEqual([
      'format',
      'genres',
      'authors',
      'narrators',
      'series',
      'languages',
      'durations',
      'lengths',
      'formats',
      'read',
      'wanted',
    ]);
    const facets = registryFor('books:wall').facets;
    const byKey = new Map(facets.map((f) => [f.key, f]));
    // C-03 — the three-state Format seg: select kind, ?format=, ungated (the wall's fixed axis).
    expect(byKey.get('format')).toMatchObject({ kind: 'select', param: 'format', label: 'Format' });
    expect(byKey.get('format')?.formatGate).toBeUndefined();
    expect(byKey.get('format')?.dataGated).toBeUndefined();
    // C-04 — audio-gated chips (Narrator/Series/Language/Length/Read) vs ebook-gated (Pages/File).
    for (const key of ['narrators', 'series', 'languages', 'durations', 'read']) {
      expect(byKey.get(key)?.formatGate, key).toBe('hasAudio');
    }
    expect(byKey.get('lengths')?.formatGate).toBe('hasEbook');
    expect(byKey.get('lengths')?.param).toBe('len'); // the surviving Books wall keeps its param
    expect(byKey.get('durations')?.param).toBe('dur'); // the audio Length facet's fresh param
    // Author/Genre/Wanted are UNIVERSAL (no format gate).
    for (const key of ['genres', 'authors', 'wanted']) {
      expect(byKey.get(key)?.formatGate, key).toBeUndefined();
    }
    // The File relabel (C-03): key/param unchanged, label = File.
    expect(byKey.get('formats')).toMatchObject({ label: 'File', param: 'fmt' });
    // The Read facet keeps its per-user gate AND gains the audio gate (ADR-053 stays honest).
    expect(byKey.get('read')?.gate).toBe('bookProgress');
  });

  it('Comics (Kavita) are untouched (E-5): no format seg, no pairing dimensions', () => {
    expect(sortKeys('comics:wall')).toEqual(['title', 'added', 'pages']);
    expect(facetKeys('comics:wall')).toEqual(['formats', 'lengths', 'wanted']);
    // No Format seg, no audio dimensions, no year — the comic wall never pairs.
    expect(facetKeys('comics:wall')).not.toContain('format');
    expect(facetKeys('comics:wall')).not.toContain('narrators');
    expect(facetKeys('comics:wall')).not.toContain('durations');
    expect(sortKeys('comics:wall')).not.toContain('duration');
    expect(sortKeys('comics:wall')).not.toContain('year');
    // The Comics Format (file-type) chip keeps its ORIGINAL label — only the Books wall relabeled.
    const comicFormats = registryFor('comics:wall').facets.find((f) => f.key === 'formats');
    expect(comicFormats).toMatchObject({ label: 'Format', param: 'fmt' });
    // Comics facets never carry a format-side gate (they are not format-partitioned).
    for (const f of registryFor('comics:wall').facets) {
      expect(f.formatGate, f.key).toBeUndefined();
    }
  });

  it('sparse/per-user facets are gated (ADR-051 C-06 — no dead chip)', () => {
    const bookFacets = registryFor('books:wall').facets;
    for (const key of ['narrators', 'series', 'languages']) {
      expect(bookFacets.find((f) => f.key === key)?.dataGated, key).toBe(true);
    }
    expect(bookFacets.find((f) => f.key === 'read')?.gate).toBe('bookProgress');
    // ADR-057 (PLAN-045) — the composed-Wanted narrowing rides both book walls, value-gated
    // on the overlay itself (no dead chip while no wanted tiles exist).
    for (const level of ['books:wall', 'comics:wall'] as const) {
      const wanted = registryFor(level).facets.find((f) => f.key === 'wanted');
      expect(wanted?.kind, level).toBe('select');
      expect(wanted?.param, level).toBe('wanted');
      expect(wanted?.dataGated, level).toBe(true);
    }
    expect(registryFor('movies:wall').facets.find((f) => f.key === 'watch')?.gate).toBe('watch');
    expect(registryFor('tv:wall').facets.find((f) => f.key === 'watch')?.gate).toBe('watch');
    // Music offers NO per-user watch facet (D-03 — lidarr watch data is 0%).
    expect(facetKeys('music:wall')).not.toContain('watch');
  });

  it('grouped levels sort the CARDS (dimension + count), not item dimensions', () => {
    expect(sortKeys('books:grouped')).toEqual(['author', 'count']);
    expect(facetKeys('books:grouped')).toEqual([]);
    // The genre grouped level (group-card-art pass, folded in by ADR-075) sorts label/count only —
    // an abstract card answers no item dimension either.
    expect(sortKeys('books:grouped-genre')).toEqual(['label', 'count']);
    expect(facetKeys('books:grouped-genre')).toEqual([]);
  });

  it('the A–Z jump is offered exactly on the big walls’ A–Z sorts (D-09)', () => {
    expect(registryFor('movies:wall').azSorts).toEqual(['title']);
    expect(registryFor('books:wall').azSorts).toEqual(['title', 'author']);
    expect(registryFor('tv:season').azSorts).toEqual([]);
    expect(registryFor('peloton:wall').azSorts).toEqual([]); // client-side wall — deferred (D-11)
  });
});
