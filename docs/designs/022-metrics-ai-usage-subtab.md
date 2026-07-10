# DESIGN-022: Metrics → AI usage sub-tab (Open WebUI)

- **Status:** Accepted
- **Last updated:** 2026-07-10
- **Satisfies:** PRD-001 R-141, R-142, R-143; governed by ADR-044 (AI usage ingestion + level-gated
  attribution), ADR-037 (Metrics level model), ADR-015 (reflow-free interaction).

## Overview

A new **AI** sub-tab on the Metrics section surfaces Open WebUI (OWUI) usage. It reuses the
DESIGN-016..020 idioms wholesale (tile/group/table/sparkline, the `?tab=`-driven tablist, the bounded
poll, tokens-only styling). The data comes from an app-owned mirror (`ai_usage_chats`) that the
`ai-usage-sync` sync mode populates from OWUI's admin API — never a live cross-DB read (ADR-044 C-01).

The sub-tab is **level-shaped** (ADR-044 C-03): a `limited` viewer sees aggregate counts + trends only;
a `full`/admin viewer additionally sees the per-model and per-user detail.

## Detailed design

### D-01 — the mirror table (`ai_usage_chats`, migration 0035)

One row per OWUI chat, keyed by the OWUI chat id. Columns: `owui_user_id` + denormalized
`user_name`/`user_email`/`user_role` (admin-only surface), `title`, `models` (jsonb), `primary_model`,
`message_count`, `image_count`, `total_tokens`, `total_duration_ms`, `chat_created_at`,
`chat_updated_at`, `archived`, `synced_at`. Indexed on `chat_created_at` (trend bucketing) and
`owui_user_id` (per-user grouping). A rebuildable read-model (ADR-044 C-05) — the sole writer is the
`@hnet/domain` `syncAiUsage` single-writer; no per-row audit event.

### D-02 — the `ai-usage-sync` mode (@hnet/sync)

Mirrors the `smart-alerts` shape: not a per-source loop, writes no `sync_runs` row, returns an `aiUsage`
report. It polls the read-only OWUI client (`OPENWEBUI_URL` default = the in-cluster service DNS
`http://open-webui.ai.svc.cluster.local`; `OPENWEBUI_API_KEY` required), normalizes each chat, and hands
the snapshot to `syncAiUsage`, which UPSERTS the mirror. A CronJob in the haynesnetwork helmrelease runs
it on a bounded cadence. READ-ONLY against OWUI (ADR-044 C-04).

### D-03 — the OWUI endpoints + image-gen heuristic (ADR-044 C-01/C-02)

- `GET /api/v1/chats/all/db` → every chat: `{ id, user_id, title, created_at, updated_at, archived,
  chat:{ models, messages:[{ role, model?, timestamp, content, files?:[{type,url}], usage? }] } }`.
  `created_at`/`updated_at` are epoch seconds; assistant `usage` carries `total_tokens` +
  `total_duration` (ns).
- `GET /api/v1/users/` → `{ users:[{ id, name, email, role, … }] }` (a bare array is tolerated).
- **Image generation** = an assistant-role message file of `type === 'image'`. Only assistant files
  count, so user uploads (user-role files) never inflate the number. `total_duration_ms` = summed
  assistant `usage.total_duration` (ns → ms) — the "how long" grain.

### D-04 — the tRPC payload (`metrics.aiUsage`, level-gated)

Gated by the Metrics section visibility (`metricsProcedure`); input `{ range?: '7d'|'30d'|'90d'|'all' }`
(default `30d`). Shaped by `effectiveMetricsLevel`:

- **`limited`** → `{ level, range, since, syncedAt, totals:{ chats, imageGenerations, messages,
  activeUsers: null }, series:[{ day, chats, imageGenerations }] }`. NO `byModel`/`byUser` keys;
  `activeUsers` is null (no identity).
- **`full`/admin** → the same PLUS `byModel:[{ model, chats, imageGenerations, messages }]` and
  `byUser:[{ userId, name, email, role, chats, imageGenerations, messages, totalDurationMs, models,
  lastActivityAt }]`, and a populated `totals.activeUsers`. The per-user/model queries are issued ONLY on
  the full branch (`getAiUsage` returns early for limited) — the identity columns are never read into a
  limited response.

### D-05 — the UI (`apps/web/app/(app)/metrics/ai-tab.tsx`)

- A segmented **range control** (`7d / 30d / 90d / All time`) — `role="group"`, `aria-pressed`; the
  pressed button recolors, never relayouts (ADR-015). New CSS `.metrics-range*` (tokens only, no hex).
- **Stat tiles**: Chats, Image generations, Messages (both levels); Active users (full only — the tile is
  simply absent at limited because `activeUsers` is null).
- **Sparklines**: chats-per-day + image-generations-per-day (the fixed-geometry `metrics-spark` box,
  reused from DESIGN-019; only the polyline path changes on refresh).
- **Full-only tables**: "By model" and "By user" (the `metrics-apps-table` idiom). At limited, the By-user
  table is replaced by a muted note ("Per-user detail … is available to admins.").
- A `synced_at` freshness footnote. Bounded 60s poll, paused when the tab is hidden/inactive; dims in
  place via `placeholderData`.

## Alternatives considered

Per-message-grain rows (finer, but chat-message arrays are edited/regenerated in OWUI, making idempotent
incremental sync fragile) vs the chosen per-chat upsert (stable natural key, trivially idempotent). A
daily-rollup table (loses the per-user/per-model detail the admin view needs). Both rejected; the
per-chat mirror carries enough for both the aggregate trend and the admin attribution.

## Test strategy

- **Unit (domain)** — `syncAiUsage` upsert idempotency + attribution; `getAiUsage` level seam
  (limited omits `byUser`/`byModel`/`activeUsers`; full includes) + range windowing.
- **Unit (sync)** — the OWUI normalizer: the image-gen heuristic (assistant-only), ns→ms duration, model
  union/primary, tolerant users-endpoint shape, best-effort user degrade, api-key config error.
- **tRPC** — `metrics.aiUsage` returns full detail to an admin, aggregate-only to a limited member, and
  FORBIDDEN when the section is disabled (`packages/api/__tests__/metrics.test.ts`).
- **Migration** — `ai_usage_chats` columns/indexes + the `sync_runs.run_kind` CHECK relax.
- **e2e** — a stub OWUI usage API (mirrors the *arr stubs) + the `ai-usage-sync` seed; the AI tab renders
  real counts; screenshots at desktop + 390px (admin + member personas).

## Open questions

| ID | Question | Resolution |
|----|----------|------------|
| Q-01 | Should the model breakdown be visible at `limited`? | No — the owner framed "for what (model)" as the admin detail; `limited` is counts + trend only (ADR-044 C-03). |
| Q-02 | Grafana deep-link on the AI tab? | Not added; N/A here. If ever added, admin-only per DESIGN-016 D-07. |
