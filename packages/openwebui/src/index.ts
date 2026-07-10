// ADR-045 / DESIGN-023 — @hnet/openwebui barrel: errors, config, schemas, and the READ client. The WRITE
// surface is reached only via `@hnet/openwebui/write` and is import-confined to packages/domain.
export * from './errors';
export * from './config';
export * from './schemas';
export * from './read';
