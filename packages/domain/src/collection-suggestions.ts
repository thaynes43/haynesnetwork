// ADR-069 / DESIGN-042 D-05 (PLAN-052 — the member contribution flow) — the propose→approve lifecycle
// single-writers. A `suggest`-granted member files a PENDING suggestion (applies nothing); a `manage`
// admin approves (materialize the recipe via the confined @hnet/libretto writer — acquisition OFF unless
// the approver holds `acquire` and opts in) or declines with a reason. Every step co-writes a
// permission_audit row in the SAME transaction as the state change (hard rule 6). Provider-shaped
// (`provider`, 'libretto' now). Approve's external recipe write happens BEFORE the same-tx stamp+audit
// (the book-fix crash-safety idiom: an idempotent PUT re-approves cleanly if a crash lands between them).
import {
  collectionSuggestions,
  permissionAudit,
  type CollectionBuilderType,
  type CollectionProvider,
  type CollectionSuggestionRow,
  type CollectionSuggestionStatus,
  type CollectionSyncMode,
  type DbClient,
} from '@hnet/db';
import { and, desc, eq } from 'drizzle-orm';
import { inTransaction, resolveDb } from './db-client';
import { NotFoundError } from './errors';
import { CollectionAcquireForbiddenError, saveRecipe } from './collections-manager';
import type { LibrettoClientBundle } from './libretto-clients';

/** A suggestion is not `pending` — someone else already reviewed it (approve/decline race). */
export class CollectionSuggestionNotOpenError extends Error {
  readonly code = 'COLLECTION_SUGGESTION_NOT_OPEN' as const;
  constructor() {
    super('This suggestion has already been reviewed');
  }
}

/** Slugify a name into a Libretto recipe id (global-unique — the composer/approver owns uniqueness). */
export function suggestionRecipeId(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base || `suggestion-${Date.now()}`;
}

export interface CreateCollectionSuggestionInput {
  db?: DbClient;
  suggesterId: string;
  provider?: CollectionProvider;
  name: string;
  builderType: CollectionBuilderType;
  builderRef: string;
  targetLibrary?: string | null;
  note?: string | null;
}

/** File a PENDING member suggestion (applies NOTHING) + a same-tx `create_collection_suggestion` audit row. */
export async function createCollectionSuggestion(
  input: CreateCollectionSuggestionInput,
): Promise<CollectionSuggestionRow> {
  return inTransaction(input.db, async (tx) => {
    const [row] = await tx
      .insert(collectionSuggestions)
      .values({
        suggesterId: input.suggesterId,
        provider: input.provider ?? 'libretto',
        name: input.name,
        builderType: input.builderType,
        builderRef: input.builderRef,
        targetLibrary: input.targetLibrary ?? null,
        note: input.note ?? null,
        status: 'pending',
      })
      .returning();
    if (!row) throw new Error('collection suggestion insert returned no row');
    await tx.insert(permissionAudit).values({
      actorId: input.suggesterId,
      action: 'create_collection_suggestion',
      detail: {
        suggestion_id: row.id,
        provider: row.provider,
        name: row.name,
        builder_type: row.builderType,
        builder_ref: row.builderRef,
      },
    });
    return row;
  });
}

/** List suggestions — the manager's review queue (by status) or a member's own (by suggesterId), newest-first. */
export async function listCollectionSuggestions(input: {
  db?: DbClient;
  status?: CollectionSuggestionStatus;
  suggesterId?: string;
  limit?: number;
}): Promise<CollectionSuggestionRow[]> {
  const db = resolveDb(input.db);
  const conds = [];
  if (input.status !== undefined) conds.push(eq(collectionSuggestions.status, input.status));
  if (input.suggesterId !== undefined) conds.push(eq(collectionSuggestions.suggesterId, input.suggesterId));
  const base = db.select().from(collectionSuggestions);
  const rows = await (conds.length > 0 ? base.where(and(...conds)) : base)
    .orderBy(desc(collectionSuggestions.createdAt))
    .limit(input.limit ?? 100);
  return rows;
}

/** One suggestion by id (null when absent). */
export async function getCollectionSuggestion(input: {
  db?: DbClient;
  suggestionId: string;
}): Promise<CollectionSuggestionRow | null> {
  const [row] = await resolveDb(input.db)
    .select()
    .from(collectionSuggestions)
    .where(eq(collectionSuggestions.id, input.suggestionId))
    .limit(1);
  return row ?? null;
}

export interface ApproveCollectionSuggestionInput {
  db?: DbClient;
  libretto: LibrettoClientBundle;
  suggestionId: string;
  reviewerId: string;
  /** The reviewer holds the `acquire` grant (gates enabling acquisition on the materialized recipe). */
  canAcquire: boolean;
  /** Opt the created recipe into acquisition — refused unless `canAcquire` (ADR-069 C-04). Default false. */
  enableAcquisition?: boolean;
  /** Override the derived recipe id (else slugified from the name). */
  recipeId?: string;
  /** The target library for the recipe (else the suggestion's, else Libretto's default handling). */
  targetLibrary?: string | null;
  ordered?: boolean;
  syncMode?: CollectionSyncMode;
  now?: Date;
}

/**
 * Approve a pending suggestion: materialize the recipe via the confined writer (acquisition OFF unless
 * `canAcquire` AND `enableAcquisition`), THEN stamp the suggestion `approved` + `created_recipe_id` and
 * co-write a `review_collection_suggestion` audit row in ONE tx (compare-and-set on `pending` — a lost
 * race throws CollectionSuggestionNotOpenError). The external PUT is idempotent, so a crash between the
 * write and the stamp re-approves cleanly.
 */
export async function approveCollectionSuggestion(
  input: ApproveCollectionSuggestionInput,
): Promise<CollectionSuggestionRow> {
  const now = input.now ?? new Date();
  const existing = await getCollectionSuggestion({ db: input.db, suggestionId: input.suggestionId });
  if (!existing) throw new NotFoundError(`Collection suggestion ${input.suggestionId} not found`);
  if (existing.status !== 'pending') throw new CollectionSuggestionNotOpenError();

  const wantAcquire = input.enableAcquisition === true;
  if (wantAcquire && !input.canAcquire) throw new CollectionAcquireForbiddenError();

  const recipeId = input.recipeId?.trim() || suggestionRecipeId(existing.name);
  const targetLibrary = input.targetLibrary ?? existing.targetLibrary ?? undefined;
  const draft = {
    id: recipeId,
    name: existing.name,
    builder: { type: existing.builderType, ref: existing.builderRef },
    ...(targetLibrary != null ? { targetLibrary } : {}),
    variables: {
      ...(input.syncMode ? { syncMode: input.syncMode } : {}),
      ...(input.ordered !== undefined ? { ordered: input.ordered } : {}),
      acquisitionEnabled: wantAcquire,
    },
    enabled: true,
  };

  // External recipe write BEFORE the same-tx stamp (crash-safe: PUT is idempotent — re-approve re-PUTs).
  await saveRecipe({ libretto: input.libretto, draft, canAcquire: input.canAcquire });

  return inTransaction(input.db, async (tx) => {
    const [locked] = await tx
      .select({ id: collectionSuggestions.id, status: collectionSuggestions.status })
      .from(collectionSuggestions)
      .where(eq(collectionSuggestions.id, input.suggestionId))
      .for('update');
    if (!locked) throw new NotFoundError(`Collection suggestion ${input.suggestionId} not found`);
    if (locked.status !== 'pending') throw new CollectionSuggestionNotOpenError();
    const [row] = await tx
      .update(collectionSuggestions)
      .set({
        status: 'approved',
        createdRecipeId: recipeId,
        reviewedById: input.reviewerId,
        reviewedAt: now,
        updatedAt: now,
      })
      .where(eq(collectionSuggestions.id, input.suggestionId))
      .returning();
    if (!row) throw new Error('collection suggestion approve returned no row');
    await tx.insert(permissionAudit).values({
      actorId: input.reviewerId,
      action: 'review_collection_suggestion',
      detail: {
        suggestion_id: row.id,
        decision: 'approved',
        recipe_id: recipeId,
        acquisition_enabled: wantAcquire,
      },
    });
    return row;
  });
}

/** Decline a pending suggestion with a reason + a same-tx `review_collection_suggestion` audit row. */
export async function declineCollectionSuggestion(input: {
  db?: DbClient;
  suggestionId: string;
  reviewerId: string;
  reason: string;
  now?: Date;
}): Promise<CollectionSuggestionRow> {
  const now = input.now ?? new Date();
  return inTransaction(input.db, async (tx) => {
    const [locked] = await tx
      .select({ id: collectionSuggestions.id, status: collectionSuggestions.status })
      .from(collectionSuggestions)
      .where(eq(collectionSuggestions.id, input.suggestionId))
      .for('update');
    if (!locked) throw new NotFoundError(`Collection suggestion ${input.suggestionId} not found`);
    if (locked.status !== 'pending') throw new CollectionSuggestionNotOpenError();
    const [row] = await tx
      .update(collectionSuggestions)
      .set({
        status: 'declined',
        decisionNote: input.reason,
        reviewedById: input.reviewerId,
        reviewedAt: now,
        updatedAt: now,
      })
      .where(eq(collectionSuggestions.id, input.suggestionId))
      .returning();
    if (!row) throw new Error('collection suggestion decline returned no row');
    await tx.insert(permissionAudit).values({
      actorId: input.reviewerId,
      action: 'review_collection_suggestion',
      detail: { suggestion_id: row.id, decision: 'declined', reason: input.reason },
    });
    return row;
  });
}
