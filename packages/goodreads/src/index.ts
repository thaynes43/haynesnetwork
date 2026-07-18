// @hnet/goodreads — the read-only Goodreads shelf-RSS + Google Books enrichment clients (ADR-055 /
// DESIGN-028, PLAN-044). Pull-only by construction: Goodreads has no write API (we ingest, never push).
export * from './errors';
export * from './config';
export * from './rss';
export * from './google-books';
export { redactKey, nextBackoffMs, type GetOptions } from './http';
