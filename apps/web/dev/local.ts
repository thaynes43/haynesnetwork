// Interactive local test environment (owner request, 2026-07-03): boots the
// EXACT stack the e2e suite uses — embedded Postgres 16 with the real
// migrations + catalog seed, the stub OIDC provider with its personas, and
// `next dev` — but long-running, so the app can be vetted hands-on in a real
// browser (phone/tablet/PC via devtools device emulation) with no Docker, no
// Authentik, no cluster, and no real credentials.
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
import { startStack } from '../e2e/support/harness';
import { STUB_USERS, type PersonaName } from '../e2e/support/stub-oidc';

const PORT = Number(process.env.PORT ?? 3000);

async function main(): Promise<void> {
  console.log('[dev:local] booting the stack (embedded PG16 → migrations → stub OIDC → next dev)…');
  const stack = await startStack({ port: PORT, prewarm: false });

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
