// e2e reset (ADR-099) — release every Save left open by an earlier test, THROUGH the @hnet/domain un-save writer
// (`removeExclusion`: it revokes the save intent and writes the `unsave` ledger row; never a direct table write, the
// no-direct-state-writes guard scans this file too). Since ADR-099 a Save is the app's own record, not the stub
// Maintainerr's exclusion, so resetting the stub alone no longer un-saves a title: the walls would keep showing it
// saved and batch creation would keep leaving it out. Run as a tsx SUBPROCESS after the stub reset (so the stub holds
// no exclusions and every un-save takes the lapsed path).
//
//   DATABASE_URL=… MAINTAINERR_URL=… MAINTAINERR_API_KEY=… tsx e2e/support/reset-saves.ts
import { getPool } from '@hnet/db';
import { maintainerrClientBundleFromEnv, removeExclusion } from '@hnet/domain';

async function main(): Promise<void> {
  const { rows } = await getPool().query<{ media_item_id: string; maintainerr_media_id: string }>(
    'SELECT media_item_id, maintainerr_media_id FROM trash_save_intents WHERE revoked_at IS NULL',
  );
  const maintainerr = maintainerrClientBundleFromEnv();
  for (const row of rows) {
    await removeExclusion({
      maintainerr,
      maintainerrMediaId: row.maintainerr_media_id,
      mediaItemId: row.media_item_id,
      actorId: null,
    });
  }
  process.stdout.write(`released ${rows.length}\n`);
}

main()
  .then(async () => {
    await getPool().end();
  })
  .catch(async (err: unknown) => {
    process.stderr.write(`reset-saves failed: ${err instanceof Error ? err.stack : String(err)}\n`);
    await getPool().end();
    process.exit(1);
  });
