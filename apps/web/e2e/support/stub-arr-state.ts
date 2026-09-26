// ADR-093 / DESIGN-052 D-14 / D-20 (PLAN-072) — state the stub Maintainerr and the stub *arr share in the harness
// process: the items a stub per-item handle deleted. After a Trash delete the app GETs the *arr item and expects a
// 404 before it turns the Deleted-Release Record `active`; the stub *arr answers 404 for anything listed here. Both
// stubs' `/_stub/reset` clear it (and the Trash spec resets the Maintainerr stub after its last test), so no later
// spec sees a stub movie vanish.
export const stubArrDeleted = { tmdb: new Set<number>(), tvdb: new Set<number>() };

export function markStubArrDeleted(ids: { tmdbId?: number | null; tvdbId?: number | null }): void {
  if (typeof ids.tmdbId === 'number') stubArrDeleted.tmdb.add(ids.tmdbId);
  if (typeof ids.tvdbId === 'number') stubArrDeleted.tvdb.add(ids.tvdbId);
}

export function clearStubArrDeleted(): void {
  stubArrDeleted.tmdb.clear();
  stubArrDeleted.tvdb.clear();
}
