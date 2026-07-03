// @hnet/sync — the *arr → ledger sync runner (DESIGN-005 D-14). One-way by
// construction: this package imports only the @hnet/arr READ surface and mutates the
// ledger exclusively through the @hnet/domain single-writers (D-12; ADR-008).
export * from './logger';
export * from './clients';
export * from './adapt';
export * from './normalize';
export * from './arr-full';
export * from './arr-incremental';
export * from './seerr';
export * from './orchestrator';
