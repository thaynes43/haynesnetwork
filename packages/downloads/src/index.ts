// @hnet/downloads — the downloads-stack clients the MAM compliance governor drives (ADR-054 / DESIGN-027,
// PLAN-039). qBittorrent (count unsatisfied `books-mam` torrents) + LazyLibrarian (read + toggle the MAM
// Torznab provider's enabled flag — the gate seam). The governor never calls MyAnonaMouse itself.
//
// Entrypoints (the @hnet/arr read/write split — ADR-008 enforceability):
//   @hnet/downloads        — config, typed errors, shared count helpers/consts (safe everywhere)
//   @hnet/downloads/read   — QbittorrentClient + LazyLibrarianReadClient (read-only; safe everywhere)
//   @hnet/downloads/write  — LazyLibrarianWriteClient (the gate toggle; ONLY packages/domain)
export * from './errors';
export * from './config';
// Re-export the pure count helper + the 72h constant + the UnsatisfiedCounts type from the read entry
// (safe everywhere — no client construction). The client CLASSES live only under ./read and ./write.
export { MAM_SEED_OBLIGATION_SECONDS, computeUnsatisfied, type UnsatisfiedCounts } from './read';
