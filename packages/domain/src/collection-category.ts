// DESIGN-035 D-10' / PRD R-214 / DDD T-186 — THE label-driven collection-category derivation.
// One pure function, no I/O: `syncPlexCollections` calls it at every upsert, so the
// `plex_collections.category` annotation is RECOMPUTED each collections-sync and the whole column
// rebuilds on the next run — bump COLLECTION_CLASSIFIER_VERSION when the rules change and the estate
// re-annotates itself (nothing migrates).
//
// SUPERSEDES the title-only `classifyCollectionType(title)` (retired 2026-07-17). The owner now
// labels every collection deliberately in the Kometa config; those labels ARE the category chips.
// Categories are OPEN/free-form (no CHECK enum, no "Other" bucket) — a new label the owner coins
// simply becomes a new stored category and a new chip on the next sync.
//
// Precedence (owner-ratified, 2026-07-17):
//   1. OWNER label wins — the FIRST label that is neither the reserved `Kometa` provenance label
//      nor one of Kometa's section labels is returned VERBATIM (display case preserved). This is
//      the deliberate inline `label:` the owner set (Universe / Sequels / Director / Actor / List /
//      Studio / Audio / a new one). It beats the fallback map — e.g. Game of Thrones carries both
//      the legacy `Show Franchise Collections` section label AND an inline `Sequels`, and Sequels
//      must win.
//   2. Section-label FALLBACK — for Default-produced collections that carry no inline owner label,
//      map the section label Kometa applies to a category (below).
//   3. Otherwise `null` — no chip; the collection shows only under "All". `labels === null` (a
//      failed label read) also returns `null`, so the writer's COALESCE preserves the prior value
//      (symmetric with `derivePlexCollectionProvenance`).

import { KOMETA_LABEL } from './collection-provenance';

/** Bump when the rules below change — the next collections-sync re-annotates the estate. */
export const COLLECTION_CLASSIFIER_VERSION = 2;

/**
 * Kometa's own SECTION labels → our category. These are applied automatically by the franchise /
 * universe / award Defaults (and the legacy TV list), NOT deliberately by the owner, so they are
 * only the FALLBACK for a Default-produced collection that has no inline owner label. Keyed
 * lowercase for case-insensitive matching.
 */
const SECTION_LABEL_CATEGORY: ReadonlyMap<string, string> = new Map([
  ['tmdb collections', 'Sequels'],
  ['universe collections', 'Universe'],
  ['oscars winners awards', 'List'],
  ['golden globes awards', 'List'],
  ['show franchise collections', 'Universe'],
]);

/**
 * Reserved labels that are NEVER an owner category: the managed `Kometa` provenance label plus
 * every section label (those drive the fallback map instead of being returned verbatim). Lowercase.
 */
const RESERVED_LABELS: ReadonlySet<string> = new Set([
  KOMETA_LABEL.toLowerCase(),
  ...SECTION_LABEL_CATEGORY.keys(),
]);

/** Normalize a label for reserved/section matching (trim + collapse whitespace + lowercase). */
function matchKey(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Derive the OPEN owner-category for a mirrored Plex collection from its labels (T-186). Pure and
 * deterministic. Returns the owner label verbatim, else a mapped section-label category, else null.
 * `labels === null` (failed read) → null so the caller can preserve the prior value.
 */
export function deriveCollectionCategory(labels: readonly string[] | null): string | null {
  if (labels === null) return null;

  // 1. Owner label wins — first non-reserved, non-empty label, returned in its display case.
  for (const raw of labels) {
    const display = raw.trim().replace(/\s+/g, ' ');
    if (display === '') continue;
    if (RESERVED_LABELS.has(matchKey(raw))) continue;
    return display;
  }

  // 2. Section-label fallback — map the first recognized section label to a category.
  for (const raw of labels) {
    const mapped = SECTION_LABEL_CATEGORY.get(matchKey(raw));
    if (mapped) return mapped;
  }

  // 3. No owner label and no known section label → no category (shows under "All").
  return null;
}
