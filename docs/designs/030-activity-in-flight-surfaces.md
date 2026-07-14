# DESIGN-030: Activity / In-Flight surfaces

- **Status:** Accepted
- **Date:** 2026-07-14
- **Basis:** ADR-059 (the live read + failure-ledger decision + the `ActivityItem` contract), PLAN-048
  (owner rulings R1–R3), ADR-058 / DESIGN-004 D-21 (the shared card family), ADR-023 (fine-grained
  action grants), ADR-055 (the confined LazyLibrarian read/write split), OPS-013 §11 (the books
  pipeline contract this surfaces).
- **Scope (SLICE 1):** the common contract, the Library → Activity sub-tab, the wall poster in-flight
  badge, the failure detail page + role-gated actions, and the BOOKS adapter (LL + SAB). The *arr and
  Kapowarr adapters are the fan-out follow-ups; they fill the SAME contract (D-08).

## D-01 — Library → Activity sub-tab (R1, the Trash→Activity idiom)

One cross-library Activity sub-tab lives in the Library tab shell (`library-client.tsx`), rendered
LAST (after Books, beside My Fixes) as an **always-on, ungated tab** — the Library section has no
section id, and Activity is a household/personal utility like My Fixes. Server-authoritative gating
happens on the **list resolver**, not the tab: the `activity.list` procedure returns only items whose
`section` the caller may see (a `book`/`audiobook`/`comic` item is included only when `books ≥
read_only`; the future *arr items ride the universal Library walls, no gate). A member who can see
nothing gets an empty Activity with the "nothing in flight" empty state — never a forbidden error and
never a client-only hide.

The panel is a **`PosterGrid` of `ActivityCard`s** (D-05) with a **Helpdesk-idiom chip bar** (D-02),
newest-activity first. It polls `activity.list` on a short client interval (a few seconds — the live
read of ADR-059) with `placeholderData: (prev) => prev` so progress numbers tick without the grid
flashing (ADR-015 — recolor/relabel, never reflow).

## D-02 — stage + kind filter chips with counts (the Helpdesk chip idiom)

Two chip groups mirror `HelpdeskTab` (multi-select, URL-encoded as repeated params, counts baked into
the chip label `LABEL · N`):

- **Stage:** Searching · Downloading · Importing · Failed · Recently done — the `ActivityStage` set.
- **Kind:** Movies · TV · Music · Books · Audiobooks · Comics — the `ActivityKind` set, populated-only
  (a kind chip renders only when the current result set has ≥ 1 item of that kind, like the
  populated-value-gated Goodreads shelf chips).

Counts come from the same `activity.list` payload (a `counts` roll-up computed server-side over the
gated set, zero-filled — the `communication.tickets.counts` pattern), so the chips and the grid can
never disagree. An "All · total" chip resets. `Failed` is visually the loudest chip (danger tone) so a
strand is impossible to miss.

## D-03 — the wall poster in-flight badge (R1) — a typed prop, never a new anatomy slot

The wall in-flight signal is delivered through the **existing ADR-058 badge row**, NOT a new poster
overlay/puck (pucks are reserved to Trash/Ticket — ADR-058). `MediaCard` and `BookCard` gain ONE typed
prop, `inFlight?: ActivityStageBadge`, which the card renders as the **leading `CardBadge`** in its
(≤ `MAX_CARD_BADGES`) badge row via a shared `activityStageBadge(stage, progress)` helper:

| Stage | Badge | Tone |
|---|---|---|
| `searching` | "Searching" | `muted` |
| `downloading` | "34%" (or "Downloading") | `info` |
| `importing` | "Importing" | `info` |
| `failed` | "Stuck" | `danger` |
| `completed` | "Just added" | `ok` |

Anatomy is unchanged (still one art box · one caption · one ≤3 badge row), tokens-only, ADR-015-safe (a
stage change recolors the badge in place). The wall query joins the live activity read by wall — a
poster with an in-flight item shows the badge; when it lands, the badge clears on the next poll. In
SLICE 1 the books walls consume it; the *arr walls consume the same prop when their adapter lands.

## D-04 — the failure DETAIL page (R2, the #264 wanted-detail idiom)

Route `apps/web/app/(app)/library/activity/[failureId]/` copies the books wanted-detail idiom:

- **Server wrapper** (`page.tsx`): resolves `params.failureId` + `?from=`; the VIEW gate is authed +
  the failure's `section` visible (books ≥ read_only for a book failure); otherwise
  `redirect('/library')`.
- **Client** (`activity-failure-detail.tsx`): `trpc.activity.failure.useQuery({ failureId })` behind a
  `BackLink`; a `.card.detail-head` with the 2:3 `MediaPoster`, title (year), a `.media-card__badges`
  hero row carrying the **stage + failure-kind** badges, the **human failure reason** (the LL
  `DLResult` / "download completed but never imported (stranded)" copy), a "what this means" line, and
  — for an Admin (or a role granted the action) — the **action row** (D-06). Non-actors see the same
  facts read-only ("An admin needs to retry this import.").
- **Server resolver** (`activity.failure`): returns the failure joined with the live source state +
  the per-viewer `canAct` flags (admin OR the role grant), so the buttons are server-authoritative.

## D-05 — `ActivityCard` (a new ADR-058 family member, not a fork)

The Activity grid tile is a new typed BaseCard extension `ActivityCard` (the sanctioned "add a typed
variant in the package + gallery + spec" path): a 2:3 poster (cover-proxy or the KindIcon fallback) ·
title (year) · a muted subtitle of the source app · the stage badge (+ progress) and, for a failure,
the failure-kind badge (≤ 2 badges, well under the cap). Its whole face is a click-through: a failure
links to its detail page (D-04); a non-failure links to the library item (or is inert). No buttons on
the card face (ADR-058) — actions live only on the detail page. It is registered in the card gallery
(`/e2e/card-gallery`) in every stage state and asserted by the gallery spec (one art box, one caption,
≤3 badges, no card-face buttons) — the drift gate keeps it honest.

## D-06 — role-gated actions + PLAN-015 feedback (R2)

Two Admin actions on the failure detail, each a reserved-slot button that swaps to a `PhaseChip` on
fire (the `FormatSearchSlot` idiom — no reflow):

- **Retry import** (`activity.retryImport`) — re-runs the LazyLibrarian post-processor for the stuck
  book (`forceProcess`, the confined LL write). This is the in-app analog of the OPS-013 §11.3
  break-glass `forceProcess`.
- **Force re-search** (`activity.forceSearch`) — the existing `searchBook` confined write (the same
  write the books "Search again" fires), to fetch a fresh source when the grab is a dead end.
- **Open downstream** — a plain deep link (LL/SAB) shown to Admins only (the operator UIs are
  LAN-only, so it is a best-effort convenience, never load-bearing).

Both mutations are gated by `activityActionProcedure(action)`: authed AND (admin OR the caller's role
holds the `role_activity_action_grants` row for that action). Each co-writes a `permission_audit` row
(`activity_retry_import` / `activity_force_search`) in the same transaction as it stamps the failure's
`lastActionAt`/`lastActionBy` (CLAUDE.md hard rule 6 — the `recordManualSearch` precedent), and the LL
write fires AFTER commit (the fix-flow discipline — external calls stay out of the transaction). A
non-actor calling either mutation gets `FORBIDDEN` (server-authoritative, not a client hide).

## D-07 — the failure ledger + the `activity-scan` sync mode (ADR-059)

`activity_import_failures` (migration 0048) holds one row per OPEN failure: `source`, `kind`,
`sourceRef` (the LL bookId + format / SAB nzo_id), `failureKind`, `failureReason`, `title`, the first-
and last-seen stamps, the `notifiedAt` (outbox dedupe), and the action audit stamps. The `activity-scan`
sync mode (a `frontend` CronJob, no `sync_runs` row) runs `evaluateActivityFailures`: it polls the
books sources, computes the current open-failure set (the D-02/Q-02 stage machine), and in ONE
transaction upserts the ledger AND — for each NEWLY-seen failure — enqueues one
`activity_import_failed` outbox row (same-tx; first-sight-of-a-failure pages once; a cleared failure is
closed). NO push per in-flight event (owner ruling — in-app only for now); the outbox feeds the future
admin digest (PLAN-035 channel, post-SMTP).

## D-08 — the fan-out recipe (for the *arr + Kapowarr follow-up agents)

A new source family plugs in WITHOUT touching the contract, the card, the tab, the chips, or the
detail page:

1. Implement `ActivitySourceAdapter.list(): Promise<ActivityItem[]>` for the source (read the *arr
   `queue`/`manualimport` or Kapowarr `queue`/`tasks`, normalize to `ActivityItem` — the pure
   `buildBooksActivity` normalizer in `@hnet/domain/activity/books-adapter.ts` is the template).
2. Set each item's `section`/`wall` so the gating + the wall-badge join work; set `stage`/`progress`/
   `failureKind`/`failureReason`/`actions` per the same stage vocabulary.
3. Register the adapter in the `activity.list` aggregator's source list and in the `activity-scan`
   mode's failure poll.
4. Add the source's confined action write (retry-import / force-research) behind
   `activityActionProcedure` if it has actionable failures.
5. Extend the adapter fixtures + role-gating tests; add a gallery entry if the source needs a new
   badge state. The card, tab, chips, and detail page require NO change — they are contract-shaped.

### D-08 amendment — the *arr adapter (Radarr / Sonarr / Lidarr), PLAN-048 slice 2 (2026-07-14)

The first fan-out adapter landed (`@hnet/domain/activity/arr-adapter.ts`, pure `buildArrActivity`), filling
the contract with NO change to the card, tab, chips, or detail page (the recipe held). Coverage per *arr:

- **Source family:** one `arr` family across all three instances (the failure ledger `source`); the item
  `id` encodes the instance + fix target — `arr:radarr:<movieId>`, `arr:sonarr:<seriesId>:<episodeId>`,
  `arr:lidarr:<artistId>:<albumId>` — so the wall-badge join (parent id), the ledger `source_ref`, and the
  per-kind Force-Search dispatch all read one stable ref. `section` is always **null** (movies/tv/music are
  the ungated universal walls — D-01), so *arr items show for EVERY authed viewer; the aggregator + the
  `activity.list` resolver add the *arr adapter unconditionally (books stays section-gated).
- **Stages** (from the `queue` `status` + `trackedDownloadState`/`trackedDownloadStatus`): `downloading`
  (progress = `(size − sizeleft)/size`), `importing` (`importPending`/`importing` or a completed download),
  and `completed` (a recent import read from `history`, within a 15-min horizon — deduped against the live
  queue). **Failure classes:** `import_blocked` (`trackedDownloadState: importBlocked`/`importFailed`, or a
  completed download the importer flagged — the *arr "manual import required", reason from `statusMessages`/
  `errorMessage`) and `download_failed` (`failed`/`failedPending`). Read-only otherwise — no new `@hnet/arr`
  read was needed (the existing `getQueue`/`getHistory` sufficed).
- **Actions (R2):** `retry_import` → the confined `@hnet/arr/write` `ProcessMonitoredDownloads` command (the
  `forceProcess` analog — estate-wide completed-download re-import); `force_research` → the existing
  per-kind Force-Search commands (`MoviesSearch` / `EpisodeSearch` / `AlbumSearch`, PLAN-015 machinery). Both
  dispatch off the parsed ref, audited same-tx + fired after commit, exactly like the books writes. A blocked
  import offers both; a dead download offers re-search only.

## Decisions log

| ID | Decision |
|----|----------|
| D-01 | Activity is an always-on Library sub-tab (My Fixes precedent); the LIST resolver does the per-section gating, so the tab needs no section id. |
| D-02 | Stage + kind chips mirror the Helpdesk multi-select chips with server-computed counts; kind chips are populated-only; Failed is the loud danger chip. |
| D-03 | The wall in-flight signal is a typed `inFlight` prop on MediaCard/BookCard rendered as the leading badge in the existing ≤3 row — no new poster anatomy (ADR-058 stands). |
| D-04 | The failure detail page copies the #264 wanted-detail idiom (server gate + `?from=`, BackLink, `.card.detail-head`, reserved action slots). |
| D-05 | `ActivityCard` is a new BaseCard family member (typed variant + gallery + spec), never a fork. |
| D-06 | Actions are `activityActionProcedure(action)`-gated (admin OR grant), audited same-tx, LL write after commit; non-actors get FORBIDDEN. |
| D-07 | Failures persist in `activity_import_failures`; `activity-scan` upserts + enqueues the outbox same-tx; no per-event push. |
| D-08 | The fan-out recipe: new adapters fill the contract; the card/tab/chips/detail are source-agnostic. |
| D-08a | *arr adapter (Radarr/Sonarr/Lidarr) shipped (PLAN-048 slice 2): `source: 'arr'`, `section: null` (universal), `id` encodes instance + fix target; stages downloading/importing/completed + failures import_blocked/download_failed; retry = confined `ProcessMonitoredDownloads`, re-search = the existing per-kind Force-Search. No card/tab/chip/detail change. |

## Open questions

- Q-01: the client poll interval + in-process cache TTL (seconds) are tuned live once the *arr adapter
  lands and real queue volume is observed — a constant, not a schema decision.
- Q-02: the `stranded_import` staleness horizon (how long `Snatched` + SAB-Completed before it's
  called failed) starts at a conservative constant; owner may tune after the first real strand.
