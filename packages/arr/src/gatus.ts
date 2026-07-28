// ADR-079 / DESIGN-004 D-25 (PLAN-064 — haynes-ops saga haynesnetwork-ha plan 04) — Gatus
// READ client for the front-page uptime badge. KEYLESS by design (Gatus's read API carries
// no auth in-cluster; the MaintainerrClient keyless-read pattern) and READ-ONLY — there is
// no Gatus write surface, so no /write confinement applies. The badge reads exactly two
// things about ONE endpoint key (`external_haynesnetwork` by default): the current status
// and the windowed uptime ratios. The status plane itself stays LAN-only (saga Decision 4);
// this client is the only bridge, server-side over the cluster Service DNS.
import { ArrHttp } from './http';
import { ArrParseError } from './errors';
import type { GatusConfig } from './config';
import {
  gatusEndpointStatusSchema,
  gatusUptimeTextSchema,
} from './schemas/gatus';

/** The uptime windows Gatus serves (`/uptimes/{window}`). The badge reads 24h/7d/30d. */
export type GatusUptimeWindow = '1h' | '24h' | '7d' | '30d';

export interface GatusClientOptions extends GatusConfig {
  timeoutMs?: number;
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
}

export class GatusClient {
  private readonly http: ArrHttp;
  private readonly endpointKey: string;

  constructor(options: GatusClientOptions) {
    this.http = new ArrHttp({
      baseUrl: options.baseUrl,
      apiBasePath: '/api/v1',
      // Gatus reads are keyless; ArrHttp requires a key so a placeholder rides the header
      // (harmless — Gatus ignores it), exactly like the keyless MaintainerrClient reads.
      apiKey: 'unused',
      timeoutMs: options.timeoutMs,
      retryDelayMs: options.retryDelayMs,
      fetchImpl: options.fetchImpl,
    });
    this.endpointKey = options.endpointKey;
  }

  /**
   * `GET /api/v1/endpoints/{key}/uptimes/{window}` — the uptime ratio 0..1 as a
   * PLAIN-TEXT float (live-verified: `0.999783`, Content-Type text/plain — the one
   * non-JSON read in this package). Parsed from the raw text through
   * `gatusUptimeTextSchema`; an empty/NaN/out-of-range body throws ArrParseError
   * (upstream drift must fail loud here — the caller degrades it to "unmeasured").
   */
  async getUptime(window: GatusUptimeWindow): Promise<number> {
    const method = 'GET';
    const path = `endpoints/${this.endpointKey}/uptimes/${window}`;
    const res = await this.http.request(method, path);
    const raw = await res.text();
    const parsed = gatusUptimeTextSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ArrParseError(
        method,
        this.http.buildUrl(path),
        parsed.error.issues.map((i) => i.message),
      );
    }
    return parsed.data;
  }

  /**
   * `GET /api/v1/endpoints/{key}/statuses` — current status = `results[last].success`
   * (the newest check result). The response's top-level `uptime` is null on the wire and
   * is NEVER parsed for uptime (schema omits it); the ratios come from getUptime.
   */
  async isUp(): Promise<boolean> {
    const page = await this.http.requestJson(
      'GET',
      `endpoints/${this.endpointKey}/statuses`,
      gatusEndpointStatusSchema,
    );
    return page.results[page.results.length - 1]!.success;
  }
}
