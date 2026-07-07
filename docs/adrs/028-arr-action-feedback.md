# ADR-028: Live downstream *arr action feedback via on-demand queue polling

- **Status:** Accepted
- **Date:** 2026-07-07
- **Deciders:** Tom Haynes (owner backlog 2026-07-07) · authored + ratified by Fable 5
- **Builds on:** [ADR-007](007-fix-semantics.md) (the Fix flow), [ADR-008](008-media-ledger-and-sync.md)
  (the *arr → app sync + Force Search), and DESIGN-005 D-12/D-18 (the `@hnet/arr/write` import
  confinement — untouched here).

## Context and problem statement

A user who clicks **Fix** or **Force Search** triggers real downstream *arr behavior (blocklist +
re-grab, or a search command) but today gets a **static** end-state and nothing more: the dialog says
"a search is running… it completes when the new copy imports" and stops. Nobody sees that a download
is 40% done, that nothing was found, or that the request stalled. The owner's requirement (verbatim
essence): *"Users must never click a button that triggers downstream *arr behavior and then not know
if anything happened or how long to wait."* Every user-triggered *arr action must report status back
— a wire-ack it landed ("searching"), download progress (queued → downloading% → importing →
complete), and a **terminal** for the empty/failed/stalled cases (never a stuck state) — surfaced
beside the button, in the shared item History, and in My Fixes, cascading to every child a roll-up
touched.

The coarse lifecycle already exists (`fix_requests.status`: pending → actioned → search_triggered →
completed | failed; `completeFixRequests` matches the replacement import on the next sync). The
**missing layer** is everything between `search_triggered` and `completed`: the live grab + download
progress, the "searching…" ack, the found-nothing terminal, and the staleness timeout.

## Decision drivers

- **Smallest blast radius.** We deliberately expose limited *arr functions; the feedback must add no
  new write surface, no always-on infra, and no fossilized state.
- **Never-stuck.** Every action must reach a terminal the user can see, even when the *arr is quiet.
- **The *arrs are the source of truth** (hard rule 4). Progress is a projection over their live queue
  + the milestones the sync cron already ingests — not a new authority.
- **Read-only.** Nothing about surfacing status should mutate an *arr or the ledger.

## Considered options

1. **Derived phases from an on-demand, read-only queue poll (chosen).** A tRPC *query* live-reads the
   owning *arr's download queue when the client asks; the browser polls only while a progress surface
   is mounted and the phase is non-terminal. Phases are computed, never stored.
2. **Persist a richer phase enum.** Grow `FIX_STATUSES` (or `LEDGER_EVENT_TYPES`) to nine phases + a
   migration + a writer that flips them. Rejected: fossilizes inherently transient, per-poll state and
   multiplies the write surface for no durable gain.
3. **A server-side background poller** (cron/`setInterval`/webhook/SSE) reconciling progress for
   everyone. Rejected for v1: new always-on infra + a push surface the owner did not ask for; the
   authoritative milestones already arrive via the sync cron, so History stays correct unwatched.

## Decision

- **Source of truth for live progress = the *arrs' download queue, read-only.** `GET /api/v3/queue`
  (Sonarr, Radarr) / `GET /api/v1/queue` (Lidarr), server-side filtered by the parent id
  (`seriesIds` / `movieIds` / `artistIds` — **verified live 2026-07-07**), joined to the target by
  `episodeId` (sonarr) / `movieId` (radarr) / `albumId` (lidarr). The consumed subset
  (`size`,`sizeleft`,`status`,`trackedDownloadStatus`,`trackedDownloadState`,`estimatedCompletionTime`,
  `errorMessage`,`statusMessages`, ids) is zod-schema'd behind the BC-03 ACL. Queue reads live on the
  **read** side of the bundle — the D-12/D-18 `@hnet/arr/write` confinement is untouched.
- **Phases are DERIVED, not stored (no migration).** `FIX_STATUSES` / `LEDGER_EVENT_TYPES` are
  **unchanged**. The Action Progress Phase `{ queued | searching | grabbed | downloading | importing |
  completed | nothing_found | stalled | failed }` is computed on demand from `(fix_requests.status |
  the latest search_requested event) + the live queue + the sync-ingested ledger milestones
  (grabbed/imported/download_failed)`. `computeFixProgress` / `computeSearchProgress`
  (`packages/domain/src/action-progress.ts`) are the pure projectors.
- **Poll-on-demand, client-driven; NO server-side poller in v1.** A tRPC **query** (`fix.progress`,
  `fix.searchProgress`) live-reads when the client asks; the browser polls (`refetchInterval`) only
  while the surface is mounted and the phase is non-terminal. No cron, no `setInterval`, no
  webhook/SSE. The authoritative milestones (`grabbed`/`imported`/`download_failed`) still flow into
  `ledger_events` via the sync cron, so History stays correct even when nobody is watching.
- **Wire-ack = the mutation's own resolution.** `runFixRequest` returns `search_triggered` and
  `runForceSearch` returns the accepted `commandName` only **after** the *arr accepts the command —
  that resolution IS the proof the request crossed the wire, so the UI enters `searching` the instant
  the mutation succeeds.
- **Never-stuck via two windows (constants, not settings v1).** (a) **Found-nothing window = 15 min:**
  no grab and no queue record within it after a search → `searching`, then the terminal
  `nothing_found`. (b) **Stalled threshold = 45 min**, or **immediate on `trackedDownloadStatus:'error'`**
  (and on `importBlocked`/`importFailed`, which need manual attention) → `stalled`, with a retry
  affordance (re-issue the same Fix/Force-Search). A *download_failed* ledger event with an empty queue
  → `failed`.
- **Roll-up cascade (least-advanced headline).** A season / artist action reports **per-child** phases
  (queue records keyed by the run's episode/album ids via `listMediaChildren`); the headline is the
  **least-advanced non-terminal** child (all-terminal → `completed` if any imported, else `stalled`,
  else `nothing_found`).
- **"No mashing" is already enforced server-side; v1 only surfaces it.** `FixAlreadyOpenError` blocks a
  second open Fix; the UX follow-up renders the in-flight chip + disables Fix while an open fix targets
  that child. Force Search stays lock-free (progress derives from the latest `search_requested` event;
  its in-flight button state is driven by the phase).
- **Projection vs. authority.** The derived `completed` may lead the durable row: the projection reads
  a matching import live, before `completeFixRequests` flips `fix_requests.status` on the next sync. The
  cron matcher remains the durable writer; the derived phase is a view. `computeFixProgress` treats the
  row's own terminals (`completed`/`failed`) as authority when set.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: the owner's status-back-up contract is met with **no** new write surface, **no** fossilized enum, **no** migration, and **no** always-on infra — a purely read-only, additive projection. |
| C-02 | Good: exactly **one** live *arr read per poll (the queue); every other input is a cheap `ledger_events` read of milestones the sync already ingests, so History stays correct unwatched. |
| C-03 | Bad: the queue is a new upstream read dependency + one more failure surface. Mapped via the existing `guardArrCall` → `ArrUpstreamError` (BAD_GATEWAY): a queue read failure surfaces as a transient "couldn't reach the manager", **never a false terminal**, and never mutates state. |
| C-04 | Bad: in v1 the found-nothing/stalled terminals are only *observed* when someone polls — an unwatched Force Search's `nothing_found` isn't persisted until a background poller exists (explicitly future). The durable milestones (grab/import/fail) are unaffected. |
| C-05 | Neutral: derived phases mean the live phase and `fix_requests.status` can momentarily disagree (`completed` derives from a matching import before the cron flip). Documented as a projection; the row remains the durable record. |
| C-06 | Neutral: the windows (15 min / 45 min) are documented constants, not settings, in v1. If music indexers prove slower, they graduate to the `app_settings` store (ADR-025 C-06) without a schema change. |

## More information

- Requirements: PRD-001 **R-106/R-107** (+ the 2026-07-07 note under R-43/R-46/R-47).
- Design: DESIGN-005 **D-20** (the progress model + queue client + projectors + poll contract) and
  **D-21** (the roll-up cascade + the UI feedback states for the Fable UX follow-up), + the Queue row
  on the D-03 endpoint inventory.
- Glossary: DDD-001 **T-90** Action Progress Phase, **T-91** Download Queue, **T-92**
  Found-Nothing / Stalled, **T-93** Action Feedback.
- Plan: `.agents/plans/015-arr-action-feedback.md`. The progress **UI** (chips/bars on Fix +
  Force-Search, live My Fixes phases, the roll-up child display) is a separate Fable UX follow-up;
  this ADR + DESIGN-005 D-20 define the wire contract it consumes.
