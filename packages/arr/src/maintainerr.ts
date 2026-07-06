// ADR-018 / DESIGN-008 D-06 — Maintainerr best-effort read client. Supplies computed
// rule-collection provenance into media_metadata.extra.maintainerr (which auto-collection a
// title sits in — the "where unwanted media comes from" signal PLAN-006 builds on). READ-ONLY;
// fully degradable — if the instance is unreachable the harvest logs the skip and continues.
import { z } from 'zod';
import { ArrHttp } from './http';
import type { MaintainerrConfig } from './config';
import { maintainerrCollectionSchema, type MaintainerrCollection } from './schemas/maintainerr';

export interface MaintainerrClientOptions extends MaintainerrConfig {
  timeoutMs?: number;
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
}

export class MaintainerrClient {
  private readonly http: ArrHttp;

  constructor(options: MaintainerrClientOptions) {
    this.http = new ArrHttp({
      baseUrl: options.baseUrl,
      apiBasePath: '/api',
      // Maintainerr's read API answers without a key; when one is configured it rides x-api-key.
      apiKey: options.apiKey ?? 'unused',
      apiKeyHeader: 'x-api-key',
      timeoutMs: options.timeoutMs,
      retryDelayMs: options.retryDelayMs,
      fetchImpl: options.fetchImpl,
    });
  }

  /** `GET /api/collections` — the rule collections + their member media (tmdb ids). */
  getCollections(): Promise<MaintainerrCollection[]> {
    return this.http.requestJson('GET', 'collections', z.array(maintainerrCollectionSchema));
  }
}
