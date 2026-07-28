// Shared fetch-stubbed Maintainerr harness for the curation-pipeline + space-policy domain tests
// (ADR-025 / ADR-031). Mirrors the v3.19.0 REST surface the confined write client drives, including
// the Leaving-Soon RULE-GROUP-SHELL contracts (POST /api/rules with useRules:false + zero rules;
// arrAction MUST be DO_NOTHING=4; dataType/type are the MediaItemTypes STRING; setRules returns a
// ReturnStatus and NO ids — callers re-read by title) and the nightly purge semantics
// (`purgeRuleLessCollections` mirrors RuleMaintenanceService.removeCollectionsWithoutRule, which
// silently deletes every collection record lacking a rule group). Extracted so multiple test files
// share ONE faithful stub.
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
  /** null = no aging horizon (the rules-surface create path stores null verbatim — no zod coercion). */
  deleteAfterDays: number | null;
  /** ServarrAction (0=DELETE … 4=DO_NOTHING). Default 0 (a rule collection) in the GET handler. */
  arrAction?: number;
  /** true for app-managed Leaving-Soon manual collections; default false (rule collection). */
  manualCollection?: boolean;
  type: string;
  title: string;
  libraryId: number;
  items: StubItem[];
}
export interface StubRuleGroup {
  id: number;
  name: string;
  isActive: boolean;
  useRules: boolean;
  libraryId: string;
  dataType: string;
  collectionId: number;
}
export interface MaintState {
  integrations: { radarr: boolean; sonarr: boolean; tautulli: boolean; seerr: boolean };
  plexOk: boolean;
  reachable: boolean;
  exclusions: Set<string>;
  collections: StubCollection[];
  /** Rule groups (GET /api/rules). Every REAL rule pool has one; a collection without one is purged
   *  nightly by Maintainerr's RuleMaintenanceService — see purgeRuleLessCollections. */
  ruleGroups: StubRuleGroup[];
  /** mediaServerIds whose per-item handle fired — dropped from collection content. */
  handled: Set<string>;
  /** the id the stub assigns to the next created collection (POST /rules or legacy POST /collections). */
  nextCollectionId: number;
  nextRuleGroupId: number;
  fail: Set<string>;
  /** Test seam: fired on every GET /rules/exclusion. */
  onExclusionCheck?: (mediaServerId: string) => Promise<void> | void;
}

/**
 * Mirror of Maintainerr's nightly `RuleMaintenanceService.removeCollectionsWithoutRule` (cron
 * `20 4 * * *`): silently deletes EVERY collection record that has no rule group — no log, no
 * Plex-side cleanup. Tests call this to simulate a night passing; the rule-shell fix exists so the
 * Leaving-Soon record SURVIVES this.
 */
export function purgeRuleLessCollections(state: MaintState): number[] {
  const grouped = new Set(state.ruleGroups.map((g) => g.collectionId));
  const purged = state.collections.filter((c) => !grouped.has(c.id)).map((c) => c.id);
  state.collections = state.collections.filter((c) => grouped.has(c.id));
  return purged;
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
    if (method === 'GET' && path === '/rules')
      return ok(
        state.ruleGroups.map((g) => ({
          id: g.id,
          name: g.name,
          isActive: g.isActive,
          useRules: g.useRules,
          libraryId: g.libraryId,
          dataType: g.dataType,
          collection: (() => {
            const c = state.collections.find((col) => col.id === g.collectionId);
            return c ? { id: c.id, title: c.title, manualCollection: c.manualCollection ?? false } : null;
          })(),
        })),
      );
    if (method === 'GET' && path === '/collections') {
      return ok(
        state.collections.map((c) => ({
          id: c.id,
          isActive: c.isActive,
          deleteAfterDays: c.deleteAfterDays,
          arrAction: c.arrAction ?? 0,
          manualCollection: c.manualCollection ?? false,
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
    // writes — the Leaving-Soon rule-group-shell surface (v3.19.0 setRules). Creates the group AND
    // its collection; returns ONLY a ReturnStatus (no ids — the app re-reads by title).
    if (method === 'POST' && path === '/rules') {
      const p = (body ?? {}) as {
        name?: unknown;
        libraryId?: unknown;
        isActive?: boolean;
        arrAction?: unknown;
        useRules?: boolean;
        rules?: unknown[];
        dataType?: unknown;
        collection?: Record<string, unknown>;
      };
      if (typeof p.name !== 'string' || p.name.length === 0)
        return ok({ code: 0, result: 'name: Required' });
      if (!Array.isArray(p.rules)) return ok({ code: 0, result: 'rules: Required' });
      const dataType = p.dataType;
      if (typeof dataType !== 'string' || !['movie', 'show', 'season', 'episode'].includes(dataType))
        return ok({ code: 0, result: `dataType: expected MediaItemTypes enum string, got ${JSON.stringify(dataType)}` });
      const col = p.collection ?? {};
      if (p.arrAction !== 4) {
        throw new Error(
          `STUB CONTRACT VIOLATION (Maintainerr v3.19.0): Leaving-Soon rule shell ${JSON.stringify(p.name)} ` +
            `created with arrAction=${JSON.stringify(p.arrAction)} (≠ DO_NOTHING=4); the estate aging ` +
            `worker would delete its members.`,
        );
      }
      if (p.useRules === true || p.rules.length > 0) {
        throw new Error(
          `STUB CONTRACT VIOLATION: Leaving-Soon shell ${JSON.stringify(p.name)} carries rules ` +
            `(useRules=${String(p.useRules)}, ${p.rules.length} rule(s)) — the executor would strip ` +
            `app-curated members on its next run.`,
        );
      }
      const collectionId = state.nextCollectionId;
      state.nextCollectionId += 1;
      state.collections.push({
        id: collectionId,
        isActive: p.isActive ?? true,
        // The rules path stores deleteAfterDays VERBATIM (internal call, no z.coerce) — null stays null.
        deleteAfterDays:
          col.deleteAfterDays === undefined || col.deleteAfterDays === null ? null : Number(col.deleteAfterDays),
        arrAction: 4,
        manualCollection: Boolean(col.manualCollection ?? false),
        type: dataType,
        title: p.name,
        libraryId: Number(p.libraryId ?? 0),
        items: [],
      });
      state.ruleGroups.push({
        id: state.nextRuleGroupId,
        name: p.name,
        isActive: p.isActive ?? true,
        useRules: false,
        libraryId: String(p.libraryId ?? ''),
        dataType,
        collectionId,
      });
      state.nextRuleGroupId += 1;
      return ok({ code: 1, result: 'Success' }, 201);
    }
    // writes — rule-group teardown: cascades group + collection (v3.19.0 deleteRuleGroup).
    const groupMatch = path.match(/^\/rules\/(\d+)$/);
    if (method === 'DELETE' && groupMatch) {
      const gid = Number(groupMatch[1]);
      const group = state.ruleGroups.find((g) => g.id === gid);
      state.ruleGroups = state.ruleGroups.filter((g) => g.id !== gid);
      if (group) state.collections = state.collections.filter((c) => c.id !== group.collectionId);
      return ok({ code: 1, result: 'Success' });
    }
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
    // Membership writes are STATEFUL so the reconcile paths (drive/heal/close) are observable via
    // the content endpoint. Adds dedupe by mediaServerId; removing an absent member is a server-side
    // no-op (matches removeFromCollectionInternal's tolerant skip).
    if (method === 'POST' && path === '/collections/add') {
      const b = body as { collectionId: number; media?: Array<{ mediaServerId: string }> };
      const col = state.collections.find((c) => c.id === b.collectionId);
      if (col)
        for (const m of b.media ?? []) {
          if (!col.items.some((i) => i.mediaServerId === m.mediaServerId))
            col.items.push({ mediaServerId: m.mediaServerId, sizeBytes: 0, addDate: new Date().toISOString() });
        }
      return ok(null, 201);
    }
    if (method === 'POST' && path === '/collections/remove') {
      const b = body as { collectionId: number; media?: Array<{ mediaServerId: string }> };
      const col = state.collections.find((c) => c.id === b.collectionId);
      if (col) {
        const gone = new Set((b.media ?? []).map((m) => m.mediaServerId));
        col.items = col.items.filter((i) => !gone.has(i.mediaServerId));
      }
      return ok(null, 201);
    }
    if (method === 'POST' && path === '/collections/removeCollection') {
      const b = body as { collectionId: number };
      state.collections = state.collections.filter((c) => c.id !== b.collectionId);
      return ok(null, 201);
    }

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
    // Healthy-estate default: an aging-safe horizon + DELETE arrAction, so the audit's aging invariant
    // (DESIGN-010 errata 2026-07-09) is SAFE by default; tests that probe the invariant override these.
    deleteAfterDays: 9999,
    arrAction: 0,
    manualCollection: false,
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
    deleteAfterDays: 9999, // aging-safe default (see movieCollection)
    arrAction: 0,
    manualCollection: false,
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

export const baseState = (over: Partial<MaintState> = {}): MaintState => {
  const collections = over.collections ?? [movieCollection()];
  return {
    integrations: { radarr: true, sonarr: true, tautulli: true, seerr: true },
    plexOk: true,
    reachable: true,
    exclusions: new Set(),
    handled: new Set(),
    nextCollectionId: 555,
    nextRuleGroupId: 7000,
    fail: new Set(),
    ...over,
    collections,
    // Every REAL rule pool has a rule group (the Maintainerr UI only creates collections through
    // rules) — default one per seeded collection so purgeRuleLessCollections mirrors production.
    ruleGroups:
      over.ruleGroups ??
      collections.map((c, i) => ({
        id: 7100 + i,
        name: c.title,
        isActive: true,
        useRules: true,
        libraryId: String(c.libraryId),
        dataType: c.type,
        collectionId: c.id,
      })),
  };
};
