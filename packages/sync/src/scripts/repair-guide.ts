// ADR-109 / DESIGN-055 D-01, D-08, D-09 (PLAN-077 P1) — the Repair Guide's in-cluster tool (not a sync mode):
//
//   tsx repair-guide.ts preview  (--tmdb <id> | --tvdb <id>) [--episode S01E05 | --season <n> [--episodes 1,2]]
//                                [--replace-file]
//   tsx repair-guide.ts evidence (--tmdb <id> | --tvdb <id>) --email <app user email>
//   tsx repair-guide.ts audio    (--tmdb <id> | --tvdb <id>) [--episode S01E05 | --season <n>]
//   tsx repair-guide.ts settings [--set remedy=on|off,...] [--known-issue slug,slug | --known-issue none]
//
// `preview`, `evidence` and `audio` only READ: they print the guarded Fix's plan (with every planning remedy on,
// whatever the stored switch says, so a remedy can be checked live before it is turned on), a person's Playback
// Evidence, or the file's audio languages. Nothing is sent to an *arr but GETs; `preview` runs the *arr's interactive
// release search when a file would be deleted (it searches the indexers; it grabs nothing). `settings` prints the
// switch and, with `--set` / `--known-issue`, writes it through the audited single writer (actor null: the
// coordinator, the PLAN-065 janitor-flip precedent).
//
// Env: DATABASE_URL, SONARR_API_KEY, RADARR_API_KEY, LIDARR_API_KEY, BAZARR_API_KEY (URLs default in-cluster), and the
// TAUTULLI_* keys for `evidence`.
import { and, eq, isNull } from 'drizzle-orm';
import { REPAIR_GUIDE_REMEDIES, db as defaultDb, getPool, mediaItems, users, type RepairGuideRemedy } from '@hnet/db';
import { resolveTautulliInstances } from '@hnet/arr';
import { TautulliClient } from '@hnet/arr/read';
import {
  allRemediesOff,
  arrClientBundleFromEnv,
  getKnownIssueServers,
  getRepairGuideRemedies,
  planFix,
  readFileAudio,
  readPlaybackEvidence,
  setKnownIssueServers,
  setRepairGuideRemedies,
} from '@hnet/domain';

const USAGE = `Usage:
  repair-guide.ts preview  (--tmdb <id> | --tvdb <id>) [--episode S01E05 | --season <n> [--episodes 1,2]] [--replace-file]
  repair-guide.ts evidence (--tmdb <id> | --tvdb <id>) --email <app user email>
  repair-guide.ts audio    (--tmdb <id> | --tvdb <id>) [--episode S01E05 | --season <n>]
  repair-guide.ts settings [--set remedy=on|off,...] [--known-issue slug,slug | --known-issue none]

preview, evidence and audio only read. settings writes only with --set or --known-issue (audited, actor null).
Remedies: ${REPAIR_GUIDE_REMEDIES.join(', ')}.`;

export interface RepairGuideArgs {
  command: 'preview' | 'evidence' | 'audio' | 'settings';
  tmdb?: number;
  tvdb?: number;
  episode?: { season: number; episode: number };
  season?: number;
  episodes?: number[];
  replaceFile: boolean;
  email?: string;
  set?: Partial<Record<RepairGuideRemedy, boolean>>;
  knownIssue?: string[];
}

const positiveInt = (flag: string, value: string | undefined): number => {
  if (value === undefined || !/^\d+$/.test(value)) throw new Error(`${flag} needs a whole number`);
  return Number(value);
};

/** Parse the command line (exported for the unit test). */
export function parseRepairGuideArgs(argv: readonly string[]): RepairGuideArgs | 'help' {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === '-h') return 'help';
  if (command !== 'preview' && command !== 'evidence' && command !== 'audio' && command !== 'settings') {
    throw new Error(`unknown command "${command}"`);
  }
  const args: RepairGuideArgs = { command, replaceFile: false };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i]!;
    const value = rest[i + 1];
    switch (flag) {
      case '--tmdb':
        args.tmdb = positiveInt(flag, value);
        i += 1;
        break;
      case '--tvdb':
        args.tvdb = positiveInt(flag, value);
        i += 1;
        break;
      case '--season':
        args.season = positiveInt(flag, value);
        i += 1;
        break;
      case '--episode': {
        const m = /^S(\d+)E(\d+)$/i.exec(value ?? '');
        if (!m) throw new Error('--episode needs the form S01E05');
        args.episode = { season: Number(m[1]), episode: Number(m[2]) };
        i += 1;
        break;
      }
      case '--episodes':
        args.episodes = (value ?? '').split(',').map((n) => positiveInt(flag, n.trim()));
        i += 1;
        break;
      case '--replace-file':
        args.replaceFile = true;
        break;
      case '--email':
        if (!value) throw new Error('--email needs an address');
        args.email = value.trim().toLowerCase();
        i += 1;
        break;
      case '--set': {
        args.set = {};
        for (const pair of (value ?? '').split(',')) {
          const [name, state] = pair.split('=').map((s) => s.trim());
          if (!(REPAIR_GUIDE_REMEDIES as readonly string[]).includes(name ?? '')) {
            throw new Error(`unknown remedy "${name}"`);
          }
          if (state !== 'on' && state !== 'off') throw new Error(`remedy ${name} needs =on or =off`);
          args.set[name as RepairGuideRemedy] = state === 'on';
        }
        i += 1;
        break;
      }
      case '--known-issue':
        if (!value) throw new Error('--known-issue needs server slugs or "none"');
        args.knownIssue = value === 'none' ? [] : value.split(',').map((s) => s.trim());
        i += 1;
        break;
      default:
        throw new Error(`unknown argument "${flag}"`);
    }
  }
  if (command !== 'settings') {
    if ((args.tmdb === undefined) === (args.tvdb === undefined)) throw new Error('give exactly one of --tmdb or --tvdb');
    if (args.tmdb !== undefined && (args.episode || args.season !== undefined)) {
      throw new Error('--episode and --season are for a show (--tvdb)');
    }
    if (args.tvdb !== undefined && command !== 'evidence' && !args.episode && args.season === undefined) {
      throw new Error('a show needs --episode or --season');
    }
    if (command === 'evidence' && !args.email) throw new Error('evidence needs --email');
  }
  if (args.episodes && args.season === undefined) throw new Error('--episodes goes with --season');
  return args;
}

async function main(): Promise<number> {
  let args: RepairGuideArgs | 'help';
  try {
    args = parseRepairGuideArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`repair-guide: ${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (args === 'help') {
    console.log(USAGE);
    return 0;
  }
  if (!process.env.DATABASE_URL) {
    console.error('repair-guide: DATABASE_URL is required');
    return 2;
  }
  const db = defaultDb;

  if (args.command === 'settings') {
    if (args.set) await setRepairGuideRemedies({ db, remedies: args.set, actorId: null });
    if (args.knownIssue) await setKnownIssueServers({ db, servers: args.knownIssue, actorId: null });
    console.log(
      JSON.stringify(
        { remedies: await getRepairGuideRemedies(db), knownIssueServers: await getKnownIssueServers(db) },
        null,
        2,
      ),
    );
    return 0;
  }

  const kind = args.tmdb !== undefined ? 'radarr' : 'sonarr';
  const [item] = await db
    .select({ id: mediaItems.id, title: mediaItems.title })
    .from(mediaItems)
    .where(
      and(
        eq(mediaItems.arrKind, kind),
        kind === 'radarr' ? eq(mediaItems.tmdbId, args.tmdb!) : eq(mediaItems.tvdbId, args.tvdb!),
        isNull(mediaItems.deletedFromArrAt),
      ),
    );
  if (!item) {
    console.error(`repair-guide: no live ${kind} item with ${kind === 'radarr' ? 'tmdb' : 'tvdb'} id ${args.tmdb ?? args.tvdb}`);
    return 1;
  }

  if (args.command === 'evidence') {
    const [person] = await db.select({ id: users.id }).from(users).where(eq(users.email, args.email!));
    if (!person) {
      console.error('repair-guide: no app user with that email');
      return 1;
    }
    const evidence = await readPlaybackEvidence({
      db,
      mediaItemId: item.id,
      requesterId: person.id,
      tautulli: resolveTautulliInstances().map((inst) => {
        const client = new TautulliClient({ baseUrl: inst.baseUrl, apiKey: inst.apiKey, timeoutMs: 15_000 });
        return { slug: inst.slug, getHistory: (params) => client.getHistory(params) };
      }),
    });
    console.log(JSON.stringify({ title: item.title, evidence }, null, 2));
    return 0;
  }

  const arr = arrClientBundleFromEnv();
  let scope: { scope?: 'episode' | 'season'; targetChildId?: number; seasonNumber?: number } = {};
  if (kind === 'sonarr') {
    if (args.episode) {
      const series = await db
        .select({ arrItemId: mediaItems.arrItemId })
        .from(mediaItems)
        .where(eq(mediaItems.id, item.id));
      const episodes = await arr.read.sonarr.listEpisodes(series[0]!.arrItemId);
      const ep = episodes.find(
        (e) => e.seasonNumber === args.episode!.season && e.episodeNumber === args.episode!.episode,
      );
      if (!ep) {
        console.error('repair-guide: no such episode on the series');
        return 1;
      }
      scope = { scope: 'episode', targetChildId: ep.id };
    } else {
      scope = { scope: 'season', seasonNumber: args.season! };
    }
  }

  if (args.command === 'audio') {
    const audio = await readFileAudio({ db, arr, mediaItemId: item.id, ...scope });
    console.log(JSON.stringify({ title: item.title, audio }, null, 2));
    return 0;
  }

  // preview: every planning remedy on, so the guard can be checked live before the switch is turned on.
  let episodeIds: number[] | undefined;
  if (args.episodes && scope.seasonNumber !== undefined) {
    const series = await db.select({ arrItemId: mediaItems.arrItemId }).from(mediaItems).where(eq(mediaItems.id, item.id));
    const episodes = await arr.read.sonarr.listEpisodes(series[0]!.arrItemId);
    episodeIds = episodes
      .filter((e) => e.seasonNumber === scope.seasonNumber && args.episodes!.includes(e.episodeNumber))
      .map((e) => e.id);
  }
  const plan = await planFix({
    db,
    arr,
    mediaItemId: item.id,
    ...scope,
    episodeIds,
    replaceFile: args.replaceFile,
    remedies: { ...allRemediesOff(), replacement_preview: true, season_guard: true },
  });
  console.log(JSON.stringify({ title: item.title, plan }, null, 2));
  return 0;
}

// Run only as a script (tests import parseRepairGuideArgs).
if (process.argv[1]?.endsWith('repair-guide.ts')) {
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
