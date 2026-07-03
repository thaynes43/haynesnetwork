// On-disk handoff between Playwright globalSetup and the test workers — workers do
// not reliably inherit process.env mutations made inside globalSetup across
// Playwright versions (donor lesson: todos-for-dues e2e/fixtures/runtime-env.ts).
// Path is relative to process.cwd(): Playwright always runs from apps/web.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const TMP_DIR = join(process.cwd(), '.playwright-tmp');
const ENV_FILE = join(TMP_DIR, 'env.json');

export interface RuntimeEnv {
  /** Embedded PG16 connection string (ADR-010 — real Postgres, no Docker). */
  DATABASE_URL: string;
  /** Stub OIDC origin — specs POST its /_control endpoints. */
  STUB_OIDC_URL: string;
  OIDC_DISCOVERY_URL: string;
  OIDC_CLIENT_ID: string;
  OIDC_CLIENT_SECRET: string;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  BOOTSTRAP_ADMIN_EMAILS: string;
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
