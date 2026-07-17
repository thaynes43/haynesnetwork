// DESIGN-035 D-10' / R-214 — the label-driven collection-category derivation. Pins the ratified
// precedence (owner inline label FIRST, then Kometa's section-label fallback map), the reserved-label
// exclusions, and the null-preserve contract, with REAL cases from the haynes-ops kometa estate.
import { describe, expect, it } from 'vitest';
import { deriveCollectionCategory, COLLECTION_CLASSIFIER_VERSION } from '../src/collection-category';

describe("deriveCollectionCategory (DESIGN-035 D-10' — label-driven, open categories)", () => {
  it('is versioned (a rules change must bump the version — the estate re-annotates on next sync)', () => {
    expect(COLLECTION_CLASSIFIER_VERSION).toBe(2);
  });

  it('returns the OWNER inline label verbatim (display case preserved), ignoring the Kometa label', () => {
    // Hand-authored defs carry `Kometa` (managed) + one owner category label.
    expect(deriveCollectionCategory(['Kometa', 'Director'])).toBe('Director');
    expect(deriveCollectionCategory(['Actor', 'Kometa'])).toBe('Actor');
    expect(deriveCollectionCategory(['Kometa', 'Studio'])).toBe('Studio');
    expect(deriveCollectionCategory(['Kometa', 'Audio'])).toBe('Audio');
    // A coined category is free-form — returned exactly as labeled.
    expect(deriveCollectionCategory(['Kometa', 'Cyberpunk Noir'])).toBe('Cyberpunk Noir');
  });

  it('OWNER label BEATS the section-label fallback (the Game of Thrones case)', () => {
    // GoT carries the legacy `Show Franchise Collections` section label (→ Universe by the map) AND
    // the owner inline `Sequels`. The owner label must win.
    expect(
      deriveCollectionCategory(['Kometa', 'Show Franchise Collections', 'Sequels']),
    ).toBe('Sequels');
    // Fantastic Four: the `TMDb Collections` section twin (→ Sequels) + owner inline Sequels — same
    // result, but proves the owner label is read first regardless.
    expect(deriveCollectionCategory(['Kometa', 'TMDb Collections', 'Sequels'])).toBe('Sequels');
  });

  it('FALLBACK maps Kometa section labels to a category when there is no owner label', () => {
    expect(deriveCollectionCategory(['Kometa', 'TMDb Collections'])).toBe('Sequels');
    expect(deriveCollectionCategory(['Kometa', 'Universe Collections'])).toBe('Universe');
    expect(deriveCollectionCategory(['Kometa', 'Oscars Winners Awards'])).toBe('List');
    expect(deriveCollectionCategory(['Kometa', 'Golden Globes Awards'])).toBe('List');
    expect(deriveCollectionCategory(['Kometa', 'Show Franchise Collections'])).toBe('Universe');
    // Case / whitespace insensitive on the section-label match.
    expect(deriveCollectionCategory(['Kometa', 'tmdb   collections'])).toBe('Sequels');
  });

  it('excludes RESERVED labels from being a category (Kometa + the section labels)', () => {
    // Only the managed Kometa label → no owner category and no section map hit → null.
    expect(deriveCollectionCategory(['Kometa'])).toBeNull();
    // A section label alone is NOT returned verbatim as a category — it is mapped (above) or, if the
    // owner-label scan sees only reserved labels, falls through to the map.
    expect(deriveCollectionCategory(['Kometa', 'Universe Collections'])).not.toBe(
      'Universe Collections',
    );
  });

  it('returns null for an unlabeled collection (no owner label, no known section label — no chip)', () => {
    expect(deriveCollectionCategory([])).toBeNull();
    expect(deriveCollectionCategory(['Kometa', '   '])).toBeNull();
    // A hand-made (non-Kometa) collection with no category label — shows only under "All".
    expect(deriveCollectionCategory([])).toBeNull();
  });

  it('preserves the prior value on a FAILED label read (null in → null out)', () => {
    // Symmetric with derivePlexCollectionProvenance: null labels (read failed) → null so the writer
    // COALESCE keeps the existing category rather than wiping it.
    expect(deriveCollectionCategory(null)).toBeNull();
  });

  it('trims whitespace on the returned owner label', () => {
    expect(deriveCollectionCategory(['Kometa', '  List  '])).toBe('List');
  });
});
