// ADR-045 / DESIGN-023 — the @hnet/authentik barrel: errors, config, schemas, and the READ client. The
// WRITE surface is deliberately NOT re-exported here — it is reached only via the `@hnet/authentik/write`
// subpath and is import-confined to packages/domain (arr-write-import-guard test).
export * from './errors';
export * from './config';
export * from './schemas';
export * from './read';
