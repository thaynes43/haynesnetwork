// ADR-072 / DESIGN-042 D-04/D-05 (PLAN-052 PR4b) — the pure Kometa recipe → managed-include compiler.
// Proves: the builder allowlist (a disallowed builder REJECTS), ref shape validation + canonicalization,
// the egress-free preview (id-list count known; URL/id unknown → honest note), the namespace marker,
// deterministic + idempotent + byte-stable output (golden), and the round-trip (compile → parse). No I/O.
import { describe, expect, it } from 'vitest';
import {
  KometaRecipeError,
  assertKometaBuilder,
  compileManagedFile,
  managedFileName,
  parseManagedFile,
  previewKometaRef,
  validateKometaRef,
  type KometaRecipe,
} from '../src/kometa-compiler';

const imdb = (over?: Partial<KometaRecipe>): KometaRecipe => ({
  id: 'christmas',
  name: 'Christmas HNet',
  mediaType: 'movies',
  builderType: 'imdb_list',
  builderRef: 'https://www.imdb.com/list/ls012345678/',
  findMissing: false,
  ...over,
});

describe('validateKometaRef — allowlist + shape (D-04)', () => {
  it('normalizes an IMDb list URL and cannot resolve a count without egress', () => {
    const r = validateKometaRef('imdb_list', 'https://imdb.com/list/ls012345678');
    expect(r.normalizedRef).toBe('https://www.imdb.com/list/ls012345678/');
    expect(r.resolvableCount).toBeNull();
  });

  it('rejects a non-IMDb URL for imdb_list', () => {
    expect(() => validateKometaRef('imdb_list', 'https://example.com/list/ls1')).toThrow(KometaRecipeError);
  });

  it('validates a TMDb collection id (integer) and a TVDb list URL', () => {
    expect(validateKometaRef('tmdb_collection_details', '10').normalizedRef).toBe('10');
    expect(() => validateKometaRef('tmdb_collection_details', 'abc')).toThrow(KometaRecipeError);
    expect(validateKometaRef('tvdb_list_details', 'https://thetvdb.com/lists/arrowverse').normalizedRef).toBe(
      'https://thetvdb.com/lists/arrowverse',
    );
  });

  it('parses + dedupes an id-list and reports the egress-free count', () => {
    const r = validateKometaRef('tmdb_movie', '11, 22 22 33');
    expect(r.normalizedRef).toBe('11,22,33');
    expect(r.resolvableCount).toBe(3);
  });

  it('rejects a non-numeric id in an id-list', () => {
    expect(() => validateKometaRef('tmdb_show', '10, x')).toThrow(KometaRecipeError);
  });

  it('assertKometaBuilder rejects a Libretto builder', () => {
    expect(() => assertKometaBuilder('hardcover_series')).toThrow(KometaRecipeError);
    expect(() => assertKometaBuilder('imdb_list')).not.toThrow();
  });
});

describe('previewKometaRef — canary-first (Q-06)', () => {
  it('echoes the id-list count without egress', () => {
    const p = previewKometaRef('tvdb_show', '1 2 3');
    expect(p.resolvedCount).toBe(3);
    expect(p.egressRequired).toBe(false);
  });

  it('reports egress-required + an honest note for a URL ref (no fabricated name/count)', () => {
    const p = previewKometaRef('imdb_list', 'https://www.imdb.com/list/ls1/');
    expect(p.resolvedCount).toBeNull();
    expect(p.egressRequired).toBe(true);
    expect(p.note).toMatch(/unavailable/i);
  });
});

describe('compileManagedFile — allowlist, marker, determinism (D-03/D-05)', () => {
  it('rejects a disallowed builder', () => {
    expect(() =>
      compileManagedFile({ mediaType: 'movies', recipes: [imdb({ builderType: 'hardcover_series' as never })] }),
    ).toThrow(KometaRecipeError);
  });

  it('rejects duplicate ids and duplicate names', () => {
    expect(() =>
      compileManagedFile({ mediaType: 'movies', recipes: [imdb(), imdb({ name: 'Other' })] }),
    ).toThrow(/Duplicate recipe id/);
    expect(() =>
      compileManagedFile({ mediaType: 'movies', recipes: [imdb(), imdb({ id: 'other' })] }),
    ).toThrow(/Duplicate collection name/);
  });

  it('emits acquisition OFF, the namespace marker, and a golden movies file', () => {
    const out = compileManagedFile({
      mediaType: 'movies',
      recipes: [
        imdb(),
        imdb({ id: 'addams', name: 'The Addams Family', builderType: 'tmdb_collection_details', builderRef: '11716' }),
        imdb({ id: 'unbreak', name: 'Unbreakable', builderType: 'tmdb_movie', builderRef: '9741, 358' }),
      ],
    });
    expect(out).toContain('radarr_add_missing: false');
    expect(out).toContain('label: "HNet Managed"');
    expect(out).not.toContain('radarr_search'); // grouping-only ⇒ no search line
    // Deterministic id-sorted order: addams < christmas < unbreak.
    const order = ['The Addams Family', 'Christmas HNet', 'Unbreakable'].map((n) => out.indexOf(n));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(out).toMatchSnapshot();
  });

  it('emits sonarr_* keys for TV and radarr_* for movies', () => {
    const tv = compileManagedFile({
      mediaType: 'tv',
      recipes: [imdb({ mediaType: 'tv', builderType: 'tvdb_show', builderRef: '81189' })],
    });
    expect(tv).toContain('sonarr_add_missing: false');
    expect(tv).not.toContain('radarr_');
  });

  it('is idempotent — recompiling an unchanged set is byte-identical', () => {
    const recipes = [imdb(), imdb({ id: 'b', name: 'B list', builderRef: 'https://www.imdb.com/list/ls9/' })];
    expect(compileManagedFile({ mediaType: 'movies', recipes })).toBe(
      compileManagedFile({ mediaType: 'movies', recipes: [...recipes].reverse() }),
    );
  });

  it('emits an empty-but-valid file for no recipes', () => {
    expect(compileManagedFile({ mediaType: 'movies', recipes: [] })).toContain('collections: {}');
  });
});

describe('parseManagedFile — round-trip (D-01)', () => {
  it('reads exactly what compile wrote (the manifest is authoritative)', () => {
    const recipes = [
      imdb(),
      imdb({ id: 'ids', name: 'Curated', builderType: 'tmdb_show', builderRef: '1, 2, 3', ordered: true }),
    ];
    const parsed = parseManagedFile(compileManagedFile({ mediaType: 'movies', recipes }));
    expect(parsed).toHaveLength(2);
    const curated = parsed.find((r) => r.id === 'ids')!;
    expect(curated.builderRef).toBe('1,2,3');
    expect(curated.ordered).toBe(true);
    expect(curated.findMissing).toBe(false);
  });

  it('returns [] for an empty/bootstrap file and throws on a corrupt manifest', () => {
    expect(parseManagedFile(null)).toEqual([]);
    expect(parseManagedFile('collections: {}\n')).toEqual([]);
    expect(() => parseManagedFile('# hnet-recipes: {not json\n')).toThrow(KometaRecipeError);
  });

  it('managedFileName splits movies vs tv', () => {
    expect(managedFileName('movies')).toBe('hnet-managed-movies.yml');
    expect(managedFileName('tv')).toBe('hnet-managed-tv.yml');
  });
});
