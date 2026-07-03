// DESIGN-003 D-05/D-09 — admin views recompute effective apps + provenance
// client-side from users.list + catalog.adminList + tags.list (no getById
// endpoint). Pure and structurally typed so it's unit-testable and decoupled
// from the tRPC output types (which satisfy these shapes).

export interface CatalogEntryLike {
  id: string;
  defaultVisible: boolean;
}

export interface AdminUserLike {
  directGrants: Array<{ appId: string }>;
  tags: Array<{ id: string }>;
}

export interface AdminTagLike {
  id: string;
  name: string;
  bundle: { appIds: string[] };
}

export type Provenance =
  | { kind: 'default' }
  | { kind: 'direct' }
  | { kind: 'tag'; tagId: string; tagName: string };

/**
 * Where a user's access to `entry` comes from (R-22): defaultVisible entry,
 * direct grant, and/or each applied tag whose bundle includes the app —
 * rendered as `default` / `direct` / `tag:<name>` chips. Empty = no access.
 */
export function provenanceForApp(
  entry: CatalogEntryLike,
  user: AdminUserLike,
  allTags: readonly AdminTagLike[],
): Provenance[] {
  const chips: Provenance[] = [];
  if (entry.defaultVisible) chips.push({ kind: 'default' });
  if (user.directGrants.some((g) => g.appId === entry.id)) chips.push({ kind: 'direct' });
  const applied = new Set(user.tags.map((t) => t.id));
  for (const tag of allTags) {
    if (applied.has(tag.id) && tag.bundle.appIds.includes(entry.id)) {
      chips.push({ kind: 'tag', tagId: tag.id, tagName: tag.name });
    }
  }
  return chips;
}

/** Chip label as the D-11 spec renders it. */
export function provenanceLabel(p: Provenance): string {
  return p.kind === 'tag' ? `tag:${p.tagName}` : p.kind;
}
