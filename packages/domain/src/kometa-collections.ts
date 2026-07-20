// ADR-072 / DESIGN-042 D-02/D-07/D-09/D-10 (PLAN-052 PR4b) — the Kometa (Movies/TV) collections
// orchestrator: the confined write PATH that fronts @hnet/haynesops for the tRPC layer. The write surface
// (open PR / merge PR) is import-confined to packages/domain, so packages/api reaches haynes-ops ONLY
// through these functions (the ADR-055 discipline). It is the mirror-only doctrine's write loop (ADR-064):
// the app compiles a Kometa RECIPE into the app-owned managed include, opens a bot-authored haynes-ops PR,
// and — for the safe case — AUTO-MERGES it; Flux applies it, the next Kometa run produces the Plex
// collection, and the existing collections-sync mirrors it back with `provenance: kometa`. The app NEVER
// writes a Plex collection.
//
// Auto-merge (D-10, as-implemented 2026-07-20). The write path ARMS an app-enforced auto-merge only when the
// three COMPILE/PR-TIME conditions hold: within-cap (the assert passed AND not an over-cap materialization),
// grouping-only (find-missing OFF), and the PR diff touches ONLY the app-owned managed include. The runtime
// `--validate-file` CI gate is enforced SEPARATELY, SCOPED to its ONE named check-run: green → merge; failed
// → leave for a human; still pending at request time → arm the DEFERRED merge (a background wait on the named
// gate) and return immediately. This replaced the original in-request roll-up-the-whole-check-matrix poll,
// which false-negatived every eligible add on the slow Flux Local matrix and blocked the request ~135s
// (live 2026-07-20, haynes-ops #2170/#2171). Native GitHub auto-merge is NOT used: the validate check is
// path-filtered and therefore NOT a branch-protection required check, so GitHub would merge on the required
// Flux Local/Diff Scope checks WITHOUT the validate gate — the app must be the gate enforcer. Anything not
// armed/merged leaves the PR for a human.
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
import { NotFoundError } from './errors';
import { assertWithinCollectionSizeCap } from './collection-size-cap';
import {
  compileManagedFile,
  managedFileName,
  parseManagedFile,
  validateKometaRef,
  type KometaMediaType,
  type KometaRecipe,
} from './kometa-compiler';
import {
  isHandConfigFile,
  parseHandConfigFile,
  spliceHandCollectionFindMissing,
  spliceHandCollectionRef,
  spliceHandCollectionRemoval,
  type KometaHandCollection,
} from './kometa-hand-config';
import type { HaynesopsClientBundle } from './haynesops-clients';

export type { KometaMediaType, KometaRecipe } from './kometa-compiler';
export type { KometaHandCollection } from './kometa-hand-config';

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

/**
 * One of the estate's HAND-AUTHORED Kometa collections (owner ruling 2026-07-18) as the overview sees it:
 * the parse result (name, builder, editability) plus the mirror-joined item count and its source. `hand`
 * = it lives in a config file the app can surgically edit; `default` = a mirror collection produced by a
 * Kometa Default (config.yml) with no hand file to edit (listed honestly, never editable).
 */
export interface KometaHandCollectionView extends Omit<KometaHandCollection, 'file'> {
  /** The config file basename (the splice PR path); null for a Defaults-produced mirror-only collection. */
  file: string | null;
  /** Item count from the mirror join by normalized title (null when the mirror has not built it). */
  itemCount: number | null;
  source: 'hand' | 'default';
}

/** The owner-tone reason a Defaults-produced collection (no hand file) cannot be edited here. */
const DEFAULTS_UNEDITABLE_REASON = 'Built by the estate’s Kometa defaults.';

export interface KometaCollectionsOverview {
  /** False when haynes-ops (GitHub) could not be reached — the surface renders the honest degrade. */
  reachable: boolean;
  mediaType: KometaMediaType;
  /** The merged managed recipes (source of truth: the app-owned include on the base branch). */
  recipes: KometaRecipeView[];
  /** The produced collections the mirror already carries (provenance kometa). */
  collections: KometaProducedCollection[];
  /** The estate's hand-authored config collections + the Defaults-produced mirror rows (one Kometa list). */
  handCollections: KometaHandCollectionView[];
  /** Open app-authored PRs a human still has to merge (awaiting-merge rows). */
  pendingPrs: KometaPendingPr[];
}

const EMPTY_UNREACHABLE = (mediaType: KometaMediaType): KometaCollectionsOverview => ({
  reachable: false,
  mediaType,
  recipes: [],
  collections: [],
  handCollections: [],
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
 * Read + parse the estate's HAND-AUTHORED Kometa config files for a media type (owner ruling 2026-07-18).
 * Lists the config directory, keeps the movies-*.yml / shows-*.yml siblings (never the app include), reads
 * each, and parses its collections (name, builder, editability). Pure text parsing — no builder is ever
 * inferred beyond the D-04 allowlist.
 */
async function readHandCollections(
  haynesops: HaynesopsClientBundle,
  mediaType: KometaMediaType,
): Promise<KometaHandCollection[]> {
  const names = await haynesops.read.listDirectory(haynesops.configDir, haynesops.baseBranch);
  const handFiles = names.filter((n) => isHandConfigFile(n, mediaType)).sort();
  const out: KometaHandCollection[] = [];
  for (const f of handFiles) {
    const file = await haynesops.read.getFile(`${haynesops.configDir}/${f}`, haynesops.baseBranch);
    out.push(...parseHandConfigFile(file?.text, f, mediaType));
  }
  return out;
}

/**
 * DESIGN-042 D-02/D-07 (owner ruling 2026-07-18 — EDIT the estate's Kometa collections, not read-only) —
 * the per-media-type monitor: the app-owned managed recipes (reconciled to `live`/`pending_run` against
 * the mirror) PLUS the estate's hand-authored config collections (parsed from every movies-*.yml /
 * shows-*.yml, editable where the D-04 allowlist recognizes a single validated ref), each joined to its
 * mirror item count by normalized title. A Kometa-Defaults-produced mirror collection with no hand file is
 * still listed (source `default`, never editable). One list, source-badged. A HaynesopsUnreachableError
 * degrades to `reachable: false` (empty) — the surface stays up; any other error rethrows.
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
    const producedByTitle = new Map(produced.map((c) => [normalizeTitle(c.title), c]));
    const recipeTitles = new Set(recipes.map((r) => normalizeTitle(r.name)));
    const hand = await readHandCollections(input.haynesops, input.mediaType);
    const handTitles = new Set(hand.map((h) => normalizeTitle(h.name)));
    const openPrs = await input.haynesops.read.listOpenManagedPrs();

    const handViews: KometaHandCollectionView[] = hand.map((h) => ({
      ...h,
      itemCount: producedByTitle.get(normalizeTitle(h.name))?.childCount ?? null,
      source: 'hand',
    }));
    // Mirror collections not authored by an app recipe OR a hand file are Kometa-Defaults output — listed
    // honestly (the tab reflects the whole estate) but never editable (there is no file to splice).
    const defaultViews: KometaHandCollectionView[] = produced
      .filter(
        (c) =>
          !recipeTitles.has(normalizeTitle(c.title)) && !handTitles.has(normalizeTitle(c.title)),
      )
      .map((c) => ({
        name: c.title,
        file: null,
        mediaType: input.mediaType,
        builderType: null,
        builderRef: null,
        findMissing: false,
        editable: false,
        editableReason: DEFAULTS_UNEDITABLE_REASON,
        itemCount: c.childCount,
        source: 'default' as const,
      }));

    return {
      reachable: true,
      mediaType: input.mediaType,
      recipes: recipes.map((r) => ({
        ...r,
        state: producedTitles(producedByTitle).has(normalizeTitle(r.name)) ? 'live' : 'pending_run',
      })),
      collections: produced,
      handCollections: [...handViews, ...defaultViews],
      pendingPrs: openPrs.map((p) => ({ number: p.number, title: p.title, url: p.url })),
    };
  } catch (error) {
    if (error instanceof HaynesopsUnreachableError) return EMPTY_UNREACHABLE(input.mediaType);
    throw error;
  }
}

/** Small helper so the recipe live/pending reconcile reuses the produced-by-title map. */
function producedTitles(map: Map<string, KometaProducedCollection>): Set<string> {
  return new Set(map.keys());
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
}

export interface KometaAutoMergeDecision {
  /** Eligible to ARM the auto-merge (all three compile/PR-time conditions hold). */
  autoMerge: boolean;
  /** Why auto-merge was withheld (the PR is left for a human) — null when eligible. */
  reason: string | null;
}

/**
 * DESIGN-042 D-10 — the ELIGIBILITY policy: the app arms an auto-merge only when ALL THREE compile/PR-time
 * conditions hold (within-cap, grouping-only, managed-file-only); any one failing leaves the PR for a human.
 * The runtime `--validate-file` CI gate is NOT part of this pure decision — it is enforced separately by the
 * (scoped, named) checks conclusion once a PR is eligible (green → merge; failed/pending → deferred/human).
 * This keeps "is this the kind of write we auto-merge?" (compile-time, exhaustively testable) cleanly split
 * from "is the CI gate green?" (runtime). Pure so the condition matrix stays exhaustively testable.
 */
export function evaluateKometaAutoMerge(input: KometaAutoMergeInputs): KometaAutoMergeDecision {
  if (!input.capAsserted) return { autoMerge: false, reason: 'over the size cap' };
  if (input.isMaterialization)
    return { autoMerge: false, reason: 'over-cap materialization (human-merged)' };
  if (input.findMissing) return { autoMerge: false, reason: 'find-missing enabled (human-merged)' };
  if (!input.managedFileOnly)
    return { autoMerge: false, reason: 'PR touches files outside the managed include' };
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
  // The acquisition state on the recipe this write commits (the find-missing knob — PR4c).
  find_missing: recipe.findMissing,
  ...(extra ?? {}),
});

export interface KometaWriteResult {
  prNumber: number;
  prUrl: string;
  /** True when the app merged the PR IN the request (eligible + the validate gate already green — D-10). */
  merged: boolean;
  /**
   * True when the app ARMED the deferred auto-merge: eligible (within-cap, grouping-only, managed-file-only)
   * but the validate gate had not settled yet, so a background wait will merge it the instant the gate is
   * green (or leave it for a human if it fails/times out). `merged` and `autoMergeArmed` are mutually
   * exclusive; both false means the PR is left for a human (autoMergeBlockedReason says why).
   */
  autoMergeArmed: boolean;
  /** Why NOT merged/armed (the honest "awaiting merge" reason on the row); null when merged or armed. */
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

/** A minimal logger seam for the deferred (out-of-request) auto-merge — optional; defaults to a no-op. */
export interface KometaAutoMergeLogger {
  info?: (message: string, meta?: Record<string, unknown>) => void;
  warn?: (message: string, meta?: Record<string, unknown>) => void;
}

/**
 * Schedule the DEFERRED auto-merge OUT of the request path. The task self-catches (never rejects), so the
 * default is a safe fire-and-forget: the request returns immediately, the merge fires when the named gate is
 * green. Tests inject a capturing scheduler to run the task deterministically; a caller that wants a
 * different lifecycle (a queue, a restart-durable job) can inject its own. A merge lost to a pod restart
 * leaves the PR open — the pre-existing safe default (a human merges the already-validated PR).
 */
export type ScheduleAutoMerge = (task: () => Promise<void>) => void;

const defaultScheduleAutoMerge: ScheduleAutoMerge = (task) => {
  void task();
};

interface KometaWriteContext {
  db?: DbClient;
  haynesops: HaynesopsClientBundle;
  actorId: string;
  recipe: KometaRecipe;
  mediaType: KometaMediaType;
  /** Injectable unique branch suffix (tests pass a fixed value). */
  branchSuffix?: string;
  /** Injectable DEFERRED-wait knobs (tests pass 1 attempt / a fake sleep). */
  checkPoll?: { attempts?: number; intervalMs?: number; sleepImpl?: (ms: number) => Promise<void> };
  /** Injectable scheduler for the deferred merge (default: safe fire-and-forget). */
  scheduleAutoMerge?: ScheduleAutoMerge;
  /** Optional logger for the deferred merge's outcome (merged / left-for-human / failed). */
  logger?: KometaAutoMergeLogger;
}

/**
 * The shared open-PR → maybe-auto-merge → audit flow. `isMaterialization` forces the human-merge path
 * (D-07 case 3). The audit row is co-written in the SAME tx as the write's completion (hard rule 6); the
 * external PR opens BEFORE the audit (crash-safe: a crash before the audit leaves an open PR a human can see).
 */
async function openAndMaybeAutoMerge(
  ctx: KometaWriteContext,
  content: string,
  opts: {
    isMaterialization: boolean;
    title: string;
    body: string;
    auditAction: 'upsert_collection';
  },
): Promise<KometaWriteResult> {
  const path = managedPath(ctx.haynesops, ctx.mediaType);
  const suffix =
    ctx.branchSuffix ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const pr = await ctx.haynesops.write.openManagedFilePr({
    path,
    content,
    branchSlug: branchSlug(ctx.mediaType, ctx.recipe.id, suffix),
    title: opts.title,
    body: opts.body,
  });

  let merged = false;
  let autoMergeArmed = false;
  let reason: string | null = 'awaiting merge';
  // Materialization + find-missing are never eligible — no GitHub round-trips (D-10).
  const preEligible = !opts.isMaterialization && !ctx.recipe.findMissing;
  if (!preEligible) {
    reason = opts.isMaterialization
      ? 'over-cap materialization (human-merged)'
      : 'find-missing enabled (human-merged)';
  } else {
    const files = await ctx.haynesops.write.getPrFilePaths(pr.number);
    const managedFileOnly = files.length > 0 && files.every((f) => f === path);
    const decision = evaluateKometaAutoMerge({
      capAsserted: true,
      isMaterialization: false,
      findMissing: false,
      managedFileOnly,
    });
    if (!decision.autoMerge) {
      // Ineligible (managed-file-only failed) — left for a human.
      reason = decision.reason;
    } else {
      // Eligible. Enforce the runtime validate gate, SCOPED to its ONE named check-run (never the whole
      // matrix). One check — NOT a blocking poll: the request path returns fast. Already green → merge now;
      // already failed → human; still pending → ARM the deferred (out-of-request) merge and return.
      const gate = ctx.haynesops.kometaCheckName;
      const conclusion = await ctx.haynesops.read.getChecksConclusion(
        pr.headSha,
        gate ? { requiredCheckName: gate } : undefined,
      );
      if (conclusion === 'success') {
        await ctx.haynesops.write.squashMergePr(pr.number, opts.title);
        merged = true;
        reason = null;
      } else if (conclusion === 'failure') {
        reason = 'validation gate failed (left for a human)';
      } else {
        // pending / none — the gate has not settled. Arm the deferred merge OUT of the request path.
        autoMergeArmed = true;
        reason = null;
        armDeferredAutoMerge(ctx, {
          prNumber: pr.number,
          headSha: pr.headSha,
          title: opts.title,
          checkName: gate,
        });
      }
    }
  }

  await inTransaction(ctx.db, async (tx) => {
    await tx.insert(permissionAudit).values({
      actorId: ctx.actorId,
      action: opts.auditAction,
      detail: upsertAuditDetail(ctx.recipe, {
        pr_number: pr.number,
        pr_url: pr.url,
        merged,
        auto_merge_armed: autoMergeArmed,
        materialization: opts.isMaterialization,
      }),
    });
  });

  return {
    prNumber: pr.number,
    prUrl: pr.url,
    merged,
    autoMergeArmed,
    autoMergeBlockedReason: reason,
  };
}

/**
 * DESIGN-042 D-10 (as-implemented 2026-07-20) — arm the DEFERRED auto-merge. The request path already proved
 * the PR eligible (within-cap, grouping-only, managed-file-only) and that the named validate gate had not yet
 * settled; this schedules a background wait on THAT ONE named check and squash-merges the instant it is green.
 * Everything is out of the request path — the caller returns immediately. The task self-catches (never
 * rejects) and degrades honestly: a gate that fails / times out, or a merge that errors, leaves the PR OPEN
 * for a human (the pre-existing safe default — the merged PR is the audit trail, a bad recipe is a revert).
 */
function armDeferredAutoMerge(
  ctx: KometaWriteContext,
  pr: { prNumber: number; headSha: string; title: string; checkName: string },
): void {
  const schedule = ctx.scheduleAutoMerge ?? defaultScheduleAutoMerge;
  const logger = ctx.logger;
  schedule(async () => {
    try {
      const conclusion = await ctx.haynesops.write.waitForChecks(pr.headSha, {
        ...ctx.checkPoll,
        ...(pr.checkName ? { requiredCheckName: pr.checkName } : {}),
      });
      if (conclusion !== 'success') {
        logger?.warn?.('kometa deferred auto-merge: validate gate not green, PR left for a human', {
          prNumber: pr.prNumber,
          conclusion,
        });
        return;
      }
      await ctx.haynesops.write.squashMergePr(pr.prNumber, pr.title);
      logger?.info?.('kometa deferred auto-merge complete', { prNumber: pr.prNumber });
    } catch (error) {
      logger?.warn?.('kometa deferred auto-merge failed, PR left for a human', {
        prNumber: pr.prNumber,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
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
  /** Injectable deferred-merge scheduler (default: fire-and-forget) + logger — the arming seam (D-10). */
  scheduleAutoMerge?: KometaWriteContext['scheduleAutoMerge'];
  logger?: KometaWriteContext['logger'];
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
      ...(input.scheduleAutoMerge ? { scheduleAutoMerge: input.scheduleAutoMerge } : {}),
      ...(input.logger ? { logger: input.logger } : {}),
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
  /** Injectable deferred-merge scheduler (default: fire-and-forget) + logger — the arming seam (D-10). */
  scheduleAutoMerge?: KometaWriteContext['scheduleAutoMerge'];
  logger?: KometaWriteContext['logger'];
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
      ...(input.scheduleAutoMerge ? { scheduleAutoMerge: input.scheduleAutoMerge } : {}),
      ...(input.logger ? { logger: input.logger } : {}),
    },
    content,
    {
      isMaterialization: false,
      title: `collections(kometa): remove ${recipe.name}`,
      body: [
        `Remove the app-managed Kometa collection **${recipe.name}** from the managed include.`,
        ``,
        `The produced Plex collection is orphaned (it survives; the recipe stops managing it).`,
        input.deleteCollection
          ? `Requester asked to also delete the collection (orphan-only in v1).`
          : ``,
      ]
        .filter(Boolean)
        .join('\n'),
      auditAction: 'upsert_collection',
    },
  ).then((res) => ({ ...res }));
}

/**
 * DESIGN-042 D-06/D-14 (PLAN-052 PR4c) — the per-collection FIND-MISSING knob for Kometa (movies/TV). Reads
 * the managed include back, finds the recipe by id, flips its `findMissing` (the compiler then emits
 * `radarr_add_missing`/`sonarr_add_missing` + `_search` — PR4b), recompiles, and opens a bot haynes-ops PR.
 * ENABLING find-missing is the acquisition lever — one of the two NON-auto-merge cases (D-10): its PR is
 * ALWAYS human-merged (evaluateKometaAutoMerge withholds auto-merge for `findMissing: true`). DISABLING it
 * returns the recipe to grouping-only, which may auto-merge (managed-file-only, CI green). Grant-gated at the
 * API; this writer trusts the gate. A recipe not present in the managed include is a NotFound (never a
 * fabricated write). Audits `upsert_collection` (with `find_missing` in the detail) in the shared write flow.
 */
export async function setKometaFindMissing(input: {
  db?: DbClient;
  haynesops: HaynesopsClientBundle;
  actorId: string;
  id: string;
  mediaType: KometaMediaType;
  on: boolean;
  branchSuffix?: string;
  checkPoll?: KometaWriteContext['checkPoll'];
  /** Injectable deferred-merge scheduler (default: fire-and-forget) + logger — the arming seam (D-10). */
  scheduleAutoMerge?: KometaWriteContext['scheduleAutoMerge'];
  logger?: KometaWriteContext['logger'];
}): Promise<KometaWriteResult> {
  const path = managedPath(input.haynesops, input.mediaType);
  const file = await input.haynesops.read.getFile(path, input.haynesops.baseBranch);
  const existing = parseManagedFile(file?.text);
  const current = existing.find((r) => r.id === input.id && r.mediaType === input.mediaType);
  if (!current) {
    throw new NotFoundError(
      `Kometa collection "${input.id}" not found in the managed ${input.mediaType} include`,
    );
  }
  const recipe: KometaRecipe = { ...current, findMissing: input.on };
  const content = recompileWith(existing, recipe, input.mediaType);
  return openAndMaybeAutoMerge(
    {
      db: input.db,
      haynesops: input.haynesops,
      actorId: input.actorId,
      recipe,
      mediaType: input.mediaType,
      ...(input.branchSuffix ? { branchSuffix: input.branchSuffix } : {}),
      ...(input.checkPoll ? { checkPoll: input.checkPoll } : {}),
      ...(input.scheduleAutoMerge ? { scheduleAutoMerge: input.scheduleAutoMerge } : {}),
      ...(input.logger ? { logger: input.logger } : {}),
    },
    content,
    {
      isMaterialization: false,
      title: `collections(kometa): ${input.on ? 'enable' : 'disable'} find-missing on ${recipe.name}`,
      body: kometaPrBody(recipe, { materialization: false }),
      auditAction: 'upsert_collection',
    },
  );
}

// ── The HAND-FILE write flow (owner ruling 2026-07-18 — edit the estate's Kometa collections) ────────────
//
// A hand-file edit touches a SIBLING config file (movies-*.yml / shows-*.yml), not the app-owned managed
// include, so it can NEVER auto-merge (the D-10 managed-file-only condition already forbids it; this path
// simply never attempts it). Every hand-file PR is HUMAN-merged. The surgical splice (kometa-hand-config.ts)
// preserves every untouched byte of the file — the round-trip fidelity requirement.

/** The repo-relative path of a hand-authored config file (basename joined to the config dir). */
function handPath(haynesops: HaynesopsClientBundle, file: string): string {
  return `${haynesops.configDir}/${file}`;
}

/** Read a hand file's current text off the base branch, or throw NotFound (never a fabricated splice). */
async function readHandFileText(haynesops: HaynesopsClientBundle, file: string): Promise<string> {
  const repoFile = await haynesops.read.getFile(handPath(haynesops, file), haynesops.baseBranch);
  if (!repoFile) throw new NotFoundError(`Kometa config file "${file}" not found in haynes-ops`);
  return repoFile.text;
}

/**
 * Open a HUMAN-merged haynes-ops PR against a hand config file and audit it in the SAME tx (hard rule 6).
 * The PR opens BEFORE the audit (crash-safe: a crash leaves a visible open PR). Never auto-merges.
 */
async function openHandFilePrAndAudit(input: {
  db?: DbClient;
  haynesops: HaynesopsClientBundle;
  actorId: string;
  file: string;
  content: string;
  mediaType: KometaMediaType;
  name: string;
  title: string;
  body: string;
  auditDetail: Record<string, unknown>;
  branchSuffix?: string;
}): Promise<KometaWriteResult> {
  const suffix =
    input.branchSuffix ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const pr = await input.haynesops.write.openManagedFilePr({
    path: handPath(input.haynesops, input.file),
    content: input.content,
    branchSlug: branchSlug(input.mediaType, input.name, `hand-${suffix}`),
    title: input.title,
    body: input.body,
  });
  await inTransaction(input.db, async (tx) => {
    await tx.insert(permissionAudit).values({
      actorId: input.actorId,
      action: 'upsert_collection',
      detail: {
        provider: 'kometa' as const,
        media_type: input.mediaType,
        hand_file: input.file,
        name: input.name,
        pr_number: pr.number,
        pr_url: pr.url,
        merged: false,
        ...input.auditDetail,
      },
    });
  });
  return {
    prNumber: pr.number,
    prUrl: pr.url,
    merged: false,
    autoMergeArmed: false,
    autoMergeBlockedReason: 'awaiting merge (config file)',
  };
}

/**
 * DESIGN-042 D-01/D-04 (owner ruling 2026-07-18) — SURGICALLY edit a hand-authored Kometa collection's
 * builder ref and open a HUMAN-merged haynes-ops PR against its own config file (every untouched byte
 * preserved). The cap applies to non-admin edits (an unprovable-size ref is treated as over-cap → the
 * client routes to the ticket path). NotFound for an unknown collection/file; KometaRecipeError for a
 * too-custom collection or a malformed ref (never a lossy rewrite). Audited same-tx.
 */
export async function editKometaHandCollection(input: {
  db?: DbClient;
  haynesops: HaynesopsClientBundle;
  actorId: string;
  file: string;
  name: string;
  mediaType: KometaMediaType;
  builderType: KometaRecipe['builderType'];
  builderRef: string;
  /** Resolved membership size (id-list length) or null when unresolvable without egress. */
  size: number | null;
  cap: number;
  isAdmin: boolean;
  branchSuffix?: string;
}): Promise<KometaWriteResult> {
  const { normalizedRef } = validateKometaRef(input.builderType, input.builderRef);
  const effectiveSize = input.size ?? (input.isAdmin ? 0 : input.cap + 1);
  assertWithinCollectionSizeCap({ size: effectiveSize, cap: input.cap, isAdmin: input.isAdmin });
  const text = await readHandFileText(input.haynesops, input.file);
  const content = spliceHandCollectionRef({
    fileText: text,
    name: input.name,
    mediaType: input.mediaType,
    builderRef: input.builderRef,
  });
  return openHandFilePrAndAudit({
    db: input.db,
    haynesops: input.haynesops,
    actorId: input.actorId,
    file: input.file,
    content,
    mediaType: input.mediaType,
    name: input.name,
    title: `collections(kometa): edit ${input.name}`,
    body: [
      `Edit the estate's Kometa collection **${input.name}** in \`${input.file}\` (owner ruling 2026-07-18).`,
      ``,
      `- Builder: ${input.builderType} (${normalizedRef})`,
      ``,
      `Surgical edit — only this collection's builder ref changed; every other byte of the file is preserved.`,
      `Hand-file PRs are HUMAN-merged (never auto-merged — DESIGN-042 D-10).`,
    ].join('\n'),
    auditDetail: { builder_type: input.builderType, builder_ref: normalizedRef, hand_edit: true },
    ...(input.branchSuffix ? { branchSuffix: input.branchSuffix } : {}),
  });
}

/**
 * DESIGN-042 D-06 (owner ruling 2026-07-18) — flip the find-missing (acquisition) knob on a hand-authored
 * Kometa collection by SURGICALLY splicing its `<arr>_add_missing`/`_search` keys, then open a HUMAN-merged
 * PR. Grant-gated at the API. Same fidelity + human-merge bar as an edit.
 */
export async function setKometaHandFindMissing(input: {
  db?: DbClient;
  haynesops: HaynesopsClientBundle;
  actorId: string;
  file: string;
  name: string;
  mediaType: KometaMediaType;
  on: boolean;
  branchSuffix?: string;
}): Promise<KometaWriteResult> {
  const text = await readHandFileText(input.haynesops, input.file);
  const content = spliceHandCollectionFindMissing({
    fileText: text,
    name: input.name,
    mediaType: input.mediaType,
    on: input.on,
  });
  return openHandFilePrAndAudit({
    db: input.db,
    haynesops: input.haynesops,
    actorId: input.actorId,
    file: input.file,
    content,
    mediaType: input.mediaType,
    name: input.name,
    title: `collections(kometa): ${input.on ? 'enable' : 'disable'} find-missing on ${input.name}`,
    body: [
      `${input.on ? 'Enable' : 'Disable'} find-missing on the estate's Kometa collection **${input.name}** in \`${input.file}\`.`,
      ``,
      `Surgical edit — only the ${input.mediaType === 'movies' ? 'radarr' : 'sonarr'}_add_missing/_search keys changed.`,
      `${input.on ? 'Enabling find-missing is the acquisition lever, so this PR is HUMAN-merged (DESIGN-042 D-10).' : 'Hand-file PRs are HUMAN-merged.'}`,
    ].join('\n'),
    auditDetail: { find_missing: input.on, hand_edit: true },
    ...(input.branchSuffix ? { branchSuffix: input.branchSuffix } : {}),
  });
}

/**
 * DESIGN-042 D-03 (owner ruling 2026-07-18) — DELETE a hand-authored Kometa collection (ADMIN only; the API
 * gates the caller) by SURGICALLY removing exactly its block from the config file, then open a HUMAN-merged
 * PR. Orphans the produced Plex collection (the existing semantics). NotFound for an unknown collection.
 */
export async function deleteKometaHandCollection(input: {
  db?: DbClient;
  haynesops: HaynesopsClientBundle;
  actorId: string;
  file: string;
  name: string;
  mediaType: KometaMediaType;
  deleteCollection?: boolean;
  branchSuffix?: string;
}): Promise<KometaWriteResult> {
  const text = await readHandFileText(input.haynesops, input.file);
  const content = spliceHandCollectionRemoval({ fileText: text, name: input.name });
  return openHandFilePrAndAudit({
    db: input.db,
    haynesops: input.haynesops,
    actorId: input.actorId,
    file: input.file,
    content,
    mediaType: input.mediaType,
    name: input.name,
    title: `collections(kometa): remove ${input.name}`,
    body: [
      `Remove the estate's Kometa collection **${input.name}** from \`${input.file}\`.`,
      ``,
      `The produced Plex collection is orphaned (it survives; the config stops managing it).`,
      input.deleteCollection
        ? `Requester asked to also delete the collection (orphan-only in v1).`
        : ``,
      `Hand-file PRs are HUMAN-merged.`,
    ]
      .filter(Boolean)
      .join('\n'),
    auditDetail: { hand_delete: true, delete_collection: input.deleteCollection ?? false },
    ...(input.branchSuffix ? { branchSuffix: input.branchSuffix } : {}),
  });
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
