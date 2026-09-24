// e2e seed (ADR-091 / DESIGN-050 D-08, PLAN-069 S5) — give an EXISTING user N live connector connections, THROUGH
// the @hnet/domain oauth single-writers (register → authorize → consent → code exchange; never a direct table
// write — the no-direct-state-writes guard scans this file too). Run as a tsx SUBPROCESS (the seed-ledger.ts
// reason). The Connected apps resize matrix uses it for its 1- and 5-row states.
//
//   DATABASE_URL=… BETTER_AUTH_URL=… tsx e2e/support/seed-connections.ts <email> <count>
import { createHash, randomBytes } from 'node:crypto';
import { getPool } from '@hnet/db';
import {
  exchangeCode,
  getOAuthClient,
  grantConsent,
  registerClient,
  startAuthorization,
} from '@hnet/domain';
import { validateAuthorizationParams } from '@hnet/oauth';

const NAMES = [
  'ChatGPT',
  'Claude Code (haynesnetwork)',
  'Codex',
  'A connector with a much longer registered name',
  'Claude',
];

async function main(): Promise<void> {
  const [email, countArg] = process.argv.slice(2);
  const count = Number(countArg ?? '1');
  if (!email || !Number.isInteger(count) || count < 1)
    throw new Error('usage: seed-connections <email> <count>');
  const { rows } = await getPool().query<{ id: string }>(
    'SELECT id FROM users WHERE lower(email) = lower($1)',
    [email],
  );
  const userId = rows[0]?.id;
  if (!userId) throw new Error(`seed-connections: no user ${email} (sign the persona in first)`);
  for (let i = 0; i < count; i++) {
    const name = NAMES[i % NAMES.length]!;
    const redirect =
      i % 2 === 0
        ? `https://connector-${i}.e2e.test/callback`
        : `http://127.0.0.1:${4000 + i}/callback`;
    const reg = await registerClient({ body: { client_name: name, redirect_uris: [redirect] } });
    const client = (await getOAuthClient({ clientId: reg.client_id }))!;
    const verifier = randomBytes(32).toString('base64url');
    const validated = validateAuthorizationParams({
      responseType: 'code',
      state: `seed-${i}`,
      codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
      codeChallengeMethod: 'S256',
      ...(i % 3 === 2 ? { scope: 'watch:read offline_access' } : {}),
    });
    const { txnId } = await startAuthorization({
      client,
      userId,
      redirectUri: redirect,
      validated,
    });
    const granted = await grantConsent({ txnId, userId });
    if (granted.status !== 'redirect')
      throw new Error(`seed-connections: consent ${granted.status}`);
    const code = new URL(granted.redirectUrl).searchParams.get('code')!;
    await exchangeCode({ client, request: { code, codeVerifier: verifier } });
  }
  console.log(`[seed-connections] ${count} connection(s) for ${email}`);
}

main()
  .then(async () => {
    await getPool().end();
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error('[seed-connections] failed:', error);
    process.exit(1);
  });
