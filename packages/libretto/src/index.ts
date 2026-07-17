// @hnet/libretto — the confined Libretto client (ADR-070 / DESIGN-043, PLAN-052). This barrel is the
// "safe everywhere" surface: typed errors, env config, ACL schemas. It does NOT export the clients — read
// via `@hnet/libretto/read`, write (import-confined to packages/domain) via `@hnet/libretto/write`.
// Mirrors the @hnet/lazylibrarian / @hnet/plex barrel discipline.
export * from './errors';
export * from './config';
export * from './schemas';
