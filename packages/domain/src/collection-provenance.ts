// Collection PROVENANCE — "what software created this collection" (owner directive 2026-07-16:
// "tagging collections for what created them"). A pure, no-I/O derivation the collection syncs call
// at every upsert, so `plex_collections.created_by` / `books_collections.created_by` are RECOMPUTED
// each run and rebuild with the rest of the derived-cache row (the classifyCollectionType idiom).
//
// DOCTRINE (CLAUDE.md hard rule 4 / owner R1): the mirror stays a MIRROR. Provenance is READ from
// what the source itself exposes, never invented:
//   • Movies/TV — Kometa LABELS its managed Plex collections (verified live on the HOps server
//     2026-07-16: 123/124 sampled collections carry the `Kometa` label; one hand-made collection
//     carries none). A collection labelled `Kometa` ⇒ 'kometa'; an unlabelled one ⇒ 'plex' (the
//     source app, hand-made). The secondary labels the estate also carries ("Universe Collections",
//     "TMDb Collections", awards groupings) are CATEGORY labels, not builder identity — so 'kometa'
//     is the honest software tag; we do NOT invent a per-builder tag the label does not encode.
//   • Books — Libretto (the "Kometa for books" collection manager) plants a provenance MARKER
//     `[libretto:<recipeId>]` in the collection description it writes (Kavita: the collection /
//     reading-list `summary`; ABS: the collection `description` — verified in the Libretto target
//     source). A marker present ⇒ 'libretto'; absent ⇒ the source app that hand-made it ('kavita' /
//     'audiobookshelf'). The marker carries the recipeId but NOT the builder.type, so 'libretto' is
//     the honest software tag; the finer builder identity ("Hardcover Series" / "NY Times") needs
//     the Libretto /api/recipes recipeId→builder.type join — deferred (a new sync dependency; see
//     DESIGN-038 open question).
//
// created_by is an OPEN text column, deliberately unconstrained (unlike the closed owner-ruled
// collection_type enum): the vocabulary belongs to external software the app does not own (a new
// Kometa label, a future Libretto builder), so an unknown token displays as its title-cased raw
// form rather than being rejected.
import type { BooksSource } from '@hnet/db';

/** Bump when the derivation below changes — the next collections-sync re-derives the estate. */
export const COLLECTION_PROVENANCE_VERSION = 1;

/** The Plex collection LABEL Kometa stamps on everything it manages (verified live, HOps server). */
export const KOMETA_LABEL = 'Kometa';

// The Libretto provenance marker embedded in a produced collection's description. Group 1 is the
// recipeId (provenance). Group 2 is an OPTIONAL free-form `cat=<Category>` token (DESIGN-038 D-12) a
// FUTURE Libretto may emit to carry the owner category through the description — mirror-pure, the
// books analog of a Kometa label. The suffix is optional so today's markers (`[libretto:<id>]`) match
// unchanged; when it is present the app reads the category off the same description read (no new I/O).
const LIBRETTO_MARKER_RE = /\[libretto:([a-z0-9][a-z0-9_-]*)(?:\|cat=([^\]]+))?\]/i;

/** The recipeId Libretto embedded, or undefined when the description carries no marker. */
export function librettoRecipeIdFromDescription(
  description: string | null | undefined,
): string | undefined {
  if (!description) return undefined;
  return LIBRETTO_MARKER_RE.exec(description)?.[1];
}

/**
 * DESIGN-038 D-12 — the OPEN, free-form CATEGORY a Libretto marker MAY carry in its `cat=` token
 * (`[libretto:<recipeId>|cat=Series]`), or null when the description carries no marker or no `cat=`.
 * This is the FORWARD-COMPATIBLE L1 derive: live descriptions carry no `cat=` yet, so it returns null
 * for every row today. When it returns non-null the sync writer lets it WIN over any prior value (the
 * source is authoritative — mirror doctrine); when it returns null the writer PRESERVES the prior
 * value, so the ratified L2 agent-set category on `books_collections` survives every re-sync. Pure,
 * no I/O. The returned string keeps its display case, trimmed of surrounding whitespace.
 */
export function deriveBooksCollectionCategory(
  description: string | null | undefined,
): string | null {
  if (!description) return null;
  const raw = LIBRETTO_MARKER_RE.exec(description)?.[2];
  if (raw === undefined) return null;
  const trimmed = raw.trim().replace(/\s+/g, ' ');
  return trimmed === '' ? null : trimmed;
}

/**
 * Movies/TV provenance from a mirrored Plex collection's LABELS: 'kometa' when Kometa's label is
 * present (case-insensitive), else 'plex' (hand-made). `labels === null` means the label read did
 * not run/failed — provenance is UNKNOWN and returns null so a transient read failure never
 * misfiles a Kometa collection as hand-made (the writer preserves the prior value on null).
 */
export function derivePlexCollectionProvenance(labels: readonly string[] | null): string | null {
  if (labels === null) return null;
  const hasKometa = labels.some((l) => l.trim().toLowerCase() === KOMETA_LABEL.toLowerCase());
  return hasKometa ? 'kometa' : 'plex';
}

/**
 * Books provenance from a mirrored collection's source + description: 'libretto' when the Libretto
 * marker is present, else the source app that hand-made it ('kavita' / 'audiobookshelf'). The
 * description is always available on the mirror read (no extra dependency), so this never returns
 * null — an absent/blank description simply carries no marker.
 */
export function deriveBooksCollectionProvenance(
  source: BooksSource,
  description: string | null | undefined,
): string {
  return librettoRecipeIdFromDescription(description) !== undefined ? 'libretto' : source;
}

/**
 * The badge display name for a stored `created_by` token. Data-driven: KNOWN software tokens map to
 * their proper-cased name; an unknown token (a new source-exposed label/builder) displays as its
 * title-cased raw form (owner directive — "unknown builder types display as the raw type").
 */
export const PROVENANCE_DISPLAY: Readonly<Record<string, string>> = {
  kometa: 'Kometa',
  plex: 'Plex',
  libretto: 'Libretto',
  kavita: 'Kavita',
  audiobookshelf: 'Audiobookshelf',
};

/**
 * The FUTURE builder-level display map (Libretto recipe builder.type → name). Data-driven and ready
 * for the deferred recipeId→builder join; unused in v1 (provenance is software-level), kept so the
 * mapping lives in one place when the join lands.
 */
export const BUILDER_DISPLAY: Readonly<Record<string, string>> = {
  hardcover_series: 'Hardcover Series',
  nyt: 'NY Times',
  static_ids: 'Static List',
};

/** Title-case a raw token ('imdb_builder' → 'Imdb Builder') for the unknown-token fallback. */
function titleCase(token: string): string {
  return token
    .split(/[\s_-]+/)
    .filter((w) => w.length > 0)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Resolve a stored `created_by` token to its badge label. null/blank ⇒ null (no badge — provenance
 * unknown). A known token uses its proper name; an unknown token is title-cased honestly.
 */
export function provenanceDisplayName(token: string | null | undefined): string | null {
  if (!token) return null;
  const key = token.trim().toLowerCase();
  if (key === '') return null;
  return PROVENANCE_DISPLAY[key] ?? BUILDER_DISPLAY[key] ?? titleCase(token.trim());
}
