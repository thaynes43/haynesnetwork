// ADR-072 / DESIGN-042 D-01/D-04 (owner ruling 2026-07-18 evening) — the READ + SURGICAL-EDIT layer for the
// estate's HAND-AUTHORED Kometa collection files (movies-*.yml / shows-*.yml), the counterpart to the
// app-owned managed include (kometa-compiler.ts).
//
// The owner ruling supersedes the #414 read-only stance: the Movies/TV Collections tabs must EDIT the
// estate's existing Kometa collections, not merely list them. This module is PURE (no I/O): it parses a
// hand-authored config file into its collections (name, builder, editability) and produces a byte-faithful
// SURGICAL SPLICE that changes ONLY one collection's builder ref (or its find-missing keys), leaving every
// other byte of the file — comments, anchors, sibling collections, template blocks, blank lines — identical.
//
// Round-trip fidelity is the hard requirement (owner ruling). A YAML load→dump cannot preserve comments /
// flow-map formatting / the estate's hand layout, so this operates at the TEXT level: it locates the exact
// line(s) of the edited collection block and rewrites only the builder value token (or inserts/edits the
// `<arr>_add_missing`/`_search` keys). Everything outside the touched line(s) is carried through verbatim.
//
// Editability honesty (D-04): a collection is editable here ONLY when it reduces to exactly ONE builder in
// the six-type allowlist with a ref that `validateKometaRef` canonicalizes. Anything else (a query/search/
// regex engine like tmdb_discover/imdb_search/plex_all, a multi-builder block, a ref we cannot model) is
// listed but its Edit is disabled — the app never does a lossy rewrite of config it does not fully model.
import type { KometaBuilderType } from '@hnet/db';
import { NotFoundError } from './errors';
import {
  KometaRecipeError,
  validateKometaRef,
  type KometaMediaType,
} from './kometa-compiler';

/** The short, owner-tone reason an Edit is disabled (no em-dashes, no names — MEMORY copy rule). */
export const HAND_UNEDITABLE_REASON = 'Too custom to edit here. Edit the config directly.';

/** A parsed hand-authored Kometa collection (one entry under a config file's `collections:` block). */
export interface KometaHandCollection {
  /** The exact YAML key (the Plex collection title) — the splice locator + the mirror-join key. */
  name: string;
  /** The config file basename this collection lives in (e.g. `movies-franchises.yml`). */
  file: string;
  mediaType: KometaMediaType;
  /** The allowlisted builder type when the block reduces to one recognizable ref; else null. */
  builderType: KometaBuilderType | null;
  /** The canonical ref when recognizable (an id, an id-list, or a normalized URL); else null. */
  builderRef: string | null;
  /** Whether the block's find-missing (acquisition) resolves ON (explicit key, template, or global default). */
  findMissing: boolean;
  /** True when the app can safely splice this collection's ref (single allowlisted builder + valid ref). */
  editable: boolean;
  /** Why Edit is disabled (the tooltip copy) when `editable` is false; null when editable. */
  editableReason: string | null;
}

// ── The Kometa builder attribute vocabulary ──────────────────────────────────────────────────────────────
// The six member-editable builders (D-04). `collection` is the TEMPLATE ALIAS the estate's franchise
// templates map onto `tmdb_collection_details` (`tmdb_collection_details: <<collection>>`), so a block that
// carries `collection: <id>` is an editable TMDb-collection recipe.
const EDITABLE_ATTR_TO_TYPE: Readonly<Record<string, KometaBuilderType>> = {
  imdb_list: 'imdb_list',
  tmdb_collection_details: 'tmdb_collection_details',
  collection: 'tmdb_collection_details',
  tvdb_list_details: 'tvdb_list_details',
  tmdb_movie: 'tmdb_movie',
  tmdb_show: 'tmdb_show',
  tvdb_show: 'tvdb_show',
};

// The FULL builder vocabulary the parser recognizes as "this key is a builder" — the editable six plus the
// owner-only query/search/regex engines and the auth-gated list builders. A block carrying any NON-editable
// builder (or more than one builder of any kind) is listed but not app-editable (D-04 honesty).
const KNOWN_BUILDER_ATTRS: ReadonlySet<string> = new Set<string>([
  ...Object.keys(EDITABLE_ATTR_TO_TYPE),
  // owner-only query/search/regex engines (never a single ref)
  'tmdb_discover',
  'tmdb_popular',
  'tmdb_now_playing',
  'tmdb_trending',
  'tmdb_top_rated',
  'tmdb_upcoming',
  'imdb_chart',
  'imdb_search',
  'plex_all',
  'plex_search',
  'plex_collectionless',
  // auth-gated / list builders the app does not model as a single validated ref
  'tmdb_list',
  'tvdb_list',
  'trakt_list',
  'trakt_chart',
  'trakt_list_details',
  'trakt_trending',
  'trakt_popular',
  'trakt_recommended',
  'mdblist_list',
  'letterboxd_list',
  'mal_search',
  'anilist_search',
]);

/** The *arr key prefix a media type acquires through (drives the find-missing keys). */
function arrPrefix(mediaType: KometaMediaType): 'radarr' | 'sonarr' {
  return mediaType === 'movies' ? 'radarr' : 'sonarr';
}

/** Strip surrounding YAML double quotes (and unescape) from a scalar value token. */
function unquote(raw: string): string {
  const s = raw.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return s;
}

/** Format a canonical ref back into the value token the hand files use (id-lists quoted, else bare). */
function formatRefValue(builderType: KometaBuilderType, normalizedRef: string): string {
  if (builderType === 'tmdb_movie' || builderType === 'tmdb_show' || builderType === 'tvdb_show') {
    return `"${normalizedRef}"`;
  }
  return normalizedRef;
}

// ── Block location ───────────────────────────────────────────────────────────────────────────────────────

interface BlockSpan {
  /** Index of the collection header line (`  <name>:`). */
  start: number;
  /** Exclusive end index (the next collection header / top-level key / EOF). */
  end: number;
}

/** Match a top-level (column-0) key line (`collections:`, `templates:`). */
function isTopLevelKey(line: string): boolean {
  return /^[^\s#].*:\s*(?:#.*)?$/.test(line) || /^[^\s#][^:]*:\s/.test(line);
}

/** The `[start,end)` line span of the file's `collections:` block (or null when there is none). */
function collectionsBlockRange(lines: string[]): { first: number; end: number } | null {
  const idx = lines.findIndex((l) => /^collections:\s*(?:#.*)?$/.test(l));
  if (idx === -1) return null;
  let end = lines.length;
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length > 0 && !/^\s/.test(line) && isTopLevelKey(line)) {
      end = i;
      break;
    }
  }
  return { first: idx + 1, end };
}

/** Is this a 2-space-indented collection header line? Returns the key when so, else null. */
function collectionHeaderName(line: string): string | null {
  // Exactly two leading spaces, then a non-space non-# char (a 4-indent child has a space at col 2).
  const m = /^ {2}([^\s#][^:]*?):\s*(?:#.*)?$/.exec(line);
  return m ? m[1]! : null;
}

/** Enumerate the collection header spans in the file (skips comments + commented-out entries). */
function collectionSpans(lines: string[]): Array<{ name: string } & BlockSpan> {
  const range = collectionsBlockRange(lines);
  if (!range) return [];
  const headers: Array<{ name: string; start: number }> = [];
  for (let i = range.first; i < range.end; i++) {
    const name = collectionHeaderName(lines[i]!);
    if (name !== null) headers.push({ name, start: i });
  }
  return headers.map((h, k) => ({
    name: h.name,
    start: h.start,
    end: k + 1 < headers.length ? headers[k + 1]!.start : range.end,
  }));
}

/** Locate one collection's block by its exact name (throws NotFound so a splice never fabricates). */
function findBlock(lines: string[], name: string): BlockSpan {
  const span = collectionSpans(lines).find((s) => s.name === name);
  if (!span) throw new NotFoundError(`Kometa collection "${name}" not found in the config file`);
  return { start: span.start, end: span.end };
}

// ── Builder detection within a block ─────────────────────────────────────────────────────────────────────

interface BuilderOccurrence {
  attr: string;
  rawValue: string;
  /** The absolute line index of the builder token (direct child, or the `template:` line). */
  lineIndex: number;
  form: 'direct' | 'template';
  /** For a direct builder whose ref is a YAML block list (`tmdb_show:` then `- id` items): the item span. */
  block?: { start: number; end: number };
}

/** Pull `key: value` builder pairs out of an inline flow map body (`name: X, collection: 141282`). */
function scanTemplateInner(inner: string): Array<{ attr: string; rawValue: string }> {
  const out: Array<{ attr: string; rawValue: string }> = [];
  const re = /([A-Za-z_][\w]*):\s*("(?:[^"\\]|\\.)*"|[^,}]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner)) !== null) {
    const attr = m[1]!;
    if (KNOWN_BUILDER_ATTRS.has(attr)) out.push({ attr, rawValue: m[2]!.trim() });
  }
  return out;
}

/** Every builder occurrence in a block (direct 4-space children + inline-template map keys). */
function detectBuilders(lines: string[], span: BlockSpan): BuilderOccurrence[] {
  const out: BuilderOccurrence[] = [];
  for (let i = span.start; i < span.end; i++) {
    const line = lines[i]!;
    const tmpl = /^ {4}template:\s*\{(.*)\}\s*$/.exec(line);
    if (tmpl) {
      for (const b of scanTemplateInner(tmpl[1]!)) {
        out.push({ attr: b.attr, rawValue: b.rawValue, lineIndex: i, form: 'template' });
      }
      continue;
    }
    const direct = /^ {4}([A-Za-z_][\w]*):\s*(.*)$/.exec(line);
    if (direct && KNOWN_BUILDER_ATTRS.has(direct[1]!)) {
      const inlineVal = direct[2]!.trim();
      if (inlineVal === '') {
        // A block-list ref: `    tmdb_show:` followed by `      - <id>` items (6-space list).
        const ids: string[] = [];
        let j = i + 1;
        for (; j < span.end; j++) {
          const item = /^ {6}-\s*([^\s#]+)\s*(?:#.*)?$/.exec(lines[j]!);
          if (!item) break;
          ids.push(item[1]!);
        }
        out.push({
          attr: direct[1]!,
          rawValue: ids.join(','),
          lineIndex: i,
          form: 'direct',
          block: { start: i + 1, end: j },
        });
      } else {
        out.push({ attr: direct[1]!, rawValue: inlineVal, lineIndex: i, form: 'direct' });
      }
    }
  }
  return out;
}

// ── find-missing resolution (explicit key > referenced template > global default ON) ─────────────────────

/** Parse each template's explicit `<arr>_add_missing` value (self-contained per file). */
function templateAddMissing(lines: string[], arr: 'radarr' | 'sonarr'): Map<string, boolean> {
  const out = new Map<string, boolean>();
  const tIdx = lines.findIndex((l) => /^templates:\s*(?:#.*)?$/.test(l));
  if (tIdx === -1) return out;
  let end = lines.length;
  for (let i = tIdx + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length > 0 && !/^\s/.test(line) && isTopLevelKey(line)) {
      end = i;
      break;
    }
  }
  const names: Array<{ name: string; start: number }> = [];
  for (let i = tIdx + 1; i < end; i++) {
    const name = collectionHeaderName(lines[i]!);
    if (name !== null) names.push({ name, start: i });
  }
  names.forEach((n, k) => {
    const nEnd = k + 1 < names.length ? names[k + 1]!.start : end;
    for (let i = n.start; i < nEnd; i++) {
      const m = new RegExp(`^ {4}${arr}_add_missing:\\s*(true|false)\\b`).exec(lines[i]!);
      if (m) out.set(n.name, m[1] === 'true');
    }
  });
  return out;
}

/** The template name a block references via `template: {name: X ...}` (or a direct `template: X`), if any. */
function referencedTemplateName(lines: string[], span: BlockSpan): string | null {
  for (let i = span.start; i < span.end; i++) {
    const flow = /^ {4}template:\s*\{(.*)\}\s*$/.exec(lines[i]!);
    if (flow) {
      const nm = /(?:^|,)\s*name:\s*("?)([^",}]+)\1/.exec(flow[1]!);
      if (nm) return nm[2]!.trim();
    }
    const scalar = /^ {4}template:\s*([^\s{].*)$/.exec(lines[i]!);
    if (scalar) return unquote(scalar[1]!.trim());
  }
  return null;
}

function resolveFindMissing(
  lines: string[],
  span: BlockSpan,
  mediaType: KometaMediaType,
  templates: Map<string, boolean>,
): boolean {
  const arr = arrPrefix(mediaType);
  for (let i = span.start; i < span.end; i++) {
    const m = new RegExp(`^ {4}${arr}_add_missing:\\s*(true|false)\\b`).exec(lines[i]!);
    if (m) return m[1] === 'true';
  }
  const tmpl = referencedTemplateName(lines, span);
  if (tmpl !== null && templates.has(tmpl)) return templates.get(tmpl)!;
  // The estate's global config.yml sets add_missing: true — an un-overridden block inherits ON.
  return true;
}

// ── Public: parse a whole hand config file ───────────────────────────────────────────────────────────────

/**
 * Parse a hand-authored Kometa config file into its collections. Each collection carries its editability
 * (a single allowlisted builder with a canonicalizable ref) and its resolved find-missing state. NEVER
 * throws on a malformed/too-custom block — it simply marks that collection non-editable (the tab must list
 * the whole estate honestly). `file` is the basename used for the surgical splice PR path.
 */
export function parseHandConfigFile(
  fileText: string | null | undefined,
  file: string,
  mediaType: KometaMediaType,
): KometaHandCollection[] {
  if (!fileText) return [];
  const lines = fileText.split('\n');
  const templates = templateAddMissing(lines, arrPrefix(mediaType));
  return collectionSpans(lines).map((span) => {
    const builders = detectBuilders(lines, span);
    const findMissing = resolveFindMissing(lines, span, mediaType, templates);
    const base = {
      name: span.name,
      file,
      mediaType,
      findMissing,
    };
    if (builders.length !== 1) {
      return { ...base, builderType: null, builderRef: null, editable: false, editableReason: HAND_UNEDITABLE_REASON };
    }
    const only = builders[0]!;
    const type = EDITABLE_ATTR_TO_TYPE[only.attr];
    if (!type) {
      return { ...base, builderType: null, builderRef: null, editable: false, editableReason: HAND_UNEDITABLE_REASON };
    }
    try {
      const { normalizedRef } = validateKometaRef(type, unquote(only.rawValue));
      return { ...base, builderType: type, builderRef: normalizedRef, editable: true, editableReason: null };
    } catch {
      return { ...base, builderType: type, builderRef: null, editable: false, editableReason: HAND_UNEDITABLE_REASON };
    }
  });
}

// ── Public: the surgical splices ─────────────────────────────────────────────────────────────────────────

/** Replace the builder value token on one line (direct scalar or inline-template map), preserving all else. */
function replaceBuilderValueOnLine(
  line: string,
  occ: BuilderOccurrence,
  formatted: string,
): string {
  if (occ.form === 'direct') {
    // `    <attr>: <value>` → keep the `    <attr>: ` prefix verbatim, swap only the value.
    return line.replace(/^(\s*[A-Za-z_][\w]*:\s*)(.*)$/, (_full, prefix: string) => `${prefix}${formatted}`);
  }
  // Inline template map: swap only this attr's value token (quoted values may contain commas).
  const re = new RegExp(`(\\b${occ.attr}:\\s*)("(?:[^"\\\\]|\\\\.)*"|[^,}]*)`);
  return line.replace(re, (_full, prefix: string) => `${prefix}${formatted}`);
}

/**
 * DESIGN-042 (owner ruling 2026-07-18) — SURGICALLY edit one hand-file collection's builder ref. Validates
 * the new ref against the collection's detected (locked) builder type, then rewrites ONLY that builder's
 * value token; every other byte of the file is preserved. Throws NotFound (unknown collection) or
 * KometaRecipeError (the collection is not app-editable, or the new ref is malformed) — never a lossy
 * rewrite. Returns the new file text.
 */
export function spliceHandCollectionRef(input: {
  fileText: string;
  name: string;
  mediaType: KometaMediaType;
  builderRef: string;
}): string {
  const lines = input.fileText.split('\n');
  const span = findBlock(lines, input.name);
  const builders = detectBuilders(lines, span);
  if (builders.length !== 1) {
    throw new KometaRecipeError(`"${input.name}" has multiple builders and cannot be edited here.`);
  }
  const only = builders[0]!;
  const type = EDITABLE_ATTR_TO_TYPE[only.attr];
  if (!type) throw new KometaRecipeError(`"${input.name}" uses a builder that cannot be edited here.`);
  const { normalizedRef } = validateKometaRef(type, input.builderRef);
  if (only.block) {
    // Replace the block-list `- <id>` items with the new set (bare ids, header line untouched).
    const items = normalizedRef.split(',').map((id) => `      - ${id}`);
    lines.splice(only.block.start, only.block.end - only.block.start, ...items);
    return lines.join('\n');
  }
  lines[only.lineIndex] = replaceBuilderValueOnLine(
    lines[only.lineIndex]!,
    only,
    formatRefValue(type, normalizedRef),
  );
  return lines.join('\n');
}

/**
 * DESIGN-042 D-06 (owner ruling 2026-07-18) — SURGICALLY set the find-missing (acquisition) keys on one
 * hand-file collection. ON writes `<arr>_add_missing: true` + `<arr>_search: true`; OFF writes
 * `<arr>_add_missing: false` and drops any `<arr>_search`. Edits existing keys in place; inserts missing
 * ones right after the collection header (4-space children). Every untouched line is preserved. Enabling is
 * the storage blast-radius lever, so its PR is always human-merged (the caller enforces that).
 */
export function spliceHandCollectionFindMissing(input: {
  fileText: string;
  name: string;
  mediaType: KometaMediaType;
  on: boolean;
}): string {
  const lines = input.fileText.split('\n');
  const span = findBlock(lines, input.name);
  const arr = arrPrefix(input.mediaType);
  const addRe = new RegExp(`^( {4}${arr}_add_missing:\\s*)(true|false)\\b(.*)$`);
  const searchRe = new RegExp(`^ {4}${arr}_search:\\s*(?:true|false)\\b`);
  // Operate on a sub-array of the block's CHILD lines (span.start is the header, kept in `head`) so an
  // insert/remove can never shift an index across the block boundary — every untouched line is preserved.
  const head = lines.slice(0, span.start + 1);
  const tail = lines.slice(span.end);
  let body = lines.slice(span.start + 1, span.end);
  const setTrue = (line: string) => line.replace(addRe, (_f, p: string, _v: string, t: string) => `${p}true${t}`);
  const setFalse = (line: string) => line.replace(addRe, (_f, p: string, _v: string, t: string) => `${p}false${t}`);
  const setSearchTrue = (line: string) =>
    line.replace(/^( {4}\w+_search:\s*)(?:true|false)\b(.*)$/, (_f, p: string, t: string) => `${p}true${t}`);

  if (input.on) {
    const addIdx = body.findIndex((l) => addRe.test(l));
    const searchIdx = body.findIndex((l) => searchRe.test(l));
    if (addIdx >= 0) body[addIdx] = setTrue(body[addIdx]!);
    if (searchIdx >= 0) body[searchIdx] = setSearchTrue(body[searchIdx]!);
    const missing: string[] = [];
    if (addIdx < 0) missing.push(`    ${arr}_add_missing: true`);
    if (searchIdx < 0) missing.push(`    ${arr}_search: true`);
    body = [...missing, ...body];
  } else {
    const searchIdx = body.findIndex((l) => searchRe.test(l));
    if (searchIdx >= 0) body.splice(searchIdx, 1);
    const addIdx = body.findIndex((l) => addRe.test(l));
    if (addIdx >= 0) body[addIdx] = setFalse(body[addIdx]!);
    else body = [`    ${arr}_add_missing: false`, ...body];
  }
  return [...head, ...body, ...tail].join('\n');
}

/**
 * SURGICALLY remove one collection block from a hand file (admin delete). Drops exactly the block's lines
 * (header through the line before the next collection / EOF) and nothing else. Orphans the produced Plex
 * collection (the existing semantics). Throws NotFound when the collection is absent.
 */
export function spliceHandCollectionRemoval(input: {
  fileText: string;
  name: string;
}): string {
  const lines = input.fileText.split('\n');
  const span = findBlock(lines, input.name);
  const result = lines.slice();
  result.splice(span.start, span.end - span.start);
  return result.join('\n');
}

/** The hand config files a media type's collections live in (the estate layout; excludes the app include). */
export function isHandConfigFile(name: string, mediaType: KometaMediaType): boolean {
  if (name === managedBasename(mediaType)) return false;
  const prefix = mediaType === 'movies' ? 'movies-' : 'shows-';
  return name.startsWith(prefix) && name.endsWith('.yml');
}

/** The app-owned managed include basename (kept here to exclude it from the hand-file scan). */
function managedBasename(mediaType: KometaMediaType): string {
  return mediaType === 'movies' ? 'hnet-managed-movies.yml' : 'hnet-managed-tv.yml';
}
