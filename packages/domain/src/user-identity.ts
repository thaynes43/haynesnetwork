// fix/plex-identity-mapping — the @hnet/domain single-writer for a user's Plex identity OVERRIDE
// (users.plex_email / plex_username, migration 0023). The single-writer guard requires every
// `users` write to live here; this one carries NO audit row — it is an identity HINT for My Plex
// display (resolved claim → override → app email), never an access grant, so it mirrors the
// upsertMediaMetadataBatch precedent (descriptive data, no per-row audit event). The admin roster
// mutation (packages/api users.setPlexIdentity) delegates here.
import { users, type DbClient } from '@hnet/db';
import { eq } from 'drizzle-orm';
import { NotFoundError } from './errors';
import { resolveDb } from './db-client';

/** Normalize a Plex identity field: trim + lowercase; blank/absent → null (matching is CI). */
function normalizePlexField(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim().toLowerCase();
  return trimmed ? trimmed : null;
}

export interface SetUserPlexIdentityInput {
  db?: DbClient;
  userId: string;
  /** The user's plex.tv account email, or null/blank to clear. Stored trimmed + lowercased. */
  plexEmail: string | null;
  /** The user's plex.tv username, or null/blank to clear. Stored trimmed + lowercased. */
  plexUsername: string | null;
}

/**
 * Set (or clear) a user's Plex identity override. Throws NotFoundError when the user is gone.
 * Returns the persisted (normalized) identity.
 */
export async function setUserPlexIdentity(
  input: SetUserPlexIdentityInput,
): Promise<{ plexEmail: string | null; plexUsername: string | null }> {
  const plexEmail = normalizePlexField(input.plexEmail);
  const plexUsername = normalizePlexField(input.plexUsername);
  const [row] = await resolveDb(input.db)
    .update(users)
    .set({ plexEmail, plexUsername, updatedAt: new Date() })
    .where(eq(users.id, input.userId))
    .returning({ plexEmail: users.plexEmail, plexUsername: users.plexUsername });
  if (!row) throw new NotFoundError(`User ${input.userId} not found`);
  return { plexEmail: row.plexEmail, plexUsername: row.plexUsername };
}
