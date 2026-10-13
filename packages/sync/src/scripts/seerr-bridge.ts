// ADR-111 C-03 / DESIGN-055 D-10 (PLAN-077 P7) — staff's tool for the Seerr Issue bridge (not a sync mode):
//
//   tsx seerr-bridge.ts --show
//   tsx seerr-bridge.ts --set [--user <seerrUserId>|none] [--comment on|off] [--resolve on|off]
//   tsx seerr-bridge.ts --run [--issue <seerrIssueId>]
//
// `--show` only reads: the `seerr_issue_bridge` setting, the bridge user as Seerr has it now, and the bridge's writes on
// the open and recent issues. `--set` writes the audited setting (actor null; permission_audit carries the before and
// after); a value left out keeps what is stored. `--run` runs one bridge pass now (the same single writer as the
// `seerr-issues` sync and the issue webhook), for every issue or one: it writes to Seerr only what that pass would.
// Nothing here prints a name, email or key.
//
// Env: DATABASE_URL; SEERR_API_KEY (+ SEERR_URL, default in-cluster) for `--show` and `--run`; SONARR_API_KEY optional;
// BETTER_AUTH_URL is the link's origin.
import { getPool } from '@hnet/db';
import {
  getSeerrIssueBridge,
  readSeerrIssueBridgeStatus,
  runSeerrIssueBridgeFromEnv,
  runSeerrIssueBridgeSmokeFromEnv,
  seerrIssueWritesFor,
  setSeerrIssueBridge,
} from '@hnet/domain';
import { createConsoleLogger } from '../logger';

const USAGE = `Usage: seerr-bridge.ts --show | --set [--user <id>|none] [--comment on|off] [--resolve on|off] | --run [--issue <id>] | --smoke | --smoke-cleanup

  --show                  the setting, the bridge user as Seerr has it, and the bridge's recent writes
  --set                   change the audited seerr_issue_bridge setting (a value left out keeps what is stored)
    --user <id>|none      the Seerr user the comment and resolve post as (never 1, the owner)
    --comment on|off      the fix-it-yourself comment on each new issue
    --resolve on|off      the resolve once the repair a report's guide ran has completed
  --run [--issue <id>]    one bridge pass now, for every issue or one
  --smoke                 one audited staff fixture on media 10974, simulated repair, then cleanup
  --smoke-cleanup         resume cleanup of only the saved fixture after an interruption`;

export type SeerrBridgeCommand =
  | { kind: 'show' }
  | { kind: 'smoke'; cleanupOnly: boolean }
  | { kind: 'set'; user?: number | null; comment?: boolean; resolve?: boolean }
  | { kind: 'run'; issueId: number | null };

const onOff = (flag: string, v: string | undefined): boolean => {
  if (v === 'on') return true;
  if (v === 'off') return false;
  throw new Error(`${flag} expects on or off`);
};

const positiveInt = (flag: string, v: string | undefined): number => {
  const n = Number(v);
  if (v === undefined || !Number.isSafeInteger(n) || n <= 0)
    throw new Error(`${flag} expects a positive id`);
  return n;
};

export function parseSeerrBridgeArgs(argv: readonly string[]): SeerrBridgeCommand | 'help' {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) return 'help';
  const [command, ...rest] = argv;
  if (command === '--smoke' || command === '--smoke-cleanup') {
    if (rest.length > 0) throw new Error(`${command} takes no options or issue id`);
    return { kind: 'smoke', cleanupOnly: command === '--smoke-cleanup' };
  }
  if (command === '--show') {
    if (rest.length > 0) throw new Error('--show takes no options');
    return { kind: 'show' };
  }
  if (command === '--run') {
    if (rest.length === 0) return { kind: 'run', issueId: null };
    if (rest.length === 2 && rest[0] === '--issue')
      return { kind: 'run', issueId: positiveInt('--issue', rest[1]) };
    throw new Error('--run takes only --issue <id>');
  }
  if (command === '--set') {
    const out: Extract<SeerrBridgeCommand, { kind: 'set' }> = { kind: 'set' };
    for (let i = 0; i < rest.length; i += 2) {
      const flag = rest[i];
      const value = rest[i + 1];
      if (flag === '--user') out.user = value === 'none' ? null : positiveInt('--user', value);
      else if (flag === '--comment') out.comment = onOff('--comment', value);
      else if (flag === '--resolve') out.resolve = onOff('--resolve', value);
      else throw new Error(`unknown option "${flag}"`);
    }
    if (out.user === undefined && out.comment === undefined && out.resolve === undefined) {
      throw new Error('--set needs at least one of --user, --comment, --resolve');
    }
    if (out.user === 1)
      throw new Error('--user 1 is the owner; the bridge never posts as the owner');
    return out;
  }
  throw new Error(`unknown command "${command}"`);
}

async function main(): Promise<number> {
  const logger = createConsoleLogger();
  let cmd: SeerrBridgeCommand | 'help';
  try {
    cmd = parseSeerrBridgeArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`seerr-bridge: ${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (cmd === 'help') {
    console.log(USAGE);
    return 0;
  }
  if (!process.env.DATABASE_URL) {
    logger.error('DATABASE_URL is required');
    return 2;
  }
  if (cmd.kind === 'set') {
    const stored = await getSeerrIssueBridge({});
    const res = await setSeerrIssueBridge({
      value: {
        comment: cmd.comment ?? stored.comment,
        resolve: cmd.resolve ?? stored.resolve,
        bridgeUserId: cmd.user !== undefined ? cmd.user : stored.bridgeUserId,
      },
      actorId: null,
    });
    console.log(JSON.stringify(res, null, 2));
    return 0;
  }
  if (cmd.kind === 'smoke') {
    console.log(
      JSON.stringify(
        await runSeerrIssueBridgeSmokeFromEnv({ cleanupOnly: cmd.cleanupOnly }),
        null,
        2,
      ),
    );
    return 0;
  }
  if (cmd.kind === 'run') {
    const report = await runSeerrIssueBridgeFromEnv({
      ...(cmd.issueId !== null ? { issueIds: [cmd.issueId] } : {}),
      logger,
    });
    console.log(JSON.stringify(report, null, 2));
    return report.status === 'ok' || report.status === 'off' ? 0 : 1;
  }
  const status = await readSeerrIssueBridgeStatus({});
  const { rows } = await getPool().query<{ id: number }>(
    `SELECT seerr_issue_id AS id FROM seerr_issues WHERE status = 'open' OR updated_at > now() - interval '14 days'
     ORDER BY seerr_issue_id DESC LIMIT 20`,
  );
  const writes = await seerrIssueWritesFor(
    undefined,
    rows.map((r) => r.id),
  );
  console.log(
    JSON.stringify(
      {
        ...status,
        writes: Object.fromEntries([...writes.entries()].map(([id, w]) => [String(id), w])),
      },
      null,
      2,
    ),
  );
  return 0;
}

if (process.argv[1]?.endsWith('seerr-bridge.ts')) {
  main()
    .then(async (code) => {
      await getPool()
        .end()
        .catch(() => {});
      process.stdout.write('', () => process.exit(code));
    })
    .catch(async (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      await getPool()
        .end()
        .catch(() => {});
      process.stdout.write('', () => process.exit(1));
    });
}
