// ADR-072 / DESIGN-043 D-14 (PLAN-052 PR4c) — the client mirror of @hnet/db COLLECTION_ACTIONS (the
// fine-grained collection action grants), kept React-free and local so the /admin roles grid can render the
// toggle without importing server code (the lib/books-actions.ts convention). The owner opens these per role
// (THE FLIP): a role with `find_missing` may turn "find missing" on per collection on the /collections page,
// which makes the estate pull that collection's missing titles on its next runs. Labels use owner tone.
export const COLLECTION_ACTION_NAMES = ['find_missing'] as const;
export type CollectionActionName = (typeof COLLECTION_ACTION_NAMES)[number];

export const COLLECTION_ACTION_LABELS: Record<CollectionActionName, string> = {
  find_missing: 'Find missing (pull a collection’s missing titles on the next runs)',
};
