// @hnet/lazylibrarian — the confined LazyLibrarian client (ADR-055 / DESIGN-028, PLAN-044).
// This barrel is the "safe everywhere" surface: typed errors, env config, ACL schemas. It does NOT export
// the clients — read via `@hnet/lazylibrarian/read`, write (import-confined to packages/domain) via
// `@hnet/lazylibrarian/write`. Mirrors the @hnet/plex barrel discipline.
export * from './errors';
export * from './config';
export * from './schemas';
