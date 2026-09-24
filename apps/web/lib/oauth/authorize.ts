// ADR-091 / DESIGN-050 D-05 steps 1–5 (FLOW-001) — the authorization request, as one testable function the
// `/oauth/authorize` page runs before it renders anything:
//   0. D-10 rate limit (30 / minute / client IP) — refused ⇒ the bad-request page;
//   1. the client and its redirect (a repeated client_id / redirect_uri, an unknown client or an unregistered
//      redirect ⇒ the bad-request page, NEVER a redirect: the callback is untrusted);
//   2. the session gate ⇒ no session: `${issuer}/login?next=<this path and query>` — BEFORE the parameters, so a
//      signed-out request never redirects anywhere but our own login (driver ruling 2026-09-23, D-15 #24): with open
//      registration anyone can register a callback, and redirecting parameter errors there without a session made
//      /oauth/authorize an open redirector (RFC 9700 §4.11.2);
//   3. the parameters (response_type, a REQUIRED state, S256 PKCE, scopes, resource) ⇒ for the signed-in user,
//      errors go back to the registered callback with `error`, `error_description` and `state` (RFC 6749 §4.1.2.1);
//   4. no owner gate (ADR-091 C-04: any signed-in user may connect);
//   5. the pending transaction ⇒ `${issuer}/oauth/consent?txn=<uuid>`.
// Every URL it sends a browser to is built from the issuer (BETTER_AUTH_URL), never from the request.
import { getServerSession } from '@hnet/auth';
import { resolveAuthorizationClient, startAuthorization } from '@hnet/domain';
import {
  OAuthError,
  authEvent,
  clientRedirect,
  isClientId,
  issuerOrigin,
  validateAuthorizationParams,
  type OAuthEnv,
} from '@hnet/oauth';
import { NEXT_MAX_LENGTH, loginPath } from '@/lib/safe-next';
import { clientIp, limitRequest } from './http';

export type AuthorizeOutcome =
  | { kind: 'redirect'; location: string }
  /** D-14 "Something is off with this connection request" — rendered in place, never a redirect. */
  | { kind: 'bad_request' };

/** D-10: 30 authorization requests per minute per client IP. */
export const AUTHORIZE_LIMIT = { windowSeconds: 60, max: 30 } as const;

/** Parameters that may appear at most once (RFC 6749 §3.1). */
const SINGLE = [
  'client_id',
  'redirect_uri',
  'response_type',
  'state',
  'code_challenge',
  'code_challenge_method',
  'scope',
];

/**
 * The authorize path + query, re-serialized percent-encoded (URLSearchParams leaves `*` bare; Better Auth's
 * relative-callback grammar has no `*`, so it is encoded too) — what `/login?next=` carries back here.
 */
export function authorizeNext(query: URLSearchParams): string {
  return `/oauth/authorize?${query.toString().replace(/\*/g, '%2A')}`;
}

export async function handleAuthorize(input: {
  query: URLSearchParams;
  headers: Headers;
  env?: OAuthEnv;
}): Promise<AuthorizeOutcome> {
  const { query, headers } = input;
  const env = input.env ?? process.env;
  const issuer = issuerOrigin(env);
  const one = (name: string) => query.get(name) ?? undefined;
  const clientId = one('client_id');
  const reject = (reason: string): AuthorizeOutcome => {
    // The raw query value is untrusted and unbounded: log it only when it has the shape of a client id.
    const loggedId = clientId === undefined ? null : isClientId(clientId) ? clientId : 'malformed';
    authEvent('authorize_rejected', { reason, client_id: loggedId });
    return { kind: 'bad_request' };
  };

  const limit = await limitRequest(
    'authorize',
    clientIp(headers),
    AUTHORIZE_LIMIT.windowSeconds,
    AUTHORIZE_LIMIT.max,
  );
  if (!limit.allowed) return { kind: 'bad_request' };

  // 1. The client and its redirect: failures render the page and never redirect.
  if (query.getAll('client_id').length > 1 || query.getAll('redirect_uri').length > 1)
    return reject('duplicate_parameter');
  const redirectUri = one('redirect_uri');
  let client: Awaited<ReturnType<typeof resolveAuthorizationClient>>;
  try {
    client = await resolveAuthorizationClient({ clientId, redirectUri });
  } catch (error) {
    if (error instanceof OAuthError) return reject(error.code);
    throw error;
  }
  // Matched a registered URI (a loopback one on any port): the browser goes back to the one it presented.
  const trustedRedirect = redirectUri!;
  const state = query.getAll('state').length === 1 ? one('state') : undefined;
  const backWithError = (error: OAuthError): AuthorizeOutcome => {
    authEvent('authorize_rejected', { reason: error.code, client_id: clientId });
    return {
      kind: 'redirect',
      location: clientRedirect(trustedRedirect, {
        error: error.code,
        error_description: error.description,
        ...(state ? { state } : {}),
      }),
    };
  };

  // 2. The session gate — before any parameter is judged: signed out, the only redirect is to our own login, and
  // the parameters are judged when the user comes back to this exact request.
  const session = await getServerSession(headers);
  if (!session) {
    const next = authorizeNext(query);
    // A request too long to survive the sign-in round trip (D-09 caps `next`): with no session nothing may redirect
    // to the client, so it gets the bad-request page.
    if (next.length > NEXT_MAX_LENGTH) return reject('request_too_long');
    return { kind: 'redirect', location: `${issuer}${loginPath(next)}` };
  }

  // 3. The redirectable parameters — a signed-in user's errors go back to the registered callback.
  const repeated = SINGLE.find((name) => query.getAll(name).length > 1);
  if (repeated)
    return backWithError(new OAuthError('invalid_request', `${repeated} was sent more than once`));
  let validated;
  try {
    validated = validateAuthorizationParams(
      {
        responseType: one('response_type'),
        scope: one('scope'),
        codeChallenge: one('code_challenge'),
        codeChallengeMethod: one('code_challenge_method'),
        resources: query.getAll('resource'),
        state,
      },
      { env, clientId },
    );
  } catch (error) {
    if (error instanceof OAuthError) return backWithError(error);
    throw error;
  }

  // 4. No owner gate. 5. The pending transaction, then consent.
  const { txnId } = await startAuthorization({
    client,
    userId: session.user.id,
    redirectUri: trustedRedirect,
    validated,
  });
  return { kind: 'redirect', location: `${issuer}/oauth/consent?txn=${encodeURIComponent(txnId)}` };
}
