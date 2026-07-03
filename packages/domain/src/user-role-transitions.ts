import { users, userRoleTransitions, type DbClient, type Role } from '@hnet/db';
import { and, eq, sql } from 'drizzle-orm';
import { ConcurrentTransitionError, NotFoundError } from './errors';
import { inTransaction } from './db-client';

/**
 * DESIGN-001 D-04/D-12 — role initiators. There is no 'user' kind: users never change
 * their own role (bootstrap promotions are 'system', future admin actions 'admin').
 */
export type RoleInitiator = { id: string; kind: 'admin' } | { id: null; kind: 'system' };

export interface TransitionRoleInput {
  /** Optional executor (a Database or an open Transaction); defaults to the lazy @hnet/db client. */
  db?: DbClient;
  userId: string;
  toRole: Role;
  initiator: RoleInitiator;
  note?: string;
  /**
   * Optional optimistic-concurrency guard (donor pattern): when provided and the user's
   * current role differs, ConcurrentTransitionError is thrown instead of proceeding.
   */
  expectedFromRole?: Role;
}

export interface TransitionRoleResult {
  changed: boolean;
  fromRole: Role;
}

/**
 * DESIGN-001 D-12 — the SINGLE writer for users.role. Updates the role and inserts the
 * user_role_transitions audit row in one transaction (R-04, AC-03). Idempotent: if the
 * user already holds toRole, no-op — no write, no audit row (ADR-002 C-03: repeat
 * bootstrap logins are no-ops).
 */
export async function transitionRole(input: TransitionRoleInput): Promise<TransitionRoleResult> {
  return inTransaction(input.db, async (tx) => {
    const [current] = await tx
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, input.userId))
      .for('update');

    if (!current) {
      throw new NotFoundError(`User ${input.userId} not found`);
    }
    if (input.expectedFromRole !== undefined && current.role !== input.expectedFromRole) {
      throw new ConcurrentTransitionError(
        `User ${input.userId} is not in role '${input.expectedFromRole}' (currently '${current.role}')`,
      );
    }
    if (current.role === input.toRole) {
      return { changed: false, fromRole: current.role };
    }

    const result = await tx
      .update(users)
      .set({ role: input.toRole, updatedAt: sql`now()` })
      .where(and(eq(users.id, input.userId), eq(users.role, current.role)))
      .returning({ id: users.id });

    if (result.length === 0) {
      throw new ConcurrentTransitionError(
        `User ${input.userId} changed role concurrently during transition to '${input.toRole}'`,
      );
    }

    await tx.insert(userRoleTransitions).values({
      userId: input.userId,
      fromRole: current.role,
      toRole: input.toRole,
      initiatorId: input.initiator.id,
      initiatorKind: input.initiator.kind,
      note: input.note ?? null,
    });

    return { changed: true, fromRole: current.role };
  });
}
