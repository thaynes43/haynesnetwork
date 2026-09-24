// ADR-091 / DESIGN-050 D-01 / D-03 — @hnet/oauth is pure (zod only at runtime), so it keeps its own copies of the
// closed vocabularies the @hnet/db CHECK constraints are built from. They must never drift: a scope the metadata
// advertised but the schema refused (or the reverse) would break every token issue.
import { describe, expect, it } from 'vitest';
import * as db from '@hnet/db';
import * as oauth from '../src/index';

describe('D-03 — @hnet/oauth vocabularies = @hnet/db enums.ts', () => {
  it('scopes, auth methods, grant types, response types, PKCE methods', () => {
    expect([...oauth.OAUTH_SCOPES]).toEqual([...db.OAUTH_SCOPES]);
    expect([...oauth.SUPPORTED_SCOPES]).toEqual([...db.OAUTH_SCOPES]);
    expect([...oauth.OAUTH_TOKEN_ENDPOINT_AUTH_METHODS]).toEqual([
      ...db.OAUTH_TOKEN_ENDPOINT_AUTH_METHODS,
    ]);
    expect([...oauth.OAUTH_GRANT_TYPES]).toEqual([...db.OAUTH_GRANT_TYPES]);
    expect([...oauth.OAUTH_RESPONSE_TYPES]).toEqual([...db.OAUTH_RESPONSE_TYPES]);
    expect([...oauth.OAUTH_CODE_CHALLENGE_METHODS]).toEqual([...db.OAUTH_CODE_CHALLENGE_METHODS]);
  });

  it('the D-04 caps match the schema CHECKs', () => {
    expect(oauth.CLIENT_NAME_MAX).toBe(80);
    expect(oauth.REDIRECT_URIS_MAX).toBe(5);
  });

  it('the watch scopes are the two MCP scopes @hnet/mcp knows', () => {
    expect([...oauth.WATCH_SCOPES]).toEqual(['watch:read', 'watch:write']);
  });
});
