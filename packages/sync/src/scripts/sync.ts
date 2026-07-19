// DESIGN-005 D-14 — the CronJob CLI entry:
//
//   tsx sync.ts --mode=full|incremental [--source=sonarr|radarr|lidarr|seerr] [--force-tombstones]
//
// Env (D-18): DATABASE_URL plus SONARR_URL/SONARR_API_KEY (+ RADARR_/LIDARR_/SEERR_);
// URLs default to the in-cluster service DNS. Exit 0 with a per-source report unless
// EVERY requested source failed (or the run could not start at all) — one *arr being
// down must not mask the sources that synced (D-14 failure isolation).
import {
  ARR_KINDS,
  SYNC_RUN_KINDS,
  SYNC_SOURCES,
  getPool,
  type SyncRunKind,
  type SyncSource,
} from '@hnet/db';
import {
  booksActivityBundleFromEnv,
  buildArrActivityAdapter,
  buildKapowarrActivityAdapter,
  createGbCallMeter,
  kapowarrBundleFromEnv,
  lazyLibrarianBundleFromEnv,
  maintainerrClientBundleFromEnv,
  mamGovernorBundleFromEnv,
  plexClientBundleFromEnv,
  resolveArrBaseUrls,
  resolveGovernorConfig,
  resolveKapowarrBaseUrl,
  type ActivitySourceAdapter,
  type BooksActivityBundle,
  type GbCallMeter,
  type KapowarrClientBundle,
  type LazyLibrarianClientBundle,
  type UtilizationArrBundle,
} from '@hnet/domain';
import { prometheusClientFromEnv } from '@hnet/metrics';
import { assertAuthentikEnv, authentikReadClient } from '@hnet/authentik';
import { assertBooksEnv } from '@hnet/books';
import { booksReadClients } from '@hnet/books/read';
import { assertLibrettoEnv, LibrettoConfigError } from '@hnet/libretto';
import { LibrettoReadClient } from '@hnet/libretto/read';
import { GoodreadsRssClient, GoogleBooksClient, goodreadsConfigFromEnv } from '@hnet/goodreads';
import type { GoodreadsSourceBundle } from '../goodreads';
import {
  buildMetadataSourceClients,
  buildOptionalMaintainerrRead,
  buildSyncClients,
  requireClient,
} from '../clients';
import { openWebUiClientFromEnv } from '../openwebui';
import type { BooksSyncBundle } from '../books';
import { createConsoleLogger } from '../logger';
import { runSync } from '../orchestrator';

const USAGE = `Usage: sync.ts --mode=full|incremental|metadata-refresh|trash-batch-sweep|space-policy|notify-outbox|smart-alerts|poster-guard|ai-usage-sync|authentik-users|books-sync|plex-match|collections-sync|books-collections-sync|mam-governor|goodreads-sync|format-pairing|activity-scan [--source=${SYNC_SOURCES.join('|')}] [--force-tombstones]

  --mode=full              item-list upsert + tombstone pass per *arr (+ Seerr requests)
  --mode=incremental       history/since cursor polling per *arr (+ Seerr requests)
  --mode=metadata-refresh  harvest ratings/genres/runtime/posters (+ Tautulli watch-stats,
                           Maintainerr, direct TMDB/TVDB fallback) into media_metadata (ADR-018)
  --mode=trash-batch-sweep delete the survivors of every EXPIRED Leaving-Soon batch, one guarded
                           item at a time (ADR-025 — SAFE audit + live exclusions + guardian re-run).
                           Drives Maintainerr; needs MAINTAINERR_URL/MAINTAINERR_API_KEY. No --source.
  --mode=space-policy      PROPOSE (never delete) a draft batch for each media array over its space
                           target (ADR-031 — reads *arr /diskspace + createBatchFromPending; admin gate
                           stays the human check). Needs SONARR/RADARR/LIDARR_URL/_API_KEY +
                           MAINTAINERR_URL/MAINTAINERR_API_KEY. No --source. No-op unless space_policy
                           is enabled in app_settings.
  --mode=notify-outbox     drain DUE notification_outbox rows to Pushover (ADR-034 — batch-lifecycle
                           pushes; sent_at null + attempts<5 + earliest_send_at<=now). Needs
                           PUSHOVER_APP_TOKEN + PUSHOVER_USER_KEY; disabled-safe — a clean no-op that
                           leaves rows queued when either is absent. No --source. Writes no sync_runs row.
  --mode=smart-alerts      detect CRITICAL SMART transitions since the last check (ADR-040 — pass→FAIL,
                           media_errors 0→n, spare crossing threshold margin, a NEW critical_warning bit,
                           or the critical appdata pool wear crossing 80/90%) and enqueue ONE
                           notification_outbox row per transition, same-tx with the smart_drive_state
                           update. First sight of a drive records a BASELINE and pages nothing. Reads the
                           in-cluster Prometheus (PROMETHEUS_URL, in-cluster default; no secret). No
                           --source. Writes no sync_runs row.
  --mode=poster-guard      re-apply drifted Peloton override posters on k8plex (ADR-043 — read HOps
                           Peloton, resolve each show→series art + season→duration art from the durable
                           assets baked into the image, and re-push ONLY the targets whose Plex thumb
                           drifted since the last apply). Appends one poster_guard_applications ledger row
                           per re-apply (drift baseline + audit). Needs PLEX_HAYNESKUBE_TOKEN. No --source.
                           Writes no sync_runs row.
  --mode=ai-usage-sync     poll the Open WebUI admin API (GET /api/v1/chats/all/db + /api/v1/users/) and
                           UPSERT the ai_usage_chats mirror (ADR-044 — the Metrics AI sub-tab's substrate).
                           READ-ONLY against OWUI; counts chats + image generations (assistant image files)
                           + per-user/model detail. Needs OPENWEBUI_API_KEY (OPENWEBUI_URL defaults to the
                           in-cluster service DNS). No --source. Writes no sync_runs row.
  --mode=authentik-users   page the Authentik directory (GET /api/v3/core/users/ incl. external + never-
                           logged-in identities + /groups/) and UPSERT the authentik_users mirror the
                           /admin/users portal reads (ADR-045). READ-ONLY against Authentik. Needs
                           AUTHENTIK_API_TOKEN (AUTHENTIK_URL defaults to the in-cluster Service DNS).
                           No --source. Writes no sync_runs row.
  --mode=plex-match        resolve each *arr ledger media_item to its exact Plex {library, ratingKey} by
                           shared-GUID match (tmdb/imdb/tvdb/musicbrainz) and UPSERT the media_plex_matches
                           cache (ADR-047 — the Library access gate + "Watch on Plex" deep-link substrate).
                           READS DB media_items (their ids, already synced) + the Plex libraries READ-ONLY —
                           no *arr call, no write to Plex. Needs PLEX_HAYNESTOWER/HAYNESOPS/HAYNESKUBE_TOKEN
                           (URLs default to in-cluster/ingress). No --source. Writes no sync_runs row.
  --mode=collections-sync  mirror the HOps Plex server's collections (ADR-064 — external software is
                           ALWAYS the collections source of truth; charts included): page each
                           registered movie/show section's /collections + each collection's children
                           READ-ONLY and UPSERT the plex_collections/plex_collection_members mirror
                           (reconcile scoped to fully-read sections/collections). Needs
                           PLEX_HAYNESOPS_TOKEN (the bundle asserts all three PLEX_*_TOKENs). No
                           --source. Writes no sync_runs row.
  --mode=books-collections-sync
                           mirror the BOOK servers' collections (ADR-066 — the ADR-064 model applied
                           to books; external software is ALWAYS the collections source of truth):
                           read Kavita collections + Kavita reading lists (mirrored as ORDERED
                           collections) + ABS collections READ-ONLY and UPSERT the
                           books_collections/books_collection_members mirror (reconcile scoped to
                           fully-read (source, kind) families; member refs resolve against the fresh
                           books_items mirror — run it AFTER books-sync). Needs KAVITA_PASSWORD +
                           AUDIOBOOKSHELF_PASSWORD (the books-sync env, URLs default in-cluster). No
                           --source. Writes no sync_runs row.
  --mode=mam-governor      the MAM COMPLIANCE GOVERNOR (ADR-054 — cap-aware torrent-fallback pacing): count
                           UNSATISFIED torrents locally in qBittorrent (category books-mam, seeding_time
                           < 72h + still-downloading — ZERO MyAnonaMouse API surface) and, near the rank cap
                           (unsatisfied ≥ MAM_UNSATISFIED_LIMIT − MAM_UNSATISFIED_BUFFER), PAUSE the
                           MyAnonaMouse Prowlarr indexer's enable flag (Prowlarr's fullSync propagates it to
                           LazyLibrarian; usenet keeps flowing); RESUME when headroom returns. Fail-closed: a
                           failed count ⇒ gate closed. Upserts mam_gate_state + enqueues a transition /
                           >48h-stuck notification_outbox row same-tx. Needs PROWLARR_API_KEY (URLs +
                           indexer id default in-cluster; qBittorrent needs no secret). No --source. Writes
                           no sync_runs row.
  --mode=goodreads-sync    poll each LINKED Goodreads integration's PUBLIC shelf RSS (ADR-055 — no OAuth,
                           no secret), enrich against Google Books (mandatory retry/backoff + comic
                           classification), mirror the shelf, match each want against the books_items
                           library, mint book_requests for the unmatched, and push BOTH formats to
                           LazyLibrarian (GB-volume → addBook → queueBook → searchBook, PACED) — then
                           reconcile LL statuses + compute coverage. COMICS route to KAPOWARR instead (ADR-056:
                           ComicVine volume search → add MONITORED (auto-search) → reconcile comic_status;
                           Kapowarr's OWN GetComics DDL sources, NEVER MAM/qB/Prowlarr). GOODREADS_BASE_URL /
                           GOOGLE_BOOKS_URL default to the public hosts; GOOGLE_BOOKS_API_KEY /
                           LAZYLIBRARIAN_API_KEY / KAPOWARR_API_KEY are OPTIONAL (absent LL ⇒ mirror + mint, no
                           book push; absent Kapowarr ⇒ comics parked). NEVER writes LL/Kapowarr provider
                           config. No --source. Writes no sync_runs row.
  --mode=format-pairing    book ⇄ audiobook FORMAT PAIRING (ADR-065 — PLAN-050): rebuild the
                           books_format_pairs derived cache from the books_items mirror (conservative
                           normalized-title + author-agreement matcher; comics excluded; never a wrong
                           pair), mint the PACED estate-wide system wants for unpaired titles' missing
                           formats (book_requests origin='pairing', capped at PAIRING_MINT_CAP_PER_RUN
                           attempts/run, missing-format-only addBook → queueBook → searchBook), and
                           reconcile open pairing wants against LL. Fetches NOTHING external for the
                           pair pass — run it AFTER books-sync. LAZYLIBRARIAN_API_KEY /
                           GOOGLE_BOOKS_API_KEY are OPTIONAL (absent LL ⇒ pair + mint only; absent GB
                           key ⇒ keyless GB lookups, reuse-first). NEVER touches LL provider config.
                           No --source. Writes no sync_runs row.
  --mode=activity-scan     the ACTIVITY / IN-FLIGHT failure scan (ADR-059 — the pipeline made visible): poll
                           each source family's queue/import state (the books LL wanted-table + SAB queue/
                           history AND the *arr Radarr/Sonarr/Lidarr queue + recent-import state), detect OPEN
                           import failures (stranded_import — downloaded but never imported; import_blocked —
                           the *arr importer needs a manual import; download_failed), UPSERT the
                           activity_import_failures ledger + enqueue one activity_import_failed
                           notification_outbox row per NEW failure (same-tx). Each source is reconciled
                           independently (a source down never closes another's strands). Needs
                           LAZYLIBRARIAN_API_KEY + SABNZBD_API_KEY + SONARR/RADARR/LIDARR_API_KEY (URLs default
                           in-cluster). No --source. Writes no sync_runs row.
  --source=NAME            limit the run to one source (repeatable; default: all sources; for
                           metadata-refresh the default is the three *arr kinds)
  --force-tombstones       override the mass-tombstone guard (DESIGN-005 D-14/Q-03)
  --help                   print this usage

Env (DESIGN-005 D-18): DATABASE_URL, SONARR_URL/SONARR_API_KEY, RADARR_URL/RADARR_API_KEY,
LIDARR_URL/LIDARR_API_KEY, SEERR_URL/SEERR_API_KEY (URLs default to in-cluster DNS).
Metadata sources (ADR-018 / DESIGN-008 — all OPTIONAL, skip-if-absent): TAUTULLI_API_KEY,
TAUTULLI_K8PLEX_API_KEY, TAUTULLI_HAYNESTOWER_API_KEY (+ _URL for haynestower), TMDB_API_KEY /
TMDB_API_READ_ACCESS_TOKEN, TVDB_API_KEY, MAINTAINERR_URL/MAINTAINERR_API_KEY.`;

interface CliArgs {
  mode: SyncRunKind;
  sources: SyncSource[];
  forceTombstones: boolean;
}

class CliUsageError extends Error {}

function parseArgs(argv: string[]): CliArgs | 'help' {
  let mode: SyncRunKind | undefined;
  const sources: SyncSource[] = [];
  let forceTombstones = false;

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') return 'help';
    if (arg === '--force-tombstones') {
      forceTombstones = true;
    } else if (arg.startsWith('--mode=')) {
      const value = arg.slice('--mode='.length);
      if (!(SYNC_RUN_KINDS as readonly string[]).includes(value)) {
        throw new CliUsageError(`invalid --mode "${value}" (expected ${SYNC_RUN_KINDS.join('|')})`);
      }
      mode = value as SyncRunKind;
    } else if (arg.startsWith('--source=')) {
      const value = arg.slice('--source='.length);
      if (!(SYNC_SOURCES as readonly string[]).includes(value)) {
        throw new CliUsageError(`invalid --source "${value}" (expected ${SYNC_SOURCES.join('|')})`);
      }
      sources.push(value as SyncSource);
    } else {
      throw new CliUsageError(`unknown argument "${arg}"`);
    }
  }
  if (mode === undefined) {
    throw new CliUsageError(
      '--mode=full|incremental|metadata-refresh|trash-batch-sweep|space-policy|notify-outbox|smart-alerts is required',
    );
  }
  if (
    (mode === 'trash-batch-sweep' ||
      mode === 'space-policy' ||
      mode === 'notify-outbox' ||
      mode === 'smart-alerts' ||
      mode === 'poster-guard' ||
      mode === 'ai-usage-sync' ||
      mode === 'authentik-users' ||
      mode === 'books-sync' ||
      mode === 'plex-match' ||
      mode === 'collections-sync' ||
      mode === 'books-collections-sync' ||
      mode === 'mam-governor' ||
      mode === 'activity-scan' ||
      mode === 'goodreads-sync' ||
      mode === 'format-pairing') &&
    sources.length > 0
  ) {
    throw new CliUsageError(`--source is not valid for --mode=${mode}`);
  }
  // metadata-refresh defaults to the *arr kinds (Seerr has no metadata); trash-batch-sweep +
  // space-policy + notify-outbox + smart-alerts use no *arr SOURCE loop at all (they drive Maintainerr /
  // read diskspace / drain the outbox / read Prometheus directly); other modes default to all sources.
  const defaultSources =
    mode === 'trash-batch-sweep' ||
    mode === 'space-policy' ||
    mode === 'notify-outbox' ||
    mode === 'smart-alerts' ||
    mode === 'poster-guard' ||
    mode === 'ai-usage-sync' ||
    mode === 'authentik-users' ||
    mode === 'books-sync' ||
    mode === 'plex-match' ||
    mode === 'collections-sync' ||
    mode === 'books-collections-sync' ||
    mode === 'mam-governor' ||
    mode === 'activity-scan' ||
    mode === 'goodreads-sync' ||
    mode === 'format-pairing'
      ? []
      : mode === 'metadata-refresh'
        ? [...ARR_KINDS]
        : [...SYNC_SOURCES];
  return {
    mode,
    sources: sources.length > 0 ? [...new Set(sources)] : defaultSources,
    forceTombstones,
  };
}

async function main(): Promise<number> {
  const logger = createConsoleLogger();

  let args: CliArgs | 'help';
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof CliUsageError) {
      console.error(`sync: ${error.message}\n\n${USAGE}`);
      return 2;
    }
    throw error;
  }
  if (args === 'help') {
    console.log(USAGE);
    return 0;
  }

  if (!process.env.DATABASE_URL) {
    logger.error('DATABASE_URL is required');
    return 2;
  }

  // Build only the clients this run needs; missing keys for requested sources throw
  // one ArrConfigError naming every absent variable (never their values). trash-batch-sweep
  // has no *arr sources — it drives the Maintainerr bundle built below.
  const clients = buildSyncClients(args.sources);
  // ADR-018 / DESIGN-008 — the OPTIONAL metadata-harvest sources (Tautulli/TMDB/TVDB/
  // Maintainerr). Only built for metadata-refresh; each tier is skip-if-absent.
  const metadataSources =
    args.mode === 'metadata-refresh' ? buildMetadataSourceClients() : undefined;
  // ADR-025 / ADR-031 — the confined Maintainerr bundle for the batch-expiry sweep AND the
  // space-policy proposal mode (throws one ArrConfigError naming MAINTAINERR_API_KEY if absent). The
  // mutating client is constructed INSIDE @hnet/domain (maintainerrClientBundleFromEnv), so the
  // confined write surface stays domain-only (ADR-008 guard).
  // trash-batch-sweep / space-policy REQUIRE the bundle (throw if the key is absent). full/incremental
  // build it OPTIONALLY (DESIGN-014 build D — the pool-refresh backstop needs the WRITE surface); a
  // Maintainerr-less env just skips the backstop, like the candidate-refresh read handle below.
  let maintainerr: ReturnType<typeof maintainerrClientBundleFromEnv> | undefined;
  if (args.mode === 'trash-batch-sweep' || args.mode === 'space-policy') {
    maintainerr = maintainerrClientBundleFromEnv();
  } else if (args.mode === 'full' || args.mode === 'incremental') {
    try {
      maintainerr = maintainerrClientBundleFromEnv();
    } catch {
      maintainerr = undefined; // no MAINTAINERR_API_KEY — skip the backstop cleanly
    }
  }
  // ADR-035 — the OPTIONAL Maintainerr READ handle: full/incremental end by refreshing the Trash
  // candidate snapshot (skip-if-absent — a Maintainerr-less env just skips the step).
  const maintainerrRead =
    args.mode === 'full' || args.mode === 'incremental'
      ? buildOptionalMaintainerrRead()
      : undefined;
  // ADR-031 — the diskspace-only *arr read bundle for space-policy's getUtilization (needs the three
  // *arr keys; throws one ArrConfigError naming any absent). Wrapped as the minimal UtilizationArrBundle
  // shape — no bazarr, no confined write surface.
  let arr: UtilizationArrBundle | undefined;
  if (args.mode === 'space-policy') {
    const disk = buildSyncClients(['sonarr', 'radarr', 'lidarr']);
    arr = {
      read: {
        sonarr: requireClient(disk, 'sonarr'),
        radarr: requireClient(disk, 'radarr'),
        lidarr: requireClient(disk, 'lidarr'),
      },
    };
  }
  // ADR-040 / DESIGN-020 — the read-only @hnet/metrics Prometheus reader the `smart-alerts` mode reads
  // the smartctl series through (PROMETHEUS_URL, in-cluster default; no secret).
  const smartReader = args.mode === 'smart-alerts' ? prometheusClientFromEnv() : undefined;
  // ADR-054 / DESIGN-027 — the MAM-governor bundle (qBittorrent count read + the confined Prowlarr indexer
  // toggle) built INSIDE @hnet/domain (mamGovernorBundleFromEnv), so the confined downloads-stack write
  // surface stays domain-only (the arr-write import guard). Throws one DownloadsConfigError if
  // PROWLARR_API_KEY is absent. The tuning (limit/buffer/stuck-hours) is resolved through the
  // resolveGovernorConfig SEAM (env in v1; PLAN-040 adds a DB-backed admin override behind the same call).
  const mamGovernor = args.mode === 'mam-governor' ? mamGovernorBundleFromEnv() : undefined;
  const mamTuning = args.mode === 'mam-governor' ? await resolveGovernorConfig() : undefined;
  // ADR-059 / DESIGN-030 — the books activity bundle (LL wanted-table read + SAB queue/history read + the
  // confined LL write) built INSIDE @hnet/domain (booksActivityBundleFromEnv), so the confined LL write
  // surface stays domain-only (the arr-write import guard). Construction asserts env (throws if
  // LAZYLIBRARIAN_API_KEY or SABNZBD_API_KEY is absent). Only the `activity-scan` mode uses it (READ side —
  // failure detection). GUARDED (the Kapowarr idiom): a missing env parks the BOOKS source for this run —
  // the *arr + comics sources still scan (per-source isolation — the orchestrator won't close book strands
  // it couldn't read). The exact prod incident: a missing SABNZBD_API_KEY must degrade, never crash the run.
  let activityBundle: BooksActivityBundle | undefined;
  if (args.mode === 'activity-scan') {
    try {
      activityBundle = booksActivityBundleFromEnv();
    } catch (error) {
      activityBundle = undefined;
      logger.warn('activity-scan: books source unavailable (LL/SAB env) — comics/*arr still scan', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  // ADR-059 / DESIGN-030 D-08 — the UNIVERSAL *arr activity adapter (Radarr/Sonarr/Lidarr queue + recent-
  // import read) the `activity-scan` mode ALSO scans for import failures (import_blocked / download_failed).
  // Built from the D-18 *arr read clients (throws one ArrConfigError naming any absent SONARR/RADARR/LIDARR
  // key). READ-ONLY here — the retry/re-search WRITES fire only from the API action resolver. GUARDED for
  // the same per-source isolation: a missing *arr key parks the *arr source, never crashes the whole scan.
  let arrActivityAdapter: ActivitySourceAdapter | undefined;
  if (args.mode === 'activity-scan') {
    try {
      const arrClients = buildSyncClients(['sonarr', 'radarr', 'lidarr']);
      arrActivityAdapter = buildArrActivityAdapter(
        {
          radarr: requireClient(arrClients, 'radarr'),
          sonarr: requireClient(arrClients, 'sonarr'),
          lidarr: requireClient(arrClients, 'lidarr'),
        },
        { baseUrls: resolveArrBaseUrls() },
      );
    } catch (error) {
      arrActivityAdapter = undefined;
      logger.warn(
        'activity-scan: *arr source unavailable (Sonarr/Radarr/Lidarr env) — books/comics still scan',
        {
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }
  // ADR-059 / DESIGN-030 D-08 — the KAPOWARR (comics) activity adapter (queue + tasks + history read) the
  // `activity-scan` mode ALSO scans for comic download failures. OPTIONAL/degrade-safe (the goodreads-sync
  // idiom): absent KAPOWARR_API_KEY ⇒ comics are simply not scanned (parked), never a failed run. READ-ONLY
  // here — the force-search WRITE fires only from the API action resolver via the confined write surface.
  let kapowarrActivityAdapter: ActivitySourceAdapter | undefined;
  if (args.mode === 'activity-scan') {
    try {
      const bundle = kapowarrBundleFromEnv();
      kapowarrActivityAdapter = buildKapowarrActivityAdapter(bundle.read, {
        baseUrl: resolveKapowarrBaseUrl(),
      });
    } catch {
      kapowarrActivityAdapter = undefined;
      logger.info('activity-scan: no KAPOWARR_API_KEY — comics not scanned');
    }
  }
  // ADR-043 / DESIGN-021 — the Plex client bundle (read + confined write) the `poster-guard` mode uses.
  // ADR-047 / DESIGN-025 — `plex-match` reuses the same bundle (READ side only) to enumerate the Movies/
  // TV/Music libraries. Built INSIDE @hnet/domain (plexClientBundleFromEnv), so the confined Plex write
  // surface stays domain-only (ADR-017 guard); throws one PlexConfigError if a PLEX_*_TOKEN is absent.
  // ADR-064 / DESIGN-035 — `collections-sync` reuses the same bundle (READ side only, haynesops).
  const plex =
    args.mode === 'poster-guard' || args.mode === 'plex-match' || args.mode === 'collections-sync'
      ? plexClientBundleFromEnv()
      : undefined;
  // DESIGN-035 D-16 — the OPTIONAL Radarr read the `collections-sync` mode uses for the movie
  // Wanted-tile membership. Skip-if-absent: no RADARR_API_KEY ⇒ held-only (the mirror still runs).
  const collectionsRadarr =
    args.mode === 'collections-sync'
      ? (() => {
          try {
            return buildSyncClients(['radarr']).radarr;
          } catch {
            return undefined;
          }
        })()
      : undefined;
  // ADR-044 / DESIGN-022 — the read-only Open WebUI admin-API client the `ai-usage-sync` mode polls
  // (OPENWEBUI_URL defaults to the in-cluster service DNS; throws OpenWebUiConfigError if
  // OPENWEBUI_API_KEY is absent). Read-only — it never mutates Open WebUI.
  const openWebUi = args.mode === 'ai-usage-sync' ? openWebUiClientFromEnv() : undefined;
  // ADR-045 / DESIGN-023 — the read-only Authentik directory client the `authentik-users` mode pages
  // (AUTHENTIK_URL defaults to the in-cluster Service DNS; throws AuthentikConfigError if
  // AUTHENTIK_API_TOKEN is absent). Read-only — it never mutates Authentik.
  const authentik =
    args.mode === 'authentik-users'
      ? (() => {
          const cfg = assertAuthentikEnv();
          return authentikReadClient({ baseUrl: cfg.baseUrl, token: cfg.token });
        })()
      : undefined;
  // ADR-046 / DESIGN-024 — the read-only Kavita + Audiobookshelf clients the `books-sync` mode pages
  // (KAVITA_URL/AUDIOBOOKSHELF_URL default to the in-cluster Service DNS; throws BooksConfigError if a
  // password is absent). Read-only — never a write to the book servers.
  // ADR-066 / DESIGN-038 — `books-collections-sync` rides the SAME read-only bundle (no new env).
  const books: BooksSyncBundle | undefined =
    args.mode === 'books-sync' || args.mode === 'books-collections-sync'
      ? (() => {
          const cfg = assertBooksEnv();
          const clients = booksReadClients(cfg);
          return {
            kavita: clients.kavita,
            audiobookshelf: clients.audiobookshelf,
            kavitaPublicUrl: cfg.kavita.publicUrl,
            audiobookshelfPublicUrl: cfg.audiobookshelf.publicUrl,
          };
        })()
      : undefined;
  // DESIGN-038 D-13 — the OPTIONAL Libretto READ client the `books-collections-sync` mode uses for the
  // collection Wanted-tile membership (recipes' missing members → origin='collection' book_requests).
  // Skip-if-absent: no LIBRETTO_API_KEY ⇒ held-only (the mirror still runs). Read-only — never a Libretto
  // write (the /write surface stays domain-confined; the CLI imports only /read).
  const librettoRead =
    args.mode === 'books-collections-sync'
      ? (() => {
          try {
            const cfg = assertLibrettoEnv();
            return new LibrettoReadClient({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey });
          } catch (error) {
            if (error instanceof LibrettoConfigError) {
              logger.info('books-collections-sync: no LIBRETTO_API_KEY — collection wanted tiles skipped');
              return undefined;
            }
            throw error;
          }
        })()
      : undefined;
  // ADR-055 / DESIGN-028 — the read-only Goodreads RSS + Google Books clients (GOODREADS_BASE_URL /
  // GOOGLE_BOOKS_URL default to the public hosts; GOOGLE_BOOKS_API_KEY optional). Pull-only.
  // DESIGN-039 D-21 — one daily GB CALL BUDGET meter per GB-using cron process, wired into the GB
  // client's http wrapper (onCall) so EVERY outbound GB leg is counted; the domain run attributes the
  // meter's per-seam delta to a consumer and persists it to gb_call_budget (RSS getText carries no
  // meter, so shelf reads are never counted).
  const gbMeter: GbCallMeter | undefined =
    args.mode === 'goodreads-sync' || args.mode === 'format-pairing' ? createGbCallMeter() : undefined;
  const goodreads: GoodreadsSourceBundle | undefined =
    args.mode === 'goodreads-sync'
      ? (() => {
          const cfg = goodreadsConfigFromEnv();
          return {
            rss: new GoodreadsRssClient({ baseUrl: cfg.goodreadsBaseUrl }),
            googleBooks: new GoogleBooksClient({
              baseUrl: cfg.googleBooksUrl,
              ...(cfg.googleBooksApiKey ? { apiKey: cfg.googleBooksApiKey } : {}),
              ...(gbMeter ? { onCall: gbMeter.onCall } : {}),
            }),
          };
        })()
      : undefined;
  // ADR-055 / DESIGN-028 — the confined LazyLibrarian bundle (built INSIDE @hnet/domain, so the confined
  // write surface stays domain-only — the arr-write import guard). OPTIONAL for goodreads-sync: absent
  // LAZYLIBRARIAN_API_KEY ⇒ a degraded run that mirrors + mints requests but pushes nothing (logged).
  // ADR-065 — the `format-pairing` mode rides the SAME confined bundle for its missing-format pushes.
  // ADR-072 / DESIGN-043 D-14 (PLAN-052 PR4c) — `books-collections-sync` ALSO builds the confined bundle so
  // the cron FORCE-SEARCH leg can drive LazyLibrarian over find-missing collections' wants. Absent the key
  // ⇒ the flag is set but the app pulls nothing (Libretto's own apply/cron still acquires) — a degraded run.
  let lazyLibrarian: LazyLibrarianClientBundle | undefined;
  if (
    args.mode === 'goodreads-sync' ||
    args.mode === 'format-pairing' ||
    args.mode === 'books-collections-sync'
  ) {
    try {
      lazyLibrarian = lazyLibrarianBundleFromEnv();
    } catch {
      lazyLibrarian = undefined;
      logger.info(`${args.mode}: no LAZYLIBRARIAN_API_KEY — running in mint-only (no push) mode`);
    }
  }
  // ADR-065 / DESIGN-036 — the GB resolver the `format-pairing` mode falls back to (reuse-first) for a
  // pairing want's LL identity. Keyless GB works (rate-limited) — the client is always constructible.
  const pairingGb =
    args.mode === 'format-pairing'
      ? (() => {
          const cfg = goodreadsConfigFromEnv();
          return new GoogleBooksClient({
            baseUrl: cfg.googleBooksUrl,
            ...(cfg.googleBooksApiKey ? { apiKey: cfg.googleBooksApiKey } : {}),
            ...(gbMeter ? { onCall: gbMeter.onCall } : {}),
          });
        })()
      : undefined;
  // ADR-056 (PLAN-046) — the confined Kapowarr bundle for the goodreads-sync COMIC leg (built INSIDE
  // @hnet/domain, so the confined write surface stays domain-only — the arr-write import guard). OPTIONAL:
  // absent KAPOWARR_API_KEY ⇒ comics stay PARKED (unroutable_reason='comic') — the honest degraded run.
  let kapowarr: KapowarrClientBundle | undefined;
  if (args.mode === 'goodreads-sync') {
    try {
      kapowarr = kapowarrBundleFromEnv();
    } catch {
      kapowarr = undefined;
      logger.info('goodreads-sync: no KAPOWARR_API_KEY — comics parked (no Kapowarr routing)');
    }
  }

  logger.info('sync starting', {
    mode: args.mode,
    sources: args.sources,
    forceTombstones: args.forceTombstones,
    ...(metadataSources
      ? {
          tautulliInstances: metadataSources.tautulli.map((t) => t.slug),
          tmdb: Boolean(metadataSources.tmdb),
          tvdb: Boolean(metadataSources.tvdb),
          maintainerr: Boolean(metadataSources.maintainerr),
        }
      : {}),
  });
  const report = await runSync({
    mode: args.mode,
    sources: args.sources,
    forceTombstones: args.forceTombstones,
    clients,
    ...(metadataSources ? { metadataSources } : {}),
    ...(maintainerr ? { maintainerr } : {}),
    ...(arr ? { arr } : {}),
    ...(maintainerrRead ? { maintainerrRead } : {}),
    ...(smartReader ? { smartReader } : {}),
    ...(mamGovernor ? { mamGovernor } : {}),
    ...(mamTuning ? { mamTuning } : {}),
    ...(activityBundle ? { activityBundle } : {}),
    ...(arrActivityAdapter ? { arrActivityAdapter } : {}),
    ...(kapowarrActivityAdapter ? { kapowarrActivityAdapter } : {}),
    ...(plex ? { plex } : {}),
    ...(collectionsRadarr ? { collectionsRadarr } : {}),
    ...(openWebUi ? { openWebUi } : {}),
    ...(authentik ? { authentik } : {}),
    ...(books ? { books } : {}),
    ...(librettoRead ? { librettoRead } : {}),
    ...(goodreads ? { goodreads } : {}),
    ...(lazyLibrarian ? { lazyLibrarian } : {}),
    ...(kapowarr ? { kapowarr } : {}),
    ...(pairingGb ? { pairingGb } : {}),
    ...(gbMeter ? { gbMeter } : {}),
    logger,
  });

  logger.info('sync finished', {
    mode: report.mode,
    durationMs: report.finishedAt.getTime() - report.startedAt.getTime(),
    totalFailure: report.totalFailure,
    backfill: report.backfill,
    fixesCompleted: report.fixesCompleted,
    ...(report.candidateRefresh
      ? {
          candidateRefresh: {
            durationMs: report.candidateRefresh.durationMs,
            kinds: report.candidateRefresh.kinds,
          },
        }
      : {}),
    ...(report.candidateRefreshError !== undefined
      ? { candidateRefreshError: report.candidateRefreshError }
      : {}),
    ...(report.poolRefresh && report.poolRefresh.dueKinds.length > 0
      ? { poolRefresh: report.poolRefresh }
      : {}),
    ...(report.poolRefreshError !== undefined ? { poolRefreshError: report.poolRefreshError } : {}),
    ...(report.sweep
      ? { sweep: { batchesSwept: report.sweep.batchesSwept, batches: report.sweep.batches } }
      : {}),
    ...(report.sweepError !== undefined ? { sweepError: report.sweepError } : {}),
    ...(report.spacePolicy
      ? {
          spacePolicy: {
            enabled: report.spacePolicy.enabled,
            proposedCount: report.spacePolicy.proposedCount,
            arrays: report.spacePolicy.arrays,
          },
        }
      : {}),
    ...(report.spacePolicyError !== undefined ? { spacePolicyError: report.spacePolicyError } : {}),
    ...(report.outbox
      ? {
          outbox: {
            dueCount: report.outbox.dueCount,
            sent: report.outbox.sent,
            failed: report.outbox.failed,
            parked: report.outbox.parked,
            skipped: report.outbox.skipped,
          },
        }
      : {}),
    ...(report.outboxError !== undefined ? { outboxError: report.outboxError } : {}),
    ...(report.smartAlerts ? { smartAlerts: report.smartAlerts } : {}),
    ...(report.smartAlertsError !== undefined ? { smartAlertsError: report.smartAlertsError } : {}),
    ...(report.mamGovernor ? { mamGovernor: report.mamGovernor } : {}),
    ...(report.mamGovernorError !== undefined ? { mamGovernorError: report.mamGovernorError } : {}),
    ...(report.posterGuard
      ? {
          posterGuard: {
            found: report.posterGuard.found,
            checked: report.posterGuard.checked,
            inSync: report.posterGuard.inSync,
            reapplied: report.posterGuard.reapplied.length,
            unmapped: report.posterGuard.unmapped.length,
            missingAssets: report.posterGuard.missingAssets,
          },
        }
      : {}),
    ...(report.posterGuardError !== undefined ? { posterGuardError: report.posterGuardError } : {}),
    ...(report.aiUsage ? { aiUsage: report.aiUsage } : {}),
    ...(report.aiUsageError !== undefined ? { aiUsageError: report.aiUsageError } : {}),
    ...(report.plexMatch
      ? {
          plexMatch: {
            upserted: report.plexMatch.upserted,
            removed: report.plexMatch.removed,
            byKind: report.plexMatch.stats.byKind,
            plexTitlesIndexed: report.plexMatch.stats.plexTitlesIndexed,
            unmappedSections: report.plexMatch.stats.unmappedSections,
          },
        }
      : {}),
    ...(report.plexMatchError !== undefined ? { plexMatchError: report.plexMatchError } : {}),
    ...(report.collectionsSync
      ? {
          collectionsSync: {
            collectionsUpserted: report.collectionsSync.collectionsUpserted,
            membersUpserted: report.collectionsSync.membersUpserted,
            collectionsRemoved: report.collectionsSync.collectionsRemoved,
            membersRemoved: report.collectionsSync.membersRemoved,
            truncatedCollections: report.collectionsSync.stats.truncatedCollections,
            truncatedSections: report.collectionsSync.stats.truncatedSections,
            unmappedSections: report.collectionsSync.stats.unmappedSections,
          },
        }
      : {}),
    ...(report.collectionsSyncError !== undefined
      ? { collectionsSyncError: report.collectionsSyncError }
      : {}),
    ...(report.booksCollectionsSync
      ? {
          booksCollectionsSync: {
            collectionsUpserted: report.booksCollectionsSync.collectionsUpserted,
            membersUpserted: report.booksCollectionsSync.membersUpserted,
            membersResolved: report.booksCollectionsSync.membersResolved,
            collectionsRemoved: report.booksCollectionsSync.collectionsRemoved,
            membersRemoved: report.booksCollectionsSync.membersRemoved,
            truncatedCollections: report.booksCollectionsSync.stats.truncatedCollections,
            unscopedFamilies: report.booksCollectionsSync.stats.unscopedFamilies,
          },
        }
      : {}),
    ...(report.booksCollectionsSyncError !== undefined
      ? { booksCollectionsSyncError: report.booksCollectionsSyncError }
      : {}),
    ...(report.goodreadsSync
      ? {
          goodreadsSync: {
            integrations: report.goodreadsSync.integrations,
            synced: report.goodreadsSync.synced,
            failed: report.goodreadsSync.failed,
            // ADR-067 (PLAN-055) — quota-skipped enrichment + the queued-fix retry pass.
            skippedEnrichment: report.goodreadsSync.skippedEnrichment,
            ...(report.goodreadsSync.fixRetries
              ? { fixRetries: report.goodreadsSync.fixRetries }
              : {}),
          },
        }
      : {}),
    ...(report.goodreadsSyncError !== undefined
      ? { goodreadsSyncError: report.goodreadsSyncError }
      : {}),
    ...(report.formatPairing ? { formatPairing: report.formatPairing } : {}),
    ...(report.formatPairingError !== undefined
      ? { formatPairingError: report.formatPairingError }
      : {}),
    sources: report.sources.map((s) => ({
      source: s.source,
      status: s.status,
      runId: s.runId,
      ...(s.error !== undefined ? { error: s.error } : {}),
      stats: s.stats,
    })),
  });
  return report.totalFailure ? 1 : 0;
}

main()
  .then(async (code) => {
    // Close the pg pool so the process can exit promptly on success paths too.
    try {
      await getPool().end();
    } catch {
      // pool never initialized (config error before any DB use) — nothing to close
    }
    process.exit(code);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
