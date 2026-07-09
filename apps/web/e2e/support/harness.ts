// Reusable stack harness — boots the full local environment as a plain async
// module (NO Playwright imports): embedded Postgres 16 (@hnet/test-utils), the
// real @hnet/db migrations (incl. the 0002 catalog seed), the stub OIDC provider,
// and `next dev`. The Playwright globalSetup is one consumer; `pnpm dev:local`
// (apps/web/dev/local.ts) is the other (same stack, interactive browser, sign in
// as the stub personas — see stub-oidc.ts STUB_USERS).
//
// Entry point: `startStack(options?)` → `RunningStack` with an idempotent
// `stop()` that tears everything down in reverse (dev server → stub OIDC → PG).
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
// The /postgres subpath keeps CJS TS loaders (Playwright's transform) away from
// @hnet/test-utils' index → @hnet/db/migrate chain (`import.meta` there is
// invalid under the CJS transform); migrations run as a subprocess instead.
import { startPostgres, type StartedPostgres } from '@hnet/test-utils/postgres';
import { startStubOidc, type StubOidcServer } from './stub-oidc';
import { startStubArr, type StubArrServer } from './stub-arr';
import { startStubBazarr, type StubBazarrServer } from './stub-bazarr';
import { startStubPlex, type StubPlexServer } from './stub-plex';
import { startStubMaintainerr, type StubMaintainerrServer } from './stub-maintainerr';
import { startStubPrometheus, type StubPrometheusServer } from './stub-prometheus';
import { composeRuntimeEnv, DEFAULT_APP_PORT, type RuntimeEnv } from './env';

const DEV_READY_TIMEOUT_MS = 180_000;

export interface StackOptions {
  /** App port (default 3100 — off 3000 so a local `pnpm dev` keeps its port). */
  port?: number;
  /**
   * Pre-compile every user-facing route once after boot (default true). Next's
   * dev server compiles on first request — on a cold CI runner that first-hit
   * cost can eat a per-test timeout (donor lesson, todos-for-dues).
   */
  prewarm?: boolean;
  /** Working directory containing the Next app (default process.cwd()). */
  cwd?: string;
}

export interface RunningStack {
  appUrl: string;
  pg: StartedPostgres;
  oidc: StubOidcServer;
  /** Stub Sonarr/Radarr/Lidarr/Seerr stand-in (DESIGN-005 e2e layer). */
  arr: StubArrServer;
  /** Stub Bazarr stand-in — subtitle-fix e2e layer (ADR-016 / D-19). */
  bazarr: StubBazarrServer;
  /** Stub Plex stand-in — library self-service e2e layer (ADR-017 / DESIGN-007). */
  plex: StubPlexServer;
  /** Stub Maintainerr stand-in — Trash section e2e layer (ADR-023 / DESIGN-010). */
  maintainerr: StubMaintainerrServer;
  /** Stub Prometheus stand-in — free-space-trend e2e layer (ADR-030 amendment 2026-07-09). */
  prometheus: StubPrometheusServer;
  devServer: ChildProcess;
  /** The DESIGN-002 D-08 env the dev server was booted with. */
  env: RuntimeEnv;
  /** Idempotent, reverse-order teardown: dev server → stub Prometheus → stub Maintainerr → stub Plex → stub Bazarr → stub *arr → stub OIDC → Postgres. */
  stop: () => Promise<void>;
}

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
 * Compile every user-facing route once. Dynamic routes are warmed with a
 * zero-UUID placeholder: the route MODULE compiles regardless of param value.
 */
async function prewarmRoutes(baseUrl: string): Promise<void> {
  const placeholderId = '00000000-0000-0000-0000-000000000000';
  const routes = [
    '/',
    '/login',
    '/library',
    `/library/${placeholderId}`,
    '/library/plex',
    '/ledger',
    '/trash',
    '/my-fixes',
    '/admin',
    '/admin/catalog',
    '/admin/roles',
    '/admin/tags',
    '/admin/fixes',
    '/admin/restore',
    `/admin/users/${placeholderId}`,
    '/api/auth/get-session',
    '/api/trpc/profile.me',
  ];
  const start = Date.now();
  await Promise.all(
    routes.map((path) => fetch(baseUrl + path, { redirect: 'manual' }).catch(() => undefined)),
  );
  console.log(`[stack] prewarm: ${routes.length} routes compiled in ${Date.now() - start}ms`);
}

async function killDevServer(dev: ChildProcess): Promise<void> {
  if (dev.exitCode !== null || dev.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    dev.once('exit', () => resolve());
    try {
      dev.kill('SIGTERM');
    } catch {
      resolve();
      return;
    }
    const escalate = setTimeout(() => {
      try {
        dev.kill('SIGKILL');
      } catch {
        // already gone
      }
    }, 5_000);
    escalate.unref();
  });
}

/**
 * Boot the whole stack: embedded PG16 → migrations (subprocess — see the
 * @hnet/test-utils/postgres import note) → stub OIDC on a free port →
 * `next dev` with the composed env. Cleans up everything it managed to start
 * if a later step fails.
 */
export async function startStack(options: StackOptions = {}): Promise<RunningStack> {
  const port = options.port ?? DEFAULT_APP_PORT;
  const cwd = options.cwd ?? process.cwd();
  const appUrl = `http://localhost:${port}`;

  const pg = await startPostgres();
  let oidc: StubOidcServer | undefined;
  let arr: StubArrServer | undefined;
  let bazarr: StubBazarrServer | undefined;
  let plex: StubPlexServer | undefined;
  let maintainerr: StubMaintainerrServer | undefined;
  let prometheus: StubPrometheusServer | undefined;
  let dev: ChildProcess | undefined;
  try {
    const migrate = spawnSync('pnpm', ['--filter', '@hnet/db', 'migrate'], {
      env: { ...process.env, DATABASE_URL: pg.connectionString },
      stdio: 'inherit',
    });
    if (migrate.status !== 0) {
      throw new Error(`@hnet/db migrations failed (exit ${String(migrate.status)})`);
    }

    // Seed the ledger rows the /library specs browse — a tsx subprocess for the
    // same CJS-transform reason migrations are (see the import note above).
    const seed = spawnSync(
      join(cwd, 'node_modules', '.bin', 'tsx'),
      [join(cwd, 'e2e', 'support', 'seed-ledger.ts')],
      {
        env: { ...process.env, DATABASE_URL: pg.connectionString },
        stdio: 'inherit',
        cwd,
      },
    );
    if (seed.status !== 0) {
      throw new Error(`e2e ledger seed failed (exit ${String(seed.status)})`);
    }

    oidc = await startStubOidc();
    arr = await startStubArr();
    bazarr = await startStubBazarr();
    plex = await startStubPlex();
    maintainerr = await startStubMaintainerr();
    prometheus = await startStubPrometheus();
    const env = composeRuntimeEnv({
      databaseUrl: pg.connectionString,
      stubOidcBaseUrl: oidc.baseUrl,
      stubOidcDiscoveryUrl: oidc.discoveryUrl,
      stubArrBaseUrl: arr.baseUrl,
      stubBazarrBaseUrl: bazarr.baseUrl,
      stubPlexBaseUrl: plex.baseUrl,
      stubMaintainerrBaseUrl: maintainerr.baseUrl,
      stubPrometheusBaseUrl: prometheus.baseUrl,
      appUrl,
    });

    // Spawn .bin/next directly — some pnpm versions filter child env vars.
    dev = spawn(join(cwd, 'node_modules', '.bin', 'next'), ['dev', '--port', String(port)], {
      env: { ...process.env, ...env },
      cwd,
      stdio: 'inherit',
      detached: false,
    });
    dev.on('exit', (code, signal) => {
      if (code !== 0 && code !== null) {
        console.error(
          `[stack] dev server exited unexpectedly (code=${code}, signal=${signal ?? 'none'})`,
        );
      }
    });

    await waitForReady(appUrl, DEV_READY_TIMEOUT_MS);
    if (options.prewarm !== false) await prewarmRoutes(appUrl);

    const running = dev;
    const runningArr = arr;
    const runningBazarr = bazarr;
    const runningPlex = plex;
    const runningMaintainerr = maintainerr;
    const runningPrometheus = prometheus;
    let stopped = false;
    return {
      appUrl,
      pg,
      oidc,
      arr: runningArr,
      bazarr: runningBazarr,
      plex: runningPlex,
      maintainerr: runningMaintainerr,
      prometheus: runningPrometheus,
      devServer: running,
      env,
      stop: async () => {
        if (stopped) return;
        stopped = true;
        await killDevServer(running);
        await runningPrometheus.stop().catch(() => undefined);
        await runningMaintainerr.stop().catch(() => undefined);
        await runningPlex.stop().catch(() => undefined);
        await runningBazarr.stop().catch(() => undefined);
        await runningArr.stop().catch(() => undefined);
        await oidc!.stop();
        await pg.stop();
      },
    };
  } catch (err) {
    // Partial-boot cleanup, best effort in reverse order.
    if (dev) await killDevServer(dev).catch(() => undefined);
    if (prometheus) await prometheus.stop().catch(() => undefined);
    if (maintainerr) await maintainerr.stop().catch(() => undefined);
    if (plex) await plex.stop().catch(() => undefined);
    if (bazarr) await bazarr.stop().catch(() => undefined);
    if (arr) await arr.stop().catch(() => undefined);
    if (oidc) await oidc.stop().catch(() => undefined);
    await pg.stop().catch(() => undefined);
    throw err;
  }
}
