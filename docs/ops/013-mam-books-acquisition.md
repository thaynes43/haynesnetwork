# OPS-013 — MyAnonaMouse books/audiobooks acquisition (as-built runbook)

- **Status:** Live (2026-07-11). Phase-B wiring of PLAN-031 complete and proven end-to-end.
- **Scope:** How the MyAnonaMouse (MAM) private tracker is wired into the books pipeline
  (Prowlarr + LazyLibrarian + Mullvad-egress qBittorrent) and the compliance invariants that
  keep the owner's brand-new account safe.
- **Normative basis:** `.agents/plans/031-books-acquisition-mam.md` (plan),
  `.agents/context/2026-07-11-mam-rules-scrape.md` (the compliance contract — every step here
  satisfies it), `.agents/context/2026-07-10-book-trackers-research.md` (mechanics).
- **Repos:** cluster config in `haynes-ops`
  (`kubernetes/main/apps/downloads/{qbittorrent,prowlarr,lazylibrarian}`). No app-repo change.

---

## 1. The two-IP / two-session model (why this works)

MAM authenticates two different things two different ways, and our topology splits cleanly
across them:

| MAM concept | Our component | Egress IP MAM sees | Credential |
|---|---|---|---|
| Site search / API | **Prowlarr** (no VPN) | home WAN — Comcast **AS7922** | **Session A** `mam_id` cookie (**ASN-locked** to the home ASN) |
| Torrent announces | **qBittorrent** (VLAN-30 macvlan) | **Mullvad exit** `87.249.134.9` — Datapacket **AS212238** | passkey embedded in each `.torrent`; **no `mam_id`** |
| Seedbox-IP registration | **`mam-update` sidecar** (same pod as qBittorrent) | same Mullvad exit | **Session B** `mam_id` cookie (**dynamic-seedbox** enabled) |

**Two separate sessions on purpose.** MAM **rotates the `mam_id` on every use**; if two
consumers share one cookie they invalidate each other. Session A is Prowlarr's alone; Session B
is the updater's alone; qBittorrent holds no cookie.

Cookies live in 1Password item **`myanonamouse`** (HaynesKube vault), fields
**`MAM_ID_PROWLARR`** (Session A) and **`MAM_ID_SEEDBOX`** (Session B), surfaced to the cluster
by the `myanonamouse` ExternalSecret → secret `myanonamouse-secret` in `downloads`.

---

## 2. The `mam-update` sidecar (seedbox-IP keeper)

`kubernetes/main/apps/downloads/qbittorrent/app/` — added as a **third container in the
qBittorrent pod** (`app` + `exporter` + `mam-update`). Placement is deliberate (PLAN-031 Q-02):
the sidecar shares the pod's macvlan netns, so its `dynamicSeedbox.php` calls egress the **exact
Mullvad exit IP qBittorrent announces from** — the IP we register is provably the IP MAM sees on
our announces.

- **Image:** `docker.io/curlimages/curl` (minimal shell + curl). Script:
  `qbittorrent/app/scripts/mam-update.sh` (mounted read-only via `configMapGenerator`).
- **What it does, hourly:**
  1. Confirms we are on the Mullvad exit and reads the current exit IP in one call
     (`https://am.i.mullvad.net/json` → requires `"mullvad_exit_ip": true`). If it can't confirm,
     it **skips** (fail-closed — never registers a home/leaked IP). This mirrors the pod's
     readiness probe.
  2. Only calls `https://t.myanonamouse.net/json/dynamicSeedbox.php` when the exit IP **changed**
     (or was never registered), and **never more than once per hour** (`MIN_GAP`, tracked in a
     persisted `mam.last_call`). Every actual call is counted against the hourly limit
     (conservative — we err toward fewer calls).
  3. Logs the outcome distinctly: `Completed` / `No Change` / `Last Change Too Recent` / errors.
- **Cookie-rotation persistence (the critical gotcha):** MAM rotates the seedbox `mam_id` on use.
  The sidecar keeps a **curl cookie jar** at `/state/mam.cookies` — a **subpath (`mam-update`) of
  qBittorrent's config PVC** (so it is volsync-backed and survives restarts). On **first run only**
  the jar is seeded from `MAM_ID_SEED` (the ExternalSecret value); thereafter the persisted,
  server-rotated cookie is authoritative. State files under `/state`: `mam.cookies`, `mam.ip`,
  `mam.last_call`, `mam.err`.
- **No readiness/startup probe** — only the `app` container's Mullvad-egress check may gate pod
  readiness (same rule as the exporter sidecar); a sidecar readiness probe would 503 the
  VPN-gated WebUI and false-page Gatus.

**Proven at rollout:** log line
`mam-update: Completed: registered seedbox IP none -> 87.249.134.9`, and the jar captured a
rotated (different-length) `mam_id`, confirming rotation persistence works.

Env knobs (helmrelease): `MAM_SEEDBOX_URL`, `MAM_CHECK_URL`, `INTERVAL=3600`, `MIN_GAP=3600`,
`STATE_DIR=/state`, `MAM_ID_SEED` (from `myanonamouse-secret/MAM_ID_SEEDBOX`).

---

## 3. Prowlarr — the MyAnonaMouse indexer

- Added via API using **`MAM_ID_PROWLARR`** (Session A). Indexer **id 17**, `Test` returns
  **green** (MAM accepts the ASN-locked cookie from the home WAN — Prowlarr egresses the home ASN,
  matching Session A's lock).
- **Seed criteria left empty** (`torrentBaseSettings.seedRatio` / `seedTime` / `packSeedTime`
  unset) so Prowlarr never injects a stingy per-indexer share limit — the client seeds forever.
- `useFreeleechWedge = No` (hoard wedges; do not auto-spend).
- Torznab feed consumed downstream: `http://prowlarr.downloads.svc.cluster.local:9696/17/api`.
- **Indexer priority = 50** (lowest preference; set 2026-07-11). Prowlarr runs a
  **LazyLibrarian APPLICATION (`fullSync`, app id 4)** that owns LL's provider sections — this
  priority syncs to LL as `dlpriority = 1`, pinning usenet-first durably (mapping + rationale
  in §5).
- Prowlarr has **no download client** configured (LazyLibrarian talks to qBittorrent directly).
- Prowlarr's API key lives in secret `prowlarr-secret` (`PROWLARR__AUTH__APIKEY`, from 1Password
  `media-stack`).

---

## 4. qBittorrent — the `books-mam` category

- Category **`books-mam`** → save path **`/data/cephfs-hdd/torrents/books/books-mam`** (gasha01
  replicated HDD; same filesystem as the LazyLibrarian library dirs, so imports copy/hardlink).
- **Seed-forever / never-delete:** the category inherits qBittorrent's **global** share policy,
  which is already `max_ratio_enabled=false`, `max_seeding_time_enabled=false`, on-limit action
  `= Pause` (never Remove/delete). New `books-mam` torrents carry `ratio_limit=-2` /
  `seeding_time_limit=-2` (= use global = unlimited). Auto-delete is impossible (no limit is ever
  reached, and even the action is Pause). This qBittorrent WebAPI (2.15.1) `editCategory` accepts
  only name+savePath, so per-category limits are not pinned separately — the global policy is the
  guarantee and matches the existing `sonarr`/`radarr`/`lidarr` categories.
- **`anonymous_mode = false`** (verified). **Private-flag DHT/PEX/LSD auto-disable is intact** —
  libtorrent disables them per-torrent for private torrents regardless of the global DHT/PEX/LSD
  toggles (verified on the test torrent: `[DHT]/[PeX]/[LSD]` rows show *disabled*).
- **Torrent queueing DISABLED (live fix 2026-07-11):** qBittorrent's global queueing was found
  enabled (`max_active_torrents=5`, `max_active_uploads=3`, `dont_count_slow_torrents=false`) —
  completed MAM torrents beyond the cap sat **`queuedUP` and did not announce**, so MAM listed
  them as not seeding (hit-and-run exposure; the owner saw 6 flagged on the site). Set
  `queueing_enabled=false` via the WebAPI; all `books-mam` torrents flipped to active seeding and
  announce continuously (verified 13/13 tracker `status=2` Working). **Queueing must stay off**
  (or, if ever re-enabled, `dont_count_slow_torrents=true` with caps far above the fleet size) —
  a queued torrent accrues no seed time and reads as an H&R to MAM.
- **Untouched:** fixed torrenting port **50469**, the fail-closed Mullvad readiness probe.

---

## 5. LazyLibrarian — Torznab consumer, USENET-FIRST

LazyLibrarian config lives on its PVC (`/config/config.ini`); changes below were applied live via
LL's own API (`addProvider` / `changeProvider` / `writeCFG`, which persist + apply immediately).

- **`[Torznab_0]` MyAnonaMouse (Prowlarr)** — `enabled`, host = the indexer-17 Torznab feed,
  `bookcat=7020` (ebooks), `comiccat=7030`, `magcat=7010`. It is a **torrent** provider → routes
  to qBittorrent.
- **USENET-FIRST (owner ruling Q-05) — CORRECTED 2026-07-11, twice:** the original wiring had
  the priority direction **backwards**. LazyLibrarian's `find_best_result` picks
  `max(matches, key=(score, priority))` (`resultlist.py`) — **higher `dlpriority` wins** among
  equal-scoring results — so the initial `dlpriority=100` made MAM the *preferred* provider over
  the four usenet/Newznab providers (`dlpriority 42–50`), and early grabs routed to MAM even when
  usenet had the title.
  **Second correction — where the knob really lives:** Prowlarr's **LazyLibrarian application
  (`fullSync`)** owns LL's `[Newznab_*]`/`[Torznab_*]` sections and **clobbers manual LL-side
  edits** on every sync (a manual `dlpriority=0` set via LL's `changeProvider` was overwritten
  within the hour). The mapping is **LL `dlpriority` = 51 − Prowlarr indexer priority**. The
  durable fix is at the Prowlarr layer: MyAnonaMouse indexer **priority = 50** (lowest) → the
  app-sync writes LL `dlpriority = 1`, firmly below usenet (42–50). Usenet outranks MAM on
  comparable results and **MAM fills gaps**. Nuances: `dlpriority` is the tie-breaker *after*
  match score — a strictly better-scoring MAM result (title/format match) can still win
  (intended); **never hand-edit LL provider sections expecting persistence** — change the
  Prowlarr indexer and let the application sync propagate.
- **Inert stub:** a disabled `[Torznab_1]` section (same indexer-17 host, no `enabled` key —
  most likely an app-sync/`addProvider` artifact) sits in `config.ini`; harmless, delete at
  will (expect the sync to be authoritative).
- **Torrent routing:** `qbittorrent_label = books-mam`, `qbittorrent_dir =
  /data/cephfs-hdd/torrents/books/books-mam`. MAM is LazyLibrarian's *only* torrent source, so
  every torrent LL grabs lands in `books-mam`.
- **Keep-seeding on import (compliance):** `KEEP_SEEDING = 1` (LL default; also pinned). For a
  torrent with KEEP_SEEDING, LL **copies** the book files to the library and leaves the torrent
  payload seeding (never moves/deletes it). LL only removes a torrent when its client reports
  seeding `finished` — which for qBittorrent means a *met* ratio/time limit (both disabled here),
  so `finished` never becomes true and LL never removes a `books-mam` torrent.
  Per-provider `SEED_RATIO`/`SEED_DURATION` stay `0`, so LL sends **no** per-torrent share limit
  to qBittorrent (it seeds forever). `DEL_COMPLETED` stays at its default (needed for **usenet**
  cleanup; it cannot touch torrents because their `finished` is never true).

---

## 6. Compliance invariants (the never-do list — enforced by construction)

From `2026-07-11-mam-rules-scrape.md`. Every row is satisfied by the wiring, not by discipline
alone:

- **Automate only the documented API.** The only MAM endpoints touched by automation are
  Prowlarr's standard `mam_id` search auth and `dynamicSeedbox.php`. No scraping, no other site
  automation.
- **≤ 1 `dynamicSeedbox.php` call/hour.** Enforced by the sidecar's `MIN_GAP` + persisted
  `mam.last_call`; it also only calls on an actual IP change.
- **Never announce/register off-VPN.** qBittorrent fails closed (readiness probe — untouched); the
  sidecar independently confirms `mullvad_exit_ip:true` before every call. The home WAN can never
  be registered as the seedbox IP.
- **One account / one declared IP.** Shared-Mullvad-IP declared to staff (owner-side, done); the
  updater keeps the *declared* IP current.
- **Seed ≥ 72h / no hit-and-run.** `books-mam` seeds forever (global limits disabled, on-limit =
  Pause, never delete); LL copies-and-keeps-seeding. Never manually delete/stop a `books-mam`
  torrent before 72h (and by policy, not at all — we seed indefinitely for points).
  **qBittorrent torrent queueing must stay disabled** — a `queuedUP` torrent does not announce
  and reads as not-seeding/H&R on MAM even though nothing is "failing" (bit us 2026-07-11; §4).
- **No partial downloads.** Never use qBittorrent file-selection on MAM torrents (grab the whole
  torrent).
- **Approved client, auto-update disabled.** qBittorrent **5.2.1** pinned; Renovate auto-merge is
  disabled for the qbittorrent package (haynes-ops `fa350fa7`) so version bumps are deliberate.
  (Verifying 5.2.1 on MAM's Approved Clients page is owner-side.)
- **Separate `mam_id` per consumer** (Session A vs B) — never share.
- **Unsatisfied-torrent cap = 200 (Elite VIP as of 2026-07-17; was 20 at New-Member join).** Keep
  concurrent not-yet-72h grabs under the rank cap; the PLAN-039 governor enforces it (pause-threshold
  185 = limit 200 − buffer 15). Cap rises with rank (New Member 20 → User 50 → PU 100 → VIP 150 →
  Elite VIP 200); bump `MAM_UNSATISFIED_LIMIT` on each promotion.
- **No buying/selling invites; regular site login** (owner-side).

---

## 7. End-to-end proof (2026-07-11)

One owner-authorized freeleech grab, run through Prowlarr/MAM → qBittorrent `books-mam`:

- **Item:** *Lee Child EBOOKS PACK [ENG / EPUB MOBI]* (MAM `t/151785`), 34.5 MB,
  `downloadvolumefactor=0` (**freeleech = zero ratio cost**), 133 seeders.
- **Result:** downloaded 100% (no partial) into `books-mam` at the correct save path; state
  `stalledUP` (**seeding indefinitely**; share limits inherit the disabled global → never
  stops/deletes); `private=True` with DHT/PeX/LSD disabled.
- **The proof:** the **MAM tracker status is `Working`** (`status=2`, empty message — not
  "unregistered/unauthorized"), i.e. qBittorrent's announce from the Mullvad exit `87.249.134.9`
  was **accepted**. Combined with the updater's `Completed` registration of that same IP, the
  seedbox-IP path is confirmed end-to-end.
- This torrent is left seeding indefinitely — it starts the seed-time economy. **Do not delete
  it.**

> Freeleech is currently **per-item**, not site-wide (a broad Prowlarr sweep found the vast
> majority of torrents at `downloadvolumefactor=1`). For the batch phase, filter to
> `downloadvolumefactor=0` items (the Torznab feed carries the flag) or wait for site-wide
> freeleech — do **not** spend freeleech wedges on small files.

---

## 8. Break-glass — "Unrecognized Host" / passkey or session errors

If MAM starts rejecting announces (torrent tracker status flips to *not working* /
"unregistered" / "unauthorized") or the sidecar logs auth errors:

1. **Most likely cause: the Mullvad exit IP rotated** and the new IP isn't registered yet.
   - Check the sidecar log: `kubectl -n downloads logs deploy/qbittorrent -c mam-update`.
     It should self-heal within the hour (`Completed: … -> <new IP>`). To force a check, restart
     the pod (`kubectl -n downloads rollout restart deploy/qbittorrent`) — first run re-registers
     immediately.
   - Confirm the current exit: `kubectl -n downloads exec deploy/qbittorrent -c app --
     wget -qO- https://am.i.mullvad.net/json`.
2. **If MAM shows torrents "not seeding" but VPN/tracker look fine:** check the torrent states —
   `queuedUP` means qBittorrent queueing got re-enabled (WebAPI
   `/api/v2/app/preferences` → `queueing_enabled` must be `false`, §4). Queued torrents send no
   announces at all; nothing errors, MAM just stops seeing the seed.
3. **If the ASN changed** (Mullvad rented the new server on a different ASN) and Session B is
   ASN-locked, the dynamicSeedbox call may fail. Fix on the MAM site (owner-side):
   *Preferences → Security →* the seedbox session → add/allow the new ASN, or re-issue Session B
   and update 1Password `myanonamouse/MAM_ID_SEEDBOX` (the ExternalSecret re-syncs; the sidecar
   re-seeds its jar on next restart because the jar seeds from the env value only when absent —
   delete `/state/mam.cookies` to force a re-seed).
4. **If Prowlarr searches start failing** (Session A), re-issue Session A from the home WAN
   (ASN-locked), update 1Password `myanonamouse/MAM_ID_PROWLARR`, and paste the new value into the
   Prowlarr MyAnonaMouse indexer (`Test` should go green from the home ASN).
5. **Longer-term stability:** pin the VLAN-30 gateway's Mullvad tunnel to a single WireGuard
   server (owner-present gateway change, outside k8s) so the exit IP/ASN stops rotating. The
   updater remains the safety net for the occasional renumber. **Deferred** — owner-present.

---

## 9. Owner-side responsibilities (not automated)

- **Regular MAM site login** (the account parks/disables on prolonged inactivity — Prowlarr
  searches are not a substitute). "Park" the account before long absences.
- **Staff comms / declarations** already sent (Mullvad, shared exit IP). Re-declare if the pinned
  exit IP changes.
- **Batch pacing / ratio economy:** small few-seeder **freeleech** batches, keep everything
  seeding ≥ 72h (we seed forever), grow points → 25 GB credit (Power User) → VIP. Keep concurrent
  not-yet-72h grabs under the rank cap (20 as New Member). See PLAN-039 for the planned
  cap-aware governor.
- **Approved Clients page:** verify qBittorrent 5.2.1 is listed/allowed before merging any
  qbittorrent version bump.
- **Gateway Mullvad-server pin** (owner-present) — see §8.5.

---

## 10. The compliance governor (PLAN-039 / ADR-054 / DESIGN-027)

The **`mam-governor`** sync mode (a ~15-min CronJob in the `frontend` namespace, alongside the other
`haynesnetwork-sync-*` jobs) keeps automated MAM grabs under the account's **unsatisfied-torrent cap**
(New Member 20 → User 50 → PU 100 → VIP 150 → **Elite VIP 200**; exceeding it blocks downloads up to 24h
— §6). **Current: the account is Elite VIP (confirmed 2026-07-17, MAM Client Summary "… Unsatisfied
(limit 200)"), and the governor is set to `MAM_UNSATISFIED_LIMIT=200` / `MAM_UNSATISFIED_BUFFER=15`
→ pause-threshold 185** (haynes-ops helmrelease). It is the
automated enforcement of the last two rows of the §6 never-do list. **It adds ZERO MAM API surface** —
counting is local to qBittorrent and gating is local to Prowlarr; the governor never calls MAM.

### 10.1 What it does each run

1. **Counts unsatisfied LOCALLY from qBittorrent.** `GET /api/v2/torrents/info?category=books-mam` (the qB
   WebAPI answers **unauthenticated** from the cluster pod network — verified from `frontend`); a torrent is
   **unsatisfied** if it is still-downloading (`progress < 1`) OR complete-but-`seeding_time < 72h`. This is
   deliberately conservative (a wire hiccup over-counts, closing the gate earlier).
2. **Decides the gate.** Pause when `unsatisfied ≥ MAM_UNSATISFIED_LIMIT − buffer` (limit 20, buffer 5 →
   pause at 15); resume below. **Fail-closed:** if the count can't be obtained, it treats the account as
   at-cap and pauses.
3. **Actuates at the Prowlarr indexer.** It toggles the **MyAnonaMouse Prowlarr indexer's `enable`** flag
   (`GET /api/v1/indexer/17` → set only `enable` → `PUT`), NOT LazyLibrarian's provider directly. **Why:**
   Prowlarr runs a **LazyLibrarian application with `syncLevel=fullSync` (app id 4)** — it OWNS LL's
   `[Torznab_*]`/`[Newznab_*]` entries and **clobbers manual LL-side edits on every sync** (it overwrote a
   manual `dlpriority=0` with 26 within the hour; mapping is `LL dlpriority = 51 − Prowlarr priority`). So an
   LL-side `enabled=false` is not durable. Disabling the **Prowlarr indexer** instead **propagates
   `enabled=false` down to LL's `Torznab_0` via that fullSync** (verified live 2026-07-11: within ~6s LL's
   `listNabProviders` flips MAM `Enabled` 1→0 and `config.ini` drops the `enabled` line), so **LL stops
   QUERYING the provider entirely — no failed Torznab searches, so LL's provider-failure blocklist is never
   tripped.** Re-enabling propagates back cleanly. Usenet keeps flowing throughout.
4. **Records + notifies.** Upserts the single-row `mam_gate_state` (gate + counts + limit/buffer/headroom)
   and, **only on a gate transition** (`mam_gate_paused`/`mam_gate_resumed`) or when **headroom stays pinned
   at 0 for > 48h** (`mam_gate_stuck`), enqueues a Pushover row in the existing `notification_outbox` (same
   tx). First run records a baseline and pages nothing.

### 10.2 Config & credentials

- **Tuning:** `MAM_UNSATISFIED_LIMIT` (code default 20 — the owner **bumps this at each MAM rank promotion**:
  User 50 → PU 100 → VIP 150 → Elite VIP 200; **set to 200 in the haynes-ops helmrelease as of 2026-07-17**,
  the Elite VIP cap), `MAM_UNSATISFIED_BUFFER` (code default 5; **set to 15** → pause-threshold 185),
  `MAM_ZERO_HEADROOM_ALERT_HOURS`
  (default 48). All resolve through one seam (`resolveGovernorConfig`); **PLAN-040** moves them to an audited
  DB-backed admin setting with governor-state visibility.
- **Credential:** `PROWLARR_API_KEY` — from the shared `media-stack` 1Password item, already `extract`ed
  into the haynesnetwork ExternalSecret (one added template line; **no new 1Password item**). qBittorrent
  needs none. URLs + the indexer id (17) default to the in-cluster Services.
- **Indexer priority pinned to 50** (→ LL `dlpriority` 1) so usenet stays strictly first even when MAM is
  enabled; the governor's GET-then-PUT changes ONLY `enable`, never priority/fields.

### 10.3 Break-glass

- **"MAM grabs paused" but you didn't expect it:** check the CronJob log
  (`kubectl -n frontend logs job/haynesnetwork-sync-mam-governor-<id>`) — it prints `unsatisfied`, `limit`,
  `threshold`, `gateOpen`, `event`. A `count_failed` reason means qBittorrent was unreachable (fail-closed).
  Confirm the current state row: `SELECT * FROM mam_gate_state;`.
- **Manually force the gate open/closed:** set the Prowlarr indexer `enable` directly (Prowlarr UI or
  `PUT /api/v1/indexer/17`); the next governor run reconciles it to what the count calls for, so to keep it
  forced you must also address the count (or raise `MAM_UNSATISFIED_LIMIT`).
- **Suspend the governor entirely:** `kubectl -n frontend patch cronjob haynesnetwork-sync-mam-governor -p
  '{"spec":{"suspend":true}}'` — grabs then flow ungated (watch the cap manually). Un-suspend to resume.
- **The gate seam depends on Prowlarr's fullSync LL application.** If that application is ever removed or set
  to a non-syncing level, disabling the indexer would stop propagating and the disabled-indexer-Torznab-error
  risk returns — re-verify the propagation (flip `enable`, confirm LL `config.ini` flips) after any Prowlarr
  application change.

---

## 11. The usenet leg — SABnzbd category/dir contract (the LL → SAB import path)

LazyLibrarian is **usenet-first** (§5): the four `[Newznab_*]` providers route grabs to **SABnzbd**
(`sabnzbd.downloads.svc.cluster.local:8080`), *not* qBittorrent. That leg has its own category/dir
contract, separate from the MAM/torrent path, and its absence was the missing piece behind a
stranded-import incident (2026-07-14; see `.agents/context/2026-07-13-f10-english-audit.md` RUN 4).

### 11.1 The two-mount reality (why a category is mandatory)

SAB and LazyLibrarian mount the same storage cluster at **different paths**:

- **SAB** mounts both `haynestower` NFS (`/data/haynestower`; its `complete_dir` root =
  `/data/haynestower/usenet/complete-k8s`) **and** the gasha01 cephfs (`/data/cephfs-hdd`).
- **LazyLibrarian** mounts **only** cephfs (`/data/cephfs-hdd`); its post-processor watches
  `download_dir = /data/cephfs-hdd/data/usenet/complete-k8s/lazylibrarian`.

`/data/haynestower/usenet/complete-k8s` (SAB's default complete root) and
`/data/cephfs-hdd/data/usenet/complete-k8s` are **different underlying storage** — a job completed at
SAB's root is *invisible* to LL. The bridge is a **SAB category whose dir is the absolute cephfs
path**, the same idiom Lidarr uses (`lidarr` category → `/data/cephfs-hdd/data/usenet/complete-k8s/music`).

### 11.2 The contract (both sides must agree)

| Layer | Key | Value |
|---|---|---|
| LazyLibrarian `[SABnzbd]` | `sab_cat` | `lazylibrarian` |
| LazyLibrarian `[SABnzbd]` | `sab_subdir` | *(empty)* — RUN 3 fix; a value here makes LL POST to `…/<subdir>/api` → 404 |
| LazyLibrarian `[General]` | `download_dir` | `/data/cephfs-hdd/data/usenet/complete-k8s/lazylibrarian` |
| SABnzbd category `lazylibrarian` | `dir` | `/data/cephfs-hdd/data/usenet/complete-k8s/lazylibrarian` (absolute) |

With `sab_cat` set, LL sends `&category=lazylibrarian` on every add — **one category for both ebook
and audiobook** (`use_label` returns the single value when `sab_cat` has no comma; a comma-list
`ebookcat,audiocat,magcat,comiccat` would split by library type). SAB routes the completed job to the
category's absolute cephfs dir = LL's `download_dir`, and the post-processor imports it (routing ebook
vs audiobook by the `wanted` row's type, not by folder). **Without `sab_cat` LL sends no category → SAB
completes at its `*` root on `haynestower` → LL never sees it.** That was the 2026-07-14 incident: 42
completed books stranded at the haynestower root while LL's watch dir stayed empty. Changes are applied
live via LL's own API (`writeCFG&group=SABnzbd&name=SAB_CAT&value=lazylibrarian`; LL config is on the
PVC, live-imperative, **not** GitOps — §5 precedent) and the SAB category via
`mode=set_config&section=categories` (it already existed here, mirroring `lidarr`).

Verify both sides:
- LL: `…/api?cmd=readCFG&name=SAB_CAT&group=SABnzbd` → `[lazylibrarian]`.
- SAB: `…/api?mode=get_config&section=categories` → the `lazylibrarian` category's `dir` == LL's `download_dir`.

### 11.3 Completion-detection caveat (SAB v5 history archive) + stranded-books break-glass

LL's post-processor gates import on `get_download_progress`, which queries SAB
`mode=history&nzo_ids=<id>`. In **SAB 5.0.4** that filter returns **0** once a job has aged into the
history **archive** (only `&archive=1` finds it), even though the unfiltered `mode=history` still lists
it. So a job that sits un-processed long enough vanishes from LL's completion check, LL's Pass-3 timeout
marks it **Failed** (`DLResult: "… Progress: 0%"`), and it strands. Fresh completions are in the *active*
history and are caught within LL's 10-min cycle, so the category fix (11.2) is sufficient for steady
state — the archive quirk only bit the already-stranded backlog.

**Break-glass — rescue stranded usenet books** (used 2026-07-14 to recover 42 → 39 imported):
1. Enumerate SAB history (`mode=history&limit=500`), map each `nzo_id`→`storage` against LL's `wanted`
   rows still `Snatched` (`DownloadID`). This is the conservative match set — it excludes the German/
   wrong-edition orphans and SAB's category subdirs.
2. If the folders sit at the haynestower root, **move** them into
   `/data/cephfs-hdd/data/usenet/complete-k8s/lazylibrarian/` from the **SAB** pod (only it mounts both
   NFS trees). It is a cross-filesystem move (no atomic rename) — **copy + verify byte/file counts +
   remove source; never delete before verify**. cephfs rejects metadata-preserving copies
   (`copystat` → `Errno 524 ENOTSUPP`), so copy **data only** (`shutil.copyfile` / `os.makedirs`; not
   `copy2`/`copytree`).
3. Bypass the archived-history completion check: set the rescued `wanted` rows `Source='DIRECT'` (LL then
   trusts the row's existence as 100 % complete) and `Status='Snatched'`, then `forceProcess`.
4. **Fuzzy-match caveat.** LL matches the `wanted.NZBtitle` against the download folder name via
   `token_set_ratio ≥ NAME_RATIO (90)`, and `_normalize_title` deliberately **preserves dots** (to keep
   `J.R.R.`), so **dot-separated scene names** (`Tom.Clancy.Red.Storm.Rising.1987…`) collapse to one token
   and score < 90 → no match. Fix: rename the folder dots→spaces **and** set the row's `NZBtitle` to the
   same spaced form (LL compares those two to each other, not to the clean book title).
5. Genuine content/type mismatches (an ebook grab against an audiobook want, an empty folder, mp3s against
   an ebook want) will not import — leave them `Failed` so LL re-searches for the correct edition; never
   delete the download.

### 11.4 REJECT_WORDS / REJECT_AUDIO matching semantics (language guard)

`resultlist.py` rejects a search result when `word in get_list(result_title.lower())` — LL tokenizes the
release name on **whitespace** (`get_list` folds commas/plus to spaces, then splits) and tests
**word-membership, NOT substring**. Implications for the German/abridged reject list (added in RUN 3):

- `und` is **safe** — it matches only a standalone `und` token (German "Air **und** Darkness"), never
  inside `Foundation` / `Thunder` / `Sound` (each a single token). Verified live 2026-07-14, so the
  substring-danger concern does **not** apply to this LL; keep `und`.
- A marker glued to punctuation (`[ungekrzt]`) does **not** match — keep the bare token forms too.
- Dot-separated scene names are a **single token**, so reject words don't filter them
  (`Foundation.German.Ungekuerzt` is one token) — a known blind spot, not a correctness bug.

The current list (`hörbuch/hoerbuch/hörverlag/lesung/ungekürzt/gekürzt/deutsch/german/dunklen/mächte/
entscheidung/erzählt/wüstenplanet/goldener/zorn/doppelgängerin/und` + their ascii folds; defaults
`audiobook,mp3` / `epub,mobi` preserved) is word-boundary-safe as-is — no substring-danger entries, no
change needed.
