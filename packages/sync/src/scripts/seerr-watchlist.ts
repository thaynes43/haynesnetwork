// ADR-093 C-11 / DESIGN-052 D-17 (PLAN-072 S9) — the coordinator's Seerr enrollment switch and the anime-tags preflight:
//
//   tsx seerr-watchlist.ts --show
//   tsx seerr-watchlist.ts --enroll=off | --enroll=all | --enroll=<seerrUserId>[,<seerrUserId>…]
//   tsx seerr-watchlist.ts --anime-tags=<sonarrServerId>:<tagId>[,<tagId>…]
//
// `--enroll` writes the audited `seerr_watchlist_enroll` app setting (actor null; permission_audit carries the before
// and after). The next `watchlist-registry` run enrolls the named users (or all), once each (D-17).
// `--anime-tags` sets Seerr's `animeTags` on one Sonarr server (one PUT echoing the whole server object, then a
// read-back), so an anime series Seerr adds carries `mediarequests` too. `--show` is read-only: the setting, the
// enrollment counts and each Sonarr server's id, name, tags and animeTags. Nothing here prints a name, email or key.
//
// Env: DATABASE_URL; SEERR_API_KEY (+ SEERR_URL, default in-cluster) for `--show` and `--anime-tags`.
import { getPool } from '@hnet/db';
import {
  getSeerrEnrollSummary,
  requireSeerrEnrollClientsFromEnv,
  seerrEnrollClientsFromEnv,
  setSeerrSonarrAnimeTags,
  setSeerrWatchlistEnroll,
} from '@hnet/domain';
import { createConsoleLogger } from '../logger';

const USAGE = `Usage: seerr-watchlist.ts --show | --enroll=off|all|<ids> | --anime-tags=<serverId>:<tagIds>

  --show                          the enrollment setting and counts, and each Seerr Sonarr server's tags
  --enroll=off                    turn enrollment off (existing enrollments are left as they are)
  --enroll=all                    enroll every Seerr Plex user on the next watchlist-registry run
  --enroll=<id>[,<id>…]           enroll only these Seerr user ids (the canary)
  --anime-tags=<serverId>:<ids>   set Seerr's Sonarr animeTags (e.g. 0:1 for mediarequests), read back`;

export type SeerrWatchlistCommand =
  | { kind: 'show' }
  | { kind: 'enroll'; enabled: boolean; onlyUserIds: number[] | null }
  | { kind: 'anime-tags'; serverId: number; tags: number[] };

export function parseSeerrWatchlistArgs(argv: readonly string[]): SeerrWatchlistCommand | 'help' {
  if (argv.length !== 1) {
    if (argv.includes('--help') || argv.includes('-h')) return 'help';
    throw new Error('exactly one of --show, --enroll=…, --anime-tags=… is required');
  }
  const arg = argv[0] as string;
  if (arg === '--help' || arg === '-h') return 'help';
  if (arg === '--show') return { kind: 'show' };
  if (arg.startsWith('--enroll=')) {
    const v = arg.slice('--enroll='.length);
    if (v === 'off') return { kind: 'enroll', enabled: false, onlyUserIds: null };
    if (v === 'all') return { kind: 'enroll', enabled: true, onlyUserIds: null };
    const ids = v.split(',').map((x) => Number(x.trim()));
    if (ids.length === 0 || ids.some((n) => !Number.isInteger(n) || n <= 0)) {
      throw new Error(`--enroll expects off, all or Seerr user ids, got "${v}"`);
    }
    return { kind: 'enroll', enabled: true, onlyUserIds: ids };
  }
  if (arg.startsWith('--anime-tags=')) {
    const m = /^(\d+):(\d+(?:,\d+)*)$/.exec(arg.slice('--anime-tags='.length));
    if (!m) throw new Error('--anime-tags expects <serverId>:<tagId>[,<tagId>…]');
    return {
      kind: 'anime-tags',
      serverId: Number(m[1]),
      tags: (m[2] as string).split(',').map(Number),
    };
  }
  throw new Error(`unknown argument "${arg}"`);
}

async function main(): Promise<number> {
  const logger = createConsoleLogger();
  let cmd: SeerrWatchlistCommand | 'help';
  try {
    cmd = parseSeerrWatchlistArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`seerr-watchlist: ${(error as Error).message}\n\n${USAGE}`);
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
  if (cmd.kind === 'enroll') {
    const res = await setSeerrWatchlistEnroll({
      value: { enabled: cmd.enabled, onlyUserIds: cmd.onlyUserIds },
      actorId: null,
    });
    console.log(JSON.stringify(res, null, 2));
    return 0;
  }
  if (cmd.kind === 'anime-tags') {
    const res = await setSeerrSonarrAnimeTags({
      seerr: requireSeerrEnrollClientsFromEnv(),
      serverId: cmd.serverId,
      animeTags: cmd.tags,
      logger,
    });
    console.log(JSON.stringify(res, null, 2));
    return 0;
  }
  const summary = await getSeerrEnrollSummary({});
  const seerr = seerrEnrollClientsFromEnv();
  const servers = seerr ? await seerr.read.listSonarrServers() : null;
  console.log(JSON.stringify({ ...summary, sonarrServers: servers }, null, 2));
  return 0;
}

if (process.argv[1]?.endsWith('seerr-watchlist.ts')) {
  main()
    .then(async (code) => {
      await getPool()
        .end()
        .catch(() => {});
      process.exit(code);
    })
    .catch(async (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      await getPool()
        .end()
        .catch(() => {});
      process.exit(1);
    });
}
