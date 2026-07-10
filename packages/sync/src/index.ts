// @hnet/sync — the *arr → ledger sync runner (DESIGN-005 D-14). One-way by
// construction: this package imports only the @hnet/arr READ surface and mutates the
// ledger exclusively through the @hnet/domain single-writers (D-12; ADR-008).
export * from './logger';
export * from './clients';
export * from './adapt';
export * from './adapt-metadata';
export * from './normalize';
export * from './arr-full';
export * from './arr-incremental';
export * from './metadata-refresh';
export * from './seerr';
// ADR-044 / DESIGN-022 (PLAN-021) — the read-only Open WebUI admin-API client + blob normalizer the
// `ai-usage-sync` mode polls (image-gen heuristic lives here).
export * from './openwebui';
// ADR-046 / DESIGN-024 (PLAN-023) — the read-only Kavita + Audiobookshelf snapshot fetcher + normalizers
// the `books-sync` mode hands to the domain syncBooks single-writer.
export * from './books';
export * from './orchestrator';
