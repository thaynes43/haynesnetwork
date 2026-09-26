// Interactive local test environment (owner request, 2026-07-03): boots the
// EXACT stack the e2e suite uses — embedded Postgres 16 with the real
// migrations + catalog seed, the stub OIDC provider with its personas, the stub
// Sonarr/Radarr/Lidarr/Seerr server (startStack() calls startStubArr()), and
// `next dev` — but long-running, so the app can be vetted hands-on in a real
// browser (phone/tablet/PC via devtools device emulation) with no Docker, no
// Authentik, no *arr stack, no cluster, and no real credentials. On top of the
// e2e stack it runs the Watch Companion bootstrap (a one-row demo seed + one
// `watch` sync, PLAN-068 S8) so `POST /api/mcp` answers locally — and, with the
// public connector path (ADR-091, PLAN-069), a local OAuth client can register,
// sign in through the stub OIDC, consent, and call `POST /mcp` with its token.
//
//   pnpm dev:local            # from the repo root (PORT=3000 by default)
//
// Sign in with the normal button; which persona the stub mints is selected by
// typing its name at this terminal (sticky until changed):
//   admin        → bootstrap-admin@example.test (promoted to Admin on login)
//   member       → member@example.test          (plain Member; stub default)
//   fresh-member → fresh-member@example.test    (first-login experience)
//
// Everything is throwaway: the database lives in a temp dir and is deleted on
// Ctrl-C. Restarting gives a pristine seeded catalog.
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { runInStack, startStack } from '../e2e/support/harness';
import { erroredArrQueueFixture } from '../e2e/support/stub-arr';
import { STUB_USERS, type PersonaName } from '../e2e/support/stub-oidc';

const PORT = Number(process.env.PORT ?? 3000);

async function main(): Promise<void> {
  console.log(
    '[dev:local] booting the stack (embedded PG16 → migrations → stub OIDC → stub *arr → next dev)…',
  );
  const stack = await startStack({ port: PORT, prewarm: false });

  // ADR-083 / DESIGN-046 (PLAN-065) — pre-stage a canned errored *arr queue so `--mode=queue-cleanup` runs
  // end-to-end locally in census (writes arr_queue_cleanup_actions rows; enforce stays off under the
  // all-census default). Best-effort — a staging failure never blocks the local stack.
  await fetch(`${stack.arr.baseUrl}/_stub/queue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ records: erroredArrQueueFixture() }),
  }).catch(() => {});

  // ADR-088 / DESIGN-049 D-09 (PLAN-068 S8) — the Watch Companion: give the stub owner's watchlist show a
  // ledger row (the dev-only demo seed), then run the real `watch` sync ONCE against stub Plex + stub
  // Tautulli, so `POST /api/mcp` answers from a real read-model. Best-effort: a failure never blocks the
  // stack (re-run it with the command the banner prints).
  try {
    await runInStack(stack, [join('e2e', 'support', 'seed-watch-demo.ts')], 'watch demo seed');
    await runInStack(
      stack,
      [join('..', '..', 'packages', 'sync', 'src', 'scripts', 'sync.ts'), '--mode=watch'],
      'watch sync',
    );
  } catch (error) {
    console.error('[dev:local] watch bootstrap failed (the rest of the stack is up):', error);
  }

  let shuttingDown = false;
  const shutdown = async (code: number): Promise<never> => {
    if (shuttingDown) process.exit(code);
    shuttingDown = true;
    console.log('\n[dev:local] shutting down…');
    await stack.stop();
    process.exit(code);
  };
  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));
  stack.devServer.on('exit', () => void shutdown(1));

  const personas = Object.keys(STUB_USERS).join(' | ');
  console.log(`
──────────────────────────────────────────────────────────────
  haynesnetwork local test environment
  App:       ${stack.appUrl}
  Stub OIDC: ${stack.oidc.baseUrl}   (stands in for Authentik)
  Database:  embedded Postgres 16 (throwaway, seeded catalog)

  Personas:  ${personas}
  Active:    member (stub default) — type a persona name + Enter
             to switch, then use the normal "Sign in" button.
  Tip:       phone/tablet sizes → browser devtools device toolbar.

  Watch MCP: POST ${stack.appUrl}/api/mcp  (Authorization: Bearer ${stack.env.HNET_MCP_HOP_TOKEN})
             headers: Content-Type: application/json + Accept: application/json, text/event-stream
             body e.g. {"jsonrpc":"2.0","id":1,"method":"tools/call",
                        "params":{"name":"unfinished","arguments":{}}}
             re-sync: DATABASE_URL=${stack.env.DATABASE_URL} … tsx packages/sync/src/scripts/sync.ts --mode=watch
             (docs/ops/003-local-verification.md — "Watch Companion MCP")

  Watchlists (ADR-093): the stack ran --mode=watchlist-registry once at boot; Expedite and Expire now
             need a run at most 30 minutes old. Re-run: DATABASE_URL=${stack.env.DATABASE_URL} … tsx
             packages/sync/src/scripts/sync.ts --mode=watchlist-registry

  Connectors (ADR-091, the public OAuth path — POST ${stack.appUrl}/mcp takes only OAuth tokens):
             metadata: ${stack.appUrl}/.well-known/oauth-authorization-server
             register: POST ${stack.appUrl}/oauth/register, then send the browser to /oauth/authorize
             (PKCE S256 + state); sign in and Approve on the consent page; exchange at /oauth/token.
             Type plex-linked-owner-id here first to sign in as the Plex owner (its plex_user_id claim
             maps to the tracked owner account, so the tools answer from the seeded history);
             any other persona connects too and gets "isn't set up for your account yet".
             Connected apps: ${stack.appUrl}/settings/connections
──────────────────────────────────────────────────────────────`);

  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const name = line.trim() as PersonaName;
    if (!(name in STUB_USERS)) {
      if (line.trim()) console.log(`[dev:local] unknown persona '${line.trim()}' (${personas})`);
      return;
    }
    void fetch(`${stack.oidc.baseUrl}/_control/user`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ persona: name }),
    }).then(
      (res) =>
        console.log(
          res.status === 204
            ? `[dev:local] next sign-in mints: ${name} <${STUB_USERS[name].email}>`
            : `[dev:local] persona switch failed: HTTP ${res.status}`,
        ),
      (err: unknown) => console.log('[dev:local] persona switch failed:', err),
    );
  });
}

main().catch((err: unknown) => {
  console.error('[dev:local] fatal:', err);
  process.exit(1);
});
