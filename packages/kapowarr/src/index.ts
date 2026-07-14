// @hnet/kapowarr — the confined Kapowarr client (ADR-056, PLAN-046 — comics acquisition).
// This barrel is the "safe everywhere" surface: typed errors, env config, ACL schemas. It does NOT export
// the clients — read via `@hnet/kapowarr/read`, write (import-confined to packages/domain) via
// `@hnet/kapowarr/write`. Mirrors the @hnet/lazylibrarian barrel discipline.
export * from './errors';
export * from './config';
export * from './schemas';
