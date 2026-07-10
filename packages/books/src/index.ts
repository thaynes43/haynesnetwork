// @hnet/books — read-only Kavita + Audiobookshelf clients (ADR-046 / DESIGN-024, PLAN-023).
// The "safe everywhere" barrel: errors + config + schemas. The read clients live behind ./read
// (import { KavitaClient, AudiobookshelfClient } from '@hnet/books/read'); there is no ./write.
export * from './errors';
export * from './config';
export * from './schemas';
