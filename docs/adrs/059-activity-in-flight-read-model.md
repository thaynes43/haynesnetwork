# ADR-059: Activity / In-Flight — live poll-through read + a thin persisted failure ledger

- **Status:** Accepted
- **Date:** 2026-07-14
- **Deciders:** Tom Haynes (PLAN-048 owner rulings R1–R3, 2026-07-14 morning)
- **Builds on:** ADR-035 (the `trash_candidates` synced read-model), ADR-034/DESIGN-015 (the
  transactional notification outbox), ADR-054 (the MAM governor's single-writer + same-tx outbox
  transition idiom), ADR-019/ADR-041 (the in-process poster LRU — "live-with-short-cache"), ADR-058
  (the shared card system these surfaces are built from), ADR-055/ADR-056 (the confined LazyLibrarian
  / Kapowarr read+write split), ADR-021/ADR-023 (section levels + the fine-grained action-grant
  machinery). All STAND.

## Context and problem statement

Nothing in the app shows the stage a media item is in **between Wanted and On-shelf**. The motivating
incident (OPS-013 §11 + `.agents/context/2026-07-13-f10-english-audit.md` RUN 4): **42 completed
usenet book downloads sat stranded and invisible** — SAB had completed them at its NFS root, but a
missing SAB category meant LazyLibrarian never imported them, and no surface in the app revealed the
stuck state. The owner ruled (R1) a single cross-library **Activity** sub-tab under Library (the
Trash→Activity idiom) plus **in-flight badges on wall posters**, and (R2) **import failures get an
in-app badge + a detail page with a failure reason and role-controlled actions** (Admin retries /
re-searches / deep-links downstream; everyone else reads).

Two questions the plan left for design:

- **Q-01 — live-poll vs synced read-model** for the queue/import state (latency vs load).
- **Q-02 — the books "importing" signal**: is an LL postprocess hook / dir-watch inference needed, or
  do the LL + SAB APIs suffice?

PLAN-048 is a **fan-out**: this slice (SLICE 1) builds the common read-model contract + the BOOKS
adapter (LL + SAB); later agents add the *arr-queue and Kapowarr adapters onto the SAME contract. So
the read/persist decision must serve *every* source family, not just books.

## Decision drivers

- Queues change **by the second** — a download at 34 % must read 34 %, not a 15-minutes-stale number;
  the stranded-import class must surface within one poll, not one CronJob cadence.
- Each source's queue/history is **one fast call** returning a **small** working set (a handful of
  active items) — cheap to fetch live, unlike Maintainerr's 6–9 s paged crawl that justified
  `trash_candidates`.
- A **failure transition must enqueue the notification outbox** (R2 / the future admin digest) — that
  requires *memory* of the prior state, which a pure live read does not have.
- A **failure needs a durable identity** — a stable id for the detail-page URL and for the audited
  Admin action (retry-import / force-research), and an "acted" marker so the badge can clear.
- Actions are **role-controlled** (R2) and must ride the **existing grant machinery** (ADR-023), not
  a bespoke check.
- Hermetic-only (no live cluster): every client is fetch-injectable; the read path must be stubbable.

## Considered options

**Read/persist model (Q-01):**

1. **Synced read-model** — a CronJob snapshots every source's queue into an `activity_items` table
   (the `trash_candidates` idiom); the tab/badges serve from Postgres.
2. **Pure live poll-through** — the tab/badges call each source adapter live (short in-process cache);
   nothing persists.
3. **Live read + a thin persisted FAILURE ledger** (chosen) — the read surface polls live (fresh
   progress, sub-cadence changes) behind a short in-process cache; a small `activity_import_failures`
   table, written by an `activity-scan` sync mode, records **only failures** for (a) transition →
   outbox enqueue and (b) the durable detail-page identity + action audit.

**Books "importing" signal (Q-02):**

A. **LL postprocess webhook / hook** into the app.
B. **Dir-watch inference** (the app watches the cephfs import dir).
C. **The LL + SAB REST APIs** (chosen): LL's wanted-table statuses (Wanted / Snatched / Open|Have /
   Failed) + SAB queue (downloading %) + history (Completed/Failed).

## Decision outcome

**Q-01 → Option 3 (live read + thin persisted failure ledger).** The Activity tab and the wall
in-flight badges read through per-source adapters **live**, fronted by a short in-process TTL cache
(seconds — the poster-proxy LRU idiom, ADR-019/ADR-041) so a burst of viewers can't hammer the
upstreams. A synced snapshot (Option 1) is **rejected for the read path**: queues change faster than
any CronJob cadence, so a snapshot is either stale (bad progress UX and slow to reveal a strand) or a
wasteful tight loop; `trash_candidates` earned its snapshot because Maintainerr's crawl is slow *and*
its data changes daily — neither is true here. A pure live read (Option 2) is **rejected on its own**
because it has no memory: it cannot detect the failed transition to enqueue the outbox, and it gives a
failure no durable id for the detail page or the audited action. So a **thin persisted failure
ledger** (`activity_import_failures`, migration 0048) is written by an **`activity-scan`** sync mode
(a ~15-min CronJob in `frontend`, the mam-governor sibling) that polls each source, **upserts open
failures**, and — **only on a NEW failure transition** — enqueues one `activity_import_failed`
notification-outbox row **in the same transaction** (ADR-034 C-01 / the `evaluateMamGovernor` idiom).
First sight of a failure records it and (per row) pages once; a failure that clears is closed. The
live read **joins** this ledger so it can mark which in-flight items are actionable failures and carry
their acted-state. Net: **live where it must be live, persisted only where a fact must survive a
request** — the smallest durable footprint that satisfies R2.

**Q-02 → Option C (the LL + SAB APIs).** The books "importing" signal is derived entirely from the two
existing REST surfaces — no LL hook (Option A) and no dir-watch (Option B, which the app can't even do:
it doesn't mount cephfs). The stage machine for a book format:

| Signal | Stage |
|---|---|
| LL wanted row `Wanted` (searching, nothing grabbed) | `searching` |
| LL `Snatched` + SAB **queue** entry (progress p) | `downloading` (progress = p) |
| LL `Snatched` + SAB **history** = Completed, LL not yet `Open` | `importing` (the LL post-process bridge) |
| LL `Open`/`Have` recently flipped | `completed` (recent) |
| LL `Snatched` + SAB Completed **but stale past the import horizon** | `failed` — **`stranded_import`** |
| LL wanted row `Failed` (`DLResult` set) | `failed` — **`postprocess_failed`** |
| SAB history entry `Failed` (par2/dead nzb) | `failed` — **`download_failed`** |

The **`stranded_import`** class is exactly the 42-download incident, surfaced from facts (LL row still
`Snatched`, SAB `nzo_id` Completed) — the same two API reads OPS-013 §11 used to diagnose it live. The
SAB v5 **archived-history caveat** (§11.3 — an aged job needs `&archive=1`) is honored: the SAB
history read requests the archive so a strand doesn't vanish from detection. Dir-watch is rejected as
inference over fact; a webhook is rejected as new coupling the APIs make unnecessary.

### The contract (the typed module later adapters implement)

The normalized shape lives in `@hnet/domain` (`activity/contract.ts`) as pure types + a light adapter
interface; the BOOKS adapter is the first implementation, and the *arr/Kapowarr agents implement the
same `ActivitySourceAdapter` producing `ActivityItem[]`:

```ts
export type ActivityKind = 'movie' | 'tv' | 'music' | 'book' | 'audiobook' | 'comic';
export type ActivitySourceApp =
  | 'radarr' | 'sonarr' | 'lidarr' | 'lazylibrarian' | 'sabnzbd' | 'qbittorrent' | 'kapowarr';
export type ActivityStage = 'searching' | 'downloading' | 'importing' | 'failed' | 'completed';
export type ActivityFailureKind =
  | 'stranded_import' | 'postprocess_failed' | 'download_failed' | 'import_blocked';
export type ActivityAction = 'retry_import' | 'force_research';

export interface ActivityItem {
  /** Stable, adapter-owned id — distinct items never collide (e.g. `books:ll:<bookId>:<format>`). */
  id: string;
  kind: ActivityKind;
  /** The section that gates this item's visibility ('books' for book walls; null = the universal *arr walls). */
  section: 'books' | null;
  /** The Library wall this item belongs to (the wall-badge join key); null when it maps to no single wall. */
  wall: 'movies' | 'tv' | 'music' | 'books' | 'audiobooks' | 'comics' | null;
  title: string;
  year: number | null;
  /** The user-facing app the stage came from. */
  sourceApp: ActivitySourceApp;
  stage: ActivityStage;
  /** 0..100 for `downloading`; null otherwise. */
  progress: number | null;
  /** Human failure reason for `failed`. */
  failureReason: string | null;
  /** The stable failure class the UI + actions switch on. */
  failureKind: ActivityFailureKind | null;
  /** When this stage was last observed (recency sort + staleness). ISO-8601. */
  updatedAt: string;
  /** ADR-058 poster art hints (cover-proxy URL or the KindIcon fallback kind). */
  posterUrl: string | null;
  /** In-app deep link (the failure detail page, or the library item). */
  href: string | null;
  /** The downstream app deep link (LL/SAB/*arr) — Admin-only (R2); null when none. */
  downstreamUrl: string | null;
  /** What an ADMIN may do (R2); [] for non-actionable stages. Gated again server-side per action. */
  actions: ActivityAction[];
}

/** A per-source adapter — the fan-out seam. The *arr + Kapowarr agents implement this same shape. */
export interface ActivitySourceAdapter {
  readonly source: string;
  list(): Promise<ActivityItem[]>;
}
```

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: progress reads are live (fresh %), and a strand surfaces within one poll — the incident is visible, not snapshot-stale. |
| C-02 | Good: the only persisted state is `activity_import_failures` — the minimum needed for the outbox transition + the durable detail/action identity (the mam_gate_state/smart_drive_state class). |
| C-03 | Good: failure→outbox is same-tx (ADR-034 C-01), so the future admin digest can never miss or phantom a strand. |
| C-04 | Good: the contract is source-agnostic — the *arr and Kapowarr agents implement `ActivitySourceAdapter` and fill the same `ActivityItem`, no schema change. |
| C-05 | Good: actions ride ADR-023's grant machinery (`role_activity_action_grants` + an `activityActionProcedure`), so opening an action to a role later is a data change, not code. |
| C-06 | Bad/accepted: a live read costs upstream calls per view — bounded by the short in-process cache + the small working set; if a source's queue endpoint ever gets slow, that adapter can opt into the snapshot idiom without changing the contract. |
| C-07 | Bad/accepted: because the read is live and the ledger only holds failures, a non-failure in-flight item has no server row — fine (it needs none); the ledger is deliberately failure-only. |
| C-08 | Neutral: `activity-scan` writes NO `sync_runs` row (its trail is the failure ledger + outbox rows) — the standalone-mode convention (notify-outbox / smart-alerts / mam-governor). |

## More information

- PLAN-048 (`.agents/plans/048-activity-in-flight.md`) — the owner rulings R1–R3 + the fan-out shape.
- OPS-013 §11 (`docs/ops/013-mam-books-acquisition.md`) — the LL→SAB category/dir contract, the SAB v5
  archived-history caveat, and the stranded-download break-glass this adapter surfaces.
- `.agents/context/2026-07-13-f10-english-audit.md` RUN 4 — the 42-stranded incident, verbatim.
- DESIGN-030 — the Activity surfaces (tab, chips, wall badge, failure detail) + the adapter recipe.
- ADR-058 / DESIGN-004 D-21 — the card family the surfaces extend (never fork).
