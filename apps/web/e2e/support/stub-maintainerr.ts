// ADR-023 / DESIGN-010 e2e — stub Maintainerr HTTP server (mirrors stub-arr). Serves the
// fixture-shaped READ endpoints the Trash flow resolves against (collections + paged content with
// sizes/deleteAfterDays, rules, rules/constants with all integrations configured, exclusions,
// settings, app/status, settings/test/plex) and accepts the WRITE endpoints (exclusion CRUD,
// collection handle/expedite), RECORDING every mutating call so specs can assert them. Wired into
// harness.ts / env.ts so both Playwright e2e and `pnpm dev:local` boot a complete Trash stack.
//
// Fixtures join the seed-ledger rows so the Trash UX exercises every guardian partition
// (DESIGN-010 D-09): The Fixture (tmdb 880001, recently watched → auto-protected), Stub Runner
// (tmdb 880002, dnd-tagged → already protected), Vanished Heist (tmdb 880004, cold → deletable),
// plus one item UNKNOWN to the ledger (tmdb 990009 → unverifiable/skipped). The TV collection
// holds Breaking Prod (tvdb 990001, requested → protected).
//
// Control endpoints:
//   GET  /_stub/calls         → { calls: [{method, path, query, body}] } (writes only)
//   POST /_stub/reset         → 204 (clears calls + exclusions + handled items + integrations)
//   POST /_stub/integrations  → 204; body { name: 'radarr'|'sonarr'|'tautulli'|'overseerr'|'plex',
//                               connected: boolean } — degrade/restore one integration so specs
//                               can flip the safety banner (trash.status derives connectivity
//                               from rules/constants applications + the Plex test — D-04).
//   POST /_stub/add-pending    → 204; body { collectionId, mediaServerId, tmdb/tvdbId?, sizeBytes? }
//   POST /_stub/remove-pending → 204; body { mediaServerId } — drop it from its collection (empty a
//                               kind for the Overview "nothing pending" card / suppressed-zero badge).
import { createServer, type IncomingMessage, type Server } from 'node:http';

export interface RecordedMaintainerrWrite {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

export interface StubMaintainerrServer {
  baseUrl: string;
  port: number;
  calls: RecordedMaintainerrWrite[];
  stop: () => Promise<void>;
}

/** The throwaway key the stub Maintainerr accepts (never a real credential). */
export const STUB_MAINTAINERR_API_KEY = 'stub-maintainerr-key';

/** Seed-joined Maintainerr ids (Plex ratingKeys) — exported for spec assertions. */
export const STUB_MAINT_FIXTURE_ID = 'ms-880001'; // The Fixture — recently watched
export const STUB_MAINT_RUNNER_ID = 'ms-880002'; // Stub Runner — dnd-tagged
export const STUB_MAINT_VANISHED_ID = 'ms-880004'; // Vanished Heist — cold (deletable)
export const STUB_MAINT_UNKNOWN_ID = 'ms-990009'; // not in the ledger — unverifiable
export const STUB_MAINT_TV_ID = 'ms-990001'; // Breaking Prod — requested
export const STUB_MAINT_NEWCAND_ID = 'ms-990010'; // injected post-snapshot (new-candidates strip)

const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString();

interface StubCollection {
  id: number;
  title: string;
  isActive: boolean;
  deleteAfterDays: number;
  type: string;
  libraryId: number;
  items: Array<{
    mediaServerId: string;
    tmdbId?: number;
    tvdbId?: number;
    sizeBytes: number;
    addDate: string;
  }>;
}

/** Fresh fixture state (addDates are relative so scheduled-delete stays in the future). */
function freshCollections(): StubCollection[] {
  return [
    {
      id: 7,
      title: 'Least watched movies',
      isActive: true,
      deleteAfterDays: 30,
      type: 'movie',
      libraryId: 1,
      items: [
        {
          mediaServerId: STUB_MAINT_FIXTURE_ID,
          tmdbId: 880001,
          sizeBytes: 4_294_967_296,
          addDate: daysAgo(5),
        },
        {
          mediaServerId: STUB_MAINT_RUNNER_ID,
          tmdbId: 880002,
          sizeBytes: 8_589_934_592,
          addDate: daysAgo(10),
        },
        {
          mediaServerId: STUB_MAINT_VANISHED_ID,
          tmdbId: 880004,
          sizeBytes: 2_147_483_648,
          addDate: daysAgo(25),
        },
        {
          mediaServerId: STUB_MAINT_UNKNOWN_ID,
          tmdbId: 990009,
          sizeBytes: 1_073_741_824,
          addDate: daysAgo(2),
        },
      ],
    },
    {
      id: 8,
      title: 'Stale shows',
      isActive: true,
      deleteAfterDays: 45,
      type: 'show',
      libraryId: 2,
      items: [
        {
          mediaServerId: STUB_MAINT_TV_ID,
          tvdbId: 990001,
          sizeBytes: 21_474_836_480,
          addDate: daysAgo(7),
        },
      ],
    },
  ];
}

/** One armed rule group EXACTLY as GET /api/rules serves it on v3.17.0 (verified against source):
 *  - `rules[]` is the DB ENTITY shape (RuleDbDto: an ENCODED `ruleJson` string), NOT the decoded
 *    RuleDto that PUT /api/rules validates — the shape mismatch that 502'd arm/disarm (Bug 1).
 *  - `dataType` is a STRING union member ('movie'|'show'|'season'|'episode'), NOT a number: the entity
 *    column is `varchar` and contracts' `MediaItemType` is a string. The PUT's crucial-change guard
 *    compares `group.dataType !== params.dataType`, so a numeric round-trip ('movie' !== 1) would be
 *    seen as a crucial change and WIPE the collection — the hazard this fixture must model faithfully.
 *  - `libraryId` is likewise a `varchar` string (crucial-change also compares `params.libraryId !==
 *    dbCollection.libraryId`).
 *  - the *arr server ids live NESTED under `collection` (columns on the collection entity), NOT at the
 *    group level — but PUT validates them at the group level, so the app must lift them up (Bug: the
 *    live re-verify 502 "Radarr rules require a Radarr server to be selected"). The rule references
 *    Radarr (`firstVal[0] === Application.RADARR === 1`) so that selection validation actually applies. */
function freshRules(): Array<Record<string, unknown>> {
  return [
    {
      id: 11,
      name: 'Purge stale movies',
      description: 'Unwatched 4K movies older than 90 days',
      isActive: true,
      dataType: 'movie',
      libraryId: '1',
      collection: { id: 7, libraryId: '1', deleteAfterDays: 30, radarrSettingsId: 3, sonarrSettingsId: null },
      rules: [
        {
          id: 1,
          ruleGroupId: 11,
          section: 0,
          isActive: true,
          // firstVal[0] === 1 (Application.RADARR) ⇒ PUT requires a group-level radarrSettingsId.
          ruleJson: JSON.stringify({ operator: null, action: 0, firstVal: [1, 0], lastVal: [0, 4], section: 0 }),
        },
      ],
    },
  ];
}

/** Re-encode a decoded RuleDto[] back to the DB entity shape (RuleDbDto with `ruleJson`) so a stored
 *  rule GET keeps serving the shape a fresh round-trip must decode — exactly like Maintainerr. */
function encodeRules(ruleGroupId: number, decoded: unknown[]): Array<Record<string, unknown>> {
  return decoded.map((r, i) => {
    const rule = (r ?? {}) as Record<string, unknown>;
    return {
      id: i + 1,
      ruleGroupId,
      section: typeof rule.section === 'number' ? rule.section : 0,
      isActive: true,
      ruleJson: JSON.stringify(rule),
    };
  });
}

// Ids per contracts' `Application` enum (v3.17.0): PLEX=0, RADARR=1, SONARR=2, SEERR=3, TAUTULLI=4.
// The audit matches by NAME, but the ids must line up with the server-selection check below (which
// keys a rule's `firstVal[0]`/`lastVal[0]` on RADARR=1 / SONARR=2).
const ALL_APPLICATIONS = [
  { id: 0, name: 'Plex' },
  { id: 1, name: 'Radarr' },
  { id: 2, name: 'Sonarr' },
  { id: 3, name: 'Overseerr' },
  { id: 4, name: 'Tautulli' },
];

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => (data += chunk.toString('utf8')));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function json(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

export async function startStubMaintainerr(): Promise<StubMaintainerrServer> {
  const calls: RecordedMaintainerrWrite[] = [];
  const exclusions = new Set<string>();
  /** mediaServerIds whose per-item handle (delete) has fired — dropped from collection content. */
  const handled = new Set<string>();
  /** lowercased application names currently "disconnected" (dropped from rules/constants). */
  const disconnected = new Set<string>();
  // ADR-025 — the manual Leaving-Soon collections created via POST /collections. v3.17.0's create
  // returns NO body, so the drive re-reads the new id from GET /collections by title; the list must
  // surface these (id → { title, type, libraryId, members }).
  const manualCollections = new Map<
    number,
    { title: string; type: string; libraryId: number; members: Set<string> }
  >();
  let nextManualCollectionId = 900;
  /** DESTRUCTIVE-hazard tracker: each PUT /rules that Maintainerr's `updateRules` would treat as a
   *  "crucial setting change" (dataType/manualCollection/manualCollectionName/libraryId differs from
   *  the stored group) — it wipes the collection media + specific exclusions + deletes the Plex
   *  collection. A correct isActive toggle NEVER triggers one; a spec asserts this list stays empty so
   *  a dataType/libraryId round-trip regression (e.g. coercing 'movie'→1) is caught as data loss. */
  const wipes: Array<{ ruleId: number; collectionId: unknown; from: unknown; to: unknown }> = [];
  let collections = freshCollections();
  let rules = freshRules();

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = req.method ?? 'GET';
      const path = url.pathname.replace(/^\/api/, '');
      const query = Object.fromEntries(url.searchParams.entries());

      if (url.pathname === '/_stub/calls') return json(res, 200, { calls });
      // The crucial-change wipe ledger (empty unless a PUT would have destroyed a collection).
      if (url.pathname === '/_stub/wipes') return json(res, 200, { wipes });
      if (url.pathname === '/_stub/reset' && method === 'POST') {
        calls.length = 0;
        exclusions.clear();
        handled.clear();
        disconnected.clear();
        manualCollections.clear();
        nextManualCollectionId = 900;
        wipes.length = 0;
        collections = freshCollections();
        rules = freshRules();
        res.writeHead(204);
        return res.end();
      }
      if (url.pathname === '/_stub/integrations' && method === 'POST') {
        const body = JSON.parse(await readBody(req)) as { name: string; connected: boolean };
        if (body.connected) disconnected.delete(body.name.toLowerCase());
        else disconnected.add(body.name.toLowerCase());
        res.writeHead(204);
        return res.end();
      }
      // Pre-seed a live exclusion WITHOUT going through the app's save flow — simulates an exclusion
      // created outside the current session (its `dnd` tag has not synced into arrTags). Bug 2: the
      // pending list must still show it Protected (protectedByExclusion), not wait for the tag.
      if (url.pathname === '/_stub/exclude' && method === 'POST') {
        const body = JSON.parse(await readBody(req)) as { mediaServerId: string; excluded?: boolean };
        if (body.excluded === false) exclusions.delete(body.mediaServerId);
        else exclusions.add(body.mediaServerId);
        res.writeHead(204);
        return res.end();
      }
      // ADR-033 — push a NEW pending item into a collection AFTER a batch snapshot, so the
      // "new candidates since this batch" strip has something to show (the batch froze the old
      // set; a fresh candidate joins the live pending set but not the batch).
      if (url.pathname === '/_stub/add-pending' && method === 'POST') {
        const body = JSON.parse(await readBody(req)) as {
          collectionId: number;
          mediaServerId: string;
          tmdbId?: number;
          tvdbId?: number;
          sizeBytes?: number;
        };
        const col = collections.find((c) => c.id === body.collectionId);
        if (col && !col.items.some((i) => i.mediaServerId === body.mediaServerId)) {
          col.items.push({
            mediaServerId: body.mediaServerId,
            tmdbId: body.tmdbId,
            tvdbId: body.tvdbId,
            sizeBytes: body.sizeBytes ?? 1_073_741_824,
            addDate: daysAgo(1),
          });
        }
        res.writeHead(204);
        return res.end();
      }
      // Drop a pending item from whatever collection holds it (the inverse of add-pending) — lets a
      // spec make a whole KIND empty (e.g. the TV collection) to exercise the Overview "nothing
      // pending" card + suppressed-zero badge (DESIGN-010 amendment 2026-07-08).
      if (url.pathname === '/_stub/remove-pending' && method === 'POST') {
        const body = JSON.parse(await readBody(req)) as { mediaServerId: string };
        for (const col of collections) {
          col.items = col.items.filter((i) => i.mediaServerId !== body.mediaServerId);
        }
        res.writeHead(204);
        return res.end();
      }

      if (method === 'POST' || method === 'DELETE' || method === 'PUT' || method === 'PATCH') {
        const raw = await readBody(req);
        const body = raw === '' ? undefined : (JSON.parse(raw) as unknown);
        calls.push({ method, path, query, body });
        if (method === 'POST' && path === '/rules/exclusion') {
          exclusions.add(String((body as { mediaId?: unknown })?.mediaId ?? ''));
          return json(res, 201, { code: 1 });
        }
        if (method === 'DELETE' && /^\/rules\/exclusions\/.+$/.test(path)) {
          exclusions.delete(decodeURIComponent(path.split('/').pop() ?? ''));
          return json(res, 200, { code: 1 });
        }
        if (method === 'POST' && path === '/collections/media/handle') {
          // The per-item delete trigger (the ONLY one expedite may use — C-07a): the item
          // leaves its collection so a pending refetch shows it gone.
          handled.add(String((body as { mediaId?: unknown })?.mediaId ?? ''));
          return json(res, 201, {});
        }
        if (method === 'POST' && path === '/collections/handle') {
          // The estate-wide handler expedite must NEVER call (C-07a). Accept it (Maintainerr
          // would) so the guard is the spec's /_stub/calls assertion, not a stub 404.
          return json(res, 201, {});
        }
        // ADR-025 — the manual Leaving-Soon collection surface (Q-05). Faithful to v3.17.0: `type` is a
        // STRING enum, `arrAction` is required (DO_NOTHING=4 for Leaving-Soon), and create returns VOID.
        if (method === 'POST' && path === '/collections') {
          const dto = body as {
            collection?: { title?: unknown; type?: unknown; libraryId?: unknown };
            media?: Array<{ mediaServerId: string }>;
          };
          const col = dto.collection ?? {};
          const id = ++nextManualCollectionId;
          manualCollections.set(id, {
            title: String(col.title ?? ''),
            type: typeof col.type === 'string' ? col.type : 'movie',
            libraryId: Number(col.libraryId ?? 0),
            members: new Set((dto.media ?? []).map((m) => m.mediaServerId)),
          });
          return json(res, 201, undefined); // v3.17.0 create returns NO body
        }
        if (method === 'POST' && path === '/collections/add') {
          const dto = body as { collectionId: number; media?: Array<{ mediaServerId: string }> };
          const mc = manualCollections.get(dto.collectionId);
          if (mc) for (const m of dto.media ?? []) mc.members.add(m.mediaServerId);
          return json(res, 201, {});
        }
        if (method === 'POST' && path === '/collections/remove') {
          const dto = body as { collectionId: number; media?: Array<{ mediaServerId: string }> };
          const mc = manualCollections.get(dto.collectionId);
          if (mc) for (const m of dto.media ?? []) mc.members.delete(m.mediaServerId);
          return json(res, 201, {});
        }
        if (method === 'POST' && path === '/collections/removeCollection') {
          manualCollections.delete((body as { collectionId: number }).collectionId);
          return json(res, 201, {});
        }
        if ((method === 'POST' || method === 'PUT') && path === '/rules') {
          const dto = body as {
            id?: unknown;
            rules?: unknown;
            dataType?: unknown;
            libraryId?: unknown;
            radarrSettingsId?: unknown;
            sonarrSettingsId?: unknown;
          };
          const dtoRules = Array.isArray(dto.rules) ? dto.rules : [];
          // (1) Faithful to Maintainerr updateRules/validateRule: rules[] must be the DECODED RuleDto
          // shape (it never decodes ruleJson). A round-tripped DB entity (still carrying `ruleJson`)
          // fails validation → ReturnStatus {code:0} → the app fails closed (BAD_GATEWAY). This is
          // the Bug-1 502; a rule with `rules: []` (the OLD fixture) never hit it.
          const undecoded = dtoRules.some(
            (r) => r !== null && typeof r === 'object' && typeof (r as { ruleJson?: unknown }).ruleJson === 'string',
          );
          if (undecoded) {
            return json(res, 200, { code: 0, result: 'First value is not available for this server' });
          }
          // (2) validateRuleServerSelection: a rule referencing Radarr (Application.RADARR=1) or
          // Sonarr (=2) in firstVal[0]/lastVal[0] requires the matching GROUP-LEVEL server id. GET
          // nests those under `collection`, so a verbatim round-trip omits them and Maintainerr
          // rejects the PUT — the live re-verify 502 the settings-id backfill fixes.
          const appIds = new Set<number>();
          for (const r of dtoRules) {
            if (r === null || typeof r !== 'object') continue;
            for (const v of [(r as { firstVal?: unknown }).firstVal, (r as { lastVal?: unknown }).lastVal]) {
              if (Array.isArray(v) && typeof v[0] === 'number') appIds.add(v[0]);
            }
          }
          if (appIds.has(1) && dto.radarrSettingsId == null) {
            return json(res, 200, { code: 0, result: 'Radarr rules require a Radarr server to be selected' });
          }
          if (appIds.has(2) && dto.sonarrSettingsId == null) {
            return json(res, 200, { code: 0, result: 'Sonarr rules require a Sonarr server to be selected' });
          }
          if (method === 'PUT' && typeof dto.id === 'number') {
            const stored = rules.find((r) => r.id === dto.id);
            // (3) Crucial-change WIPE simulation (verified v3.17.0 updateRules): dataType or libraryId
            // differing from the stored group wipes the collection media + specific exclusions and
            // deletes the Plex collection. A correct isActive toggle carries both back VERBATIM, so
            // this must NOT fire; if it does (e.g. dataType coerced 'movie'→1), we record + enact the
            // data loss so a spec/regression catches it.
            if (stored !== undefined) {
              const crucial =
                ('dataType' in dto && dto.dataType !== stored.dataType) ||
                ('libraryId' in dto && dto.libraryId !== stored.libraryId);
              if (crucial) {
                const collectionId = (stored.collection as { id?: unknown } | undefined)?.id;
                wipes.push({
                  ruleId: dto.id,
                  collectionId,
                  from: { dataType: stored.dataType, libraryId: stored.libraryId },
                  to: { dataType: dto.dataType, libraryId: dto.libraryId },
                });
                const col = collections.find((c) => c.id === collectionId);
                if (col) col.items = []; // media wiped
                exclusions.clear(); // specific exclusions wiped
              }
              // Store the merge, re-encoding rules to the DB shape so a subsequent GET (re-arm) again
              // exercises the decode.
              rules = rules.map((r) =>
                r.id === dto.id
                  ? { ...r, ...(body as object), rules: encodeRules(dto.id as number, dtoRules) }
                  : r,
              );
            }
          }
          return json(res, 200, { code: 1 });
        }
        if (method === 'DELETE' && /^\/rules\/\d+$/.test(path)) {
          const id = Number(path.split('/').pop());
          rules = rules.filter((r) => r.id !== id);
          return json(res, 200, { code: 1 });
        }
        // BasicResponseDto (code:1 = success) — the write client fails closed on code:0 (P1a).
        if (method === 'PATCH' && path === '/settings')
          return json(res, 200, { status: 'OK', code: 1, message: 'Success' });
        return json(res, 404, {
          message: `stub-maintainerr: no write handler for ${method} ${path}`,
        });
      }

      // ---- reads ----
      switch (true) {
        case path === '/app/status':
          return json(res, 200, {
            status: 'ok',
            version: '3.17.0',
            commitTag: 'e2e',
            updateAvailable: false,
          });
        case path === '/settings/test/plex':
          return disconnected.has('plex')
            ? json(res, 200, { status: 'NOK', code: 0, message: 'Plex unreachable (stub)' })
            : json(res, 200, { status: 'OK', code: 1, message: 'Plex 1.40 (stub)' });
        case path === '/rules/constants':
          return json(res, 200, {
            applications: ALL_APPLICATIONS.filter((a) => !disconnected.has(a.name.toLowerCase())),
          });
        case path === '/rules':
          return json(res, 200, rules);
        case path === '/settings':
          return json(res, 200, {
            radarr_tag_exclusions: true,
            radarr_exclusion_tag: 'dnd',
            radarr_untag_on_unexclude: true,
            sonarr_tag_exclusions: true,
            sonarr_exclusion_tag: 'dnd',
            sonarr_untag_on_unexclude: true,
            // DESIGN-014 build D — Maintainerr's own handler crons (mirror the live install's defaults) so
            // the wall's honest "pool re-evaluates every 8 h" cadence line renders in dev/e2e too.
            rules_handler_job_cron: '0 0-23/8 * * *',
            collection_handler_job_cron: '0 0-23/12 * * *',
          });
        case path === '/collections':
          return json(res, 200, [
            ...collections.map((c) => ({
              id: c.id,
              title: c.title,
              isActive: c.isActive,
              deleteAfterDays: c.deleteAfterDays,
              type: c.type,
              libraryId: c.libraryId,
              media: [], // the list serves a PREVIEW subset — content is the paged endpoint
            })),
            // ADR-025 — surface the created Leaving-Soon collections so the drive can re-read their id
            // by title (the pending derivation skips them by title, so they never inflate the tables).
            ...[...manualCollections].map(([id, mc]) => ({
              id,
              title: mc.title,
              isActive: true,
              deleteAfterDays: 0,
              type: mc.type,
              libraryId: mc.libraryId,
              media: [],
            })),
          ]);
        case /^\/collections\/media\/\d+\/content\/\d+$/.test(path): {
          const cid = Number(path.split('/')[3]);
          const items =
            collections
              .find((c) => c.id === cid)
              ?.items.filter((i) => !handled.has(i.mediaServerId)) ?? [];
          return json(res, 200, { totalSize: items.length, items });
        }
        case path === '/rules/exclusion': {
          const id = query.mediaServerId;
          return json(
            res,
            200,
            id !== undefined && exclusions.has(id)
              ? [{ id: 1, mediaServerId: id, ruleGroupId: null, parent: id }]
              : [],
          );
        }
        default:
          return json(res, 404, { message: `stub-maintainerr: no read handler for GET ${path}` });
      }
    })().catch((err: unknown) =>
      json(res, 500, { message: `stub-maintainerr error: ${String(err)}` }),
    );
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('stub-maintainerr failed to bind a port');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    port: address.port,
    calls,
    stop: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
