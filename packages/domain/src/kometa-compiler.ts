// ADR-072 / DESIGN-042 D-04/D-05 (PLAN-052 PR4b) — the Kometa recipe → managed-include COMPILER.
//
// This module is PURE (no I/O): it turns app-authored collection recipes into the ONE app-owned Kometa
// `collection_files` include the confined git-write client commits to haynes-ops
// (`hnet-managed-movies.yml` / `hnet-managed-tv.yml`), and it reads that same file back into recipes (the
// app's own managed file IS the recipe source of truth — DESIGN-042 D-01; there is no local recipe table,
// no migration). Everything Kometa consumes lives in the generated `collections:` block; a `# hnet-recipes:`
// manifest comment carries the exact recipe JSON so the round-trip is deterministic and never depends on
// parsing generated YAML back.
//
// Three safety invariants (DESIGN-042 D-03/D-04):
//   • ALLOWLIST ONLY — a recipe whose builder is not one of the six member-suggestible Kometa builders is
//     rejected; the four owner-only query/search/regex engines are structurally unreachable here.
//   • VALIDATED REF, never raw YAML — each builder reduces to a typed, shape-checked ref (a URL grammar, an
//     integer id, or an integer-id list). A malformed ref is rejected at compile time.
//   • NAMESPACE MARKER (Q-05) — every managed collection carries the reserved `HNet Managed` Plex label so
//     it can never be mistaken for a hand-authored sibling and the mirror can recognize it; the label is
//     reserved in `deriveCollectionCategory` so it never becomes a category chip.
//
// The output is byte-stable: recipes are emitted in a deterministic (id-sorted) order and the serializer is
// closed-shape, so recompiling an unchanged recipe set yields an identical file (idempotent — no PR churn).
import { KOMETA_BUILDER_TYPES, type CollectionSyncMode, type KometaBuilderType } from '@hnet/db';
import { HNET_MANAGED_LABEL } from './collection-provenance';

/** A malformed / disallowed Kometa recipe or ref — rejected before any git write. */
export class KometaRecipeError extends Error {
  readonly code = 'KOMETA_RECIPE_INVALID' as const;
  constructor(message: string) {
    super(message);
  }
}

/** The two Kometa-backed media sub-sections (Movies → Radarr, TV → Sonarr). */
export type KometaMediaType = 'movies' | 'tv';

/**
 * One app-authored Kometa collection definition (DESIGN-042 D-01). `builderRef` is the CANONICAL string
 * form the composer produced (a normalized URL, a single integer id as a string, or a comma-separated
 * integer-id list) — `validateKometaRef` is what canonicalizes and shape-checks it. `findMissing` is the
 * acquisition lever (radarr_add_missing / sonarr_add_missing); it is FALSE on every within-cap direct add
 * (PR4b) and only a PR4c grant-gated, human-merged edit can flip it true.
 */
export interface KometaRecipe {
  id: string;
  name: string;
  mediaType: KometaMediaType;
  builderType: KometaBuilderType;
  builderRef: string;
  syncMode?: CollectionSyncMode;
  ordered?: boolean;
  findMissing: boolean;
}

/** The *arr a media type acquires through — drives the `radarr_*` / `sonarr_*` key prefix. */
function arrPrefix(mediaType: KometaMediaType): 'radarr' | 'sonarr' {
  return mediaType === 'movies' ? 'radarr' : 'sonarr';
}

/** Whether a builder's ref is an integer-id LIST (vs a single URL / id). */
const ID_LIST_BUILDERS: ReadonlySet<KometaBuilderType> = new Set([
  'tmdb_movie',
  'tmdb_show',
  'tvdb_show',
]);

export interface KometaRefValidation {
  /** The canonical ref string (a normalized URL, a single id, or a normalized comma id-list). */
  normalizedRef: string;
  /**
   * The resolvable membership count WITHOUT egress (an id-list's length), or null when the count cannot
   * be known without a network call (a URL list / a TMDb collection id — DESIGN-042 Q-06, canary-first).
   * The cap check treats null as "cannot prove within cap" (the domain routes it to the over-cap ticket).
   */
  resolvableCount: number | null;
}

const IMDB_LIST_RE = /^https:\/\/(?:www\.)?imdb\.com\/list\/(ls\d+)\/?(?:\?.*)?$/i;
const TVDB_LIST_RE = /^https:\/\/(?:www\.)?thetvdb\.com\/lists\/([a-z0-9][a-z0-9-]*)\/?$/i;

/** Parse a whitespace/comma-separated integer-id list → the canonical `"1,2,3"` form (deduped, ordered-in). */
function parseIdList(ref: string): number[] {
  const parts = ref
    .split(/[\s,]+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) throw new KometaRecipeError('This builder needs at least one id.');
  const ids: number[] = [];
  const seen = new Set<number>();
  for (const p of parts) {
    if (!/^\d+$/.test(p)) throw new KometaRecipeError(`"${p}" is not a valid numeric id.`);
    const n = Number(p);
    if (!Number.isSafeInteger(n) || n <= 0) throw new KometaRecipeError(`"${p}" is not a valid id.`);
    if (!seen.has(n)) {
      seen.add(n);
      ids.push(n);
    }
  }
  return ids;
}

/**
 * DESIGN-042 D-04 — shape-validate + CANONICALIZE a Kometa builder ref (never raw YAML). Throws a
 * `KometaRecipeError` on any malformed ref. Returns the canonical string form plus the count the app can
 * know without egress (an id-list length; null for a URL/id that would need a resolve call).
 */
export function validateKometaRef(builderType: KometaBuilderType, rawRef: string): KometaRefValidation {
  const ref = rawRef.trim();
  if (ref === '') throw new KometaRecipeError('A collection needs a source reference.');
  switch (builderType) {
    case 'imdb_list': {
      const m = IMDB_LIST_RE.exec(ref);
      if (!m) throw new KometaRecipeError('Enter a full IMDb list URL (https://www.imdb.com/list/ls…/).');
      return { normalizedRef: `https://www.imdb.com/list/${m[1]}/`, resolvableCount: null };
    }
    case 'tvdb_list_details': {
      const m = TVDB_LIST_RE.exec(ref);
      if (!m) throw new KometaRecipeError('Enter a full TheTVDB list URL (https://thetvdb.com/lists/…).');
      return { normalizedRef: `https://thetvdb.com/lists/${m[1]}`, resolvableCount: null };
    }
    case 'tmdb_collection_details': {
      if (!/^\d+$/.test(ref)) throw new KometaRecipeError('Enter a numeric TMDb collection id.');
      const n = Number(ref);
      if (!Number.isSafeInteger(n) || n <= 0) throw new KometaRecipeError('Enter a valid TMDb collection id.');
      return { normalizedRef: String(n), resolvableCount: null };
    }
    case 'tmdb_movie':
    case 'tmdb_show':
    case 'tvdb_show': {
      const ids = parseIdList(ref);
      return { normalizedRef: ids.join(','), resolvableCount: ids.length };
    }
    default: {
      // Exhaustiveness — a builder outside the allowlist can never reach the compiler.
      const never: never = builderType;
      throw new KometaRecipeError(`Unsupported Kometa builder: ${String(never)}`);
    }
  }
}

/** Assert a builder is in the Kometa allowlist (defence beneath the zod enum — the D-04 gate). */
export function assertKometaBuilder(builderType: string): asserts builderType is KometaBuilderType {
  if (!(KOMETA_BUILDER_TYPES as readonly string[]).includes(builderType)) {
    throw new KometaRecipeError(`"${builderType}" is not an allowed Kometa builder.`);
  }
}

export interface KometaRefPreview {
  /** The canonical ref (echoed back so the composer stores exactly what compiles). */
  normalizedRef: string;
  /** The count the app can prove without egress (id-list length), or null when unknown. */
  resolvedCount: number | null;
  /** True when a real name/count preview would need NEW egress the estate has not allowlisted (Q-06). */
  egressRequired: boolean;
  /** An honest human note — never a fabricated name/count. */
  note: string;
}

/**
 * DESIGN-042 D-04 / Q-06 — the canary-first ref PREVIEW. It NEVER makes a network call: for the id-list
 * builders it echoes the validated count (the app knows it exactly); for a URL/collection-id it reports
 * that a name/count preview needs egress the estate has not opened yet and renders an honest
 * "preview unavailable for this ref type" note (NOT a proxy workaround). Shape validation still runs, so a
 * malformed ref is caught here before save.
 */
export function previewKometaRef(builderType: KometaBuilderType, rawRef: string): KometaRefPreview {
  const { normalizedRef, resolvableCount } = validateKometaRef(builderType, rawRef);
  if (resolvableCount !== null) {
    return {
      normalizedRef,
      resolvedCount: resolvableCount,
      egressRequired: false,
      note: `${resolvableCount} item${resolvableCount === 1 ? '' : 's'} listed.`,
    };
  }
  return {
    normalizedRef,
    resolvedCount: null,
    egressRequired: true,
    note: 'Preview is unavailable for this reference type; membership resolves on the next collection run.',
  };
}

// ── Serialization ────────────────────────────────────────────────────────────────────────────────────

const GENERATED_HEADER = [
  '# Generated by haynesnetwork — do not hand-edit.',
  '# App-owned Kometa collection recipes authored from the /collections page (ADR-072 / DESIGN-042).',
  '# The `# hnet-recipes:` line below is the machine manifest the app reads back; edit collections in-app.',
];

const MANIFEST_PREFIX = '# hnet-recipes: ';
/** The umbrella + app marker every managed item is *arr-tagged with (traceability, Maintainerr flow-out). */
const MANAGED_TAG = 'Kometa-Added,HNet-Managed';

/** Quote a YAML scalar (double-quoted, escaping `"` and `\`) — used for titles/tags/urls. */
function yamlQuote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** The builder value line(s) for a recipe (a scalar for URL/id builders, a YAML list for id-lists). */
function builderValueLines(recipe: KometaRecipe): string[] {
  const { normalizedRef } = validateKometaRef(recipe.builderType, recipe.builderRef);
  if (ID_LIST_BUILDERS.has(recipe.builderType)) {
    const ids = normalizedRef.split(',');
    return [`    ${recipe.builderType}:`, ...ids.map((id) => `      - ${id}`)];
  }
  // imdb_list / tvdb_list_details are URLs; tmdb_collection_details is a bare integer.
  const scalar = recipe.builderType === 'tmdb_collection_details' ? normalizedRef : yamlQuote(normalizedRef);
  return [`    ${recipe.builderType}: ${scalar}`];
}

/** Emit one recipe's `collections:` entry (deterministic key order). */
function serializeRecipe(recipe: KometaRecipe): string[] {
  assertKometaBuilder(recipe.builderType);
  const arr = arrPrefix(recipe.mediaType);
  const lines: string[] = [`  ${yamlQuote(recipe.name)}:`];
  lines.push(...builderValueLines(recipe));
  lines.push(`    sync_mode: ${recipe.syncMode ?? 'sync'}`);
  if (recipe.ordered) lines.push('    collection_order: custom');
  // Acquisition lever — OFF for every within-cap add (PR4b); a PR4c human-merged edit flips it.
  lines.push(`    ${arr}_add_missing: ${recipe.findMissing ? 'true' : 'false'}`);
  if (recipe.findMissing) lines.push(`    ${arr}_search: true`);
  lines.push(`    ${arr}_tag: ${yamlQuote(MANAGED_TAG)}`);
  // Q-05 namespace marker — reserved in deriveCollectionCategory so it never becomes a category chip.
  lines.push(`    label: ${yamlQuote(HNET_MANAGED_LABEL)}`);
  return lines;
}

/** Recipes for one media type in the canonical (id-sorted) order the file always emits. */
function orderedForMedia(mediaType: KometaMediaType, recipes: readonly KometaRecipe[]): KometaRecipe[] {
  return recipes
    .filter((r) => r.mediaType === mediaType)
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * DESIGN-042 D-05 — compile a recipe set into the app-owned managed include for ONE media type. Rejects a
 * disallowed builder or malformed ref (KometaRecipeError) and a duplicate recipe id / collection name
 * (the global-uniqueness invariant). Byte-stable: an unchanged recipe set always yields an identical file.
 */
export function compileManagedFile(input: {
  mediaType: KometaMediaType;
  recipes: readonly KometaRecipe[];
}): string {
  const ordered = orderedForMedia(input.mediaType, input.recipes);
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  for (const r of ordered) {
    if (seenIds.has(r.id)) throw new KometaRecipeError(`Duplicate recipe id: ${r.id}`);
    seenIds.add(r.id);
    const nameKey = r.name.trim().toLowerCase();
    if (seenNames.has(nameKey)) throw new KometaRecipeError(`Duplicate collection name: ${r.name}`);
    seenNames.add(nameKey);
  }
  // The manifest carries the canonical recipe shape (id-sorted) — the round-trip source of truth.
  const manifest = ordered.map((r) => ({
    id: r.id,
    name: r.name,
    mediaType: r.mediaType,
    builderType: r.builderType,
    builderRef: validateKometaRef(r.builderType, r.builderRef).normalizedRef,
    syncMode: r.syncMode ?? 'sync',
    ordered: r.ordered ?? false,
    findMissing: r.findMissing,
  }));
  const body =
    ordered.length === 0 ? ['collections: {}'] : ['collections:', ...ordered.flatMap(serializeRecipe)];
  return [...GENERATED_HEADER, MANIFEST_PREFIX + JSON.stringify(manifest), '', ...body, ''].join('\n');
}

/**
 * Read the app-owned managed include back into its recipe set (DESIGN-042 D-01 — the app reads exactly
 * what it wrote). Parses the `# hnet-recipes:` manifest line (never the generated YAML). A file with no
 * manifest (an empty/bootstrap stub) yields an empty recipe list. Throws KometaRecipeError on a corrupt
 * manifest so a hand-edit can never be silently trusted.
 */
export function parseManagedFile(fileText: string | null | undefined): KometaRecipe[] {
  if (!fileText) return [];
  const line = fileText.split('\n').find((l) => l.startsWith(MANIFEST_PREFIX));
  if (!line) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(line.slice(MANIFEST_PREFIX.length));
  } catch (error) {
    throw new KometaRecipeError(`Corrupt hnet-recipes manifest: ${(error as Error).message}`);
  }
  if (!Array.isArray(raw)) throw new KometaRecipeError('hnet-recipes manifest is not an array.');
  return raw.map((r): KometaRecipe => {
    const o = r as Record<string, unknown>;
    const builderType = String(o.builderType ?? '');
    assertKometaBuilder(builderType);
    return {
      id: String(o.id ?? ''),
      name: String(o.name ?? ''),
      mediaType: (o.mediaType === 'tv' ? 'tv' : 'movies') as KometaMediaType,
      builderType,
      builderRef: String(o.builderRef ?? ''),
      syncMode: o.syncMode === 'append' ? 'append' : 'sync',
      ordered: o.ordered === true,
      findMissing: o.findMissing === true,
    };
  });
}

/** The managed-include filename for a media type (the app owns exactly these two files). */
export function managedFileName(mediaType: KometaMediaType): string {
  return mediaType === 'movies' ? 'hnet-managed-movies.yml' : 'hnet-managed-tv.yml';
}
