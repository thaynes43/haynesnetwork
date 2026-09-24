// ADR-091 / DESIGN-050 D-02 — the discovery documents every client reads before the flow (ported from
// cigar-journal `packages/oauth/src/metadata.ts`): RFC 8414 authorization-server metadata and RFC 9728
// protected-resource metadata. Every URL derives from the issuer (BETTER_AUTH_URL), never the request. The
// paths are fixed forever once published (ADR-091 C-12: clients cache this document).
import {
  OAUTH_CODE_CHALLENGE_METHODS,
  OAUTH_GRANT_TYPES,
  OAUTH_RESPONSE_TYPES,
  OAUTH_TOKEN_ENDPOINT_AUTH_METHODS,
  SUPPORTED_SCOPES,
  issuerOrigin,
  mcpResource,
  type OAuthEnv,
} from './config';

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  revocation_endpoint: string;
  scopes_supported: string[];
  response_types_supported: string[];
  response_modes_supported: string[];
  grant_types_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  revocation_endpoint_auth_methods_supported: string[];
  code_challenge_methods_supported: string[];
}

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: string[];
  resource_name: string;
}

/** D-02: the auth methods, confidential first then `none` (the order the design lists). */
const AUTH_METHODS = [...OAUTH_TOKEN_ENDPOINT_AUTH_METHODS.filter((m) => m !== 'none'), 'none'];

export function authorizationServerMetadata(
  env: OAuthEnv = process.env,
): AuthorizationServerMetadata {
  const origin = issuerOrigin(env);
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    scopes_supported: [...SUPPORTED_SCOPES],
    response_types_supported: [...OAUTH_RESPONSE_TYPES],
    response_modes_supported: ['query'],
    grant_types_supported: [...OAUTH_GRANT_TYPES],
    token_endpoint_auth_methods_supported: [...AUTH_METHODS],
    revocation_endpoint_auth_methods_supported: [...AUTH_METHODS],
    // PKCE S256 only — `plain` is refused (OAuth 2.1).
    code_challenge_methods_supported: [...OAUTH_CODE_CHALLENGE_METHODS],
  };
}

export function protectedResourceMetadata(env: OAuthEnv = process.env): ProtectedResourceMetadata {
  return {
    resource: mcpResource(env),
    authorization_servers: [issuerOrigin(env)],
    scopes_supported: [...SUPPORTED_SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'haynesnetwork Watch history',
  };
}
