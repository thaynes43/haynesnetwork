// ADR-070 / DESIGN-043 (PLAN-052 — collection manager) — the orchestrator that fronts the confined
// @hnet/libretto client for the tRPC layer. The write surface (upsertRecipe / deleteRecipe / applyScope)
// is import-confined to packages/domain, so packages/api reaches Libretto ONLY through these functions —
// the ADR-055 discipline. The manager reads Libretto LIVE (no local mirror; Libretto is stateless) and
// degrades HONESTLY: a LibrettoUnreachableError from the overview read yields `reachable: false`, never a
// crash (ADR-070 C-09). The `acquire` gate (the content-pull knob) is enforced HERE and re-checked at the
// API — a caller without `acquire` who sets acquisitionEnabled true is refused.
import { LibrettoUnreachableError } from '@hnet/libretto';
import type {
  LibrettoCollection,
  LibrettoIssue,
  LibrettoRecipe,
  LibrettoRecipeDraft,
  LibrettoRun,
  LibrettoValidateResponse,
} from '@hnet/libretto';
import type { LibrettoClientBundle } from './libretto-clients';

/** A caller lacking the `acquire` grant tried to enable a recipe's acquisition (the content-pull knob). */
export class CollectionAcquireForbiddenError extends Error {
  readonly code = 'COLLECTION_ACQUIRE_FORBIDDEN' as const;
  constructor() {
    super('Enabling acquisition needs the acquire grant');
  }
}

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
 * Resolve a draft ref through `POST /api/validate` — the composer's ref PREVIEW (ADR-070 C-07). Surfaces
 * the resolved name + work count + any issues honestly; a 0-work container-series slug comes back resolved
 * with workCount 0 (the silent-failure guard). No fabrication.
 */
export async function previewRecipeRef(input: {
  libretto: LibrettoClientBundle;
  draft: LibrettoRecipeDraft;
}): Promise<LibrettoValidateResponse> {
  return input.libretto.read.validateRecipe(input.draft);
}

/**
 * Save (create/edit) a recipe through the confined writer. The `acquire` gate: enabling
 * `variables.acquisitionEnabled` requires `canAcquire` — a `manage`-only caller who sets it is refused
 * here (CollectionAcquireForbiddenError), independent of the API re-check. Validate-before-save is the
 * caller's step (DESIGN-043 D-03); Libretto also validates on PUT (strictObject → 400 surfaced as issues).
 */
export async function saveRecipe(input: {
  libretto: LibrettoClientBundle;
  draft: LibrettoRecipeDraft;
  canAcquire: boolean;
}): Promise<void> {
  if (input.draft.variables?.acquisitionEnabled === true && !input.canAcquire) {
    throw new CollectionAcquireForbiddenError();
  }
  await input.libretto.write.upsertRecipe(input.draft);
}

/** Apply a scope (`'all'` or a recipe id) → the async run id (poll getCollectionRun). */
export async function applyCollectionScope(input: {
  libretto: LibrettoClientBundle;
  scope: string;
}): Promise<string> {
  return input.libretto.write.applyScope(input.scope);
}

/**
 * Delete a recipe. By default the produced collection SURVIVES orphaned (marker present, no recipe) — the
 * UI warns about this (ADR-070 C-08). `deleteCollection: true` also deletes the target collection.
 */
export async function deleteCollectionRecipe(input: {
  libretto: LibrettoClientBundle;
  id: string;
  deleteCollection?: boolean;
}): Promise<void> {
  await input.libretto.write.deleteRecipe(input.id, { deleteCollection: input.deleteCollection ?? false });
}

/** Poll one run's state + counts (the last-50 caveat is surfaced honestly in the UI — DESIGN-037 D-03). */
export async function getCollectionRun(input: {
  libretto: LibrettoClientBundle;
  runId: string;
}): Promise<LibrettoRun> {
  return input.libretto.read.getRun(input.runId);
}
