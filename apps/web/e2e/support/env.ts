// Environment composition for the e2e/dev-local stack — importable by anything
// (NO Playwright imports here): the Playwright globalSetup and the `pnpm dev:local`
// harness (apps/web/dev/local.ts, via startStack) both consume this same module to
// boot an identical environment — one for tests, one interactively.
//
// Also hosts the on-disk env handoff between Playwright's globalSetup and its
// test workers — workers do not reliably inherit process.env mutations made
// inside globalSetup across Playwright versions (donor lesson: todos-for-dues
// e2e/fixtures/runtime-env.ts). Path is relative to process.cwd(): both
// Playwright and pnpm-filtered scripts run from apps/web.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ADMIN_EMAIL, STUB_CLIENT_ID, STUB_CLIENT_SECRET } from './stub-oidc';
import { STUB_BAZARR_API_KEY } from './stub-bazarr';
import { STUB_PLEX_TOKENS } from './stub-plex';
import { STUB_MAINTAINERR_API_KEY } from './stub-maintainerr';
import { STUB_OPENWEBUI_API_KEY } from './stub-openwebui';
import { STUB_AUTHENTIK_API_TOKEN } from './stub-authentik';
import { STUB_ABS_PASSWORD, STUB_KAVITA_PASSWORD } from './stub-books';

/** Default app port — off 3000 so the stack coexists with a running `pnpm dev`.
 *  playwright.config.ts's baseURL derives from this. */
export const DEFAULT_APP_PORT = 3100;

export const TMP_DIR = join(process.cwd(), '.playwright-tmp');
const ENV_FILE = join(TMP_DIR, 'env.json');

export interface RuntimeEnv {
  /** Embedded PG16 connection string (ADR-010 — real Postgres, no Docker). */
  DATABASE_URL: string;
  /** Stub OIDC origin — specs/tools POST its /_control endpoints. */
  STUB_OIDC_URL: string;
  OIDC_DISCOVERY_URL: string;
  OIDC_CLIENT_ID: string;
  OIDC_CLIENT_SECRET: string;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  BOOTSTRAP_ADMIN_EMAILS: string;
  /** Stub *arr origin — specs GET its /_stub/calls endpoint (DESIGN-005 e2e layer). */
  STUB_ARR_URL: string;
  /** Stub Bazarr origin — specs GET its /_stub/calls endpoint (ADR-016 / D-19). */
  STUB_BAZARR_URL: string;
  /** DESIGN-005 D-18 env contract, all pointed at the one stub server. */
  SONARR_URL: string;
  RADARR_URL: string;
  LIDARR_URL: string;
  SEERR_URL: string;
  SONARR_API_KEY: string;
  RADARR_API_KEY: string;
  LIDARR_API_KEY: string;
  SEERR_API_KEY: string;
  /** ADR-016 / D-19 — Bazarr subtitle-fix contract, pointed at the stub Bazarr server. */
  BAZARR_URL: string;
  BAZARR_API_KEY: string;
  /** ADR-017 / DESIGN-007 — stub Plex origin (specs GET its /_stub/calls). */
  STUB_PLEX_URL: string;
  /** Per-server Plex contract: URLs + owner tokens (distinct tokens so one stub can tell the
   *  three PMS instances apart) + the plex.tv override pointed at the same stub. */
  PLEX_HAYNESTOWER_URL: string;
  PLEX_HAYNESOPS_URL: string;
  PLEX_HAYNESKUBE_URL: string;
  PLEX_HAYNESTOWER_TOKEN: string;
  PLEX_HAYNESOPS_TOKEN: string;
  PLEX_HAYNESKUBE_TOKEN: string;
  PLEX_TV_URL: string;
  /** ADR-023 / DESIGN-010 — stub Maintainerr origin (specs GET its /_stub/calls) + the Trash
   *  contract (URL/key + the webhook shared secret). */
  STUB_MAINTAINERR_URL: string;
  MAINTAINERR_URL: string;
  MAINTAINERR_API_KEY: string;
  MAINTAINERR_WEBHOOK_SECRET: string;
  /** ADR-030 amendment (2026-07-09) — stub Prometheus origin (specs POST its /_stub/state) + the
   *  free-space-trend contract (storage.trend queries PROMETHEUS_URL's /api/v1/query_range). */
  STUB_PROMETHEUS_URL: string;
  PROMETHEUS_URL: string;
  /** ADR-044 / DESIGN-022 — stub Open WebUI origin + the ai-usage-sync contract (the sync mode polls
   *  OPENWEBUI_URL's admin API with OPENWEBUI_API_KEY). */
  STUB_OPENWEBUI_URL: string;
  OPENWEBUI_URL: string;
  OPENWEBUI_API_KEY: string;
  /** ADR-045 / DESIGN-023 — stub Authentik origin + the portal contract (the authentik-users sync +
   *  /admin/users portal read AUTHENTIK_URL's API with AUTHENTIK_API_TOKEN). */
  STUB_AUTHENTIK_URL: string;
  AUTHENTIK_URL: string;
  AUTHENTIK_API_TOKEN: string;
  /** ADR-046 / DESIGN-024 — stub books-server origin + the books-sync/cover contract (KAVITA_* +
   *  AUDIOBOOKSHELF_* point at the one stub; the public URLs seed the stored deep links). */
  STUB_BOOKS_URL: string;
  KAVITA_URL: string;
  KAVITA_USERNAME: string;
  KAVITA_PASSWORD: string;
  KAVITA_PUBLIC_URL: string;
  AUDIOBOOKSHELF_URL: string;
  AUDIOBOOKSHELF_USERNAME: string;
  AUDIOBOOKSHELF_PASSWORD: string;
  AUDIOBOOKSHELF_PUBLIC_URL: string;
  /** ADR-026 / DESIGN-012 — per-source Bulletin webhook shared secrets (Seerr + Tautulli). */
  SEERR_WEBHOOK_SECRET: string;
  TAUTULLI_WEBHOOK_SECRET: string;
  /** ADR-028 test hook — the found-nothing window, shortened so the nothing_found
   *  terminal is reachable inside a Playwright test (prod default is 15 min). */
  ACTION_FOUND_NOTHING_WINDOW_MS: string;
}

/** The shared secret the e2e Maintainerr webhook receiver requires. */
export const STUB_MAINTAINERR_WEBHOOK_SECRET = 'e2e-maintainerr-webhook-secret';
/** ADR-026 — the per-source Bulletin webhook secrets the e2e receiver requires. */
export const STUB_SEERR_WEBHOOK_SECRET = 'e2e-seerr-webhook-secret';
export const STUB_TAUTULLI_WEBHOOK_SECRET = 'e2e-tautulli-webhook-secret';

/** The throwaway key every stubbed *arr accepts (never a real credential). */
export const STUB_ARR_API_KEY = 'stub-arr-key';

/**
 * The DESIGN-002 D-08 env contract wired to a running stack: embedded PG +
 * stub OIDC (discovery override — the D-08 stub hook) + the app origin.
 * The stack owns its env end to end — *.example.test personas, never the
 * owner's real emails.
 */
export function composeRuntimeEnv(opts: {
  databaseUrl: string;
  stubOidcBaseUrl: string;
  stubOidcDiscoveryUrl: string;
  stubArrBaseUrl: string;
  stubBazarrBaseUrl: string;
  stubPlexBaseUrl: string;
  stubMaintainerrBaseUrl: string;
  stubPrometheusBaseUrl: string;
  stubOpenWebUiBaseUrl: string;
  stubAuthentikBaseUrl: string;
  stubBooksBaseUrl: string;
  appUrl: string;
}): RuntimeEnv {
  return {
    DATABASE_URL: opts.databaseUrl,
    STUB_OIDC_URL: opts.stubOidcBaseUrl,
    OIDC_DISCOVERY_URL: opts.stubOidcDiscoveryUrl,
    OIDC_CLIENT_ID: STUB_CLIENT_ID,
    OIDC_CLIENT_SECRET: STUB_CLIENT_SECRET,
    BETTER_AUTH_SECRET: 'e2e-only-secret-e2e-only-secret-e2e-only',
    BETTER_AUTH_URL: opts.appUrl,
    BOOTSTRAP_ADMIN_EMAILS: ADMIN_EMAIL,
    STUB_ARR_URL: opts.stubArrBaseUrl,
    STUB_BAZARR_URL: opts.stubBazarrBaseUrl,
    SONARR_URL: opts.stubArrBaseUrl,
    RADARR_URL: opts.stubArrBaseUrl,
    LIDARR_URL: opts.stubArrBaseUrl,
    SEERR_URL: opts.stubArrBaseUrl,
    SONARR_API_KEY: STUB_ARR_API_KEY,
    RADARR_API_KEY: STUB_ARR_API_KEY,
    LIDARR_API_KEY: STUB_ARR_API_KEY,
    SEERR_API_KEY: STUB_ARR_API_KEY,
    BAZARR_URL: opts.stubBazarrBaseUrl,
    BAZARR_API_KEY: STUB_BAZARR_API_KEY,
    STUB_PLEX_URL: opts.stubPlexBaseUrl,
    // All three PMS URLs + the plex.tv override point at the one stub; distinct tokens let it
    // tell the servers apart (the stub also routes plex.tv calls by machineId in the path).
    PLEX_HAYNESTOWER_URL: opts.stubPlexBaseUrl,
    PLEX_HAYNESOPS_URL: opts.stubPlexBaseUrl,
    PLEX_HAYNESKUBE_URL: opts.stubPlexBaseUrl,
    PLEX_HAYNESTOWER_TOKEN: STUB_PLEX_TOKENS.haynestower,
    PLEX_HAYNESOPS_TOKEN: STUB_PLEX_TOKENS.haynesops,
    PLEX_HAYNESKUBE_TOKEN: STUB_PLEX_TOKENS.hayneskube,
    PLEX_TV_URL: opts.stubPlexBaseUrl,
    STUB_MAINTAINERR_URL: opts.stubMaintainerrBaseUrl,
    MAINTAINERR_URL: opts.stubMaintainerrBaseUrl,
    MAINTAINERR_API_KEY: STUB_MAINTAINERR_API_KEY,
    MAINTAINERR_WEBHOOK_SECRET: STUB_MAINTAINERR_WEBHOOK_SECRET,
    STUB_PROMETHEUS_URL: opts.stubPrometheusBaseUrl,
    PROMETHEUS_URL: opts.stubPrometheusBaseUrl,
    STUB_OPENWEBUI_URL: opts.stubOpenWebUiBaseUrl,
    OPENWEBUI_URL: opts.stubOpenWebUiBaseUrl,
    OPENWEBUI_API_KEY: STUB_OPENWEBUI_API_KEY,
    STUB_AUTHENTIK_URL: opts.stubAuthentikBaseUrl,
    AUTHENTIK_URL: opts.stubAuthentikBaseUrl,
    AUTHENTIK_API_TOKEN: STUB_AUTHENTIK_API_TOKEN,
    STUB_BOOKS_URL: opts.stubBooksBaseUrl,
    KAVITA_URL: opts.stubBooksBaseUrl,
    KAVITA_USERNAME: 'hnetadmin',
    KAVITA_PASSWORD: STUB_KAVITA_PASSWORD,
    KAVITA_PUBLIC_URL: 'https://kavita.haynesnetwork.com',
    AUDIOBOOKSHELF_URL: opts.stubBooksBaseUrl,
    AUDIOBOOKSHELF_USERNAME: 'root',
    AUDIOBOOKSHELF_PASSWORD: STUB_ABS_PASSWORD,
    AUDIOBOOKSHELF_PUBLIC_URL: 'https://audiobookshelf.haynesnetwork.com',
    SEERR_WEBHOOK_SECRET: STUB_SEERR_WEBHOOK_SECRET,
    TAUTULLI_WEBHOOK_SECRET: STUB_TAUTULLI_WEBHOOK_SECRET,
    // 30 s (vs 15 min in prod): long enough that fresh submits deterministically read
    // `searching`, short enough that a spec can WAIT OUT the window for nothing_found.
    ACTION_FOUND_NOTHING_WINDOW_MS: '30000',
  };
}

export function writeRuntimeEnv(env: RuntimeEnv): void {
  mkdirSync(TMP_DIR, { recursive: true });
  writeFileSync(ENV_FILE, JSON.stringify(env, null, 2), 'utf8');
}

export function readRuntimeEnv(): RuntimeEnv {
  if (!existsSync(ENV_FILE)) {
    throw new Error(`${ENV_FILE} not found — is Playwright's globalSetup running?`);
  }
  return JSON.parse(readFileSync(ENV_FILE, 'utf8')) as RuntimeEnv;
}
