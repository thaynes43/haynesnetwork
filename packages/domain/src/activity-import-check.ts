// DESIGN-055 D-07 P2 decision 13, built in PLAN-077 P3 — Activity's admin row for a stuck Sonarr or Radarr download
// shows its Import Check result (read-only): the same plan a Force Search press would follow (planForceSearch, which
// runs checkSonarrImport / checkRadarrImport, the janitor's own check), planned as if the `import_check` remedy were on.
// Nothing is written and nothing is sent to the *arr beyond its queue and manual-import reads.
import { mediaItems, type DbClient } from '@hnet/db';
import { and, eq, isNull } from 'drizzle-orm';
import type { ArrClientBundle } from './arr-clients';
import { resolveDb } from './db-client';
import { getActivityFailure } from './activity/failures';
import { parseArrActivityRef } from './activity/arr-adapter';
import { importCheckReasonText, type ImportCheckVerdict } from './import-check';
import { planForceSearch, type ForceSearchPlanState } from './queue-aware-search';

export type ActivityImportCheck =
  | { available: false; why: 'not_found' | 'not_arr' | 'no_target' | 'no_title' }
  | {
      available: true;
      mediaItemId: string;
      state: ForceSearchPlanState;
      verdict: ImportCheckVerdict | null;
      /** What a Force Search press on the title would do, in plain words. */
      summary: string;
      /** The Import Check's own reason (the janitor's census wording), when it ran. */
      reason: string | null;
      downloadTitle: string | null;
    };

const SUMMARY: Record<ForceSearchPlanState, string> = {
  search: 'Nothing is queued for this target now. Force Search would search.',
  on_its_way: 'A download for this target is still on its way. Force Search would send nothing.',
  import: 'Ready to import. Force Search on the title would import this download.',
  import_onto:
    'The download names another episode. Force Search offers "Import this download onto..." for that episode.',
  remove_and_search: 'Failed or defective. Force Search would remove it with a blocklist and search once.',
  staff: 'Needs staff. The self-service tools would not touch this download.',
};

export async function activityImportCheck(input: {
  db?: DbClient;
  arr: ArrClientBundle;
  failureId: string;
}): Promise<ActivityImportCheck> {
  const db = resolveDb(input.db);
  const failure = await getActivityFailure({ db, failureId: input.failureId });
  if (!failure) return { available: false, why: 'not_found' };
  const ref = parseArrActivityRef(failure.sourceRef);
  if (!ref || ref.arrKind === 'lidarr') return { available: false, why: 'not_arr' };
  if (ref.arrKind === 'sonarr' && ref.targetId === null) return { available: false, why: 'no_target' };
  const [item] = await db
    .select({ id: mediaItems.id })
    .from(mediaItems)
    .where(
      and(
        eq(mediaItems.arrKind, ref.arrKind),
        eq(mediaItems.arrItemId, ref.parentId),
        isNull(mediaItems.deletedFromArrAt),
      ),
    )
    .limit(1);
  if (!item) return { available: false, why: 'no_title' };
  const plan = await planForceSearch({
    db,
    arr: input.arr,
    mediaItemId: item.id,
    ...(ref.arrKind === 'sonarr' ? { scope: 'episode' as const, targetChildId: ref.targetId! } : { scope: 'item' as const }),
    importCheckOn: true,
  });
  return {
    available: true,
    mediaItemId: item.id,
    state: plan.state,
    verdict: plan.check?.verdict ?? null,
    summary: SUMMARY[plan.state],
    reason: plan.check ? importCheckReasonText({ ...plan.check, downloadId: plan.download?.downloadId ?? '' }) : null,
    downloadTitle: plan.download?.title ?? null,
  };
}
