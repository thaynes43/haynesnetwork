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
}

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
