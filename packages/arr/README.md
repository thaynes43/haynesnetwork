# @hnet/arr

Typed Sonarr / Radarr / Lidarr / Jellyseerr adapters — the **BC-03 anti-corruption
layer**. External *arr/Seerr models never leak past this package: every response is
parsed through a strip-mode zod subset before it enters the app.

Design of record: `docs/designs/005-*.md` (D-01 topology, D-02 field contract, D-03
endpoint inventory, D-18 package layout). Governed by ADR-007 (Fix semantics) and
ADR-008 / ADR-011 (one-way sync + the sanctioned write-backs).

## Export subpaths (who may import each)

Declared in `package.json#exports` — three entrypoints, deliberately split so the
mutating surface is import-guarded (D-18, ADR-008 enforceability):

| Subpath | Contents | Who may import |
|---|---|---|
| `@hnet/arr` (root, `src/index.ts`) | `errors`, `config`, `schemas/*` — no HTTP client | anywhere (safe: types + env contract + error taxonomy only) |
| `@hnet/arr/read` (`src/read.ts`) | `SonarrClient` / `RadarrClient` / `LidarrClient` / `SeerrClient`, `arrReadClientsFromEnv` | any read consumer — `@hnet/sync`, `ledger.children`, `restore.diff` |
| `@hnet/arr/write` (`src/write.ts`) | `*WriteClient`, `arrWriteClientsFromEnv` — mark-failed, file deletes, `command` search, add-item, create-tag | **`packages/domain` ONLY** (the fix/restore orchestrators) |

`@hnet/arr/write` being domain-only is not a convention — it is enforced by the static
scan in `packages/domain/__tests__/arr-write-import-guard.test.ts`, which greps the whole
tree and fails if `@hnet/arr/write` is referenced outside `packages/domain/` or
`packages/arr/` itself. sync, `packages/api`, and `apps/web` reach write clients only
through the domain bundle (`runFixRequest`, `executeRestore`), so every write-back is
audited (hard rule 4/6). Adding a new importer of `./write` outside domain WILL red the
suite — put the orchestration in `packages/domain` instead.

## Adding an endpoint

1. **Extend the zod subset first** in `src/schemas/{sonarr,radarr,lidarr,seerr}.ts` (or
   `common.ts` for shapes shared by all three *arrs). Parse **only the fields the app
   consumes** — schemas are default (strip) mode: extra upstream fields are tolerated and
   dropped, never surfaced. This is the BC-03 ACL boundary; do not add a field "just in
   case." The read-surface tests assert the strip (`expect(x).not.toHaveProperty(...)`).
2. Add the method to the right client in `read.ts` / `write.ts` via
   `http.requestJson(method, path, schema, { query, body })` (or `requestVoid` when the
   response body is irrelevant — mark-failed, file deletes).
3. Add a fixture + a test (see below).

`eventType` on history records stays a plain string in response schemas; the full per-kind
enums (`SONARR_HISTORY_EVENT_TYPES` etc.) live in each kind's schema and the response field
is `z.enum(...).catch('unknown')` — an unrecognized upstream eventType degrades to
`'unknown'` rather than throwing, so a new *arr event type never breaks sync. Normalization
to ledger event types is the domain's job (D-07), not this package's.

## API-key invariant

The key is sent **exclusively** in the `X-Api-Key` header (`http.ts`). It is never placed
in a URL, query string, or error message. All four typed errors (`errors.ts`) interpolate
only method + URL + status/snippet, and `ArrConfigError` names missing env variables but
never their values. Do not break this: no `apikey=` query params, no logging the key.

Retries: `request()` retries **GETs only** (idempotent), up to 2 retries / 3 attempts, on
502/503/504, timeouts, and network errors. Writes (POST/PUT/DELETE) are attempted exactly
once — a failed write never silently repeats. Per-attempt timeout defaults to 30s and
aborts via `AbortController` into an `ArrTimeoutError`.

Error taxonomy (all extend `ArrError`): `ArrConfigError` (missing env), `ArrHttpError`
(non-2xx), `ArrTimeoutError` (aborted), `ArrParseError` (2xx body failed its zod schema =
upstream drift).

## The integer-eventType footgun (fix/history-eventtype-enum)

The paged `GET /history` endpoint binds its `eventType` **query param** to the *integer*
value of the kind's history enum. The lowercase string the same endpoint *returns* in
responses (`"grabbed"`) is rejected there with HTTP 400
(`"The value 'grabbed' is not valid."`). This shipped as a prod bug once (CI green, live
400) — hence the regression guard in `read-clients.test.ts`.

- `SONARR_GRABBED_EVENT_TYPE` / `LIDARR_GRABBED_EVENT_TYPE` are derived as
  `EVENT_TYPES.indexOf('grabbed')` (= `1`) against **order-sensitive** enum arrays copied
  verbatim from the upstream `EpisodeHistoryEventType` / `EntityHistoryEventType`. **Never
  reorder those arrays** — the integer index IS the wire value. `getEpisodeGrabHistory` /
  `getAlbumGrabHistory` send the integer.
- Radarr's per-movie endpoint is different: `GET /history/movie?movieId=&eventType=grabbed`
  is **string-tolerant** and returns a plain array (not a paged envelope), so
  `getMovieGrabHistory` sends the string `'grabbed'`.
- **Latent risk:** `getHistorySince(date, eventType?)` on all three clients forwards
  `eventType` to `GET /history/since` as a **raw string**, and no test passes one. Sync
  calls it without `eventType`, so it is currently unexercised. If `/history/since` shares
  the paged endpoint's integer binding, passing a string eventType there will 400 — treat
  it the same way (send the integer) before relying on that argument.

## Offline fixtures

Tests never touch a network. Fixtures in `__fixtures__/kind.slug.json` are **sanitized
recordings of the 2026-07-03 live GET probes** (`__tests__/helpers.ts` header;
`downloadUrl` apikeys REDACTED, Seerr emails rewritten to `@example.test`). Naming is
`{sonarr|radarr|lidarr|seerr}.{endpoint-slug}.json`.

Recipe to add one:

1. Probe the live instance read-only via its LAN ingress (`https://sonarr.haynesops.com`,
   etc. — dev-only URLs, never shown to users, hard rule 3), sanitize secrets/PII, save as
   `__fixtures__/kind.slug.json`.
2. In the test, map it with the route-table stub: `stubFetch([{ path: '/api/v3/...', body:
   fixture('sonarr.slug') }])` and pass `stub.fetchImpl` as the client's `fetchImpl`
   (route `path` is an exact pathname or a RegExp; `method` defaults to GET). `calls`
   records every request for method/path/query/header assertions. Other stubs:
   `stubFetchSequence` (retry tests), `stubFetchHanging` (timeout tests). `TEST_OPTS`
   supplies `apiKey: 'test-api-key'` + `retryDelayMs: 0`.
3. Assert the strip: the parsed object must NOT carry fields outside the D-02 subset.

The **e2e stub *arr** (used by `apps/web` Playwright, not these unit fixtures) is **strict
about the integer eventType** — it mirrors the real 400 on a string `eventType`, matching
the `strictHistoryFetch` guard in `read-clients.test.ts`. New paged-history call sites must
send the integer or they will fail e2e.

## Config

`assertArrEnv(env)` reads `SONARR_URL`/`SONARR_API_KEY` (+ `RADARR_`/`LIDARR_`/`SEERR_`).
URLs are non-secret and default to in-cluster service DNS
(`ARR_CLUSTER_URL_DEFAULTS`); local dev overrides with the LAN ingresses. API keys are
**required** (no default) and secret — a single `ArrConfigError` names every absent
variable. `arrReadClientsFromEnv` builds all four clients; `arrWriteClientsFromEnv` builds
three (Seerr is read-only — no write client).
