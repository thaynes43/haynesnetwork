// ADR-018 / DESIGN-008 D-06 + ADR-023 / DESIGN-010 D-02 — Maintainerr READ client. The metadata
// harvest uses getCollections() for computed rule-collection provenance; the Trash section (PLAN-006)
// reuses this same client for the pending tables, rules listing, exclusions, and the preflight
// safety audit (settings/test/plex + app/status + rules/constants). READ-ONLY — the confined WRITE
// surface (add/remove exclusion, rule CRUD, collection handle/expedite, settings patch) lives in
// @hnet/arr/write (MaintainerrWriteClient), import-guarded to packages/domain. Reads are keyless;
// a configured key rides x-api-key.
import { z } from 'zod';
import { ArrHttp } from './http';
import type { MaintainerrConfig } from './config';
import {
  maintainerrAppStatusSchema,
  maintainerrBasicResponseSchema,
  maintainerrCollectionContentSchema,
  maintainerrCollectionSchema,
  maintainerrExclusionSchema,
  maintainerrRuleConstantsSchema,
  maintainerrRuleGroupSchema,
  maintainerrSettingsSchema,
  type MaintainerrAppStatus,
  type MaintainerrBasicResponse,
  type MaintainerrCollection,
  type MaintainerrCollectionContent,
  type MaintainerrExclusion,
  type MaintainerrRuleConstants,
  type MaintainerrRuleGroup,
  type MaintainerrSettings,
} from './schemas/maintainerr';

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

  /** `GET /api/collections` — the rule collections + their preview media (deleteAfterDays, ids). */
  getCollections(): Promise<MaintainerrCollection[]> {
    return this.http.requestJson('GET', 'collections', z.array(maintainerrCollectionSchema));
  }

  /**
   * `GET /api/collections/media/:id/content/:page` — paged FULL membership of a collection with
   * per-item `sizeBytes` + live tmdb/tvdb ids (the pending-table source; the preview media on
   * getCollections is a subset). `page` is 1-based; `size` defaults to 50.
   */
  getCollectionContent(
    collectionId: number,
    page = 1,
    size = 50,
  ): Promise<MaintainerrCollectionContent> {
    return this.http.requestJson(
      'GET',
      `collections/media/${collectionId}/content/${page}`,
      maintainerrCollectionContentSchema,
      { query: { size } },
    );
  }

  /** `GET /api/rules` — the rule groups (the rules editor's data). */
  getRules(): Promise<MaintainerrRuleGroup[]> {
    return this.http.requestJson('GET', 'rules', z.array(maintainerrRuleGroupSchema));
  }

  /** `GET /api/rules/constants` — the rule-schema catalog; `applications` names the CONFIGURED
   *  integrations (the audit's integration-presence signal). */
  getRuleConstants(): Promise<MaintainerrRuleConstants> {
    return this.http.requestJson('GET', 'rules/constants', maintainerrRuleConstantsSchema);
  }

  /**
   * `GET /api/rules/exclusion` — exclusions/whitelist. With no params Maintainerr returns [] (it
   * needs a rulegroupId or mediaServerId), so pass `mediaServerId` to check one item, or
   * `rulegroupId` for a group's (+global) set.
   */
  getExclusions(params: { mediaServerId?: string; rulegroupId?: number } = {}): Promise<
    MaintainerrExclusion[]
  > {
    return this.http.requestJson('GET', 'rules/exclusion', z.array(maintainerrExclusionSchema), {
      query: {
        ...(params.mediaServerId !== undefined ? { mediaServerId: params.mediaServerId } : {}),
        ...(params.rulegroupId !== undefined ? { rulegroupId: params.rulegroupId } : {}),
      },
    });
  }

  /** `GET /api/settings` — the (secret-masked) settings; we read the tag-exclusion subset. */
  getSettings(): Promise<MaintainerrSettings> {
    return this.http.requestJson('GET', 'settings', maintainerrSettingsSchema);
  }

  /**
   * `GET /api/app/status` — version + reachability. Maintainerr serialises VersionResponse as a
   * JSON STRING, so the body may be a double-encoded string; pre-parse before validating.
   */
  async getAppStatus(): Promise<MaintainerrAppStatus> {
    const res = await this.http.request('GET', 'app/status');
    const raw = await res.text();
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw;
    }
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value);
      } catch {
        value = { version: value };
      }
    }
    return maintainerrAppStatusSchema.parse(value);
  }

  /** `GET /api/settings/test/plex` — Plex connectivity (BasicResponseDto; status 'OK' ⇒ connected). */
  testPlex(): Promise<MaintainerrBasicResponse> {
    return this.http.requestJson('GET', 'settings/test/plex', maintainerrBasicResponseSchema);
  }
}
