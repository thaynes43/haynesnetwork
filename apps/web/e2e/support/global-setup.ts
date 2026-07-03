// Playwright globalSetup — boots the whole stack for the e2e suite (ADR-010):
// embedded Postgres 16 (@hnet/test-utils — real PG, no Docker in this WSL distro),
// the actual @hnet/db migrations (incl. the 0002 catalog seed the specs assert
// against), the stub OIDC provider, then `next dev`.
//
// The dev server is spawned HERE, not via Playwright's `webServer` block: the
// webServer plugin starts BEFORE globalSetup (runner createGlobalSetupTasks
// ordering — donor lesson, todos-for-dues), so it would launch with a stale env,
// missing the embedded PG's DATABASE_URL and the stub's OIDC_DISCOVERY_URL that
// only exist once this file has run.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
// The /postgres subpath keeps Playwright's CJS TS loader away from
// @hnet/test-utils' index → @hnet/db/migrate chain (`import.meta` there is
// invalid under the CJS transform); migrations run as a subprocess instead.
import { startPostgres, type StartedPostgres } from '@hnet/test-utils/postgres';
import {
  startStubOidc,
  type StubOidcServer,
  STUB_CLIENT_ID,
  STUB_CLIENT_SECRET,
  ADMIN_EMAIL,
} from './stub-oidc';
import { writeRuntimeEnv, TMP_DIR, type RuntimeEnv } from './runtime-env';

// Off 3000 so the suite coexists with a locally running `pnpm dev`.
export const APP_PORT = 3100;
export const APP_URL = `http://localhost:${APP_PORT}`;
const DEV_READY_TIMEOUT_MS = 180_000;

export interface GlobalState {
  pg?: StartedPostgres;
  oidc?: StubOidcServer;
  dev?: ChildProcess;
}

const state: GlobalState = {};
(globalThis as { __HNET_E2E_STATE__?: GlobalState }).__HNET_E2E_STATE__ = state;

async function waitForReady(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: 'manual' });
      // Any HTTP response means the server is up and accepting connections.
      if (res.status < 600) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out (${timeoutMs}ms) waiting for ${url}; last error: ${String(lastErr)}`);
}

/**
 * Compile every spec-facing route once. Next's dev server compiles routes on first
 * request — on a cold CI runner that first-hit cost can eat a per-test timeout, so
 * we amortise it here (donor lesson). Dynamic routes are warmed with a zero-UUID
 * placeholder: the route MODULE compiles regardless of the param value.
 */
async function prewarmRoutes(baseUrl: string): Promise<void> {
  const placeholderId = '00000000-0000-0000-0000-000000000000';
  const routes = [
    '/',
    '/login',
    '/admin',
    '/admin/catalog',
    '/admin/tags',
    `/admin/users/${placeholderId}`,
    '/api/auth/get-session',
    '/api/trpc/profile.me',
  ];
  const start = Date.now();
  await Promise.all(
    routes.map((path) => fetch(baseUrl + path, { redirect: 'manual' }).catch(() => undefined)),
  );

  console.log(`[e2e] prewarm: ${routes.length} routes compiled in ${Date.now() - start}ms`);
}

export default async function globalSetup(): Promise<void> {
  rmSync(TMP_DIR, { recursive: true, force: true });

  // ── Embedded Postgres 16 + real migrations (seeds the app catalog) ──────
  const pg = await startPostgres();
  state.pg = pg;
  const migrate = spawnSync('pnpm', ['--filter', '@hnet/db', 'migrate'], {
    env: { ...process.env, DATABASE_URL: pg.connectionString },
    stdio: 'inherit',
  });
  if (migrate.status !== 0) {
    throw new Error(`@hnet/db migrations failed (exit ${String(migrate.status)})`);
  }

  // ── Stub OIDC provider ──────────────────────────────────────────────────
  const oidc = await startStubOidc();
  state.oidc = oidc;

  // ── Runtime env for the dev server AND the test workers ────────────────
  const runtimeEnv: RuntimeEnv = {
    DATABASE_URL: pg.connectionString,
    STUB_OIDC_URL: oidc.baseUrl,
    OIDC_DISCOVERY_URL: oidc.discoveryUrl,
    OIDC_CLIENT_ID: STUB_CLIENT_ID,
    OIDC_CLIENT_SECRET: STUB_CLIENT_SECRET,
    BETTER_AUTH_SECRET: 'e2e-only-secret-e2e-only-secret-e2e-only',
    BETTER_AUTH_URL: APP_URL,
    // Tests own their env — *.example.test personas, never the owner's emails.
    BOOTSTRAP_ADMIN_EMAILS: ADMIN_EMAIL,
  };
  Object.assign(process.env, runtimeEnv);
  writeRuntimeEnv(runtimeEnv);

  // ── Dev server (spawn .bin/next directly — pnpm can filter child env) ──
  const dev = spawn(
    join(process.cwd(), 'node_modules', '.bin', 'next'),
    ['dev', '--port', String(APP_PORT)],
    {
      env: { ...process.env, ...runtimeEnv },
      cwd: process.cwd(),
      stdio: 'inherit',
      detached: false,
    },
  );
  state.dev = dev;
  dev.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) {
      console.error(
        `[e2e] dev server exited unexpectedly (code=${code}, signal=${signal ?? 'none'})`,
      );
    }
  });

  await waitForReady(APP_URL, DEV_READY_TIMEOUT_MS);
  await prewarmRoutes(APP_URL);

  console.log(`[e2e] ready: pg=${pg.connectionString} oidc=${oidc.baseUrl} app=${APP_URL}`);
}
