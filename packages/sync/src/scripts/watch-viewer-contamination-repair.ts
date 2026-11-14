// DESIGN-008 D-15: explicit one-off only. Never invoke from a scheduled harvest.
// Production apply belongs to the coordinator after reviewing aggregate dry-run counts.
import { db, getPool } from '@hnet/db';
import { resolveTautulliInstances } from '@hnet/arr';
import { TautulliClient } from '@hnet/arr/read';
import { repairViewerContamination } from '../watch-viewer-contamination-repair';

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !['--dry-run', '--apply'].includes(args[0]!)) {
    console.error('Usage: watch-viewer-contamination-repair.ts --dry-run|--apply');
    return 2;
  }
  const configured = resolveTautulliInstances();
  if (!process.env.DATABASE_URL || configured.length === 0) {
    console.error('watch-viewer-contamination-repair: configuration unavailable');
    return 2;
  }
  const report = await repairViewerContamination({
    db,
    apply: args[0] === '--apply',
    tautulli: configured.map((inst) => ({
      slug: inst.slug,
      client: new TautulliClient({ baseUrl: inst.baseUrl, apiKey: inst.apiKey }),
    })),
  });
  console.log(JSON.stringify(report));
  return report.complete ? 0 : 1;
}
if (process.argv[1]?.endsWith('watch-viewer-contamination-repair.ts')) {
  main()
    .catch(() => {
      console.error('watch-viewer-contamination-repair: failed');
      return 1;
    })
    .then(async (code) => {
      try {
        await getPool().end();
      } catch {
        // Shutdown errors must not echo connection or upstream text.
      }
      process.exitCode = code;
    });
}
