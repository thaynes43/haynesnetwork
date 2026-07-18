import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HAND_UNEDITABLE_REASON,
  parseHandConfigFile,
  spliceHandCollectionFindMissing,
  spliceHandCollectionRef,
  spliceHandCollectionRemoval,
} from '../src/kometa-hand-config';
import { KometaRecipeError } from '../src/kometa-compiler';
import { NotFoundError } from '../src/errors';
import type { KometaMediaType } from '../src/kometa-compiler';

const DIR = join(__dirname, 'fixtures', 'kometa-hand');
const read = (f: string) => readFileSync(join(DIR, f), 'utf8');

/** Indices of the lines that DIFFER between two texts (the fidelity oracle). */
function changedLineIndices(before: string, after: string): number[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const out: number[] = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) if (a[i] !== b[i]) out.push(i);
  return out;
}

describe('parseHandConfigFile — editability matrix against the real estate config', () => {
  it('recognizes single-builder editable collections (URL / id / id-list / template alias / block list)', () => {
    const franchises = parseHandConfigFile(read('movies-franchises.yml'), 'movies-franchises.yml', 'movies');
    const brave = franchises.find((c) => c.name === 'The Brave Little Toaster')!;
    expect(brave.editable).toBe(true);
    expect(brave.builderType).toBe('tmdb_collection_details');
    expect(brave.builderRef).toBe('141282');

    const monster = franchises.find((c) => c.name === 'Monsterverse')!;
    expect(monster.editable).toBe(true);
    expect(monster.builderType).toBe('imdb_list');
    expect(monster.builderRef).toBe('https://www.imdb.com/list/ls060980695/');

    const unbreakable = franchises.find((c) => c.name === 'Unbreakable')!;
    expect(unbreakable.editable).toBe(true);
    expect(unbreakable.builderType).toBe('tmdb_movie');
    expect(unbreakable.builderRef).toBe('9741,381288,450465');

    const shows = parseHandConfigFile(read('shows-franchises.yml'), 'shows-franchises.yml', 'tv');
    const arrow = shows.find((c) => c.name === 'Arrowverse')!;
    expect(arrow.editable).toBe(true);
    expect(arrow.builderType).toBe('tvdb_list_details');
    expect(arrow.builderRef).toBe('https://thetvdb.com/lists/arrowverse');

    const showsColl = parseHandConfigFile(read('shows-collections.yml'), 'shows-collections.yml', 'tv');
    const bigKid = showsColl.find((c) => c.name === 'Big Kid Cartoons')!;
    expect(bigKid.editable).toBe(true);
    expect(bigKid.builderType).toBe('tvdb_show');
    expect(bigKid.builderRef?.split(',').length).toBeGreaterThan(5);
  });

  it('disables Edit for multi-builder, query/search/regex, and template-var (people) collections', () => {
    const franchises = parseHandConfigFile(read('movies-franchises.yml'), 'movies-franchises.yml', 'movies');
    const addams = franchises.find((c) => c.name === 'The Addams Family')!;
    expect(addams.editable).toBe(false); // two builders: collection + imdb_list
    expect(addams.editableReason).toBe(HAND_UNEDITABLE_REASON);

    const collections = parseHandConfigFile(read('movies-collections.yml'), 'movies-collections.yml', 'movies');
    expect(collections.find((c) => c.name === 'Spatial Surround')!.editable).toBe(false); // plex_all

    const lists = parseHandConfigFile(read('movies-lists.yml'), 'movies-lists.yml', 'movies');
    expect(lists.find((c) => c.name === 'A24')!.editable).toBe(false); // imdb_search

    const charts = parseHandConfigFile(read('movies-charts.yml'), 'movies-charts.yml', 'movies');
    expect(charts.find((c) => c.name === 'Popular Now')!.editable).toBe(false); // tmdb_discover

    const people = parseHandConfigFile(read('movies-people.yml'), 'movies-people.yml', 'movies');
    expect(people.find((c) => c.name === 'Christopher Nolan')!.editable).toBe(false); // tmdb via template var

    const shows = parseHandConfigFile(read('shows-franchises.yml'), 'shows-franchises.yml', 'tv');
    expect(shows.find((c) => c.name === 'Walking Dead')!.editable).toBe(false); // list + show
  });

  it('resolves find-missing from explicit key > referenced template > global default ON', () => {
    // Christmas HNet carries an explicit radarr_add_missing: false.
    const collections = parseHandConfigFile(read('movies-collections.yml'), 'movies-collections.yml', 'movies');
    expect(collections.find((c) => c.name === 'Christmas HNet')!.findMissing).toBe(false);
    // A24 references the Studio template which sets radarr_add_missing: false.
    const lists = parseHandConfigFile(read('movies-lists.yml'), 'movies-lists.yml', 'movies');
    expect(lists.find((c) => c.name === 'A24')!.findMissing).toBe(false);
    // Arrowverse (Shows template, no add_missing) inherits the global default ON.
    const shows = parseHandConfigFile(read('shows-franchises.yml'), 'shows-franchises.yml', 'tv');
    expect(shows.find((c) => c.name === 'Arrowverse')!.findMissing).toBe(true);
  });

  it('the estate total: 153 hand collections, 43 editable (movies 26 + tv 17)', () => {
    const files: Array<[string, KometaMediaType]> = [
      ['movies-charts.yml', 'movies'],
      ['movies-collections.yml', 'movies'],
      ['movies-franchises.yml', 'movies'],
      ['movies-lists.yml', 'movies'],
      ['movies-people.yml', 'movies'],
      ['shows-collections.yml', 'tv'],
      ['shows-franchises.yml', 'tv'],
    ];
    let total = 0;
    let editable = 0;
    for (const [f, m] of files) {
      const cols = parseHandConfigFile(read(f), f, m);
      total += cols.length;
      editable += cols.filter((c) => c.editable).length;
    }
    expect(total).toBe(153);
    expect(editable).toBe(43);
  });
});

describe('spliceHandCollectionRef — surgical fidelity (edited block only, everything else byte-identical)', () => {
  it('edits a direct scalar URL builder and touches exactly one line', () => {
    const before = read('movies-collections.yml');
    const after = spliceHandCollectionRef({
      fileText: before,
      name: 'Christmas HNet',
      mediaType: 'movies',
      builderRef: 'https://www.imdb.com/list/ls999999999/',
    });
    const changed = changedLineIndices(before, after);
    expect(changed).toHaveLength(1);
    expect(after.split('\n')[changed[0]!]).toBe('    imdb_list: https://www.imdb.com/list/ls999999999/');
    // Re-parse: the ref changed, and a sibling (Spatial Surround) is untouched.
    const reparsed = parseHandConfigFile(after, 'movies-collections.yml', 'movies');
    expect(reparsed.find((c) => c.name === 'Christmas HNet')!.builderRef).toBe(
      'https://www.imdb.com/list/ls999999999/',
    );
    expect(reparsed.find((c) => c.name === 'Spatial Surround')!.editable).toBe(false);
  });

  it('edits an inline template-map id builder and preserves the rest of the flow map', () => {
    const before = read('movies-franchises.yml');
    const after = spliceHandCollectionRef({
      fileText: before,
      name: 'The Brave Little Toaster',
      mediaType: 'movies',
      builderRef: '424242',
    });
    const changed = changedLineIndices(before, after);
    expect(changed).toHaveLength(1);
    expect(after.split('\n')[changed[0]!]).toBe('    template: {name: Movies, collection: 424242}');
  });

  it('edits an inline quoted id-list (tmdb_movie) preserving quotes + commas', () => {
    const before = read('movies-franchises.yml');
    const after = spliceHandCollectionRef({
      fileText: before,
      name: 'Unbreakable',
      mediaType: 'movies',
      builderRef: '10, 20, 30',
    });
    const changed = changedLineIndices(before, after);
    expect(changed).toHaveLength(1);
    expect(after.split('\n')[changed[0]!]).toBe('    template: {name: Movies, tmdb_movie: "10,20,30"}');
  });

  it('edits a block-list id builder (tvdb_show) replacing only the item lines', () => {
    const before = read('shows-collections.yml');
    const beforeLines = before.split('\n');
    const startIdx = beforeLines.findIndex((l) => l === '  Earth & Space Wonders:');
    const after = spliceHandCollectionRef({
      fileText: before,
      name: 'Earth & Space Wonders',
      mediaType: 'tv',
      builderRef: '111, 222',
    });
    const afterLines = after.split('\n');
    // Everything before the block header is identical.
    for (let i = 0; i < startIdx; i++) expect(afterLines[i]).toBe(beforeLines[i]);
    const reparsed = parseHandConfigFile(after, 'shows-collections.yml', 'tv');
    expect(reparsed.find((c) => c.name === 'Earth & Space Wonders')!.builderRef).toBe('111,222');
    // A sibling curated list is untouched.
    expect(reparsed.find((c) => c.name === 'Big Kid Cartoons')!.builderRef).toBe(
      parseHandConfigFile(before, 'shows-collections.yml', 'tv').find(
        (c) => c.name === 'Big Kid Cartoons',
      )!.builderRef,
    );
  });

  it('rejects a too-custom collection and a malformed ref (never a lossy rewrite)', () => {
    const before = read('movies-franchises.yml');
    expect(() =>
      spliceHandCollectionRef({ fileText: before, name: 'The Addams Family', mediaType: 'movies', builderRef: '1' }),
    ).toThrow(KometaRecipeError);
    expect(() =>
      spliceHandCollectionRef({ fileText: before, name: 'Monsterverse', mediaType: 'movies', builderRef: 'not-a-url' }),
    ).toThrow(KometaRecipeError);
    expect(() =>
      spliceHandCollectionRef({ fileText: before, name: 'Nope', mediaType: 'movies', builderRef: '1' }),
    ).toThrow(NotFoundError);
  });

  it('preserves comments + anchors in untouched sections (synthetic anchor fixture)', () => {
    const fixture = [
      '# a leading comment with an anchor',
      'templates:',
      '  Base: &base',
      '    sonarr_add_missing: false',
      'collections:',
      '  Alpha:  # keeps its inline comment',
      '    <<: *base',
      '    tvdb_list_details: https://thetvdb.com/lists/alpha',
      '    # trailing note',
      '  Beta:',
      '    tvdb_list_details: https://thetvdb.com/lists/beta',
      '',
    ].join('\n');
    const after = spliceHandCollectionRef({
      fileText: fixture,
      name: 'Alpha',
      mediaType: 'tv',
      builderRef: 'https://thetvdb.com/lists/alpha-two',
    });
    const changed = changedLineIndices(fixture, after);
    expect(changed).toHaveLength(1);
    // The anchor line, the merge key, the inline comment, and Beta are all byte-identical.
    const lines = after.split('\n');
    expect(lines).toContain('  Base: &base');
    expect(lines).toContain('    <<: *base');
    expect(lines).toContain('  Alpha:  # keeps its inline comment');
    expect(lines).toContain('    # trailing note');
    expect(lines).toContain('    tvdb_list_details: https://thetvdb.com/lists/beta');
  });
});

describe('spliceHandCollectionFindMissing — surgical acquisition keys', () => {
  it('turns ON by inserting add_missing + search after the header (nothing else changes)', () => {
    const before = read('shows-franchises.yml');
    const beforeLines = before.split('\n');
    const headerIdx = beforeLines.findIndex((l) => l === '  Arrowverse:');
    const after = spliceHandCollectionFindMissing({
      fileText: before,
      name: 'Arrowverse',
      mediaType: 'tv',
      on: true,
    });
    const afterLines = after.split('\n');
    expect(afterLines[headerIdx]).toBe('  Arrowverse:');
    expect(afterLines[headerIdx + 1]).toBe('    sonarr_add_missing: true');
    expect(afterLines[headerIdx + 2]).toBe('    sonarr_search: true');
    // The original next line is shifted down by two, otherwise identical.
    expect(afterLines[headerIdx + 3]).toBe(beforeLines[headerIdx + 1]);
    // Everything above the header is byte-identical.
    for (let i = 0; i < headerIdx; i++) expect(afterLines[i]).toBe(beforeLines[i]);
    expect(parseHandConfigFile(after, 'shows-franchises.yml', 'tv').find((c) => c.name === 'Arrowverse')!.findMissing).toBe(true);
  });

  it('turns OFF by editing an existing add_missing in place', () => {
    const before = read('movies-collections.yml');
    // Christmas HNet already has radarr_add_missing: false — turn it ON then OFF to exercise the edit.
    const on = spliceHandCollectionFindMissing({ fileText: before, name: 'Christmas HNet', mediaType: 'movies', on: true });
    expect(on.split('\n').filter((l) => l.trim() === 'radarr_add_missing: true')).toHaveLength(1);
    expect(on.split('\n').filter((l) => l.trim() === 'radarr_search: true')).toHaveLength(1);
    const off = spliceHandCollectionFindMissing({ fileText: on, name: 'Christmas HNet', mediaType: 'movies', on: false });
    expect(off.split('\n').filter((l) => l.trim() === 'radarr_add_missing: false')).toHaveLength(1);
    expect(off.split('\n').some((l) => l.trim() === 'radarr_search: true')).toBe(false);
  });
});

describe('spliceHandCollectionRemoval — surgical block removal', () => {
  it('removes exactly one collection block, neighbors byte-identical', () => {
    const before = read('shows-franchises.yml');
    const beforeLines = before.split('\n');
    const start = beforeLines.findIndex((l) => l === '  The Boys:');
    const after = spliceHandCollectionRemoval({ fileText: before, name: 'The Boys' });
    const afterLines = after.split('\n');
    // Lines before the removed block are identical.
    for (let i = 0; i < start; i++) expect(afterLines[i]).toBe(beforeLines[i]);
    // The Boys is gone; its neighbors survive.
    const names = parseHandConfigFile(after, 'shows-franchises.yml', 'tv').map((c) => c.name);
    expect(names).not.toContain('The Boys');
    expect(names).toContain('Breaking Bad');
    expect(names).toContain('Avatar The Last Airbender');
  });
});
