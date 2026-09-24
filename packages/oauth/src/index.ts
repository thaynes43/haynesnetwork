// @hnet/oauth — the PURE half of the in-app OAuth 2.1 authorization server for the public MCP connectors
// (ADR-091, DESIGN-050 D-01), ported from cigar-journal `packages/oauth`: configuration and the D-14 scope copy,
// the RFC 8414 / RFC 9728 metadata documents, request validation (DCR, authorize, token, revoke), the loopback
// redirect rule, PKCE, token generation and hashing, the decisions (what to issue, rotate, revoke, refuse, prune)
// and the `[auth]` event log. No database access: `@hnet/oauth` decides and the `@hnet/domain` oauth
// single-writers write (hard rule 6). `service-tokens.ts` and the CLI are deliberately not ported (ADR-091
// option 5).
export * from './config';
export * from './crypto';
export * from './errors';
export * from './logger';
export * from './metadata';
export * from './validate';
export * from './decide';
