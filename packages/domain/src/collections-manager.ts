// ADR-072 / DESIGN-043 D-03/D-06/D-10/D-11 (PLAN-052 PR4a — direct-add) — the orchestrator that fronts the
// confined @hnet/libretto client for the tRPC layer. The write surface (upsertRecipe / deleteRecipe /
// applyScope) is import-confined to packages/domain, so packages/api reaches Libretto ONLY through these
// functions (the ADR-055 discipline). The manager reads Libretto LIVE (no local mirror; Libretto is
// stateless) and degrades HONESTLY: a LibrettoUnreachableError from the overview read yields
// `reachable: false`, never a crash (the surviving ADR-070 C-09).
//
// Direct-add model (ADR-072): everyone adds/edits within the size cap; there is NO grant on the safe path.
// `upsertCollection` asserts the cap (admins bypass) BEFORE the confined write, then co-writes an
// `upsert_collection` audit row in the SAME tx as the write's stamp (the crash-safe idempotent-PUT idiom:
// the external write lands first, then the same-tx audit — a crash between them re-PUTs cleanly). Delete is
// admin-only. Over-cap escalates to a `collection_override` ticket (tickets.ts) that materializes on
// approve. `find_missing` (the acquisition knob) is a per-collection grant, wired in PR4c — direct adds in
// PR4a always write acquisition OFF.
import { LibrettoUnreachableError } from '@hnet/libretto';
import type {
  LibrettoCollection,
  LibrettoIssue,
  LibrettoRecipe,
  LibrettoRecipeDraft,
  LibrettoRun,
  LibrettoValidateResponse,
} from '@hnet/libretto';
import { permissionAudit, type DbClient } from '@hnet/db';
import { inTransaction } from './db-client';
import { assertWithinCollectionSizeCap } from './collection-size-cap';
import type { LibrettoClientBundle } from './libretto-clients';

export interface CollectionsOverview {
  /** False when Libretto could not be reached — the manager renders the honest unreachable state. */
  reachable: boolean;
  recipes: LibrettoRecipe[];
  /** Invalid recipe FILES (Libretto issues[]) — the "needs attention" band. */
  issues: LibrettoIssue[];
  collections: LibrettoCollection[];
}

const EMPTY_UNREACHABLE: CollectionsOverview = {
  reachable: false,
  recipes: [],
  issues: [],
  collections: [],
};

/**
 * The manager's monitor payload: recipes (+ invalid-file issues) and the produced collections, composed
 * from ONE Libretto read pass. A LibrettoUnreachableError degrades to `reachable: false` (empty lists) —
 * the surface stays up; any OTHER error (a real 4xx / parse drift) rethrows so it is not silently hidden.
 */
export async function getCollectionsOverview(input: {
  libretto: LibrettoClientBundle;
}): Promise<CollectionsOverview> {
  try {
    const recipesResult = await input.libretto.read.listRecipes();
    let collections: LibrettoCollection[] = [];
    try {
      collections = await input.libretto.read.listCollections();
    } catch (error) {
      // Collections read is best-effort — recipes are the primary surface. An unreachable here still
      // shows recipes; a real error rethrows.
      if (!(error instanceof LibrettoUnreachableError)) throw error;
    }
    return {
      reachable: true,
      recipes: recipesResult.recipes,
      issues: recipesResult.issues,
      collections,
    };
  } catch (error) {
    if (error instanceof LibrettoUnreachableError) return EMPTY_UNREACHABLE;
    throw error;
  }
}

/**
 * Resolve a draft ref through `POST /api/validate` — the composer's ref PREVIEW (the surviving ADR-070
 * C-07). Surfaces the resolved name + work count + any issues honestly; a 0-work container-series slug
 * comes back resolved with workCount 0 (the silent-failure guard). No fabrication.
 */
export async function previewRecipeRef(input: {
  libretto: LibrettoClientBundle;
  draft: LibrettoRecipeDraft;
}): Promise<LibrettoValidateResponse> {
  return input.libretto.read.validateRecipe(input.draft);
}

/** The audit facts an upsert/materialize records (kept small — the recipe lives in Libretto, not here). */
function upsertAuditDetail(draft: LibrettoRecipeDraft, extra?: Record<string, unknown>) {
  return {
    recipe_id: draft.id,
    provider: 'libretto' as const,
    name: draft.name ?? draft.id,
    builder_type: draft.builder?.type ?? null,
    builder_ref: draft.builder?.ref ?? null,
    ...(extra ?? {}),
  };
}

/**
 * DESIGN-043 D-03/D-10 — the DIRECT add/edit writer. Asserts the size cap (admins bypass — the pure
 * `assertWithinCollectionSizeCap`, throwing `CollectionSizeCapError` the client renders the over-cap Modal
 * from) BEFORE the confined write, then upserts the recipe through the confined @hnet/libretto writer, then
 * co-writes an `upsert_collection` permission_audit row in ONE tx (the external write lands first — a crash
 * between the write and the audit re-PUTs the idempotent recipe cleanly). Direct adds always write
 * acquisition OFF (find_missing is the PR4c per-collection grant); the draft's acquisition flag is ignored
 * here. No grant on this path (ADR-072 — everyone adds within the cap).
 */
export async function upsertCollection(input: {
  db?: DbClient;
  libretto: LibrettoClientBundle;
  actorId: string;
  draft: LibrettoRecipeDraft;
  /** The resolved membership size (from the ref preview) the cap is checked against. */
  size: number;
  /** The live `collection_size_cap`. */
  cap: number;
  /** The caller's admin flag — admins bypass the cap outright. */
  isAdmin: boolean;
}): Promise<{ id: string }> {
  assertWithinCollectionSizeCap({ size: input.size, cap: input.cap, isAdmin: input.isAdmin });
  // Force acquisition OFF on the direct path (find_missing is the PR4c grant-gated per-collection knob).
  const draft: LibrettoRecipeDraft = {
    ...input.draft,
    variables: { ...(input.draft.variables ?? {}), acquisitionEnabled: false },
  };
  // External write BEFORE the same-tx audit stamp (crash-safe: the PUT is idempotent).
  await input.libretto.write.upsertRecipe(draft);
  await inTransaction(input.db, async (tx) => {
    await tx.insert(permissionAudit).values({
      actorId: input.actorId,
      action: 'upsert_collection',
      detail: upsertAuditDetail(draft, { size: input.size }),
    });
  });
  return { id: draft.id };
}

/**
 * Apply a scope (`'all'` or a recipe id) → the async run id (poll getCollectionRun). Grouping-only — no
 * acquisition side effect (the find_missing knob is separate; PR4c).
 */
export async function applyCollectionScope(input: {
  libretto: LibrettoClientBundle;
  scope: string;
}): Promise<string> {
  return input.libretto.write.applyScope(input.scope);
}

/**
 * DESIGN-043 D-03 — DELETE a recipe (ADMIN only; the API gates the caller). By default the produced
 * collection SURVIVES orphaned (marker present, no recipe) — the UI warns about this (the surviving ADR-070
 * C-08). `deleteCollection: true` also deletes the target collection. Confined write first, then a same-tx
 * `delete_collection` audit row.
 */
export async function deleteCollectionRecipe(input: {
  db?: DbClient;
  libretto: LibrettoClientBundle;
  actorId: string;
  id: string;
  deleteCollection?: boolean;
}): Promise<void> {
  await input.libretto.write.deleteRecipe(input.id, {
    deleteCollection: input.deleteCollection ?? false,
  });
  await inTransaction(input.db, async (tx) => {
    await tx.insert(permissionAudit).values({
      actorId: input.actorId,
      action: 'delete_collection',
      detail: { recipe_id: input.id, provider: 'libretto', also_delete_collection: input.deleteCollection ?? false },
    });
  });
}

/**
 * DESIGN-043 D-11 — materialize a recipe UNBOUNDED (cap-bypassed) from an approved over-cap ticket's
 * payload. The SAME confined writer as a direct add, without the cap assert. Acquisition stays OFF (a
 * find_missing enable is a distinct, human-merged action — PR4c). No audit here: the caller
 * (approveCollectionOverride) records the materialization via the ticket transition's ticket_events row in
 * the same tx as the completion, and this idempotent external PUT lands BEFORE it (crash-safe).
 */
export async function materializeCollection(input: {
  libretto: LibrettoClientBundle;
  draft: LibrettoRecipeDraft;
}): Promise<void> {
  const draft: LibrettoRecipeDraft = {
    ...input.draft,
    variables: { ...(input.draft.variables ?? {}), acquisitionEnabled: false },
  };
  await input.libretto.write.upsertRecipe(draft);
}

/** Poll one run's state + counts (the last-50 caveat is surfaced honestly in the UI — DESIGN-037 D-03). */
export async function getCollectionRun(input: {
  libretto: LibrettoClientBundle;
  runId: string;
}): Promise<LibrettoRun> {
  return input.libretto.read.getRun(input.runId);
}
