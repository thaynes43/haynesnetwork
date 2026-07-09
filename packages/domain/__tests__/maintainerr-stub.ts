// Shared fetch-stubbed Maintainerr harness for the curation-pipeline + space-policy domain tests
// (ADR-025 / ADR-031). Mirrors the v3.17.0 REST surface the confined write client drives, including
// the manual Leaving-Soon collection contracts (type is the MediaItemTypes STRING; arrAction is
// REQUIRED and must be DO_NOTHING=4; deleteAfterDays coerces via z.coerce.number(); create returns NO
// body). Extracted so multiple test files share ONE faithful stub.
import { buildMaintainerrClientBundle, type MaintainerrClientBundle } from '../src/index';

export interface StubItem {
  mediaServerId: string;
  tmdbId?: number;
  tvdbId?: number;
  sizeBytes: number;
  addDate: string;
}
export interface StubCollection {
  id: number;
  isActive: boolean;
  deleteAfterDays: number;
  type: string;
  title: string;
  libraryId: number;
  items: StubItem[];
}
export interface MaintState {
  integrations: { radarr: boolean; sonarr: boolean; tautulli: boolean; seerr: boolean };
  plexOk: boolean;
  reachable: boolean;
  exclusions: Set<string>;
  collections: StubCollection[];
  /** mediaServerIds whose per-item handle fired — dropped from collection content. */
  handled: Set<string>;
  /** the id the stub returns for POST /collections. */
  nextCollectionId: number;
  fail: Set<string>;
  /** Test seam: fired on every GET /rules/exclusion. */
  onExclusionCheck?: (mediaServerId: string) => Promise<void> | void;
}
export interface RecordedCall {
  method: string;
  pathname: string;
  query: Record<string, string>;
  body: unknown;
}

export function makeMaintainerr(state: MaintState): {
  bundle: MaintainerrClientBundle;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const path = url.pathname.replace(/^\/api/, '');
    const query = Object.fromEntries(url.searchParams.entries());
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, pathname: path, query, body });
    if (!state.reachable) return new Response('unreachable', { status: 502 });
    const key = `${method} ${path}`;
    if (state.fail.has(key)) return new Response('{"message":"forced"}', { status: 500 });
    const ok = (b: unknown, status = 200) =>
      new Response(b === undefined ? null : JSON.stringify(b), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    // reads
    if (method === 'GET' && path === '/app/status') return ok({ status: 'ok', version: '3.17.0' });
    if (method === 'GET' && path === '/settings/test/plex')
      return ok({ status: state.plexOk ? 'OK' : 'NOK', code: state.plexOk ? 1 : 0 });
    if (method === 'GET' && path === '/rules/constants') {
      const apps: Array<{ name: string }> = [];
      if (state.integrations.radarr) apps.push({ name: 'Radarr' });
      if (state.integrations.sonarr) apps.push({ name: 'Sonarr' });
      if (state.integrations.tautulli) apps.push({ name: 'Tautulli' });
      if (state.integrations.seerr) apps.push({ name: 'Overseerr' });
      return ok({ applications: apps });
    }
    if (method === 'GET' && path === '/rules') return ok([]);
    if (method === 'GET' && path === '/collections') {
      return ok(
        state.collections.map((c) => ({
          id: c.id,
          isActive: c.isActive,
          deleteAfterDays: c.deleteAfterDays,
          type: c.type,
          title: c.title,
          libraryId: c.libraryId,
          media: [],
        })),
      );
    }
    const contentMatch = path.match(/^\/collections\/media\/(\d+)\/content\/(\d+)$/);
    if (method === 'GET' && contentMatch) {
      const cid = Number(contentMatch[1]);
      const items = (state.collections.find((c) => c.id === cid)?.items ?? []).filter(
        (i) => !state.handled.has(i.mediaServerId),
      );
      return ok({ totalSize: items.length, items });
    }
    if (method === 'GET' && path === '/rules/exclusion') {
      const id = query.mediaServerId;
      if (id !== undefined) await state.onExclusionCheck?.(id);
      const present = id !== undefined && state.exclusions.has(id);
      return ok(present ? [{ id: 1, mediaServerId: id, ruleGroupId: null, parent: id }] : []);
    }

    // writes — re-evaluate all active rule groups (DESIGN-014 build D — pool refresh after save).
    // v3.17.0 enqueues fire-and-forget and returns no body; `POST /rules/execute` in `state.fail`
    // stands in for the 409 'already running' / outage path.
    if (method === 'POST' && path === '/rules/execute') return ok(undefined, 201);
    // writes — exclusions
    if (method === 'POST' && path === '/rules/exclusion') {
      state.exclusions.add(String((body as { mediaId: string }).mediaId));
      return ok({ code: 1 }, 201);
    }
    const rmMatch = path.match(/^\/rules\/exclusions\/(.+)$/);
    if (method === 'DELETE' && rmMatch) {
      state.exclusions.delete(decodeURIComponent(rmMatch[1]!));
      return ok({ code: 1 });
    }
    // writes — per-item delete
    if (method === 'POST' && path === '/collections/media/handle') {
      state.handled.add(String((body as { mediaId: string }).mediaId));
      return ok(null, 201);
    }
    // writes — the Leaving-Soon manual collection surface (v3.17.0 contracts enforced).
    if (method === 'POST' && path === '/collections') {
      const payload = (body ?? {}) as {
        collection?: Record<string, unknown>;
        media?: Array<{ mediaServerId: string }>;
      };
      const col = payload.collection ?? {};
      const type = col.type;
      if (typeof type !== 'string' || !['movie', 'show', 'season', 'episode'].includes(type)) {
        return new Response(
          JSON.stringify({ message: `type: expected MediaItemTypes enum string, got ${JSON.stringify(type)}` }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      }
      if (typeof col.arrAction !== 'number') {
        return new Response(JSON.stringify({ message: 'arrAction: Required' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      const rawDelete = col.deleteAfterDays;
      const coerced = rawDelete === undefined || rawDelete === null ? 0 : Number(rawDelete);
      if (col.arrAction !== 4) {
        throw new Error(
          `STUB CONTRACT VIOLATION (Maintainerr v3.17.0): Leaving-Soon collection ${JSON.stringify(col.title)} ` +
            `created with arrAction=${col.arrAction} (≠ DO_NOTHING=4) and deleteAfterDays ` +
            `${JSON.stringify(rawDelete)}→${coerced}; the estate aging worker would delete all ` +
            `${(payload.media ?? []).length} members on its next run.`,
        );
      }
      const id = state.nextCollectionId;
      state.collections.push({
        id,
        isActive: true,
        deleteAfterDays: coerced,
        type,
        title: String(col.title ?? ''),
        libraryId: Number(col.libraryId ?? 0),
        items: (payload.media ?? []).map((m) => ({
          mediaServerId: m.mediaServerId,
          sizeBytes: 0,
          addDate: new Date().toISOString(),
        })),
      });
      return ok(undefined, 201); // v3.17.0 create returns NO body
    }
    if (method === 'POST' && path === '/collections/add') return ok(null, 201);
    if (method === 'POST' && path === '/collections/remove') return ok(null, 201);
    if (method === 'POST' && path === '/collections/removeCollection') return ok(null, 201);

    return new Response(JSON.stringify({ message: `no stub for ${key}` }), { status: 404 });
  }) as typeof fetch;

  return {
    bundle: buildMaintainerrClientBundle({
      baseUrl: 'http://maintainerr.test:6246',
      apiKey: 'k',
      retryDelayMs: 0,
      fetchImpl,
    }),
    calls,
  };
}

/** A movie rule collection (type 'movie', libraryId 1) with N pending items (default 3). */
export function movieCollection(over: Partial<StubCollection> = {}): StubCollection {
  return {
    id: 7,
    isActive: true,
    deleteAfterDays: 30,
    type: 'movie',
    title: 'Least watched movies',
    libraryId: 1,
    items: [
      { mediaServerId: 'ms-9001', tmdbId: 9001, sizeBytes: 4_000_000_000, addDate: '2026-06-01T00:00:00Z' },
      { mediaServerId: 'ms-9002', tmdbId: 9002, sizeBytes: 3_000_000_000, addDate: '2026-06-01T00:00:00Z' },
      { mediaServerId: 'ms-9003', tmdbId: 9003, sizeBytes: 2_000_000_000, addDate: '2026-06-01T00:00:00Z' },
    ],
    ...over,
  };
}

/** A TV rule collection (type 'show', libraryId 2) with pending items. */
export function tvCollection(over: Partial<StubCollection> = {}): StubCollection {
  return {
    id: 8,
    isActive: true,
    deleteAfterDays: 30,
    type: 'show',
    title: 'Least watched shows',
    libraryId: 2,
    items: [
      { mediaServerId: 'ms-8001', tvdbId: 8001, sizeBytes: 6_000_000_000, addDate: '2026-06-01T00:00:00Z' },
      { mediaServerId: 'ms-8002', tvdbId: 8002, sizeBytes: 5_000_000_000, addDate: '2026-06-01T00:00:00Z' },
    ],
    ...over,
  };
}

export const baseState = (over: Partial<MaintState> = {}): MaintState => ({
  integrations: { radarr: true, sonarr: true, tautulli: true, seerr: true },
  plexOk: true,
  reachable: true,
  exclusions: new Set(),
  collections: [movieCollection()],
  handled: new Set(),
  nextCollectionId: 555,
  fail: new Set(),
  ...over,
});
