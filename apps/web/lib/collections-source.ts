// Owner ruling 2026-07-18 — the SOURCE-filter classification behind the /collections media-tab lists.
// A row falls into exactly ONE source category; the multi-select filter chip (shared @hnet/ui FilterChip)
// hides a category when the caller unchecks it, so unchecking "Locked" hides the immutable Kometa rows.
// Pure + framework-free so the row-state mapping is unit-tested without a DOM (the apps/web lib idiom).

/** The stable category token a row filters under (kept off the display copy so labels stay swappable). */
export type SourceCategory = 'added' | 'config' | 'locked' | 'managed' | 'library';

/** The user-facing chip label for each category (owner tone, no em-dashes; "Locked" is swappable). */
export const SOURCE_CATEGORY_LABELS: Record<SourceCategory, string> = {
  added: 'Added here',
  config: 'Kometa config',
  locked: 'Locked',
  managed: 'Managed here',
  library: 'Made in your library apps',
};

/**
 * A Kometa hand-file / Defaults row's category. An editable hand-file collection stays "Kometa config";
 * a non-editable one (a builder too custom to model here OR a Kometa-Defaults mirror with no file) is
 * "Locked" — the same predicate that greys its Edit and shows the immutable badge.
 */
export function handSourceCategory(editable: boolean): SourceCategory {
  return editable ? 'config' : 'locked';
}

/** The app-managed recipe row's category: a Kometa "Added here" recipe vs a books "Managed here" recipe. */
export function recipeSourceCategory(isKometa: boolean): SourceCategory {
  return isKometa ? 'added' : 'managed';
}

/**
 * The categories actually PRESENT in a list, in a fixed display order — the chip offers only what the
 * list holds (no dangling "Locked" option when nothing is locked). Kometa lists split hand rows into
 * editable ("Kometa config") vs non-editable ("Locked"); books lists split recipes ("Managed here") vs
 * read-only rows ("Made in your library apps").
 */
export function presentSourceCategories(input: {
  isKometa: boolean;
  recipeCount: number;
  hand: ReadonlyArray<{ editable: boolean }>;
  readOnlyCount: number;
}): SourceCategory[] {
  const cats: Array<SourceCategory | null> = input.isKometa
    ? [
        input.recipeCount > 0 ? 'added' : null,
        input.hand.some((h) => h.editable) ? 'config' : null,
        input.hand.some((h) => !h.editable) ? 'locked' : null,
      ]
    : [
        input.recipeCount > 0 ? 'managed' : null,
        input.readOnlyCount > 0 ? 'library' : null,
      ];
  return cats.filter((c): c is SourceCategory => c !== null);
}

/** The visible categories = present minus the caller's hidden (unchecked) set. */
export function visibleSourceCategories(
  present: readonly SourceCategory[],
  hidden: readonly SourceCategory[],
): SourceCategory[] {
  return present.filter((c) => !hidden.includes(c));
}
