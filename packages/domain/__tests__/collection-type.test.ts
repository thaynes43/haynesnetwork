// DESIGN-035 D-10 / R-214 (PLAN-053) — the versioned Collection Type classifier, pinned per bucket
// with REAL names from our Kometa estate (haynes-ops kometa config + the Defaults it runs — the
// research doc §4 provenance), plus the honesty battery: anything no EXPLICIT rule places must land
// in 'other' (a bare person-name heuristic is too loose — the owner's ruling encoded as tests).
import { describe, expect, it } from 'vitest';
import { classifyCollectionType, COLLECTION_CLASSIFIER_VERSION } from '../src/collection-type';

describe('classifyCollectionType (DESIGN-035 D-10 — six owner-ruled buckets)', () => {
  it('is versioned (a rules change must bump the version — the estate re-annotates on next sync)', () => {
    expect(COLLECTION_CLASSIFIER_VERSION).toBe(1);
  });

  it('trilogy — "… Trilogy" + explicit n-ology variants', () => {
    for (const title of [
      'The Dark Knight Trilogy',
      'Back to the Future Trilogy',
      'The Lord of the Rings Trilogy',
      'trilogy of terror', // position + case free
      'Alien Quadrilogy',
      'The Planet of the Apes Tetralogy',
      'The Fast Pentalogy',
    ]) {
      expect(classifyCollectionType(title), title).toBe('trilogy');
    }
  });

  it('franchise_universe — the "… Collection" / "… Saga" / "…verse" idioms + estate universe names', () => {
    for (const title of [
      'The Girl - Millennium Collection', // movies-franchises.yml (live estate)
      'Harry Potter Collection', // the franchise Default's canonical shape
      'X-Men Collection',
      'The Twilight Saga',
      'Marvel Cinematic Universe', // shows-franchises.yml (live estate)
      'Arrowverse', // shows-franchises.yml
      'Shondaverse', // shows-franchises.yml
      'Monsterverse', // movies-franchises.yml
      'View Askewniverse',
      'Star Wars', // universe-Default name (exact estate match)
      'Wizarding World',
      'Middle Earth',
      'Fast & Furious',
      'Rocky / Creed',
      'In Association with Marvel',
    ]) {
      expect(classifyCollectionType(title), title).toBe('franchise_universe');
    }
  });

  it('director — the movies-people.yml Producers/Directors names (producer/writer fold in)', () => {
    for (const title of [
      'Christopher Nolan',
      'Coen Brothers', // the multi-person row
      'Quentin Tarantino',
      'M. Night Shyamalan',
      'steven spielberg', // case-insensitive
    ]) {
      expect(classifyCollectionType(title), title).toBe('director');
    }
  });

  it('actor — the movies-people.yml Actors names (punctuation + diacritics intact)', () => {
    for (const title of [
      'Robert Downey Jr.',
      'Samuel L. Jackson',
      'Timothée Chalamet',
      'Zendaya',
      'Sacha Baron Cohen',
    ]) {
      expect(classifyCollectionType(title), title).toBe('actor');
    }
  });

  it('list — charts (IMDb/Trakt/Top-N/decade) + seasonal + awards', () => {
    for (const title of [
      'IMDB Popular', // movies-charts.yml (live estate)
      'IMDB Top 250',
      'Popular Now',
      'Top Rated',
      'Top Grossing',
      'Trakt Trending', // the disabled-but-real chart rows
      'Hops Charts',
      'Best of the 1980s',
      '1990s Movies',
      'Christmas HNet', // movies-collections.yml (live estate, seasonal)
      'Halloween Movies', // the seasonal Default's shape
      "Valentine's Day Movies",
      'Oscars Best Picture Winners', // the oscars Default
      'Golden Globes Winners', // the golden Default
      'BAFTA Best Films',
      'Cannes Palme d’Or',
    ]) {
      expect(classifyCollectionType(title), title).toBe('list');
    }
  });

  it("other — ambiguous/idiom-free names stay HONESTLY 'other'", () => {
    for (const title of [
      'Roald Dahl', // movies-lists.yml — an AUTHOR list; a person-name heuristic would misfile it
      'A24', // studio list — not a chart, not an award
      'Disney Animation',
      'DreamWorks Pictures',
      'J-Horror',
      'Curated for Jackson', // shows-collections.yml — owner-curated picks
      'Big Kid Cartoons',
      'Sharknado', // bare franchise name, no idiom — the Default would say "Sharknado Collection"
      'Mean Girls',
      'Breaking Bad', // shows-franchises.yml — bare name
      'Spatial Surround', // movies-collections.yml — tech showcase
      'Dolby Atmos',
      'Earth & Space Wonders',
      '',
    ]) {
      expect(classifyCollectionType(title), title).toBe('other');
    }
  });

  it('guards — near-miss patterns never over-match', () => {
    // "Anthology" is NOT an n-ology (the prefix list is closed).
    expect(classifyCollectionType('Anthology of Interest')).toBe('other');
    expect(classifyCollectionType('The Star Wars Anthology')).toBe('other');
    // Bare "Top …" is not a chart (only Top <number> / the chart phrases are).
    expect(classifyCollectionType('Top Gun')).toBe('other');
    // "… Collection" wins over a people name (rule order — trilogy → franchise → people → list).
    expect(classifyCollectionType('Christopher Nolan Collection')).toBe('franchise_universe');
    // A trilogy that is also a franchise name classifies by FIRST match.
    expect(classifyCollectionType('The Dark Knight Trilogy Collection')).toBe('trilogy');
  });
});
