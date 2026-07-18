// Collection PROVENANCE derivation + display mapping (owner directive 2026-07-16 — "tagging
// collections for what created them"). Pure functions, no I/O — the collections syncs call the
// derivers at every upsert; the API layer resolves the display name for the wall badges.
import { describe, expect, it } from 'vitest';
import {
  deriveBooksCollectionCategory,
  deriveBooksCollectionProvenance,
  derivePlexCollectionProvenance,
  librettoRecipeIdFromDescription,
  provenanceDisplayName,
} from '../src';

describe('derivePlexCollectionProvenance (Movies/TV — Kometa labels)', () => {
  it("returns 'kometa' when the Kometa label is present (case-insensitive, among others)", () => {
    expect(derivePlexCollectionProvenance(['Kometa'])).toBe('kometa');
    // The estate also carries secondary category labels — Kometa still wins.
    expect(derivePlexCollectionProvenance(['Universe Collections', 'Kometa'])).toBe('kometa');
    expect(derivePlexCollectionProvenance(['kometa'])).toBe('kometa');
  });

  it("returns 'plex' (hand-made) when no Kometa label is present", () => {
    expect(derivePlexCollectionProvenance([])).toBe('plex');
    expect(derivePlexCollectionProvenance(['TMDb Collections'])).toBe('plex');
  });

  it('returns null when the labels are unknown (read did not run) — the writer preserves the prior value', () => {
    expect(derivePlexCollectionProvenance(null)).toBeNull();
  });
});

describe('deriveBooksCollectionProvenance (Books — Libretto marker)', () => {
  it("returns 'libretto' when the source description carries the marker", () => {
    const desc = 'Managed by Libretto. Do not remove this marker: [libretto:expanse-hardcover]';
    expect(deriveBooksCollectionProvenance('kavita', desc)).toBe('libretto');
    expect(deriveBooksCollectionProvenance('audiobookshelf', desc)).toBe('libretto');
  });

  it('returns the SOURCE app (hand-made) when there is no marker / no description', () => {
    expect(deriveBooksCollectionProvenance('kavita', 'A normal reading list')).toBe('kavita');
    expect(deriveBooksCollectionProvenance('kavita', null)).toBe('kavita');
    expect(deriveBooksCollectionProvenance('kavita', undefined)).toBe('kavita');
    expect(deriveBooksCollectionProvenance('audiobookshelf', '')).toBe('audiobookshelf');
  });

  it('recovers the recipeId from the marker (for a future builder-level join)', () => {
    expect(librettoRecipeIdFromDescription('x [libretto:nyt-fiction] y')).toBe('nyt-fiction');
    expect(librettoRecipeIdFromDescription('no marker here')).toBeUndefined();
    // The optional forward-compatible `cat=` suffix must NOT break recipeId recovery (D-12).
    expect(librettoRecipeIdFromDescription('[libretto:dune-series|cat=Series]')).toBe(
      'dune-series',
    );
  });
});

describe('deriveBooksCollectionCategory (Books — the forward-compatible Libretto cat= marker, D-12)', () => {
  it('returns the category when the marker carries a cat= token (display case + trimmed)', () => {
    expect(deriveBooksCollectionCategory('[libretto:dune-series|cat=Series]')).toBe('Series');
    expect(deriveBooksCollectionCategory('prefix [libretto:nyt|cat=List] suffix')).toBe('List');
    expect(deriveBooksCollectionCategory('[libretto:x|cat=Award Winners]')).toBe('Award Winners');
  });

  it('returns null when there is no marker, no cat= token, or no description (the state today)', () => {
    // Today's markers carry no cat= — every live row derives null, so the L2 agent-set value stands.
    expect(deriveBooksCollectionCategory('[libretto:dune-series]')).toBeNull();
    expect(deriveBooksCollectionCategory('a normal reading list')).toBeNull();
    expect(deriveBooksCollectionCategory(null)).toBeNull();
    expect(deriveBooksCollectionCategory(undefined)).toBeNull();
    expect(deriveBooksCollectionCategory('[libretto:x|cat=   ]')).toBeNull();
  });
});

describe('provenanceDisplayName (badge label)', () => {
  it('maps known software tokens to their proper name', () => {
    expect(provenanceDisplayName('kometa')).toBe('Kometa');
    expect(provenanceDisplayName('plex')).toBe('Plex');
    expect(provenanceDisplayName('libretto')).toBe('Libretto');
    expect(provenanceDisplayName('kavita')).toBe('Kavita');
    expect(provenanceDisplayName('audiobookshelf')).toBe('Audiobookshelf');
  });

  it('returns null for null/blank (no badge — provenance unknown)', () => {
    expect(provenanceDisplayName(null)).toBeNull();
    expect(provenanceDisplayName(undefined)).toBeNull();
    expect(provenanceDisplayName('  ')).toBeNull();
  });

  it('title-cases an unknown token honestly (owner directive — unknown types display as the raw type)', () => {
    expect(provenanceDisplayName('some_new_builder')).toBe('Some New Builder');
    // The pre-wired future builder map resolves builder types too.
    expect(provenanceDisplayName('hardcover_series')).toBe('Hardcover Series');
  });
});
