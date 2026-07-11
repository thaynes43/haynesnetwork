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
- **Untouched:** fixed torrenting port **50469**, the fail-closed Mullvad readiness probe.

---

## 5. LazyLibrarian — Torznab consumer, USENET-FIRST

LazyLibrarian config lives on its PVC (`/config/config.ini`); changes below were applied live via
LL's own API (`addProvider` / `changeProvider` / `writeCFG`, which persist + apply immediately).

- **`[Torznab_0]` MyAnonaMouse (Prowlarr)** — `enabled`, host = the indexer-17 Torznab feed,
  `bookcat=7020` (ebooks), `comiccat=7030`, `magcat=7010`. It is a **torrent** provider → routes
  to qBittorrent.
- **USENET-FIRST (owner ruling Q-05):** the MAM torznab provider's **`dlpriority=100`** sits
  *below* the four usenet/Newznab providers (`dlpriority 42–50`). LazyLibrarian prefers the
  lower-numbered (higher-priority) providers, so SABnzbd/usenet is tried first and **MAM fills
  gaps**. (This also means popular titles available on usenet are grabbed from usenet, not MAM.)
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
- **No partial downloads.** Never use qBittorrent file-selection on MAM torrents (grab the whole
  torrent).
- **Approved client, auto-update disabled.** qBittorrent **5.2.1** pinned; Renovate auto-merge is
  disabled for the qbittorrent package (haynes-ops `fa350fa7`) so version bumps are deliberate.
  (Verifying 5.2.1 on MAM's Approved Clients page is owner-side.)
- **Separate `mam_id` per consumer** (Session A vs B) — never share.
- **Unsatisfied-torrent cap = 20 (New Member).** Keep concurrent not-yet-72h grabs well under 20
  until rank rises; batches start small (owner-driven; see also PLAN-039 governor).
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
2. **If the ASN changed** (Mullvad rented the new server on a different ASN) and Session B is
   ASN-locked, the dynamicSeedbox call may fail. Fix on the MAM site (owner-side):
   *Preferences → Security →* the seedbox session → add/allow the new ASN, or re-issue Session B
   and update 1Password `myanonamouse/MAM_ID_SEEDBOX` (the ExternalSecret re-syncs; the sidecar
   re-seeds its jar on next restart because the jar seeds from the env value only when absent —
   delete `/state/mam.cookies` to force a re-seed).
3. **If Prowlarr searches start failing** (Session A), re-issue Session A from the home WAN
   (ASN-locked), update 1Password `myanonamouse/MAM_ID_PROWLARR`, and paste the new value into the
   Prowlarr MyAnonaMouse indexer (`Test` should go green from the home ASN).
4. **Longer-term stability:** pin the VLAN-30 gateway's Mullvad tunnel to a single WireGuard
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
- **Gateway Mullvad-server pin** (owner-present) — see §8.4.
