# DESIGN-027: MAM compliance governor

- **Status:** Accepted
- **Last updated:** 2026-07-23 (D-09 — resume hysteresis)
- **Satisfies:** PRD-001 R-172..R-177 + R-234 (flap-free gating); governed by ADR-054 (seam) + **ADR-077
  (resume hysteresis, supersedes ADR-054 C-05)** + ADR-034 (outbox) + ADR-040 (sync-mode precedent) + ADR-008
  (confined external write surface).

## Overview

A standalone `@hnet/sync` **`mam-governor`** mode (a ~15-min CronJob) keeps automated MAM grabs under the
account's unsatisfied-torrent cap. Each run it:

1. **Counts unsatisfied LOCALLY** from qBittorrent (category `books-mam`): still-downloading torrents PLUS
   complete-but-`seeding_time < 72h` torrents. No MAM call; no qB credential (the WebAPI answers
   unauthenticated cross-namespace).
2. **Decides the gate** — pause when `unsatisfied ≥ limit − buffer`, resume when it drops below. Fail-closed:
   a failed count ⇒ paused.
3. **Actuates the gate** at the **MyAnonaMouse Prowlarr indexer** (`enable` flag; a GET-then-PUT changing only
   `enable`). Prowlarr's LazyLibrarian fullSync application propagates the flag to LL, so LL stops/starts
   querying MAM — no LL Torznab errors, no blocklist (ADR-054).
4. **Records + notifies** — upserts the single-row `mam_gate_state` and, on a gate transition or a >48h
   zero-headroom episode, enqueues a `notification_outbox` row in the SAME transaction (ADR-034 C-01). First
   sight records a baseline and pages nothing.

## Detailed design

### D-01 — packages & confinement

New package **`@hnet/downloads`** (mirrors `@hnet/arr`'s read/write split):

- `@hnet/downloads` — `assertGovernorClientsEnv`, errors, `computeUnsatisfied` + `MAM_SEED_OBLIGATION_SECONDS`
  (safe everywhere).
- `@hnet/downloads/read` — `QbittorrentClient` (count) + `ProwlarrReadClient` (`GET /api/v1/indexer/{id}` →
  `enable`). Read-only, safe everywhere.
- `@hnet/downloads/write` — `ProwlarrWriteClient` (the `enable` toggle). **Import-confined to
  `packages/domain`** by the extended `arr-write-import-guard` test (regex now `@hnet/(arr|plex|authentik|
  openwebui|downloads)/write`).

The domain factory `mamGovernorBundleFromEnv` (in `packages/domain/src/mam-clients.ts`) is the only
constructor of the write client; the sync mode receives an opaque bundle (like `plexClientBundleFromEnv`).

### D-02 — the count (compliance-critical, conservative — Q-01)

`computeUnsatisfied(torrents)` folds `GET /api/v2/torrents/info?category=books-mam`:

- `complete = progress >= 1`; a not-complete torrent is `downloading`.
- a complete torrent with `seeding_time < 72h` (`MAM_SEED_OBLIGATION_SECONDS = 259_200`) is `seedingUnder72`.
- `unsatisfied = downloading + seedingUnder72` (= NOT(complete AND seeded ≥ 72h)).

A missing/garbage `progress`/`seeding_time` defaults to the conservative (unsatisfied) side, so a wire hiccup
can only OVER-count (close the gate earlier), never under-count. Using qB `seeding_time` (accumulated active
seed time) is conservative vs wall-clock-since-completion and is the direct proxy for "have I met the 72h seed
obligation yet". The live 2026-07-11 snapshot (13 complete, all `seeding_time` well under 72h) ⇒ 13 unsatisfied
is the acceptance fixture.

### D-03 — the gate decision (pure)

- `threshold = limit − buffer`. **Pause** when `unsatisfied ≥ threshold`; **resume** below the RESUME FLOOR,
  not the threshold — see **D-09** (ADR-077). `desiredOpen` now depends on the current gate state so the dead
  band can hold.
- Defaults: `limit 20` (New Member), `buffer 5` (⇒ pause at 15), `resumeFloor 10` (derived; D-09),
  `zeroHeadroomAlertHours 48`.
- The **buffer** reserves slots below the hard `limit` for grabs already past Prowlarr's search when we pause
  (ADR-054 C-05, superseded by ADR-077 C-01 — the buffer keeps this role, the resume floor adds a second
  margin). `buffer` is clamped `< limit`.

### D-04 — actuation & the recorded state (`appliedOpen`)

The evaluator READS the indexer's current `enable`, then actuates toward `desiredOpen` **idempotently**:
actuate when the known state differs, OR when the state is UNKNOWN (read failed) and we want it CLOSED
(fail-closed; never blindly ENABLE on an unknown). The gate state RECORDED (`appliedOpen`) reflects what the
indexer ACTUALLY is after the run — so a transition is only ever recorded/paged when the provider truly
changed (an actuation failure records the last-known state and pages nothing). The LL propagation is a
side-effect of the Prowlarr write; the governor's contract is the Prowlarr `enable` flag.

### D-05 — transitions, stuck alert, same-tx (ADR-034 C-01)

- Transition: `prev.gateOpen !== appliedOpen` ⇒ `mam_gate_resumed` (→open) or `mam_gate_paused` (→closed).
  `prev` undefined (first run) ⇒ baseline, no page.
- Stuck: `zeroHeadroomSince` starts when `headroom (= limit − unsatisfied)` first hits 0, clears when headroom
  returns; `mam_gate_stuck` fires once per episode after `zeroHeadroomAlertHours` (deduped by
  `pinned_alerted_at`). A failed count carries the timer untouched.
- The outbox enqueue(s) and the `mam_gate_state` upsert commit in ONE transaction (`inTransaction`) — proven
  BOTH directions in `mam-governor.test.ts` (transition ⇒ exactly one row + flipped state together; no
  transition ⇒ zero rows, state still refreshed).

### D-06 — schema (migration 0041)

Single-row table `mam_gate_state` (id sentinel `'mam'`, CHECK-pinned): `gate_open`, `count_ok`,
`unsatisfied_count`/`downloading_count`/`seeding_under72_count`, `limit_value`/`buffer_value`/`threshold`/
`headroom`, `zero_headroom_since`, `pinned_alerted_at`, `last_event_type`, `updated_at`. Guarded single-writer
(`no-direct-state-writes` INSERT+UPDATE forms). Two CHECK relaxes: `sync_runs.run_kind += mam-governor`;
`notification_outbox.event_type += mam_gate_paused|mam_gate_resumed|mam_gate_stuck`.

### D-07 — config seam (PLAN-040) & env

`resolveGovernorConfig()` is the single tuning seam (ADR-054 C-07): env-backed in v1 (`MAM_UNSATISFIED_LIMIT`
20, `MAM_UNSATISFIED_BUFFER` 5, `MAM_ZERO_HEADROOM_ALERT_HOURS` 48), called once per run; PLAN-040 adds a
DB-backed audited override behind the same async call. Client env: `PROWLARR_API_KEY` (required; the only
secret — from `media-stack`), `PROWLARR_URL`/`PROWLARR_MAM_INDEXER_ID` (17), `QBITTORRENT_URL`/
`QBITTORRENT_MAM_CATEGORY` (`books-mam`) — all with in-cluster defaults.

### D-08 — Pushover copy (v1: logs + Pushover only — Q-03)

`renderOutboxMessage` gains three cases; NO url (v1 has no in-app surface and the operator UIs are LAN-only,
so a phone-push link would be dead):

- `mam_gate_paused` — "MAM grabs paused" (threshold or fail-closed reason; "usenet keeps flowing; auto-resumes
  as torrents pass 72h").
- `mam_gate_resumed` — "MAM grabs resumed" (headroom returned).
- `mam_gate_stuck` — "MAM cap pinned for 48h+" (demand exceeds the ~limit-per-72h throughput; prioritise the
  wanted list / rank bump).

### D-09 — resume hysteresis: a distinct resume floor + dead band (ADR-077)

**Motivation (the 2026-07-23 incident).** With one shared threshold, pause and resume happen at the same
level, so a CLOSED gate reopens the instant the count dips one below the threshold. On 2026-07-22/23 (UTC) the
live Elite-VIP gate (`limit 200`, `buffer 15` ⇒ threshold 185) sat at 185 for four hours, dipped to 184 at
23:49, reopened, and LazyLibrarian's queued backlog fired ~100 MAM searches in four minutes — unsatisfied
jumped 184 → 199 inside ONE 15-minute sample, crossing MAM's hard 200 cap at 23:59:08 and earning a ~26h
download block. Loki shows this flap 15 times in three days. Two gaps: no resume hysteresis, and a 15-minute
sample cannot see an intra-interval burst that eats the whole 15-count buffer between two samples. Full
write-up: [`.agents/context/2026-07-23-mam-gate-violation-audit.md`](../../.agents/context/2026-07-23-mam-gate-violation-audit.md).

**The rule (two levels + a dead band).** `computeDesiredGate` now takes the current recorded gate state and
returns `{ desiredOpen, threshold, resumeFloor }`:

| Prior gate | Condition | Result |
|---|---|---|
| any | `!countOk` | **closed** (fail-closed, unchanged) |
| OPEN | `unsatisfied ≥ threshold` | **close** (pause) |
| OPEN | `unsatisfied < threshold` | **hold OPEN** (incl. the whole dead band) |
| CLOSED | `unsatisfied < resumeFloor` | **open** (resume) |
| CLOSED | `unsatisfied ≥ resumeFloor` | **hold CLOSED** (incl. the whole dead band) |

The **dead band** is `resumeFloor ≤ unsatisfied < threshold`: the gate holds whatever it was, so a resume can
never happen at threshold−1. First sight (no state row) is treated as **CLOSED** (conservative — reopening
then requires `< resumeFloor`); the first-run baseline still pages nothing (D-05).

**Default derivation + validation.** `resumeFloor` defaults to `limit − 2×buffer`, clamped to
`0 ≤ floor < threshold` (`deriveResumeFloor`). Observed reopen bursts add +15..+17 unsatisfied per interval,
so the floor sits one full burst below the pause threshold: for 200/15 → **170** (a reopen burst peaks around
185–187, under the hard 200 cap, and the next sample re-closes); for the code default 20/5 → **10**. An env
override `MAM_RESUME_FLOOR` (an ABSOLUTE unsatisfied count) is honored only when `0 ≤ floor < threshold`;
anything else (out of range, negative, unparseable) falls back to the derived default and logs one warning.
It resolves through the same `resolveGovernorConfig` seam (D-07) — no schema change: the floor is recoverable
from the persisted `limit`/`buffer` (or the override), so `mam_gate_state` gains no column. `resumeFloor` is
added to the report, the outbox payload, and the per-run structured CronJob log line (next to
`limit`/`buffer`/`threshold`).

## Alternatives considered

- **LL-side provider toggle** — rejected: Prowlarr's LL fullSync application clobbers it (not durable);
  ADR-054 (a).
- **Counting via a MAM endpoint** — rejected: violates the zero-MAM-API-surface compliance invariant.
- **A dedicated in-app governor view for v1** — deferred (Q-03): logs + Pushover only; a Metrics tile is a
  later nicety (a natural PLAN-040 companion).

## Test strategy

- `@hnet/downloads`: pure `computeUnsatisfied`; fetch-stub `QbittorrentClient` (incl. the live 13-torrent
  fixture, non-2xx → throws → fail-closed), `ProwlarrReadClient`, `ProwlarrWriteClient` (GET-then-PUT
  preserves other fields; phantom-success guard; empty-echo tolerance); env contract.
- `@hnet/domain` (`mam-governor.test.ts`, embedded Postgres 16): pure gate + stuck decisions; open baseline
  below the floor (no page); threshold-cross ⇒ one `mam_gate_paused` same-tx (+ repeat ⇒ zero); resume;
  fail-closed (count throws) with `count_failed`; NO page on actuation failure; `mam_gate_stuck` once after
  48h. **D-09 hysteresis:** the incident regression (CLOSED at 184, threshold 185/floor 170 ⇒ stays closed,
  no `mam_gate_resumed`); reopen only below the floor (169 < 170); OPEN holds through the dead band and
  pauses at 185; dead-band hold across consecutive runs both directions (no event spam); floor derivation +
  `MAM_RESUME_FLOOR` override + invalid-value fallback; first-sight-treated-as-CLOSED.
- `@hnet/db` migrations: table + singleton CHECK + both CHECK-relax preservations.
- Guards: `arr-write-import-guard` (downloads/write domain-only); `no-direct-state-writes` (mam_gate_state).

## Open questions

| ID | Question | Resolution |
|----|----------|------------|
| Q-01 | Buffer size + do complete-but-<72h torrents count? | Buffer default 5; yes, count them AND still-downloading (conservative — owner ruling). |
| Q-02 | Prowlarr-indexer vs LL-provider seam? | Prowlarr indexer `enable` — the LL seam is not durable (Prowlarr fullSync clobbers it); ADR-054. |
| Q-03 | Surface governor state in-app for v1? | No — logs + Pushover only; Metrics tile deferred (a PLAN-040 companion). |
| Q-04 | Where do limit/buffer live long-term? | Behind `resolveGovernorConfig()` (env now); PLAN-040 makes them an audited DB `app_setting`. |
