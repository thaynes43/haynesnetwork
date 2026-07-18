// DESIGN-035 D-17 — the NON-ADMIN collection SIZE CAP guard (pure). Acquisition is ON for collections
// (D-16 Wanted-tiles are monitored+searched *arr members), so a member creating an unbounded collection
// could dump hundreds of monitored+searched items into Radarr/LazyLibrarian. The fence: a non-admin may
// create/add a collection whose RESOLVED membership is at or below `collection_size_cap` (app_settings,
// default 25 — COLLECTION_SIZE_CAP_DEFAULT). LISTS (an IMDb top-200) are the admin-only exception; an
// admin (role.isAdmin => all COLLECTION_ACTIONS) bypasses the cap outright. This module is PURE — the
// procedures read the live cap + the caller's admin flag and call the assert BEFORE any confined
// provider write, so an over-cap collection is refused at creation, never after it floods the *arrs.
import { CollectionSizeCapError } from './errors';

export interface CollectionSizeCapCheck {
  /** The resolved membership size the caller would create/add. */
  size: number;
  /** The live cap (getAppSetting(db, 'collection_size_cap')). */
  cap: number;
  /** The caller's admin flag — admins bypass the cap outright. */
  isAdmin: boolean;
}

/**
 * Would this create/add breach the non-admin size cap? Admins never exceed it (they bypass outright);
 * otherwise a strictly-greater-than-cap resolved membership exceeds. `size === cap` is allowed (the cap
 * is inclusive — a cap of 25 admits a 25-member collection).
 */
export function exceedsCollectionSizeCap(input: CollectionSizeCapCheck): boolean {
  if (input.isAdmin) return false;
  return input.size > input.cap;
}

/**
 * Assert a create/add is within the non-admin size cap. Throws a typed `CollectionSizeCapError` carrying
 * `{ size, cap }` (the client renders the over-cap Modal from it) when a non-admin would breach the cap.
 * A no-op for admins and for within-cap sizes. Call this in the create/apply procedures BEFORE the
 * confined provider write (the SearchCapExceededError discipline — nothing partial happens on a breach).
 */
export function assertWithinCollectionSizeCap(input: CollectionSizeCapCheck): void {
  if (exceedsCollectionSizeCap(input)) {
    throw new CollectionSizeCapError(
      `This collection is too large (${input.size} items; the limit is ${input.cap}). ` +
        `Ask an admin to approve a larger bound.`,
      { size: input.size, cap: input.cap },
    );
  }
}
