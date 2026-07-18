// DESIGN-035 D-17 — the pure non-admin collection SIZE CAP guard. Proves the predicate (admin bypass,
// inclusive at-cap, over-cap) and the assert's typed error carrying { size, cap }. Pure — no DB.
import { describe, expect, it } from 'vitest';
import {
  CollectionSizeCapError,
  assertWithinCollectionSizeCap,
  exceedsCollectionSizeCap,
} from '../src/index';

describe('exceedsCollectionSizeCap (DESIGN-035 D-17)', () => {
  it('an ADMIN never exceeds the cap, at any size', () => {
    expect(exceedsCollectionSizeCap({ size: 10000, cap: 25, isAdmin: true })).toBe(false);
  });

  it('a non-admin AT the cap is allowed (the cap is inclusive)', () => {
    expect(exceedsCollectionSizeCap({ size: 25, cap: 25, isAdmin: false })).toBe(false);
  });

  it('a non-admin BELOW the cap is allowed', () => {
    expect(exceedsCollectionSizeCap({ size: 1, cap: 25, isAdmin: false })).toBe(false);
  });

  it('a non-admin ABOVE the cap exceeds it', () => {
    expect(exceedsCollectionSizeCap({ size: 26, cap: 25, isAdmin: false })).toBe(true);
  });
});

describe('assertWithinCollectionSizeCap (DESIGN-035 D-17)', () => {
  it('is a no-op for an admin over the cap', () => {
    expect(() => assertWithinCollectionSizeCap({ size: 500, cap: 25, isAdmin: true })).not.toThrow();
  });

  it('is a no-op for a within-cap non-admin', () => {
    expect(() => assertWithinCollectionSizeCap({ size: 25, cap: 25, isAdmin: false })).not.toThrow();
  });

  it('throws a typed CollectionSizeCapError carrying { size, cap } for an over-cap non-admin', () => {
    try {
      assertWithinCollectionSizeCap({ size: 40, cap: 25, isAdmin: false });
      throw new Error('expected assertWithinCollectionSizeCap to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CollectionSizeCapError);
      const capErr = err as CollectionSizeCapError;
      expect(capErr.code).toBe('COLLECTION_SIZE_CAP_EXCEEDED');
      expect(capErr.detail).toEqual({ size: 40, cap: 25 });
    }
  });
});
