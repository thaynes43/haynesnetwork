// ADR-109 / DESIGN-055 D-01, D-08, D-09 (PLAN-077 P1) — the Repair Guide's in-cluster tool (not a sync mode):
//
//   tsx repair-guide.ts preview  (--tmdb <id> | --tvdb <id>) [--episode S01E05 | --season <n> [--episodes 1,2]]
//                                [--replace-file]
//   tsx repair-guide.ts evidence (--tmdb <id> | --tvdb <id>) --email <app user email>
//                                [--plex-user-id <plex.tv id>] [--plex-username <name>]
//   tsx repair-guide.ts audio    (--tmdb <id> | --tvdb <id>) [--episode S01E05 | --season <n>]
//   tsx repair-guide.ts settings [--set remedy=on|off,...] [--known-issue slug,slug | --known-issue none]
//   tsx repair-guide.ts search-plan (--tmdb <id> | --tvdb <id> --episode S01E05)
//   tsx repair-guide.ts release-list (--tmdb <id> | --tvdb <id> --episode S01E05) [--json]
//   tsx repair-guide.ts release-grab (--tmdb <id> | --tvdb <id> --episode S01E05) --key <row key from release-list>
//   tsx repair-guide.ts queue-check
//   tsx repair-guide.ts title-check (--backfill [--dry-run] [--json] | --flags <sonarr series id>)
//   tsx repair-guide.ts season-plan --tvdb <id> --season <n> [--place <from>:<to>,...] [--keep <n>,...] [--json]
//   tsx repair-guide.ts season-run  --tvdb <id> --season <n> [--place ...] [--keep ...] --digest <d> [--ignore-plex]
//   tsx repair-guide.ts copy-plan --tvdb <id> --episode S06E10 [--copy-of <n>]
//   tsx repair-guide.ts copy-run  --tvdb <id> --episode S06E10 [--copy-of <n>] --digest <d> --evidence "<note>"
//   tsx repair-guide.ts ordering-plan --tvdb <id> --ordering tvdbAiring
//   tsx repair-guide.ts ordering-run  --tvdb <id> --ordering tvdbAiring --digest <d>
//   tsx repair-guide.ts carry-status (--carry <id> | --tvdb <id>)
//   tsx repair-guide.ts carry-finish --carry <id>
//   tsx repair-guide.ts carry-revert --carry <id>
//   tsx repair-guide.ts replace-plan --tvdb <id> (--episode S03E01 [--also 2] | --season <n> --slots 1,2,33+34)
//   tsx repair-guide.ts replace-run  --tvdb <id> --episode S03E01 [--also 2] --key <key>[,<key>] --digest <d>
//                                    --evidence "<note>" [--same-as S03E07,S03E08 | --same-as 33:S03E65,34:S03E67]
//   tsx repair-guide.ts replace-batch --tvdb <id> --season <n> --batch '<json>' [--pause-ms <ms>]
//
// `replace-plan` / `replace-run` (DESIGN-055 P4 decision 38, coordinator ruling on #928) are staff's Wrong-Content
// Replace: a file that holds the wrong content (another season's story, another show's episode) is replaced only when a
// correct release exists. The plan only reads: the Release Pick's own season search, judged as if the file were gone,
// keeping the releases whose names agree with the slot's episodes and cover the whole slot. The run re-plans, snapshots
// the watch state, deletes the file and grabs the chosen release onto the slot (one Fix Request, requester null). A mark
// on the wrong content never lands on the replacement: `--same-as` names the episodes whose own file holds that same
// story (the carry credits the plays there); without it the marks are dropped and recorded on the carry. `--also` replaces
// more files with the same slot (one release holds all their episodes); `--key a,b` fills a slot from parts. A release
// the *arr renumbers (scene numbering) is judged by its own name and titles. `--slots` plans many slots and
// `replace-batch` runs them in one process, one season search between them (indexer API hits are capped); the batch is
// a JSON list of {"slot":"33+34","keys":[..],"digest":"..","evidence":"..","sameAs":["33:S03E65",..]}, run in order,
// stopping at the first refusal.
//
// The WATCH CARRY (ADR-114, DESIGN-055 P4 decisions 26-34; owner ruling on issue #928, 2026-10-13: "Carry marks, then
// move"): `season-run` and `copy-run` always snapshot every account's Plex watch state first (the owner, and each friend
// with the per-server token plex.tv lists; tokens stay in memory and are never printed), refuse when that cannot be
// read, clear the items the move takes files away from, and after the move put each account's plays and resume point
// on the item that now plays the file they watched, then verify per account. `ordering-plan | ordering-run` switch a
// show's Plex episode ordering (TheTVDB Aired is `tvdbAiring`) inside the same carry. `carry-status` prints a carry's
// counts (by account index, never a name); `carry-finish` runs the carry again from the stored snapshot (after Plex
// caught up, or after a mismatch); `carry-revert` restores every item the carry wrote to its state before.
//
// `copy-plan` / `copy-run` (DESIGN-055 P4 decision 25, issue #928) are staff's Second-Copy Fix: an episode whose file
// holds another episode of the season that already has its own file. The plan only reads; the run opens a Fix Request
// with no requester (reason `wrong_content`, path `delete_search`), deletes the copy, reads back that the original is
// still on its own episode, and searches for the emptied episode. It refuses when the copy is the only one, or when
// another file says it is this episode (re-map instead). Staff confirm the two files hold the same episode first.
//
// `season-plan` / `season-run` (DESIGN-055 P4 decisions 18-24, issue #916) are staff's Season Re-map: every file of the
// season moves to the episode its own name says (staff place the files whose names say nothing, `--place 21:28`, a
// two-episode file `--place 53-54:27-28`, by subtitle or title-card evidence), cycles pass through a free parking
// episode, and each file is renamed right after its move. `season-plan` only reads (Sonarr and Plex) and prints the
// steps, the files that stay and why, the Plex check and the digest; `season-run` re-plans, refuses a changed plan, a
// failed Plex check (unless `--ignore-plex`) or the remedy switched off, then runs the steps (one Repair Request,
// requester null). Check every Plex server's watch state for the season first (the staff runbook in DESIGN-055).
//
// `search-plan` (DESIGN-055 D-07, PLAN-077 P2) prints what a queue-aware Force Search press would do: the target's queue
// state and the Import Check on a stuck download, planned as if `import_check` were on. It only reads (the queue, the
// manual-import view, the episode list); nothing is imported, removed or searched. `queue-check` runs the Import Check
// over Sonarr's and Radarr's whole queues exactly as the janitor selects (DESIGN-046 D-27: every record `unknown`, stuck,
// with an identity rejection) and prints one line per download: the census spot-check, read-only.
//
// `release-list` (DESIGN-055 D-06, PLAN-077 P5) prints the Release Pick's list for one missing episode or movie: each row
// with its state (Grab, Override, Not allowed), the reasons in plain words beside the *arr's own, and the recommended
// pick. It runs the *arr's interactive search (Sonarr's season list, Radarr's movie list; it searches the indexers), and
// records nothing: no Release List row, no budget unit, no grab. The live check compares it with the *arr's own
// interactive search for the same episode or movie. `release-grab` is staff's Release Pick (DESIGN-055 P5 decision 14,
// the remap-run pattern): it opens a fresh list as staff (requester null: no budget), finds the row whose key
// `release-list` printed, and grabs it exactly as the guide does: the same refusals (a Not allowed row is never
// grabbed, by anyone), one Repair Request, the plain or the override body.
//
// `title-check` (ADR-110 C-03 / DESIGN-055 D-05, PLAN-077 P4): `--backfill` runs the one-off library-wide Title Check
// (every `downloadFolderImported` record, and the scene name of a current file with no import record) and prints the
// counts, then one line per file whose name says it is another episode; it writes title_checks rows (origin `backfill`)
// unless `--dry-run`. `--flags` prints one series' open flags, verified live (a stale flag is cleared). Both only READ
// Sonarr.
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
  arrQueueCleanupClientsFromEnv,
  classifyQueueItem,
  getRepairGuideRemedies,
  groupQueueRecordsByDownload,
  hasIdentityRejection,
  importCheckReasonText,
  planFix,
  planEpisodeRemap,
  planSeasonRemap,
  planSecondCopyFix,
  runSecondCopyFix,
  secondCopyRefusalText,
  plexClientBundleFromEnv,
  runSeasonRemap,
  seasonPlexReader,
  type SeasonRemapView,
  planForceSearch,
  previewReleaseList,
  openReleaseList,
  grabFromReleaseList,
  readRemapSeason,
  runEpisodeRemap,
  queueTexts,
  readFileAudio,
  previewAudioPreference,
  setAudioPreference,
  readLanguagePlan,
  scanAudioDefaults,
  householdTarget,
  readPlaybackEvidence,
  setKnownIssueServers,
  setRepairGuideRemedies,
  backfillTitleChecks,
  listTitleFlags,
  titleCheckSonarrFromEnv,
  type TitleCheckBackfillReport,
  carryWatchState,
  listWatchCarries,
  planShowOrdering,
  revertWatchCarry,
  runShowOrdering,
  watchCarryPlexFromEnv,
  type WatchCarryResult,
  planWrongContentReplace,
  runWrongContentReplace,
  wrongContentRefusalText,
} from '@hnet/domain';

const USAGE = `Usage:
  repair-guide.ts preview  (--tmdb <id> | --tvdb <id>) [--episode S01E05 | --season <n> [--episodes 1,2]] [--replace-file]
  repair-guide.ts evidence (--tmdb <id> | --tvdb <id>) --email <app user email> [--plex-user-id <id>] [--plex-username <name>]
  repair-guide.ts audio    (--tmdb <id> | --tvdb <id>) [--episode S01E05 | --season <n>]
  repair-guide.ts audio-preference (--tmdb <id> | --tvdb <id> (--episode S01E05 | --season <n>)) --language eng [--household] [--digest <d>]
  repair-guide.ts language-plan (--tmdb <id> | --tvdb <id> --episode S01E05) --language eng
  repair-guide.ts audio-scan [--json] [--apply-original eng | --apply-household]
  repair-guide.ts settings [--set remedy=on|off,...] [--known-issue slug,slug | --known-issue none]
  repair-guide.ts search-plan (--tmdb <id> | --tvdb <id> --episode S01E05)
  repair-guide.ts release-list (--tmdb <id> | --tvdb <id> --episode S01E05) [--json]
  repair-guide.ts release-grab (--tmdb <id> | --tvdb <id> --episode S01E05) --key <row key from release-list>
  repair-guide.ts queue-check
  repair-guide.ts title-check (--backfill [--dry-run] [--json] | --flags <sonarr series id>)
  repair-guide.ts remap-plan --tvdb <id> --season <n> [--shift <from>:<+1|-1>[:<through>] | --move <from>:<to>]
  repair-guide.ts remap-run  --tvdb <id> --season <n> (--shift ... | --move ...) --digest <the remap-plan digest>
  repair-guide.ts season-plan --tvdb <id> --season <n> [--place <from>:<to>,...] [--keep <n>,...] [--json]
  repair-guide.ts season-run  --tvdb <id> --season <n> [--place ...] [--keep ...] --digest <the season-plan digest> [--ignore-plex]
  repair-guide.ts copy-plan --tvdb <id> --episode S06E10 [--copy-of <n>]
  repair-guide.ts copy-run  --tvdb <id> --episode S06E10 [--copy-of <n>] --digest <the copy-plan digest> --evidence "<note>"
  repair-guide.ts ordering-plan --tvdb <id> --ordering <tvdbAiring|tmdbAiring|tvdbDvd|tvdbAbsolute|default>
  repair-guide.ts ordering-run  --tvdb <id> --ordering <...> --digest <the ordering-plan digest>
  repair-guide.ts carry-status (--carry <id> | --tvdb <id>)
  repair-guide.ts carry-finish --carry <id>
  repair-guide.ts carry-revert --carry <id>
  repair-guide.ts replace-plan --tvdb <id> (--episode S03E01 [--also <n>,...] | --season <n> --slots 1,2,33+34)
  repair-guide.ts replace-run  --tvdb <id> --episode S03E01 [--also <n>,...] --key <key>[,<key>] --digest <the replace-plan digest> --evidence "<note>" [--same-as [<n>:]S03E07,...]
  repair-guide.ts replace-batch --tvdb <id> --season <n> --batch '<json list>' [--pause-ms <ms>]

preview, evidence, audio, search-plan, release-list, queue-check and remap-plan only read (remap-plan plans as if episode_remap were on). settings writes only with --set or --known-issue (audited, actor null).
title-check only reads Sonarr; --backfill writes title_checks rows unless --dry-run, --flags clears a stale flag.
remap-run is staff's Episode Re-map (DESIGN-055 P4 decision 17): it re-plans, refuses unless the plan's digest is the one
given, then moves the files exactly as the guide does (one Repair Request, requester null: the staff tool).
season-plan only reads Sonarr and Plex; season-run is staff's Season Re-map (DESIGN-055 P4 decisions 18-24): files go
where their names (or --place) say, cycles pass through a free episode, each file is renamed after its move.
copy-plan only reads; copy-run is staff's Second-Copy Fix (DESIGN-055 P4 decision 25): it deletes a file whose episode
already has its own file and searches for the episode the slot is missing (a Fix Request, requester null).
release-grab is staff's Release Pick (DESIGN-055 P5 decision 14): a fresh list as staff, then the grab of the row with
that key, with the guide's refusals (one Repair Request, requester null).
audio-preference only reads without --digest (the Wrong language decision: set, already set, or guidance, and why); with
the --digest it printed it is staff's Audio Preference (DESIGN-055 P6): the show's preferred audio language on every Plex
server that carries it, read back (one Repair Request, requester null). language-plan only reads (the Language Replace
plan, as if language_search were on). audio-scan only reads: every Sonarr series whose files carry the original language
behind another one, confirmed in Plex on one file, with each Plex server's stored preference (DESIGN-055 P6 decision 10);
with --apply-original <code> it then sets the Audio Preference, as staff, on every finding whose original language is
that one and whose Plex default is another (one Repair Request each, requester null; needs the audio_preference remedy).
--apply-household applies the owner's ruling on #955 (DESIGN-055 P6 decision 14) to every finding: English where the
show's files carry an English track, else the original language; a show whose files already start in that language is a
no-op. audio-preference --household previews or sets one show under the same rule (staff only).
season-run, copy-run and ordering-run carry every account's Plex watch state onto the content it watched (the Watch
Carry, ADR-114): a snapshot first (refused when it cannot be read), then the move, then the carry and a per-account
check. carry-finish re-runs a carry from its snapshot; carry-revert restores what it wrote.
Remedies: ${REPAIR_GUIDE_REMEDIES.join(', ')}.`;

export interface RepairGuideArgs {
  command:
    | 'preview'
    | 'evidence'
    | 'audio'
    | 'settings'
    | 'search-plan'
    | 'release-list'
    | 'release-grab'
    | 'queue-check'
    | 'title-check'
    | 'remap-plan'
    | 'remap-run'
    | 'season-plan'
    | 'season-run'
    | 'copy-plan'
    | 'copy-run'
    | 'audio-preference'
    | 'language-plan'
    | 'audio-scan'
    | 'ordering-plan'
    | 'ordering-run'
    | 'carry-status'
    | 'carry-finish'
    | 'carry-revert'
    | 'replace-plan'
    | 'replace-run'
    | 'replace-batch';
  /**
   * replace-run: the episodes (this show) whose own file holds a wrong file's story; `copyOf` names the slot episode
   * whose file it copies (needed when the slot has several files).
   */
  sameAs?: Array<{ season: number; episode: number; copyOf?: number }>;
  /** replace-plan / replace-run: more episodes whose files are replaced with the slot. */
  also?: number[];
  /** replace-plan: many slots planned from one search (`33+34` is one slot of two files). */
  slots?: Array<{ episode: number; also: number[] }>;
  /** replace-batch: the slots to run, in order. */
  batch?: ReplaceBatchEntry[];
  /** replace-batch: the pause between slots. */
  pauseMs?: number;
  /** audio-preference / language-plan: the wanted audio language (ISO 639-2, e.g. `eng`). */
  language?: string;
  /** audio-scan: set the Audio Preference on the findings whose original language is this one. */
  applyOriginal?: string;
  /** audio-scan: apply the owner's household default (#955) to every finding. audio-preference: use that rule. */
  household?: boolean;
  /** ordering-plan / ordering-run: Plex's ordering value (`default` is the library default, sent as ''). */
  ordering?: string;
  /** carry-status / carry-finish / carry-revert: the Watch Carry's id. */
  carry?: string;
  /** remap-run: the digest of the remap-plan output staff confirmed. */
  digest?: string;
  /** release-grab: the row key release-list printed. */
  key?: string;
  tmdb?: number;
  tvdb?: number;
  episode?: { season: number; episode: number };
  season?: number;
  episodes?: number[];
  replaceFile: boolean;
  email?: string;
  /** The person's Plex identity as their sign-in carries it (the app keeps it in the session, not the user row). */
  plexUserId?: string;
  plexUsername?: string;
  set?: Partial<Record<RepairGuideRemedy, boolean>>;
  knownIssue?: string[];
  /** title-check: the one-off backfill (with `dryRun`: write nothing), or one series' open flags. */
  backfill?: boolean;
  dryRun?: boolean;
  json?: boolean;
  flagsSeriesId?: number;
  /** season-plan / season-run: staff placements (episode numbers; a two-episode file as a range) and kept episodes. */
  placements?: Array<{ from: number[]; to: number[] }>;
  keep?: number[];
  /** season-run: run although the Plex check failed (staff decision, recorded on the Repair Request). */
  ignorePlex?: boolean;
  /** copy-plan / copy-run: the episode the copy holds, from staff evidence, when its names do not say. */
  copyOf?: number | number[];
  /** copy-run: staff's evidence that both files hold the same episode. */
  evidence?: string;
  /** remap-plan: a claim by episode numbers (none: the season view and the suggested claim). */
  remap?: { kind: 'shift'; from: number; by: 1 | -1; through: number | null } | { kind: 'single'; from: number; to: number };
}

const positiveInt = (flag: string, value: string | undefined): number => {
  if (value === undefined || !/^\d+$/.test(value)) throw new Error(`${flag} needs a whole number`);
  return Number(value);
};

/** One slot of a `replace-batch` run, as staff wrote it from the `replace-plan --slots` output. */
export interface ReplaceBatchEntry {
  episode: number;
  also: number[];
  keys: string[];
  digest: string;
  evidence: string;
  sameAs: Array<{ season: number; episode: number; copyOf?: number }>;
}

/** `S03E07,S03E08`, or `33:S03E65,34:S03E67` (the slot episode whose file each copies). */
function parseSameAs(value: string): Array<{ season: number; episode: number; copyOf?: number }> {
  return value.split(',').map((part) => {
    const m = /^(?:(\d+):)?S(\d+)E(\d+)$/i.exec(part.trim());
    if (!m) throw new Error('--same-as needs episodes like S03E07,S03E08 (or 33:S03E65 for a slot of several files)');
    return { season: Number(m[2]), episode: Number(m[3]), ...(m[1] !== undefined ? { copyOf: Number(m[1]) } : {}) };
  });
}

/** `1,2,33+34`: one slot per comma; `+` joins the episodes whose files are replaced together. */
function parseSlots(value: string): Array<{ episode: number; also: number[] }> {
  return value.split(',').map((part) => {
    const nums = part.trim().split('+');
    if (nums.some((n) => !/^\d+$/.test(n))) throw new Error('--slots needs episode numbers like 1,2,33+34');
    return { episode: Number(nums[0]), also: nums.slice(1).map(Number) };
  });
}

function parseReplaceBatch(value: string): ReplaceBatchEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    throw new Error('--batch needs a JSON list');
  }
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('--batch needs a JSON list of slots');
  return raw.map((e: Record<string, unknown>, i) => {
    const at = `--batch entry ${i + 1}`;
    if (typeof e !== 'object' || e === null) throw new Error(`${at} is not an object`);
    const [slot] = parseSlots(String(e.slot ?? ''));
    const keys = Array.isArray(e.keys) ? e.keys.map(String) : [];
    if (keys.length === 0 || keys.some((k) => !/^[0-9a-f]{16}$/.test(k))) throw new Error(`${at} needs "keys" (the plan's 16-character keys)`);
    const digest = String(e.digest ?? '');
    if (!/^[0-9a-f]{8,64}$/.test(digest)) throw new Error(`${at} needs the plan's "digest"`);
    const evidence = String(e.evidence ?? '').trim();
    if (evidence.length < 10) throw new Error(`${at} needs "evidence" (what was read)`);
    const sameAs = Array.isArray(e.sameAs) && e.sameAs.length > 0 ? parseSameAs(e.sameAs.map(String).join(',')) : [];
    return { episode: slot!.episode, also: slot!.also, keys, digest, evidence, sameAs };
  });
}

/** Parse the command line (exported for the unit test). */
export function parseRepairGuideArgs(argv: readonly string[]): RepairGuideArgs | 'help' {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === '-h') return 'help';
  if (
    command !== 'preview' &&
    command !== 'evidence' &&
    command !== 'audio' &&
    command !== 'settings' &&
    command !== 'search-plan' &&
    command !== 'release-list' &&
    command !== 'release-grab' &&
    command !== 'queue-check' &&
    command !== 'title-check' &&
    command !== 'remap-plan' &&
    command !== 'remap-run' &&
    command !== 'season-plan' &&
    command !== 'season-run' &&
    command !== 'copy-plan' &&
    command !== 'copy-run' &&
    command !== 'audio-preference' &&
    command !== 'language-plan' &&
    command !== 'audio-scan' &&
    command !== 'ordering-plan' &&
    command !== 'ordering-run' &&
    command !== 'carry-status' &&
    command !== 'carry-finish' &&
    command !== 'carry-revert' &&
    command !== 'replace-plan' &&
    command !== 'replace-run' &&
    command !== 'replace-batch'
  ) {
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
      case '--plex-user-id':
        if (!value || !/^\d+$/.test(value)) throw new Error('--plex-user-id needs the plex.tv numeric id');
        args.plexUserId = value;
        i += 1;
        break;
      case '--plex-username':
        if (!value) throw new Error('--plex-username needs a name');
        args.plexUsername = value.trim().toLowerCase();
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
      case '--backfill':
        args.backfill = true;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--json':
        args.json = true;
        break;
      case '--shift': {
        const m = /^(\d+):([+-]1)(?::(\d+))?$/.exec(value ?? '');
        if (!m) throw new Error('--shift needs <from>:<+1|-1>[:<through>], e.g. 11:+1:18');
        args.remap = { kind: 'shift', from: Number(m[1]), by: m[2] === '+1' ? 1 : -1, through: m[3] ? Number(m[3]) : null };
        i += 1;
        break;
      }
      case '--move': {
        const m = /^(\d+):(\d+)$/.exec(value ?? '');
        if (!m) throw new Error('--move needs <from episode>:<to episode>, e.g. 24:23');
        args.remap = { kind: 'single', from: Number(m[1]), to: Number(m[2]) };
        i += 1;
        break;
      }
      case '--digest':
        if (!value || !/^[0-9a-f]{8,64}$/.test(value)) throw new Error('--digest needs the plan digest remap-plan printed');
        args.digest = value;
        i += 1;
        break;
      case '--key':
        if (!value || !/^[0-9a-f]{16}(,[0-9a-f]{16})*$/.test(value)) throw new Error('--key needs the 16-character row key release-list printed');
        if (value.includes(',') && command !== 'replace-run') throw new Error('only replace-run takes several keys');
        args.key = value;
        i += 1;
        break;
      case '--flags':
        args.flagsSeriesId = positiveInt(flag, value);
        i += 1;
        break;
      case '--place': {
        const range = (part: string) => {
          const m = /^(\d+)(?:-(\d+))?$/.exec(part);
          if (!m) return null;
          const a = Number(m[1]);
          const b = m[2] ? Number(m[2]) : a;
          if (b < a || b - a > 9) return null;
          return Array.from({ length: b - a + 1 }, (_, k) => a + k);
        };
        // DESIGN-055 P4 decision 35: the two sides may name different counts (`17:33-34`, `5-8:3-4`), and a target may
        // list episodes that are not next to each other (`29-30:25+32`).
        const list = (part: string) => {
          const pieces = part.split('+').map((x) => range(x.trim()));
          if (pieces.some((x) => x === null)) return null;
          const all = pieces.flatMap((x) => x!);
          return new Set(all).size === all.length && all.length <= 10 ? all : null;
        };
        args.placements = [...(args.placements ?? [])];
        for (const pair of (value ?? '').split(',')) {
          const [from, to] = pair.trim().split(':');
          const f = from !== undefined ? range(from) : null;
          const t = to !== undefined ? list(to) : null;
          if (!f || !t) {
            throw new Error('--place needs <from>:<to> pairs, e.g. 21:28, 53-54:27-28, 17:33-34 or 29-30:25+32 (comma separated)');
          }
          args.placements.push({ from: f, to: t });
        }
        i += 1;
        break;
      }
      case '--keep':
        args.keep = [...(args.keep ?? []), ...(value ?? '').split(',').map((n) => positiveInt(flag, n.trim()))];
        i += 1;
        break;
      case '--ignore-plex':
        args.ignorePlex = true;
        break;
      case '--copy-of':
        // P4 decision 37: a multi-episode copy names every episode it holds (`--copy-of 46-47` or `46+47`).
        {
          const parts = (value ?? '').split('+').flatMap((piece) => {
            const m = /^(\d+)(?:-(\d+))?$/.exec(piece.trim());
            if (!m) throw new Error('--copy-of needs an episode number, a range (46-47) or a list (46+47)');
            const a = Number(m[1]);
            const b = m[2] ? Number(m[2]) : a;
            if (b < a || b - a > 9) throw new Error('--copy-of needs an episode number, a range (46-47) or a list (46+47)');
            return Array.from({ length: b - a + 1 }, (_, k) => a + k);
          });
          args.copyOf = parts.length === 1 ? parts[0]! : parts;
        }
        i += 1;
        break;
      case '--apply-household':
      case '--household':
        args.household = true;
        break;
      case '--apply-original':
        if (!value || !/^[a-z]{3}$/i.test(value)) throw new Error('--apply-original needs a three-letter code, e.g. eng');
        args.applyOriginal = value.toLowerCase();
        i += 1;
        break;
      case '--language':
        if (!value || !/^[a-z]{3}$/i.test(value)) throw new Error('--language needs a three-letter code, e.g. eng');
        args.language = value.toLowerCase();
        i += 1;
        break;
      case '--evidence':
        if (!value || value.trim().length < 10) throw new Error('--evidence needs a short note of what was compared');
        args.evidence = value.trim();
        i += 1;
        break;
      case '--ordering':
        if (!value || !/^(tvdbAiring|tmdbAiring|tvdbDvd|tvdbAbsolute|default)$/.test(value)) {
          throw new Error('--ordering needs tvdbAiring, tmdbAiring, tvdbDvd, tvdbAbsolute or default');
        }
        args.ordering = value === 'default' ? '' : value;
        i += 1;
        break;
      case '--carry':
        if (!value || !/^[0-9a-f-]{36}$/.test(value)) throw new Error('--carry needs the carry id a run printed');
        args.carry = value;
        i += 1;
        break;
      case '--same-as':
        args.sameAs = parseSameAs(value ?? '');
        i += 1;
        break;
      case '--also':
        args.also = (value ?? '').split(',').map((n) => positiveInt(flag, n.trim()));
        i += 1;
        break;
      case '--slots':
        args.slots = parseSlots(value ?? '');
        i += 1;
        break;
      case '--batch':
        args.batch = parseReplaceBatch(value ?? '');
        i += 1;
        break;
      case '--pause-ms':
        if (!value || !/^\d+$/.test(value)) throw new Error('--pause-ms needs a number of milliseconds');
        args.pauseMs = Number(value);
        i += 1;
        break;
      default:
        throw new Error(`unknown argument "${flag}"`);
    }
  }
  if (command === 'carry-status' || command === 'carry-finish' || command === 'carry-revert') {
    const extra = args.tmdb !== undefined || args.episode || args.season !== undefined || args.digest || args.ordering !== undefined || args.language !== undefined || args.applyOriginal !== undefined;
    if (extra) throw new Error(`${command} takes only --carry${command === 'carry-status' ? ' or --tvdb' : ''}`);
    if (command === 'carry-status' ? (args.carry === undefined) === (args.tvdb === undefined) : args.carry === undefined || args.tvdb !== undefined) {
      throw new Error(command === 'carry-status' ? 'carry-status needs exactly one of --carry <id> or --tvdb <id>' : `${command} needs --carry <id>`);
    }
    return args;
  }
  if (args.carry !== undefined) throw new Error('--carry is for carry-status, carry-finish and carry-revert');
  if (command === 'ordering-plan' || command === 'ordering-run') {
    if (args.tvdb === undefined || args.ordering === undefined || args.tmdb !== undefined || args.episode || args.season !== undefined) {
      throw new Error(`${command} needs --tvdb <id> and --ordering <value>`);
    }
    if (args.language !== undefined || args.applyOriginal !== undefined) throw new Error(`${command} takes only --tvdb, --ordering and --digest`);
    if (command === 'ordering-run' && !args.digest) throw new Error('ordering-run needs the --digest of the ordering-plan you checked');
    if (command === 'ordering-plan' && args.digest !== undefined) throw new Error('--digest is for ordering-run');
    return args;
  }
  if (args.ordering !== undefined) throw new Error('--ordering is for ordering-plan and ordering-run');
  if (command === 'audio-scan') {
    if (Object.keys(args).some((k) => !['command', 'replaceFile', 'json', 'applyOriginal', 'household'].includes(k))) {
      throw new Error('audio-scan takes only --json, --apply-original and --apply-household');
    }
    if (args.applyOriginal && args.household) throw new Error('give one of --apply-original or --apply-household');
    return args;
  }
  if (command === 'audio-preference' || command === 'language-plan') {
    if (!args.language) throw new Error(`${command} needs --language <code>`);
    if ((args.tmdb === undefined) === (args.tvdb === undefined)) throw new Error('give exactly one of --tmdb or --tvdb');
    if (args.tmdb !== undefined && (args.episode || args.season !== undefined)) throw new Error('--episode and --season are for a show (--tvdb)');
    if (args.tvdb !== undefined && command === 'language-plan' && !args.episode) throw new Error('language-plan on a show needs --episode');
    if (args.tvdb !== undefined && !args.episode && args.season === undefined) throw new Error('a show needs --episode or --season');
    if (args.digest !== undefined && command !== 'audio-preference') throw new Error('--digest is for audio-preference');
    if (args.household && command !== 'audio-preference') throw new Error('--household is for audio-preference');
    return args;
  }
  if (args.language !== undefined) throw new Error('--language is for audio-preference and language-plan');
  if (args.applyOriginal !== undefined) throw new Error('--apply-original is for audio-scan');
  if (args.household) throw new Error('--apply-household is for audio-scan, --household for audio-preference');
  if (command === 'title-check') {
    if ((args.backfill === true) === (args.flagsSeriesId !== undefined)) {
      throw new Error('title-check needs exactly one of --backfill or --flags <series id>');
    }
    if (args.dryRun && !args.backfill) throw new Error('--dry-run goes with --backfill');
    return args;
  }
  if (command === 'replace-plan' || command === 'replace-run' || command === 'replace-batch') {
    if (args.copyOf !== undefined || args.remap || args.placements || args.keep || args.ignorePlex || args.backfill || args.dryRun || args.flagsSeriesId !== undefined || args.tmdb !== undefined) {
      throw new Error(`${command} takes only --tvdb, --episode, --also, --season, --slots, --key, --digest, --evidence, --same-as, --batch and --pause-ms`);
    }
    if (args.tvdb === undefined) throw new Error(`${command} needs --tvdb <id>`);
    if (command === 'replace-batch') {
      if (args.season === undefined || !args.batch || args.episode || args.also || args.slots || args.key !== undefined || args.digest !== undefined || args.evidence !== undefined || args.sameAs) {
        throw new Error('replace-batch needs --tvdb, --season and --batch (each entry carries its own keys, digest, evidence and sameAs)');
      }
      return args;
    }
    if (args.batch || args.pauseMs !== undefined) throw new Error('--batch and --pause-ms are for replace-batch');
    if (command === 'replace-plan') {
      if (args.digest !== undefined || args.evidence !== undefined || args.key !== undefined || args.sameAs) {
        throw new Error('--key, --digest, --evidence and --same-as are for replace-run');
      }
      if (args.slots ? args.season === undefined || args.episode !== undefined || args.also !== undefined : !args.episode || args.season !== undefined) {
        throw new Error('replace-plan needs --episode S01E05 [--also ...], or --season <n> --slots 1,2,33+34');
      }
      return args;
    }
    if (!args.episode || args.season !== undefined || args.slots) throw new Error('replace-run needs --tvdb <id> and --episode S01E05');
    if (!args.digest || !args.evidence || !args.key) {
      throw new Error('replace-run needs the --key and --digest the replace-plan printed and the --evidence you read');
    }
    return args;
  }
  if (args.sameAs) throw new Error('--same-as is for replace-run');
  if (args.also || args.slots || args.batch || args.pauseMs !== undefined) throw new Error('--also, --slots, --batch and --pause-ms are for the replace commands');
  if (command === 'copy-plan' || command === 'copy-run') {
    if (args.tvdb === undefined || !args.episode || args.tmdb !== undefined || args.season !== undefined) {
      throw new Error(`${command} needs --tvdb <id> and --episode S01E05`);
    }
    if (command === 'copy-run' && (!args.digest || !args.evidence)) {
      throw new Error('copy-run needs the --digest of the copy-plan you checked and the --evidence you compared');
    }
    if (command === 'copy-plan' && (args.digest !== undefined || args.evidence !== undefined)) {
      throw new Error('--digest and --evidence are for copy-run');
    }
    if (args.remap || args.placements || args.keep || args.ignorePlex || args.backfill || args.dryRun || args.json || args.flagsSeriesId !== undefined) {
      throw new Error(`${command} takes only --tvdb, --episode, --copy-of, --digest and --evidence`);
    }
    return args;
  }
  if (args.copyOf !== undefined || args.evidence !== undefined) throw new Error('--copy-of and --evidence are for copy-plan and copy-run');
  if (command === 'season-plan' || command === 'season-run') {
    if (args.tvdb === undefined || args.season === undefined || args.tmdb !== undefined || args.episode) {
      throw new Error(`${command} needs --tvdb <id> and --season <n>`);
    }
    if (args.remap) throw new Error('--shift and --move are for remap-plan and remap-run');
    if (command === 'season-run' && !args.digest) throw new Error('season-run needs the --digest of the season-plan you checked');
    if (command === 'season-plan' && (args.digest !== undefined || args.ignorePlex)) {
      throw new Error('--digest and --ignore-plex are for season-run');
    }
    if (args.json && command === 'season-run') throw new Error('--json is for season-plan');
    if (args.backfill || args.dryRun || args.flagsSeriesId !== undefined) {
      throw new Error('--backfill, --dry-run and --flags are for title-check');
    }
    return args;
  }
  if (args.placements || args.keep || args.ignorePlex) throw new Error('--place, --keep and --ignore-plex are for season-plan and season-run');
  if (args.remap && command !== 'remap-plan' && command !== 'remap-run') {
    throw new Error('--shift and --move are for remap-plan and remap-run');
  }
  if (args.digest !== undefined && command !== 'remap-run') throw new Error('--digest is for remap-run');
  if ((args.key !== undefined) !== (command === 'release-grab')) throw new Error('release-grab needs --key, and only it takes one');
  if ((command === 'remap-plan' || command === 'remap-run') && (args.tvdb === undefined || args.season === undefined || args.episode)) {
    throw new Error(`${command} needs --tvdb <id> and --season <n>`);
  }
  if (command === 'remap-run' && (!args.remap || !args.digest)) {
    throw new Error('remap-run needs a claim (--shift or --move) and the --digest of the plan you checked');
  }
  if (args.backfill || args.dryRun || (args.json && command !== 'release-list') || args.flagsSeriesId !== undefined) {
    throw new Error('--backfill, --dry-run and --flags are for title-check (--json also for release-list)');
  }
  if (command !== 'settings' && command !== 'queue-check') {
    if ((args.tmdb === undefined) === (args.tvdb === undefined)) throw new Error('give exactly one of --tmdb or --tvdb');
    if (args.tmdb !== undefined && (args.episode || args.season !== undefined)) {
      throw new Error('--episode and --season are for a show (--tvdb)');
    }
    if (args.tvdb !== undefined && command !== 'evidence' && !args.episode && args.season === undefined) {
      throw new Error('a show needs --episode or --season');
    }
    if (command === 'evidence' && !args.email) throw new Error('evidence needs --email');
    if (
      (command === 'search-plan' || command === 'release-list' || command === 'release-grab') &&
      args.tvdb !== undefined &&
      !args.episode
    ) {
      throw new Error(`${command} on a show needs --episode`);
    }
  }
  if (args.episodes && args.season === undefined) throw new Error('--episodes goes with --season');
  return args;
}

/** A Watch Carry's verification in plain lines: counts per server and account index, never a name (exported for the test). */
export function formatCarryResult(result: WatchCarryResult): string {
  const lines: string[] = [];
  const t = result.totals;
  lines.push(
    `Watch carry ${result.carryId}: ${result.status.toUpperCase()}. ${t.accounts} account(s) with state; ${t.written} item(s) written` +
      ` (${t.failed} failed); ${t.watchedCarried} watched file(s) on their item; ${t.resumesCarried} resume point(s); ` +
      `${t.newViews} new view(s) left alone; ${t.lost} dropped (watched or started file(s) no item plays); ${t.mismatches} mismatch(es).`,
  );
  for (const [server, byAccount] of Object.entries(result.accounts)) {
    for (const [account, s] of Object.entries(byAccount)) {
      lines.push(
        `  ${server} ${account}: watched ${s.watchedCarried}, resume ${s.resumesCarried}, clean ${s.cleanItems}, written ${s.written}` +
          (s.failed ? `, FAILED ${s.failed}` : '') +
          (s.newViews ? `, new views ${s.newViews}` : '') +
          (s.lost ? `, dropped ${s.lost}` : '') +
          (s.mismatches ? `, MISMATCH ${s.mismatches}` : ''),
      );
    }
  }
  for (const m of result.mismatchDetail.slice(0, 20)) {
    lines.push(`  mismatch ${m.server} ${m.account} ${m.episode} (item ${m.ratingKey}): want plays ${m.want.viewCount} at ${m.want.viewOffset} ms, got plays ${m.got.viewCount} at ${m.got.viewOffset} ms`);
  }
  if (result.status !== 'verified') lines.push(`Finish it with: repair-guide.ts carry-finish --carry ${result.carryId}`);
  return lines.join('\n');
}

/** The season plan in plain lines for staff (exported for the unit test). */
export function formatSeasonPlan(title: string, view: SeasonRemapView): string {
  const labels = (eps: ReadonlyArray<{ label: string }>) => eps.map((e) => e.label).join(' + ');
  const numbers = (eps: ReadonlyArray<{ episodeNumber: number }>) => {
    const ns = eps.map((e) => e.episodeNumber);
    return ns.length > 1 ? `${ns[0]}-${ns[ns.length - 1]}` : String(ns[0]);
  };
  const lines: string[] = [];
  lines.push(
    `${title}, season ${view.seasonNumber} (Sonarr series ${view.seriesId}): ${view.moved} files move in ${view.steps.length} steps` +
      (view.parkings.length > 0 ? `, passing through ${view.parkings.map((p) => `${p.label} (season ${p.seasonNumber})`).join(' and ')}` : '') +
      '.',
  );
  if (view.refusalText) lines.push(`REFUSED: ${view.refusalText}`);
  if (!view.remapOn) lines.push('The episode_remap remedy is off, so a run refuses.');
  if (view.plexCheck) {
    for (const c of view.plexCheck.servers) {
      lines.push(`Plex ${c.server}: ${c.followsTvdb} of ${c.followsTvdb + c.differs} titled items carry the TVDB title (${c.unknown} untitled).`);
    }
    for (const w of view.plexCheck.wrongAfter) {
      lines.push(
        `  Plex ${w.server} would title file ${w.fileId} on ${w.to.label} as ${w.plexTitle === null ? '(no item yet)' : JSON.stringify(w.plexTitle)}` +
          (w.rightNow ? ': WORSE, Plex shows its own title where it sits now.' : ' (wrong where it sits now too).'),
      );
    }
    lines.push(
      view.plexCheck.ok
        ? 'Plex check: ok (no move makes a Plex title worse).'
        : `Plex check: FAILED, ${view.plexCheck.worse} moves would make a right Plex title wrong (a run refuses without --ignore-plex).`,
    );
  } else {
    lines.push(`Plex check: not done (${view.plexError ?? 'unknown'}); a run refuses without --ignore-plex.`);
  }
  view.steps.forEach((st, i) => {
    const said = st.nameSays ? ` [${st.why}; name ${st.nameSays.verdict}] ${st.nameSays.name}` : ` [${st.why}]`;
    lines.push(`${String(i + 1).padStart(3)}. ${st.kind.padEnd(6)} ${labels(st.from)} -> ${labels(st.to)}${said}`);
  });
  for (const h of view.held) {
    lines.push(`stays ${labels(h.on)} (${h.reason})${h.names ? `, its name says ${h.names.label}` : ''}: ${h.name ?? h.fileName ?? ''}`);
  }
  for (const u of view.unplaced) {
    lines.push(
      `unplaced ${labels(u.on)} (name ${u.verdict}): ${u.name ?? u.fileName ?? ''}` +
        (u.suggestion ? ` -> suggestion --place ${numbers(u.on)}:${u.suggestion.episodeNumber}` : ''),
    );
  }
  if (view.open.length > 0) lines.push(`open if every name-led move went ahead: ${view.open.map((e) => e.label).join(', ')}`);
  if (view.vacated.length > 0) lines.push(`left without a file: ${view.vacated.map((e) => e.label).join(', ')}`);
  lines.push(`digest ${view.digest}`);
  return lines.join('\n');
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

  if (args.command === 'title-check') return titleCheck(args, db);

  if (args.command === 'audio-scan') {
    const arr = arrClientBundleFromEnv();
    const plex = plexClientBundleFromEnv();
    const report = await scanAudioDefaults({ db, arr, plex });
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else for (const line of formatAudioScan(report)) console.log(line);
    if (args.household) return applyHousehold(report, { db, arr, plex });
    if (!args.applyOriginal) return 0;
    let failures = 0;
    for (const f of report.findings) {
      if (f.original !== args.applyOriginal || f.preferenceSet || !f.mediaItemId || !f.sample) continue;
      if (f.plexDefault === null || f.plexDefault === f.original) continue;
      const input = {
        db,
        arr,
        plex,
        mediaItemId: f.mediaItemId,
        scope: 'episode' as const,
        targetChildId: f.sample.episodeId,
        wantedLanguage: f.original,
      };
      try {
        const preview = await previewAudioPreference(input);
        if (preview.action !== 'set') {
          console.log(JSON.stringify({ tvdbId: f.tvdbId, title: f.title, skipped: preview.action, reason: preview.reason }));
          continue;
        }
        const result = await setAudioPreference({ ...input, requesterId: null, digest: preview.digest });
        console.log(JSON.stringify({ tvdbId: f.tvdbId, title: f.title, result }));
      } catch (error) {
        failures += 1;
        console.log(JSON.stringify({ tvdbId: f.tvdbId, title: f.title, error: (error as Error).message }));
      }
    }
    return failures === 0 ? 0 : 1;
  }
  if (args.command === 'carry-status' && args.carry) {
    console.log(JSON.stringify({ carries: await listWatchCarries({ db, carryId: args.carry }) }, null, 2));
    return 0;
  }
  if (args.command === 'carry-finish') {
    const result = await carryWatchState({ db, plex: watchCarryPlexFromEnv(), carryId: args.carry! });
    console.log(formatCarryResult(result));
    return result.status === 'verified' ? 0 : 1;
  }
  if (args.command === 'carry-revert') {
    const result = await revertWatchCarry({ db, plex: watchCarryPlexFromEnv(), carryId: args.carry! });
    console.log(JSON.stringify(result, null, 2));
    return result.failed === 0 ? 0 : 1;
  }

  if (args.command === 'queue-check') {
    const clients = arrQueueCleanupClientsFromEnv();
    const tally: Record<string, number> = {};
    for (const instance of ['sonarr', 'radarr'] as const) {
      const client = clients[instance];
      const queue = await client.getQueueAll();
      for (const group of groupQueueRecordsByDownload(queue)) {
        const qualifies =
          group[0]!.downloadId &&
          group.every((r) => {
            const state = (r.trackedDownloadState ?? '').toLowerCase();
            return classifyQueueItem(r).class === 'unknown' && (state === 'importblocked' || state === 'importpending');
          }) &&
          hasIdentityRejection(queueTexts(group));
        if (!qualifies || !client.importCheck) continue;
        let line: Record<string, unknown>;
        try {
          const check = await client.importCheck(group);
          const verdict = check?.verdict ?? 'no_check';
          tally[`${instance}.${verdict}`] = (tally[`${instance}.${verdict}`] ?? 0) + 1;
          line = {
            instance,
            verdict,
            reason: check ? importCheckReasonText(check) : null,
            title: group[0]!.title,
            targets: [...new Set(group.map((r) => r.targetId))],
            importsOnto: check?.file?.targetIds ?? [],
            titleVerdict: check?.title?.verdict ?? null,
            bestEpisodeId: check?.title?.bestEpisodeId ?? null,
          };
        } catch (error) {
          tally[`${instance}.read_failed`] = (tally[`${instance}.read_failed`] ?? 0) + 1;
          line = { instance, verdict: 'read_failed', title: group[0]!.title, error: (error as Error).message };
        }
        console.log(JSON.stringify(line));
      }
    }
    console.log(JSON.stringify({ summary: tally }));
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
      plexIdentity: { userId: args.plexUserId ?? null, email: null, username: args.plexUsername ?? null },
      tautulli: resolveTautulliInstances().map((inst) => {
        const client = new TautulliClient({ baseUrl: inst.baseUrl, apiKey: inst.apiKey, timeoutMs: 15_000 });
        return { slug: inst.slug, getHistory: (params) => client.getHistory(params) };
      }),
    });
    console.log(JSON.stringify({ title: item.title, evidence }, null, 2));
    return 0;
  }

  if (args.command === 'carry-status') {
    const [series] = await db.select({ arrItemId: mediaItems.arrItemId }).from(mediaItems).where(eq(mediaItems.id, item.id));
    console.log(JSON.stringify({ title: item.title, carries: await listWatchCarries({ db, seriesId: series!.arrItemId }) }, null, 2));
    return 0;
  }

  const arr = arrClientBundleFromEnv();
  if (args.command === 'ordering-plan' || args.command === 'ordering-run') {
    const request = { db, arr, plex: watchCarryPlexFromEnv(), mediaItemId: item.id, ordering: args.ordering! };
    if (args.command === 'ordering-run') {
      const result = await runShowOrdering({ ...request, planDigest: args.digest! });
      console.log(JSON.stringify({ title: item.title, carryId: result.carryId, switched: result.switched, wait: result.wait, status: result.status }, null, 2));
      if (result.carry) console.log(formatCarryResult(result.carry));
      return result.status === 'verified' ? 0 : 1;
    }
    const plan = await planShowOrdering(request);
    console.log(
      JSON.stringify(
        { title: item.title, ...plan, servers: plan.servers.map(({ rematchKeys, rematchSizes, ...rest }) => ({ ...rest, rematch: rematchKeys.length, rematchFiles: rematchSizes.length })) },
        null,
        2,
      ),
    );
    return 0;
  }
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

  if (args.command === 'replace-plan' || args.command === 'replace-run' || args.command === 'replace-batch') {
    const toSameAs = (list: RepairGuideArgs['sameAs']) =>
      (list ?? []).map((x) => ({ seasonNumber: x.season, episodeNumber: x.episode, ...(x.copyOf !== undefined ? { copyOfEpisode: x.copyOf } : {}) }));
    if (args.command === 'replace-batch') {
      // One process for the whole list: the season search is cached between slots, and every slot re-plans first.
      const watchCarry = watchCarryPlexFromEnv();
      const pauseMs = args.pauseMs ?? 15_000;
      for (const [i, entry] of args.batch!.entries()) {
        if (i > 0 && pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs));
        const slot = [entry.episode, ...entry.also].join('+');
        try {
          const result = await runWrongContentReplace({
            db,
            arr,
            mediaItemId: item.id,
            seasonNumber: args.season!,
            episodeNumber: entry.episode,
            alsoEpisodes: entry.also,
            planDigest: entry.digest,
            keys: entry.keys,
            evidence: entry.evidence,
            sameAs: toSameAs(entry.sameAs),
            watchCarry,
            keepReleaseList: true,
          });
          const c = result.carry;
          console.log(JSON.stringify({ slot, fixRequestId: result.fixRequestId, grabbed: result.grabbed, carry: c ? { carryId: c.carryId, status: c.status, error: c.error, totals: c.result?.totals ?? null, dropped: c.result?.droppedDetail.length ?? null } : null }));
          if (c && c.status !== 'verified') {
            if (c.result) console.log(formatCarryResult(c.result));
            console.error(`repair-guide: slot ${slot}: the carry is ${c.status}; stopping`);
            return 1;
          }
        } catch (err) {
          console.log(JSON.stringify({ slot, error: err instanceof Error ? err.message : String(err) }));
          console.error(`repair-guide: slot ${slot} refused; stopping (the slots before it ran)`);
          return 1;
        }
      }
      return 0;
    }
    if (args.command === 'replace-plan' && args.slots) {
      for (const slot of args.slots) {
        const plan = await planWrongContentReplace({ db, arr, mediaItemId: item.id, seasonNumber: args.season!, episodeNumber: slot.episode, alsoEpisodes: slot.also });
        console.log(
          JSON.stringify({
            slot: [slot.episode, ...slot.also].join('+'),
            files: plan.files,
            refusal: plan.refusal,
            digest: plan.digest,
            candidates: plan.candidates.map((c) => ({ key: c.key, state: c.state, whole: c.whole, lands: c.lands, title: c.title })),
          }),
        );
      }
      return 0;
    }
    const request = {
      db,
      arr,
      mediaItemId: item.id,
      seasonNumber: args.episode!.season,
      episodeNumber: args.episode!.episode,
      alsoEpisodes: args.also ?? [],
    };
    if (args.command === 'replace-run') {
      const result = await runWrongContentReplace({
        ...request,
        planDigest: args.digest!,
        keys: args.key!.split(','),
        evidence: args.evidence!,
        sameAs: toSameAs(args.sameAs),
        watchCarry: watchCarryPlexFromEnv(),
      });
      const { carry, ...rest } = result;
      console.log(JSON.stringify({ title: item.title, result: { ...rest, carry: carry ? { carryId: carry.carryId, status: carry.status, error: carry.error } : null } }, null, 2));
      if (carry?.result) console.log(formatCarryResult(carry.result));
      return carry && carry.status !== 'verified' ? 1 : 0;
    }
    const plan = await planWrongContentReplace(request);
    console.log(JSON.stringify({ title: item.title, plan, refusalText: wrongContentRefusalText(plan.refusal) }, null, 2));
    return 0;
  }

  if (args.command === 'copy-plan' || args.command === 'copy-run') {
    const request = {
      db,
      arr,
      mediaItemId: item.id,
      seasonNumber: args.episode!.season,
      episodeNumber: args.episode!.episode,
      copyOf: args.copyOf ?? null,
    };
    if (args.command === 'copy-run') {
      const result = await runSecondCopyFix({ ...request, planDigest: args.digest!, evidence: args.evidence!, watchCarry: watchCarryPlexFromEnv() });
      const { carry, ...rest } = result;
      console.log(JSON.stringify({ title: item.title, result: { ...rest, carry: carry ? { carryId: carry.carryId, status: carry.status, error: carry.error } : null } }, null, 2));
      if (carry?.result) console.log(formatCarryResult(carry.result));
      return carry && carry.status !== 'verified' ? 1 : 0;
    }
    const plan = await planSecondCopyFix(request);
    console.log(JSON.stringify({ title: item.title, plan, refusalText: secondCopyRefusalText(plan.refusal) }, null, 2));
    return 0;
  }

  if (args.command === 'season-plan' || args.command === 'season-run') {
    const request = {
      db,
      arr,
      mediaItemId: item.id,
      seasonNumber: args.season!,
      placements: args.placements ?? [],
      keep: args.keep ?? [],
      plex: seasonPlexReader({ db, plex: plexClientBundleFromEnv() }),
    };
    if (args.command === 'season-run') {
      const result = await runSeasonRemap({
        ...request,
        planDigest: args.digest!,
        ignorePlex: args.ignorePlex === true,
        watchCarry: watchCarryPlexFromEnv(),
      });
      const { carry, ...rest } = result;
      console.log(
        JSON.stringify(
          { title: item.title, season: args.season, result: { ...rest, carry: carry ? { carryId: carry.carryId, status: carry.status, accountsWithState: carry.accountsWithState, error: carry.error } : null } },
          null,
          2,
        ),
      );
      if (carry?.result) console.log(formatCarryResult(carry.result));
      return result.outcome === 'moved' && (!carry || carry.status === 'verified') ? 0 : 1;
    }
    const view = await planSeasonRemap(request);
    console.log(args.json ? JSON.stringify({ title: item.title, plan: view }, null, 2) : formatSeasonPlan(item.title, view));
    return 0;
  }

  if (args.command === 'remap-plan' || args.command === 'remap-run') {
    const target = { db, arr, mediaItemId: item.id, seasonNumber: args.season! };
    const view = await readRemapSeason({ ...target, remapOn: true });
    if (!args.remap) {
      const withFiles = view.episodes.filter((e) => e.hasFile).length;
      console.log(JSON.stringify({ title: item.title, season: args.season, episodes: view.episodes.length, withFiles, queueBusy: view.queueBusy, suggestion: view.suggestion }, null, 2));
      return 0;
    }
    const byNumber = (n: number) => view.episodes.find((e) => e.episodeNumber === n)?.id ?? -1;
    const claim =
      args.remap.kind === 'shift'
        ? { kind: 'shift' as const, fromEpisodeNumber: args.remap.from, throughEpisodeNumber: args.remap.through, by: args.remap.by }
        : { kind: 'single' as const, fromEpisodeId: byNumber(args.remap.from), toEpisodeId: byNumber(args.remap.to) };
    if (args.command === 'remap-run') {
      // The guide's own run: re-plans, refuses a changed plan (FIX_PLAN_CHANGED) or the switch off, writes the Repair
      // Request first, then one ManualImport per move with its read-back, then the rename.
      const result = await runEpisodeRemap({ ...target, claim, planDigest: args.digest!, requesterId: null });
      console.log(JSON.stringify({ title: item.title, result }, null, 2));
      return result.outcome === 'moved' ? 0 : 1;
    }
    const plan = await planEpisodeRemap({ ...target, claim, remapOn: true });
    console.log(JSON.stringify({ title: item.title, plan }, null, 2));
    return 0;
  }

  if (args.command === 'search-plan') {
    const plan = await planForceSearch({
      db,
      arr,
      mediaItemId: item.id,
      ...(scope.scope === 'episode' ? { scope: 'episode' as const, targetChildId: scope.targetChildId } : {}),
      importCheckOn: true,
    });
    console.log(JSON.stringify({ title: item.title, plan }, null, 2));
    return 0;
  }

  if (args.command === 'release-grab') {
    const target = {
      db,
      arr,
      mediaItemId: item.id,
      ...(scope.scope === 'episode' ? { scope: 'episode' as const, targetChildId: scope.targetChildId } : {}),
    };
    const list = await openReleaseList({ ...target, requesterId: null });
    if (list.status !== 'list') {
      console.log(JSON.stringify({ title: item.title, target: list.targetLabel, status: list.status, download: list.download }, null, 2));
      return 1;
    }
    const row = list.rows.find((r) => r.keys.includes(args.key!));
    if (!row || row.state === 'not_allowed') {
      console.error(
        `repair-guide: ${row ? `that row is not allowed: ${row.reasons.map((r) => r.text).join('; ')}` : 'no row with that key on the list now'}`,
      );
      return 1;
    }
    const result = await grabFromReleaseList({ db, arr, listId: list.listId!, key: args.key!, requesterId: null });
    console.log(JSON.stringify({ title: item.title, release: row.title, state: row.state, result }, null, 2));
    return result.outcome === 'grabbed' ? 0 : 1;
  }

  if (args.command === 'release-list') {
    const list = await previewReleaseList({
      db,
      arr,
      mediaItemId: item.id,
      ...(scope.scope === 'episode' ? { scope: 'episode' as const, targetChildId: scope.targetChildId } : {}),
    });
    if (args.json) console.log(JSON.stringify({ title: item.title, list }, null, 2));
    else for (const line of formatReleaseList(item.title, list)) console.log(line);
    return 0;
  }

  if (args.command === 'audio') {
    const audio = await readFileAudio({ db, arr, mediaItemId: item.id, ...scope });
    console.log(JSON.stringify({ title: item.title, audio }, null, 2));
    return 0;
  }

  if (args.command === 'audio-preference') {
    const plex = plexClientBundleFromEnv();
    const input = {
      db,
      arr,
      plex,
      mediaItemId: item.id,
      ...scope,
      wantedLanguage: args.language!,
      ...(args.household ? { rule: 'household' as const } : {}),
    };
    if (!args.digest) {
      const preview = await previewAudioPreference(input);
      console.log(JSON.stringify({ title: item.title, preview }, null, 2));
      return 0;
    }
    const result = await setAudioPreference({ ...input, requesterId: null, digest: args.digest });
    console.log(JSON.stringify({ title: item.title, result }, null, 2));
    return 0;
  }

  if (args.command === 'language-plan') {
    const { plan } = await readLanguagePlan({
      db,
      arr,
      mediaItemId: item.id,
      ...scope,
      wantedLanguage: args.language!,
      remedies: { ...allRemediesOff(), language_check: true, language_search: true },
    });
    console.log(JSON.stringify({ title: item.title, plan }, null, 2));
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

const gb = (bytes: number | null) => (bytes === null ? '?' : `${(bytes / 1024 ** 3).toFixed(2)} GB`);

/**
 * DESIGN-055 P6 decision 14 — the owner's household default (#955) as staff: per finding, English where the show's files
 * carry it, else the original language. A show already starting in that language everywhere, or whose servers all prefer
 * it, is reported and left alone. One Repair Request per write, requester null, every server read back.
 */
async function applyHousehold(
  report: Awaited<ReturnType<typeof scanAudioDefaults>>,
  deps: { db: typeof defaultDb; arr: ReturnType<typeof arrClientBundleFromEnv>; plex: ReturnType<typeof plexClientBundleFromEnv> },
): Promise<number> {
  let failures = 0;
  for (const f of report.findings) {
    const target = householdTarget(f);
    const line = { tvdbId: f.tvdbId, title: f.title, original: f.original, language: target.language };
    if (target.noop) {
      console.log(JSON.stringify({ ...line, skipped: 'noop', note: `every file with this language already starts in it` }));
      continue;
    }
    if (!f.mediaItemId || !target.scope) {
      console.log(JSON.stringify({ ...line, skipped: 'no_scope' }));
      continue;
    }
    const input = {
      db: deps.db,
      arr: deps.arr,
      plex: deps.plex,
      mediaItemId: f.mediaItemId,
      scope: 'episode' as const,
      targetChildId: target.scope.episodeId,
      wantedLanguage: target.language,
      rule: 'household' as const,
    };
    try {
      const preview = await previewAudioPreference(input);
      if (preview.action !== 'set') {
        console.log(JSON.stringify({ ...line, skipped: preview.action, reason: preview.reason }));
        continue;
      }
      const result = await setAudioPreference({ ...input, requesterId: null, digest: preview.digest });
      console.log(JSON.stringify({ ...line, scope: target.scope.label, result }));
    } catch (error) {
      failures += 1;
      console.log(JSON.stringify({ ...line, error: (error as Error).message }));
    }
  }
  return failures === 0 ? 0 : 1;
}

/** The audio scan as text: one line per series, worst first (exported for the test). */
export function formatAudioScan(report: Awaited<ReturnType<typeof scanAudioDefaults>>): string[] {
  const lines = [
    `scanned ${report.seriesScanned} series with files (${report.filesRead} files); ${report.findings.length} put another language ahead of the original one`,
  ];
  for (const f of report.findings) {
    const prefs = f.plex.map((p) => `${p.server}=${p.unreachable ? 'unreachable' : p.current === '' ? 'account default' : p.current}`).join(' ');
    const state = f.preferenceSet ? 'set ' : f.plexDefault === null ? 'UNREAD' : f.plexDefault === f.original ? 'plays' : 'OPEN';
    lines.push(
      `${state} tvdb ${f.tvdbId} ${f.title} | original ${f.original} | ${f.filesFirstOther}/${f.filesWithOriginal} files lead with ${f.leadingLanguages.join('/')}` +
        ` | Plex starts ${f.sample?.label ?? '?'} in ${f.plexDefault ?? '?'} | ${prefs}`,
    );
  }
  return lines;
}

/** The Release Pick preview as text: the target, the counts, then one line per row with its reasons (exported for the test). */
export function formatReleaseList(title: string, list: Awaited<ReturnType<typeof previewReleaseList>>): string[] {
  const lines = [`${title} ${list.targetLabel}: ${list.status}`];
  if (list.status !== 'list') {
    if (list.download?.title) lines.push(`in the queue: ${list.download.title} (${list.download.status ?? 'unknown'})`);
    return lines;
  }
  const c = list.counts!;
  lines.push(
    `searched ${list.searchedAt}: ${c.sources} sources, ${c.dropped} for other episodes or titles dropped; ` +
      `${c.grab} grab, ${c.override} override, ${c.notAllowed} not allowed; ${list.offers} sources can be picked`,
  );
  for (const row of list.rows) {
    const state = row.state === 'grab' ? 'GRAB' : row.state === 'override' ? 'OVERRIDE' : 'NOT ALLOWED';
    const evidence = row.evidence ? ` title:${row.evidence.verdict}${row.evidence.namedLabel ? `(${row.evidence.namedLabel})` : ''}` : '';
    lines.push(
      `${row.recommended ? '* ' : '  '}[${state}] ${row.title} | ${row.qualityName ?? '?'} ${gb(row.sizeBytes)} | ` +
        `${row.indexer ?? '?'}${row.keys.length > 1 ? ` +${row.keys.length - 1} more` : ''}${evidence} | key ${row.key}`,
    );
    // P5 decision 17: a release that holds several missing episodes lands on every one of them.
    if (row.holds) lines.push(`      holds: ${row.holds.join(' + ')}`);
    for (const r of row.reasons) {
      lines.push(`      ${r.class}: ${r.text}${r.arrText && r.arrText !== r.text ? `  [${r.arrText}]` : ''}`);
    }
  }
  return lines;
}

const score = (n: number | null) => (n === null ? '-' : n.toFixed(2));
const sxe = (season: number, episode: number) =>
  `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;

/** The backfill report as text: the counts, then one line per file whose name says it is another episode. */
export function formatTitleCheckBackfill(report: TitleCheckBackfillReport): string[] {
  const v = report.verdicts;
  const lines = [
    `Title Check backfill${report.dryRun ? ' (dry run, nothing written)' : ''}: ${report.historyRecords} import records, ` +
      `${report.historyFiles} files in history, ${report.series} series read (${report.errors} failed)`,
    `judged ${report.filesJudged} current files (${report.fromHistory} by import record, ${report.fromSceneName} by scene ` +
      `name); ${report.noEvidence} with nothing to judge`,
    `agrees ${v.agrees}, disagrees ${v.disagrees}, ambiguous ${v.ambiguous}, silent ${v.silent}; ` +
      `${report.dryRun ? 'would open' : 'opened'} ${report.flagsOpened} flags, wrote ${report.written} rows`,
    ...report.errorSamples.map((e) => `read failed: ${e}`),
  ];
  for (const d of report.disagrees) {
    const best = d.best ? `${sxe(d.seasonNumber, d.best.episodeNumber)} "${d.best.title ?? ''}"` : 'unknown';
    lines.push(
      `${d.seriesTitle} ${sxe(d.seasonNumber, d.episode.episodeNumber)} "${d.episode.title ?? ''}" -> ${best} ` +
        `(score ${score(d.score)}, best ${score(d.bestScore)}) file ${d.episodeFileId} [${d.nameFrom}]: ${d.name}`,
    );
  }
  return lines;
}

async function titleCheck(args: RepairGuideArgs, db: typeof defaultDb): Promise<number> {
  const sonarr = titleCheckSonarrFromEnv();
  if (args.backfill) {
    const report = await backfillTitleChecks({
      db,
      sonarr,
      dryRun: args.dryRun === true,
      onProgress: (p) => {
        if (p.phase === 'series' && (p.done % 50 === 0 || p.done === p.total)) {
          console.error(`title-check: ${p.done}/${p.total} series read`);
        }
      },
    });
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else for (const line of formatTitleCheckBackfill(report)) console.log(line);
    return 0;
  }
  const [item] = await db
    .select({ id: mediaItems.id, title: mediaItems.title })
    .from(mediaItems)
    .where(
      and(
        eq(mediaItems.arrKind, 'sonarr'),
        eq(mediaItems.arrItemId, args.flagsSeriesId!),
        isNull(mediaItems.deletedFromArrAt),
      ),
    );
  if (!item) {
    console.error(`repair-guide: no live sonarr item with series id ${args.flagsSeriesId}`);
    return 1;
  }
  const flags = await listTitleFlags({ db, sonarr, mediaItemId: item.id });
  console.log(JSON.stringify({ title: item.title, seriesId: args.flagsSeriesId, flags }, null, 2));
  return 0;
}

// Run only as a script (tests import parseRepairGuideArgs).
if (process.argv[1]?.endsWith('repair-guide.ts')) {
  main()
    .then(async (code) => {
      await getPool()
        .end()
        .catch(() => {});
      // Exit only once stdout has drained: a large JSON report piped through `kubectl exec` was cut at 64 KiB when
      // process.exit ran with the write still queued.
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
