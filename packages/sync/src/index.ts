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
// ADR-055 / DESIGN-028 (PLAN-044) — the `goodreads-sync` mode's read side: the Goodreads RSS + GB
// enrichment orchestration handed to the domain syncGoodreadsIntegration orchestrator.
export * from './goodreads';
// ADR-053 / DESIGN-026 D-07 (PLAN-029) — the ABS per-user listening-progress read, folded into books-sync.
export * from './abs-progress';
// ADR-047 / DESIGN-025 (PLAN-028) — the read-only *arr→Plex GUID matcher the `plex-match` mode hands to the
// domain syncPlexMatches single-writer (the Library access gate + "Watch on Plex" deep-link substrate).
export * from './plex-match';
// ADR-064 / DESIGN-035 (PLAN-037) — the read-only HOps collections fetcher the `collections-sync` mode
// hands to the domain syncPlexCollections single-writer (the Movies/TV Collections group view's mirror).
export * from './plex-collections';
export * from './orchestrator';
