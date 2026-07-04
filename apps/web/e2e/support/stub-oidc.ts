// ADR-010 / DESIGN-002 R-66 — local stub OIDC provider for deterministic e2e login.
// Better Auth's genericOAuth fetches discovery/token from the SERVER side, so
// page.route() cannot intercept the flow; pointing OIDC_DISCOVERY_URL at this server
// (the DESIGN-002 D-08 env override hook) lets sign-in → callback → session run
// end-to-end with no network dependence on Authentik.
//
// Verified against the installed better-auth@1.6.23 generic-oauth plugin:
//   - discovery is re-fetched at BOTH sign-in initiation and callback
//     (authorization_endpoint / token_endpoint / userinfo_endpoint / issuer);
//   - token exchange is client_secret_post (client_id+client_secret in the form
//     body — `authentication` defaults to "post"), PKCE off per @hnet/auth config;
//   - the id_token is decoded (jose decodeJwt) and used as the profile when it
//     carries sub+email — we sign RS256 with a real keypair and serve the JWKS so
//     the token is a genuine verifiable JWT (and userinfo stays available);
//   - `iss` on the callback redirect must equal the discovery issuer when present.
//
// Endpoints:
//   GET  /.well-known/openid-configuration  → discovery document
//   GET  /jwks                              → JWKS for the RS256 signing key
//   GET  /authorize                         → 302 straight back to redirect_uri with
//                                             code+state (+iss); no login UI. The
//                                             minted user is the control-selected
//                                             persona, overridable per-request via
//                                             ?stub_user=<persona>.
//   POST /token                             → code → { access_token, id_token }
//   GET  /userinfo                          → bearer-keyed profile
//   POST /_control/user                     → select the persona minted next
//                                             ({"persona":"admin"} — sticky, NOT
//                                             consume-once, so repeat logins reuse it)
//   POST /_control/reset                    → clear codes/tokens, reset persona
//
// Personas use *.example.test emails — the e2e suite and the interactive
// `pnpm dev:local` harness (apps/web/dev/local.ts imports STUB_USERS) both set
// their own BOOTSTRAP_ADMIN_EMAILS (never the owner's real emails) and stable
// `sub`s so repeat sign-ins land on the same users row (AC-03 "repeat logins are
// no-ops").
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

export interface StubUser {
  /** Stable OIDC subject — keeps repeat logins on the same users row. */
  sub: string;
  email: string;
  /** Maps to users.display_name via @hnet/auth mapProfileToUser. */
  name: string;
  preferred_username: string;
}

export const STUB_CLIENT_ID = 'hnet-e2e-client';
export const STUB_CLIENT_SECRET = 'hnet-e2e-secret';

/** The admin email the e2e env passes as BOOTSTRAP_ADMIN_EMAILS. */
export const ADMIN_EMAIL = 'bootstrap-admin@example.test';

export const STUB_USERS = {
  /** First login must bootstrap to Admin (AC-03). */
  admin: {
    sub: 'stub-admin',
    email: ADMIN_EMAIL,
    name: 'Bootstrap Admin',
    preferred_username: 'bootstrap-admin',
  },
  /** Plain member persona — admin/dashboard grant flows act on this user. */
  member: {
    sub: 'stub-member',
    email: 'member@example.test',
    name: 'Marge Member',
    preferred_username: 'member',
  },
  /** Never granted anything — AC-04's "fresh Member sees exactly the defaults". */
  'fresh-member': {
    sub: 'stub-fresh-member',
    email: 'fresh-member@example.test',
    name: 'Fred Freshman',
    preferred_username: 'fresh-member',
  },
} as const satisfies Record<string, StubUser>;

export type PersonaName = keyof typeof STUB_USERS;

export interface StubOidcServer {
  port: number;
  baseUrl: string;
  discoveryUrl: string;
  stop: () => Promise<void>;
}

export async function startStubOidc(): Promise<StubOidcServer> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', {
    modulusLength: 2048,
    extractable: true,
  });
  const jwk = await exportJWK(publicKey);
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  jwk.kid = `stub-oidc-${randomUUID()}`;

  // authorization code / access token → the user they were minted for.
  const codes = new Map<string, StubUser>();
  const accessTokens = new Map<string, StubUser>();
  // Sticky selection (persists across sign-ins until changed) — the member context
  // in a two-context spec can refresh/re-login without re-seeding.
  let currentUser: StubUser = STUB_USERS.member;

  async function readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  function claimsFor(user: StubUser): Record<string, unknown> {
    return {
      sub: user.sub,
      email: user.email,
      email_verified: true,
      name: user.name,
      preferred_username: user.preferred_username,
    };
  }

  const server: Server = createServer((req, res) => {
    void (async () => {
      const host = req.headers.host ?? '127.0.0.1';
      const url = new URL(req.url ?? '/', `http://${host}`);
      const issuer = `http://${host}`;

      // ── Discovery ────────────────────────────────────────────────────
      if (req.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            userinfo_endpoint: `${issuer}/userinfo`,
            jwks_uri: `${issuer}/jwks`,
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code'],
            subject_types_supported: ['public'],
            id_token_signing_alg_values_supported: ['RS256'],
            scopes_supported: ['openid', 'profile', 'email'],
            token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
          }),
        );
        return;
      }

      // ── JWKS ─────────────────────────────────────────────────────────
      if (req.method === 'GET' && url.pathname === '/jwks') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ keys: [jwk] }));
        return;
      }

      // ── Authorize: no login UI — 302 straight back with a code ───────
      if (req.method === 'GET' && url.pathname === '/authorize') {
        const redirectUri = url.searchParams.get('redirect_uri');
        const state = url.searchParams.get('state');
        if (!redirectUri || !state) {
          res.writeHead(400, { 'content-type': 'text/plain' });
          res.end('missing redirect_uri or state');
          return;
        }
        // Per-request persona override (?stub_user=admin); falls back to the
        // control-selected persona. Better Auth builds the authorize URL from
        // discovery so tests normally drive this via POST /_control/user.
        const override = url.searchParams.get('stub_user');
        let user = currentUser;
        if (override !== null) {
          const named = (STUB_USERS as Record<string, StubUser>)[override];
          if (!named) {
            res.writeHead(400, { 'content-type': 'text/plain' });
            res.end(`unknown stub_user ${override}`);
            return;
          }
          user = named;
        }
        const code = `code-${randomUUID()}`;
        codes.set(code, user);
        const location = new URL(redirectUri);
        location.searchParams.set('code', code);
        location.searchParams.set('state', state);
        // better-auth@1.6.23 validates `iss` against the discovery issuer when present.
        location.searchParams.set('iss', issuer);
        res.writeHead(302, { location: location.toString() });
        res.end();
        return;
      }

      // ── Token exchange (client_secret_post) ──────────────────────────
      if (req.method === 'POST' && url.pathname === '/token') {
        const params = new URLSearchParams(await readBody(req));
        const code = params.get('code');
        const grantType = params.get('grant_type');
        const clientOk =
          params.get('client_id') === STUB_CLIENT_ID &&
          params.get('client_secret') === STUB_CLIENT_SECRET;
        if (grantType !== 'authorization_code' || !clientOk) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_client' }));
          return;
        }
        const user = code === null ? undefined : codes.get(code);
        if (code === null || user === undefined) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }
        codes.delete(code); // single-use
        const accessToken = `at-${randomUUID()}`;
        accessTokens.set(accessToken, user);
        const idToken = await new SignJWT(claimsFor(user))
          .setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
          .setIssuer(issuer)
          .setAudience(STUB_CLIENT_ID)
          .setIssuedAt()
          .setExpirationTime('1h')
          .sign(privateKey);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            access_token: accessToken,
            id_token: idToken,
            token_type: 'Bearer',
            expires_in: 3600,
            scope: 'openid profile email',
          }),
        );
        return;
      }

      // ── UserInfo (bearer-keyed) ──────────────────────────────────────
      if (req.method === 'GET' && url.pathname === '/userinfo') {
        const auth = req.headers.authorization;
        const token = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : undefined;
        const user = token === undefined ? undefined : accessTokens.get(token);
        if (!user) {
          res.writeHead(401);
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(claimsFor(user)));
        return;
      }

      // ── Test control plane ───────────────────────────────────────────
      if (req.method === 'POST' && url.pathname === '/_control/user') {
        let parsed: { persona?: string };
        try {
          parsed = JSON.parse(await readBody(req)) as { persona?: string };
        } catch {
          res.writeHead(400, { 'content-type': 'text/plain' });
          res.end('invalid JSON');
          return;
        }
        const named =
          parsed.persona === undefined
            ? undefined
            : (STUB_USERS as Record<string, StubUser>)[parsed.persona];
        if (!named) {
          res.writeHead(400, { 'content-type': 'text/plain' });
          res.end(`unknown persona ${String(parsed.persona)}`);
          return;
        }
        currentUser = named;
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method === 'POST' && url.pathname === '/_control/reset') {
        codes.clear();
        accessTokens.clear();
        currentUser = STUB_USERS.member;
        res.writeHead(204);
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    })().catch((err: unknown) => {
      const message = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);

      console.error('[stub-oidc] unhandled error', message);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(message);
    });
  });

  // OS-assigned port; unref so a misfired teardown never wedges the process.
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  server.unref();
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('stub OIDC failed to bind a port');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    port: addr.port,
    baseUrl,
    discoveryUrl: `${baseUrl}/.well-known/openid-configuration`,
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
