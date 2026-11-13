// e2e fixture adjustments for the Request Keep (ADR-118). Run as a tsx subprocess, like
// reset-saves.ts. Both writes go through @hnet/domain single writers.
//
//   tsx e2e/support/trash-e2e-fixture.ts request-tag on|off
//   tsx e2e/support/trash-e2e-fixture.ts skip-gate off
//
// Breaking Prod is the TV pool's only title and the seed tags it mediarequests. A new batch
// leaves that tag out, so a spec that must open a TV batch clears the tag for the call and
// puts it back. skip-gate off turns the admin gate back on (trash_skip_admin_gate false) when
// a spec that disabled it did not reach its own restore.
import { getPool } from '@hnet/db';
import { setAppSetting, upsertMediaItemsBatch } from '@hnet/domain';

const BREAKING_PROD = {
  arrItemId: 501,
  tvdbId: 990001,
  title: 'Breaking Prod',
  sortTitle: 'breaking prod',
  year: 2019,
  monitored: true,
  qualityProfileId: 7,
  qualityProfileName: 'HD-1080p',
  rootFolder: '/data/haynestower/Media/TV Shows',
  onDiskFileCount: 9,
  expectedFileCount: 10,
  sizeOnDisk: 21_474_836_480,
  arrAttrs: { seriesType: 'standard', seasonFolder: true, monitorNewItems: 'all' },
};

async function main(): Promise<void> {
  const command = process.argv[2];
  const value = process.argv[3];
  if (command === 'request-tag' && (value === 'on' || value === 'off')) {
    await upsertMediaItemsBatch({
      arrKind: 'sonarr',
      items: [{ ...BREAKING_PROD, arrTags: value === 'on' ? ['mediarequests'] : [] }],
    });
    process.stdout.write(`request-tag ${value}\n`);
    return;
  }
  if (command === 'skip-gate' && value === 'off') {
    await setAppSetting({ key: 'trash_skip_admin_gate', value: false, actorId: null });
    process.stdout.write('skip-gate off\n');
    return;
  }
  throw new Error('usage: trash-e2e-fixture.ts request-tag on|off | skip-gate off');
}

main()
  .then(async () => {
    await getPool().end();
  })
  .catch(async (err: unknown) => {
    process.stderr.write(
      `trash-e2e-fixture failed: ${err instanceof Error ? err.stack : String(err)}\n`,
    );
    await getPool().end();
    process.exit(1);
  });
