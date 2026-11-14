// DESIGN-008 D-15 — repair existing per-user projections without creating absent-viewer rows.
import { userMediaWatch, type DbClient } from '@hnet/db';
import type { UserMediaWatchInput, UserWatchStat } from '@hnet/domain';
import { inArray } from 'drizzle-orm';
import { identifiableWatchTarget, type WatchTarget } from './watch-identity';

export async function projectUserWatchRows(input: {
  db: DbClient;
  complete: boolean;
  mappedUsers: ReadonlyMap<string, string>;
  targets: (WatchTarget & { id: string; perUser?: ReadonlyMap<string, UserWatchStat> })[];
}): Promise<UserMediaWatchInput[]> {
  if (input.targets.length === 0 || input.mappedUsers.size === 0) return [];
  const existing = await input.db
    .select()
    .from(userMediaWatch)
    .where(
      inArray(
        userMediaWatch.mediaItemId,
        input.targets.map((t) => t.id),
      ),
    );
  const key = (item: string, user: string) => `${item}\0${user}`;
  const byKey = new Map(existing.map((r) => [key(r.mediaItemId, r.appUserId), r]));
  const rows: UserMediaWatchInput[] = [];
  for (const target of input.targets) {
    for (const [plexUserId, appUserId] of input.mappedUsers) {
      const stat = target.perUser?.get(plexUserId);
      const before = byKey.get(key(target.id, appUserId));
      if (!stat && (!input.complete || !before)) continue;
      const next: UserMediaWatchInput = {
        mediaItemId: target.id,
        appUserId,
        playCount: stat?.playCount ?? (identifiableWatchTarget(target) ? 0 : null),
        lastViewedAt: stat?.lastViewedAt ?? null,
        watched: stat?.watched ?? false,
        inProgress: stat?.inProgress ?? false,
      };
      if (
        before &&
        before.playCount === next.playCount &&
        before.lastViewedAt?.getTime() === next.lastViewedAt?.getTime() &&
        before.watched === next.watched &&
        before.inProgress === next.inProgress
      )
        continue;
      rows.push(next);
    }
  }
  return rows;
}
