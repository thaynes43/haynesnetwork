// ADR-060 C-05 / DESIGN-031 D-01/D-06 (PLAN-035 — ticket email notifications). The single seam for
// the per-user `notification_preferences` store: the email-ticket-updates opt-in (R-196, default
// OFF). Read on the profile surface and inside the ticket reply/transition transactions (the
// enqueue gate); upserted on toggle. Written ONLY by `setNotificationPreference` (guard-listed).
// NO audit row — descriptive per-user state, not a role/permission/ledger mutation (the
// library_preferences precedent, ADR-052 C-04).
import { notificationPreferences, type DbClient } from '@hnet/db';
import { eq } from 'drizzle-orm';
import { inTransaction, resolveDb } from './db-client';

export interface NotificationPreference {
  /** R-196 — email me when a ticket I authored gets a reply or a status change. Default OFF. */
  emailTicketUpdates: boolean;
}

export const NOTIFICATION_PREFERENCE_DEFAULTS: NotificationPreference = {
  emailTicketUpdates: false,
};

/** The user's notification preference (the defaults when no row exists — no row is minted on read). */
export async function getNotificationPreference(input: {
  db?: DbClient;
  userId: string;
}): Promise<NotificationPreference> {
  const [row] = await resolveDb(input.db)
    .select({ emailTicketUpdates: notificationPreferences.emailTicketUpdates })
    .from(notificationPreferences)
    .where(eq(notificationPreferences.userId, input.userId))
    .limit(1);
  return row ?? { ...NOTIFICATION_PREFERENCE_DEFAULTS };
}

/** Upsert the user's notification preference (the sole writer of `notification_preferences`). */
export async function setNotificationPreference(input: {
  db?: DbClient;
  userId: string;
  emailTicketUpdates: boolean;
}): Promise<NotificationPreference> {
  return inTransaction(input.db, async (tx) => {
    const now = new Date();
    await tx
      .insert(notificationPreferences)
      .values({
        userId: input.userId,
        emailTicketUpdates: input.emailTicketUpdates,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [notificationPreferences.userId],
        set: { emailTicketUpdates: input.emailTicketUpdates, updatedAt: now },
      });
    return { emailTicketUpdates: input.emailTicketUpdates };
  });
}
