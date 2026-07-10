# ADR-044: AI usage metrics — Open WebUI admin-API ingestion + level-gated attribution

- **Status:** Accepted
- **Date:** 2026-07-10
- **Deciders:** Tom Haynes

## Context and problem statement

PLAN-021's owner ruling adds an **AI usage metrics** surface distinct from PLAN-019's hardware/perf
metrics: a usage view where **general users see aggregate-over-time counts** (# chats, # image
generations) and **admins see the backend detail** (who used it, how long, for what model). The data
lives in Open WebUI (OWUI), the self-hosted chat front end at `ai.haynesnetwork.com`: its store carries
`chat` rows (`user_id`, `created_at`, the model + messages blob, image outputs as files), `user`, and
`group` tables.

How should this app get that data, and how should it be surfaced so a non-admin never sees who used AI?

## Decision drivers

- **CLAUDE.md rule 4 discipline** — the *arrs are the source of truth and the app syncs a copy; the same
  "external system of record, we mirror + attribute" pattern should govern a new external source.
- **User-aware-metrics gating rule** (ADR-037 / PLAN-017) — a `limited` metrics caller must never receive
  user-identifying data; the seam is server-authoritative, not client-hidden.
- **No live cross-DB reads** — the app must not couple its request path to OWUI's private database; OWUI's
  schema is not ours to depend on and its DB is not exposed.
- **Read-only against OWUI** — usage metrics must never mutate Open WebUI.
- **Reuse the existing metrics machinery** — the Metrics section, the full|limited level model, the
  sync-mode + CronJob shape, and the single-writer/guard discipline already exist.

## Considered options

1. **Live read of OWUI's Postgres/SQLite from the request path.** Rejected: couples us to OWUI's private
   schema, adds a cross-DB dependency to every page load, and OWUI's default store is a pod-local SQLite
   (`/app/backend/data/webui.db`) not reachable as a service.
2. **Scrape a Prometheus exporter for OWUI usage.** Rejected: no exporter emits per-user/per-model chat
   counts; the hardware/perf Prometheus (PLAN-019) is the wrong grain and carries no attribution.
3. **Poll OWUI's ADMIN API with the api-key, sync into an app-owned mirror table, surface level-gated
   (the *arr-ledger precedent).** Chosen.

## Decision outcome

Chosen option: **poll the Open WebUI admin API and sync into an app-owned mirror**, surfaced as a new
**AI sub-tab on the Metrics section** whose payload is shaped by the caller's metrics level.

- **C-01 (source = OWUI admin API, synced into a mirror).** A new `@hnet/sync` mode `ai-usage-sync`
  (mirroring the `smart-alerts`/`notify-outbox` CronJob shape) polls OWUI's admin API with
  `OPENWEBUI_API_KEY`: `GET /api/v1/chats/all/db` (every chat with its blob) and `GET /api/v1/users/`
  (id → name/email/role). It UPSERTS one row per chat into a new app table `ai_usage_chats` (migration
  0035) via the `@hnet/domain` `syncAiUsage` single-writer. This is the *arr-ledger pattern: OWUI is the
  system of record, the app holds a re-syncable copy plus the aggregates the sub-tab needs. Verified
  against the running instance (OWUI 0.7.2): both endpoints answer 200 to the api-key bearer and return
  the shapes above; `created_at`/`updated_at` are epoch seconds.
- **C-02 (image-generation heuristic).** An image generation is an **assistant-role message** whose
  `files[]` carries an entry of `type === 'image'` (url `/api/v1/files/{id}/content`). We count one per
  such entry. Only assistant-role files are counted, so a user IMAGE UPLOAD (which attaches to a
  user-role message) is never miscounted as a generation. Verified on the live instance: 27/27 observed
  image file entries were on assistant messages. The heuristic lives in the `@hnet/sync` OWUI normalizer
  (it knows OWUI's wire shape); the raw bytes are never copied — only the count.
- **C-03 (level-gated attribution — the seam).** `metrics.aiUsage` is gated by the Metrics section
  visibility and SHAPED by the caller's level (mirrors ADR-037 C-03): `limited` returns aggregate counts
  (# chats, # image generations, # messages) + the per-day trend ONLY; `full`/admin ADDS the per-model
  ("for what") and per-user ("who / how long") breakdown, and the distinct-active-user count. The
  identity columns (`owui_user_id`/`user_name`/`user_email`/`user_role`/`title`) are NEVER selected into a
  `limited` payload — the read model branches internally, so a member response structurally cannot carry a
  user id. Unit- and tRPC-tested (`packages/domain/__tests__/ai-usage.test.ts`,
  `packages/api/__tests__/metrics.test.ts`).
- **C-04 (read-only against OWUI).** The OWUI client only GETs; it never mutates Open WebUI. The sync mode
  writes ONLY the app's own `ai_usage_chats` mirror.
- **C-05 (single-writer + no-audit exemption).** `ai_usage_chats` is a rebuildable read-model (the
  ADR-035 `trash_candidates` / ADR-040 `smart_drive_state` class): the data of record lives in OWUI, so
  `syncAiUsage` — the sole writer, on the no-direct-state-writes guard list — appends no ledger/audit row.
  Like the other alert/mirror modes, `ai-usage-sync` writes NO `sync_runs` row (the mirror IS its trail);
  it joins `SYNC_RUN_KINDS` for CLI `--mode` parity only.
- **C-06 (admin-only by default; graceful degrade).** The Metrics section ships Admin-only (ADR-021); the
  owner opens the AI sub-tab to a role via `/admin/roles` like the other tabs. If OWUI can't supply a
  field, the sync degrades (a users-endpoint failure leaves attribution unresolved that cycle; chats
  still sync) rather than blocking. No Grafana deep-link is added here; if one ever is, it is admin-only
  per DESIGN-016 D-07.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: no live cross-DB coupling; the request path reads only the app's own mirror; OWUI is polled on a bounded CronJob cadence like the other sync modes. |
| C-02 | Good: image generations counted reliably from the assistant-file marker; user uploads never inflate the count. Bad: a future OWUI version that records generations differently would need the heuristic revisited (documented + unit-pinned). |
| C-03 | Good: the "no user identity for general users" ruling is enforced server-side, provably; the seam mirrors the other metrics tabs. |
| C-05 | Good: reuses the guard + single-writer discipline; no new audit surface. Bad: the mirror can lag OWUI by up to one sync tick (a `synced_at` freshness footnote sets expectations). |
| C-06 | Good: `OPENWEBUI_API_KEY` must be added to the haynesnetwork ExternalSecret (targeted fetch from the 1Password `openwebui` item) — an additive, surgical secret change. |

## More information

- Satisfies PRD-001 **R-141**, **R-142**, **R-143** (AI usage surface; aggregate-for-all;
  admin-only attribution).
- Design: **DESIGN-022** (the AI sub-tab + the `ai_usage_chats` mirror + the sync mode).
- Migration **0035** (`ai_usage_chats` + the `sync_runs.run_kind` CHECK relax).
- Glossary: **T-126** (AI usage sync), **T-127** (image-generation count), **T-128** (AI usage attribution level).
- Sibling: ADR-037 (Metrics level model), ADR-040 (`smart-alerts` sync mode), ADR-043 (`poster-guard`
  sync mode) — the CronJob + single-writer + no-`sync_runs`-row precedents this ADR follows.
