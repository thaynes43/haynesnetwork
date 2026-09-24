'use server';

// ADR-091 C-10 / DESIGN-050 D-08 — Disconnect. The session is re-derived here: a user may disconnect only their
// own connections; an admin may disconnect anyone's (the admin view lists every user's). The @hnet/domain writer
// revokes every token of that client for that user, expires its pending requests and codes, and writes the
// `client_disconnected` audit row in one transaction (hard rule 6); the app's next /mcp call answers 401.
import { headers } from 'next/headers';
import { getServerSession } from '@hnet/auth';
import { disconnectClient } from '@hnet/domain';
import { isClientId, isUuid } from '@hnet/oauth';

export type DisconnectResult = 'ok' | 'failed';

export async function disconnectConnection(
  clientId: string,
  userId: string,
): Promise<DisconnectResult> {
  if (
    typeof clientId !== 'string' ||
    typeof userId !== 'string' ||
    !isClientId(clientId) ||
    !isUuid(userId)
  ) {
    return 'failed';
  }
  const session = await getServerSession(await headers());
  if (!session) return 'failed';
  if (userId !== session.user.id && !session.user.role.isAdmin) return 'failed';
  try {
    await disconnectClient({ clientId, userId, actorUserId: session.user.id });
    return 'ok';
  } catch (error) {
    console.error(
      '[oauth] disconnect failed',
      error instanceof Error ? error.message : String(error),
    );
    return 'failed';
  }
}
