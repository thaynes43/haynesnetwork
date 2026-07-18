// ADR-072 / DESIGN-042 D-02/D-07/D-09/D-10 (PLAN-052 PR4b) — the Kometa (Movies/TV) collections
// orchestrator: the confined write PATH that fronts @hnet/haynesops for the tRPC layer. The write surface
// (open PR / merge PR) is import-confined to packages/domain, so packages/api reaches haynes-ops ONLY
// through these functions (the ADR-055 discipline). It is the mirror-only doctrine's write loop (ADR-064):
// the app compiles a Kometa RECIPE into the app-owned managed include, opens a bot-authored haynes-ops PR,
// and — for the safe case — AUTO-MERGES it; Flux applies it, the next Kometa run produces the Plex
// collection, and the existing collections-sync mirrors it back with `provenance: kometa`. The app NEVER
// writes a Plex collection.
//
// Auto-merge (D-10) fires only when ALL FOUR conditions hold: within-cap (the assert passed AND not an
// over-cap materialization), grouping-only (find-missing OFF), the PR diff touches ONLY the app-owned
// managed include, and the `--validate-file` CI gate is green. Anything else leaves the PR for a human.
import { and, eq } from 'drizzle-orm';
import {
  permissionAudit,
  plexCollections,
  plexLibraries,
  type DbClient,
  type PlexMediaType,
} from '@hnet/db';
import { HaynesopsUnreachableError } from '@hnet/haynesops';
import { inTransaction, resolveDb } from './db-client';
import { assertWithinCollectionSizeCap } from './collection-size-cap';
import {
  compileManagedFile,
  managedFileName,
  parseManagedFile,
  validateKometaRef,
  type KometaMediaType,
  type KometaRecipe,
} from './kometa-compiler';
import type { HaynesopsClientBundle } from './haynesops-clients';

export type { KometaMediaType, KometaRecipe } from './kometa-compiler';

/** movies → the Plex `movie` section; tv → the `show` section (the mirror read scope). */
const MEDIA_SECTION: Record<KometaMediaType, PlexMediaType> = { movies: 'movie', tv: 'show' };
const KOMETA_PROVENANCE = 'kometa';

/** The state a managed recipe resolves to across the async config→run→mirror gap (DESIGN-042 D-07). */
export type KometaRecipeState = 'live' | 'pending_run';

export interface KometaRecipeView extends KometaRecipe {
  /** `live` once its produced collection appears in the mirror; else `pending_run` (merged, awaiting Kometa). */
  state: KometaRecipeState;
}

/** A produced Kometa collection as the mirror sees it (DESIGN-035 read path; unchanged). */
export interface KometaProducedCollection {
  title: string;
  /** RAW Plex member count — diagnostics only (the walls show the access-gated ledger count). */
  childCount: number;
}

/** An app-authored PR still awaiting a HUMAN merge (over-cap materialize / find-missing enable — D-10). */
export interface KometaPendingPr {
  number: number;
  title: string;
  url: string;
}

export interface KometaCollectionsOverview {
  /** False when haynes-ops (GitHub) could not be reached — the surface renders the honest degrade. */
  reachable: boolean;
  mediaType: KometaMediaType;
  /** The merged managed recipes (source of truth: the app-owned include on the base branch). */
  recipes: KometaRecipeView[];
  /** The produced collections the mirror already carries (provenance kometa). */
  collections: KometaProducedCollection[];
  /** Open app-authored PRs a human still has to merge (awaiting-merge rows). */
  pendingPrs: KometaPendingPr[];
}

const EMPTY_UNREACHABLE = (mediaType: KometaMediaType): KometaCollectionsOverview => ({
  reachable: false,
  mediaType,
  recipes: [],
  collections: [],
  pendingPrs: [],
});

/** Normalize a title for the recipe ↔ produced-collection reconcile (trim + collapse ws + casefold). */
function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** The repo-relative path of the app-owned managed include for a media type. */
function managedPath(haynesops: HaynesopsClientBundle, mediaType: KometaMediaType): string {
  return `${haynesops.configDir}/${managedFileName(mediaType)}`;
}

/** Read the produced Kometa collections the mirror carries for a media type (the DESIGN-035 read). */
async function readProducedCollections(
  db: DbClient | undefined,
  mediaType: KometaMediaType,
): Promise<KometaProducedCollection[]> {
  const rows = await resolveDb(db)
    .select({ title: plexCollections.title, childCount: plexCollections.childCount })
    .from(plexCollections)
    .innerJoin(plexLibraries, eq(plexCollections.plexLibraryId, plexLibraries.id))
    .where(
      and(
        eq(plexLibraries.mediaType, MEDIA_SECTION[mediaType]),
        eq(plexCollections.createdBy, KOMETA_PROVENANCE),
      ),
    );
  return rows.map((r) => ({ title: r.title, childCount: r.childCount }));
}

/**
 * DESIGN-042 D-02/D-07 — the per-media-type monitor: the merged managed recipes (read back from the
 * app-owned include), each reconciled to `live`/`pending_run` against the mirror, plus the produced
 * collections and the open app-authored PRs still awaiting a human merge. A HaynesopsUnreachableError
 * degrades to `reachable: false` (empty) — the Movies/TV surface stays up; any other error rethrows.
 */
export async function getKometaCollectionsOverview(input: {
  db?: DbClient;
  haynesops: HaynesopsClientBundle;
  mediaType: KometaMediaType;
}): Promise<KometaCollectionsOverview> {
  try {
    const file = await input.haynesops.read.getFile(
      managedPath(input.haynesops, input.mediaType),
      input.haynesops.baseBranch,
    );
    const recipes = parseManagedFile(file?.text).filter((r) => r.mediaType === input.mediaType);
    const produced = await readProducedCollections(input.db, input.mediaType);
    const producedTitles = new Set(produced.map((c) => normalizeTitle(c.title)));
    const openPrs = await input.haynesops.read.listOpenManagedPrs();
    return {
      reachable: true,
      mediaType: input.mediaType,
      recipes: recipes.map((r) => ({
        ...r,
        state: producedTitles.has(normalizeTitle(r.name)) ? 'live' : 'pending_run',
      })),
      collections: produced,
      pendingPrs: openPrs.map((p) => ({ number: p.number, title: p.title, url: p.url })),
    };
  } catch (error) {
    if (error instanceof HaynesopsUnreachableError) return EMPTY_UNREACHABLE(input.mediaType);
    throw error;
  }
}

// ── The auto-merge policy (D-10, pure) ─────────────────────────────────────────────────────────────────

export interface KometaAutoMergeInputs {
  /** The size cap assert passed for this write (a non-admin over-cap add never reaches here). */
  capAsserted: boolean;
  /** True for the over-cap ticket materialization path — NEVER auto-merged. */
  isMaterialization: boolean;
  /** The acquisition lever — find-missing ON is NEVER auto-merged (the storage blast radius). */
  findMissing: boolean;
  /** True only when the PR diff touches ONLY the app-owned managed include. */
  managedFileOnly: boolean;
  /** The `--validate-file` CI gate conclusion for the PR head. */
  checksGreen: boolean;
}

export interface KometaAutoMergeDecision {
  autoMerge: boolean;
  /** Why auto-merge was withheld (the PR is left for a human) — null when autoMerge is true. */
  reason: string | null;
}

/**
 * DESIGN-042 D-10 — the app AUTO-MERGES a haynes-ops config PR only when ALL FOUR conditions hold; any one
 * failing leaves the PR for a human. Pure so the condition matrix is exhaustively testable.
 */
export function evaluateKometaAutoMerge(input: KometaAutoMergeInputs): KometaAutoMergeDecision {
  if (!input.capAsserted) return { autoMerge: false, reason: 'over the size cap' };
  if (input.isMaterialization) return { autoMerge: false, reason: 'over-cap materialization (human-merged)' };
  if (input.findMissing) return { autoMerge: false, reason: 'find-missing enabled (human-merged)' };
  if (!input.managedFileOnly) return { autoMerge: false, reason: 'PR touches files outside the managed include' };
  if (!input.checksGreen) return { autoMerge: false, reason: 'validation gate not green' };
  return { autoMerge: true, reason: null };
}

// ── The write flow (D-07) ──────────────────────────────────────────────────────────────────────────────

/** A branch slug that is unique per write (a collision is a real, visible HaynesopsHttpError). */
function branchSlug(mediaType: KometaMediaType, recipeId: string, suffix: string): string {
  return `${mediaType}-${recipeId}-${suffix}`
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

const upsertAuditDetail = (recipe: KometaRecipe, extra?: Record<string, unknown>) => ({
  recipe_id: recipe.id,
  provider: 'kometa' as const,
  media_type: recipe.mediaType,
  name: recipe.name,
  builder_type: recipe.builderType,
  builder_ref: recipe.builderRef,
  ...(extra ?? {}),
});

export interface KometaWriteResult {
  prNumber: number;
  prUrl: string;
  /** True when the app auto-merged (all four D-10 conditions held); false when left for a human. */
  merged: boolean;
  /** When not merged, why (the honest "awaiting merge" reason surfaced on the row); null when merged. */
  autoMergeBlockedReason: string | null;
}

/** Compile the new managed-include content for a recipe set (existing on base + one upserted recipe). */
function recompileWith(
  existing: KometaRecipe[],
  upserted: KometaRecipe,
  mediaType: KometaMediaType,
): string {
  const next = existing.filter((r) => r.id !== upserted.id);
  next.push(upserted);
  return compileManagedFile({ mediaType, recipes: next });
}

interface KometaWriteContext {
  db?: DbClient;
  haynesops: HaynesopsClientBundle;
  actorId: string;
  recipe: KometaRecipe;
  mediaType: KometaMediaType;
  /** Injectable unique branch suffix (tests pass a fixed value). */
  branchSuffix?: string;
  /** Injectable check-poll knobs (tests pass 1 attempt / a fake sleep). */
  checkPoll?: { attempts?: number; intervalMs?: number; sleepImpl?: (ms: number) => Promise<void> };
}

/**
 * The shared open-PR → maybe-auto-merge → audit flow. `isMaterialization` forces the human-merge path
 * (D-07 case 3). The audit row is co-written in the SAME tx as the write's completion (hard rule 6); the
 * external PR opens BEFORE the audit (crash-safe: a crash before the audit leaves an open PR a human can see).
 */
async function openAndMaybeAutoMerge(
  ctx: KometaWriteContext,
  content: string,
  opts: { isMaterialization: boolean; title: string; body: string; auditAction: 'upsert_collection' },
): Promise<KometaWriteResult> {
  const path = managedPath(ctx.haynesops, ctx.mediaType);
  const suffix = ctx.branchSuffix ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const pr = await ctx.haynesops.write.openManagedFilePr({
    path,
    content,
    branchSlug: branchSlug(ctx.mediaType, ctx.recipe.id, suffix),
    title: opts.title,
    body: opts.body,
  });

  let merged = false;
  let reason: string | null = 'awaiting merge';
  // Auto-merge is off for the materialization + find-missing paths without any GitHub round-trips.
  const eligible = !opts.isMaterialization && !ctx.recipe.findMissing;
  if (eligible) {
    const files = await ctx.haynesops.write.getPrFilePaths(pr.number);
    const managedFileOnly = files.length > 0 && files.every((f) => f === path);
    const conclusion = await ctx.haynesops.write.waitForChecks(pr.headSha, ctx.checkPoll);
    const decision = evaluateKometaAutoMerge({
      capAsserted: true,
      isMaterialization: false,
      findMissing: ctx.recipe.findMissing,
      managedFileOnly,
      checksGreen: conclusion === 'success',
    });
    if (decision.autoMerge) {
      await ctx.haynesops.write.squashMergePr(pr.number, opts.title);
      merged = true;
      reason = null;
    } else {
      reason = decision.reason;
    }
  } else {
    reason = opts.isMaterialization ? 'over-cap materialization (human-merged)' : 'find-missing enabled (human-merged)';
  }

  await inTransaction(ctx.db, async (tx) => {
    await tx.insert(permissionAudit).values({
      actorId: ctx.actorId,
      action: opts.auditAction,
      detail: upsertAuditDetail(ctx.recipe, {
        pr_number: pr.number,
        pr_url: pr.url,
        merged,
        materialization: opts.isMaterialization,
      }),
    });
  });

  return { prNumber: pr.number, prUrl: pr.url, merged, autoMergeBlockedReason: reason };
}

/**
 * DESIGN-042 D-07 — the DIRECT add/edit writer for Kometa. Validates the builder + ref (compiler), asserts
 * the size cap (admins bypass; a null resolved size for a non-admin means the app cannot PROVE within-cap,
 * so the assert is fed the cap+1 → the client routes to the over-cap ticket), reads the current managed
 * include back, recompiles with the recipe, opens a bot PR, and AUTO-MERGES when D-10 holds (grouping-only,
 * managed-file-only, CI green). Acquisition is forced OFF here (find-missing is the PR4c human-merged edit).
 */
export async function upsertKometaCollection(input: {
  db?: DbClient;
  haynesops: HaynesopsClientBundle;
  actorId: string;
  recipe: KometaRecipe;
  /** The resolved membership size (id-list length), or null when unresolvable without egress. */
  size: number | null;
  cap: number;
  isAdmin: boolean;
  branchSuffix?: string;
  checkPoll?: KometaWriteContext['checkPoll'];
}): Promise<KometaWriteResult> {
  validateKometaRef(input.recipe.builderType, input.recipe.builderRef);
  // A non-admin with an unresolvable size cannot be proven within-cap → treat as cap+1 (over-cap ticket).
  const effectiveSize = input.size ?? (input.isAdmin ? 0 : input.cap + 1);
  assertWithinCollectionSizeCap({ size: effectiveSize, cap: input.cap, isAdmin: input.isAdmin });

  const recipe: KometaRecipe = { ...input.recipe, findMissing: false };
  const file = await input.haynesops.read.getFile(
    managedPath(input.haynesops, recipe.mediaType),
    input.haynesops.baseBranch,
  );
  const existing = parseManagedFile(file?.text);
  const content = recompileWith(existing, recipe, recipe.mediaType);
  return openAndMaybeAutoMerge(
    {
      db: input.db,
      haynesops: input.haynesops,
      actorId: input.actorId,
      recipe,
      mediaType: recipe.mediaType,
      ...(input.branchSuffix ? { branchSuffix: input.branchSuffix } : {}),
      ...(input.checkPoll ? { checkPoll: input.checkPoll } : {}),
    },
    content,
    {
      isMaterialization: false,
      title: `collections(kometa): add ${recipe.name}`,
      body: kometaPrBody(recipe, { materialization: false }),
      auditAction: 'upsert_collection',
    },
  );
}

/**
 * DESIGN-042 D-07 case 3 — MATERIALIZE a Kometa recipe UNBOUNDED from an approved over-cap ticket. Same
 * confined path as a direct add, cap-bypassed, but the PR is HUMAN-merged (never auto-merged — D-10). The
 * caller (approveCollectionOverride) records the ticket completion + audit in its own same-tx transition.
 */
export async function materializeKometaCollection(input: {
  db?: DbClient;
  haynesops: HaynesopsClientBundle;
  actorId: string;
  recipe: KometaRecipe;
  branchSuffix?: string;
}): Promise<KometaWriteResult> {
  validateKometaRef(input.recipe.builderType, input.recipe.builderRef);
  const recipe: KometaRecipe = { ...input.recipe, findMissing: false };
  const file = await input.haynesops.read.getFile(
    managedPath(input.haynesops, recipe.mediaType),
    input.haynesops.baseBranch,
  );
  const existing = parseManagedFile(file?.text);
  const content = recompileWith(existing, recipe, recipe.mediaType);
  return openAndMaybeAutoMerge(
    {
      db: input.db,
      haynesops: input.haynesops,
      actorId: input.actorId,
      recipe,
      mediaType: recipe.mediaType,
      ...(input.branchSuffix ? { branchSuffix: input.branchSuffix } : {}),
    },
    content,
    {
      isMaterialization: true,
      title: `collections(kometa): materialize ${recipe.name}`,
      body: kometaPrBody(recipe, { materialization: true }),
      auditAction: 'upsert_collection',
    },
  );
}

/**
 * DESIGN-042 D-03 — DELETE a managed Kometa recipe (ADMIN only; the API gates the caller). Recompiles the
 * managed include WITHOUT the recipe and opens a PR. Removing a recipe ORPHANS its produced Plex collection
 * (the collection survives; the recipe stops managing it — the mirror still shows it until Kometa's next
 * run reconciles). A managed-file-only, grouping-only diff auto-merges when the CI gate is green (D-10).
 * `deleteCollection: true` is recorded for audit but Kometa orphan-vs-hard-delete semantics are UNVERIFIED
 * (D-03) — a hard target delete is not wired in v1; the recipe removal is the honest operation.
 */
export async function deleteKometaRecipe(input: {
  db?: DbClient;
  haynesops: HaynesopsClientBundle;
  actorId: string;
  id: string;
  mediaType: KometaMediaType;
  deleteCollection?: boolean;
  branchSuffix?: string;
  checkPoll?: KometaWriteContext['checkPoll'];
}): Promise<KometaWriteResult> {
  const path = managedPath(input.haynesops, input.mediaType);
  const file = await input.haynesops.read.getFile(path, input.haynesops.baseBranch);
  const existing = parseManagedFile(file?.text);
  const removed = existing.find((r) => r.id === input.id && r.mediaType === input.mediaType);
  const next = existing.filter((r) => !(r.id === input.id && r.mediaType === input.mediaType));
  const content = compileManagedFile({ mediaType: input.mediaType, recipes: next });
  // A deletion carries no cap/acquisition — treat as a grouping-only, within-cap managed-file write.
  const recipe: KometaRecipe = removed ?? {
    id: input.id,
    name: input.id,
    mediaType: input.mediaType,
    builderType: 'imdb_list',
    builderRef: 'https://www.imdb.com/list/ls000000000/',
    findMissing: false,
  };
  return openAndMaybeAutoMerge(
    {
      db: input.db,
      haynesops: input.haynesops,
      actorId: input.actorId,
      recipe: { ...recipe, findMissing: false },
      mediaType: input.mediaType,
      ...(input.branchSuffix ? { branchSuffix: input.branchSuffix } : {}),
      ...(input.checkPoll ? { checkPoll: input.checkPoll } : {}),
    },
    content,
    {
      isMaterialization: false,
      title: `collections(kometa): remove ${recipe.name}`,
      body: [
        `Remove the app-managed Kometa collection **${recipe.name}** from the managed include.`,
        ``,
        `The produced Plex collection is orphaned (it survives; the recipe stops managing it).`,
        input.deleteCollection ? `Requester asked to also delete the collection (orphan-only in v1).` : ``,
      ]
        .filter(Boolean)
        .join('\n'),
      auditAction: 'upsert_collection',
    },
  ).then((res) => ({ ...res }));
}

/** The bot PR body — the audit-trail prose (the collection + its builder + the auto-merge intent). */
function kometaPrBody(recipe: KometaRecipe, opts: { materialization: boolean }): string {
  const { normalizedRef } = validateKometaRef(recipe.builderType, recipe.builderRef);
  return [
    `App-authored Kometa collection from the /collections page (ADR-072 / DESIGN-042).`,
    ``,
    `- Collection: ${recipe.name}`,
    `- Library: ${recipe.mediaType === 'movies' ? 'HOps Movies' : 'HOps TV Shows'}`,
    `- Builder: ${recipe.builderType} (${normalizedRef})`,
    `- Find missing (acquisition): ${recipe.findMissing ? 'ON' : 'off'}`,
    ``,
    opts.materialization
      ? `Over-cap materialization — this PR is HUMAN-merged (auto-merge withheld, DESIGN-042 D-10).`
      : recipe.findMissing
        ? `Find-missing enable — this PR is HUMAN-merged (auto-merge withheld, DESIGN-042 D-10).`
        : `Within-cap, grouping-only — eligible for auto-merge after the validation gate is green (D-10).`,
  ].join('\n');
}
