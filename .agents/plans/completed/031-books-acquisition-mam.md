# PLAN-031: Books/ebooks/comics acquisition — MAM wiring (Prowlarr + Mullvad-qBittorrent)

- **Status:** ✅ **COMPLETED — PHASE B (the wiring) LIVE (2026-07-11); filed to completed/ in the
  board audit.** Phase C ("ratio build") is ongoing OWNER-DRIVEN seeding (not an agent build),
  automated going forward by **PLAN-039** (cap-aware governor). **Small build follow-ups carried in
  the handoff:** the LazyLibrarian MAM *audiobook* category (3030) didn't persist (only ebook/comic/
  mag caps auto-detected) — ebooks/comics covered; and the **F-08 comic re-grab list** (24 series +
  4 issues) is the first content workload. As-built runbook:
  `docs/ops/013-mam-books-acquisition.md`. Delivered: `myanonamouse` ExternalSecret (two 1P
  session cookies) + **`mam-update` seedbox-IP sidecar** in the qBittorrent pod (haynes-ops PR
  #2024, merged; pod rolled 3/3, readiness green) — updater logged `Completed: registered seedbox
  IP 87.249.134.9`, rotating `mam_id` cookie persisted to the config PVC. Prowlarr **MyAnonaMouse**
  indexer (id 17, `Test` green from the home ASN, seed criteria empty). qBittorrent **`books-mam`**
  category (seed-forever via global disabled limits, never-delete, anonymous off, private DHT/PEX
  auto-disable intact). LazyLibrarian **`[Torznab_0]`** MAM provider (enabled, **USENET-FIRST**
  `dlpriority=100`, routes to `books-mam`, KEEP_SEEDING=copy-and-hold). **End-to-end proof:** one
  freeleech ebook (*Lee Child pack*, 34.5 MB, dvf=0) grabbed into `books-mam` → **MAM tracker
  status `Working`** (announces from the Mullvad exit accepted) → left seeding indefinitely.
  Deferred: gateway Mullvad-server pin (owner-present; updater covers rotation meanwhile).
  Prior context —
  Work shape is ops/backend (no UX) ⇒ Opus-builder shaped; agent type confirmed with owner at
  dispatch. Interview PASSED, account exists. Approved to
  design + implement; owner wanted it HIGH in the queue. Owner's framing from the interview: the
  rules add real complications we must make concessions for — get the automation + requirements
  right and this becomes the primary books/ebooks source. Design must treat the compliance
  contract (`2026-07-11-mam-rules-scrape.md`) as hard requirements, not guidance.
  Remaining owner-side prerequisites before Phase B: the staff VPN declaration + the two
  Security sessions (A: ASN-locked home for Prowlarr, B: dynamic-seedbox) → hand both mam_ids over. Normative basis:
  `.agents/context/2026-07-10-book-trackers-research.md` (the research doc — read it first;
  this plan is its executable form, not a restatement) **plus the rules scrape
  `.agents/context/2026-07-11-mam-rules-scrape.md` — the compliance contract every Phase-B step
  must satisfy.** Deltas the scrape adds over the research: **unsatisfied-torrent cap = 20 for
  new members** (keep concurrent not-yet-72h grabs well under it), client must be on the
  Approved Clients page with **auto-update disabled** (image pin satisfies this — verify 5.2.1
  listed on join), automation confined to documented API only (mam_id search +
  dynamicSeedbox.php; nothing else, no scraping), no partial downloads, regular site login or
  the account parks/disables.
- **Relates:** PLAN-023 (Kavita/ABS/LazyLibrarian/Kapowarr stack — live; this plan feeds it),
  polish F-08 (24 quarantined comic series + 4 single issues = the first real re-grab workload),
  PLAN-029 (collections/reading-order will consume what this acquires).
- **Repos:** `haynes-ops` (`kubernetes/main/apps/downloads/{prowlarr,qbittorrent,lazylibrarian}`),
  no app-repo change expected (acquisition is upstream of the books-sync mirror).

## Topology facts (verified 2026-07-11)

- Home WAN (Prowlarr egress, owner browsing): `73.249.157.197` — Comcast residential, AS7922
  (dynamic `hsd1` pool ⇒ Prowlarr's Session A should be **ASN-locked**, research §3).
- Mullvad exit (qBittorrent announce egress, shared with slskd via VLAN-30 gateway):
  `87.249.134.9` — Datapacket/Datacamp **AS212238** (NOT Mullvad's own ASN ⇒ ASN-lock is fragile
  for Session B; prefer pin + dynamic-seedbox updater, research §3).
- Client: **qBittorrent 5.2.1** (`ghcr.io/home-operations/qbittorrent:5.2.1`), 24/7, fixed port
  50469, fail-closed Mullvad readiness probe. Mullvad blocks inbound ⇒ permanently
  "not connectable" — acceptable on MAM (seed-TIME economy).

## Already done (2026-07-11, ahead of Phase B)

- ✅ **Renovate auto-merge disabled for qbittorrent** (haynes-ops `fa350fa7`): package-name
  carve-out in `.renovate/autoMerge.json5` — bump PRs still open, owner merges by hand after
  checking MAM's Approved Clients page (the downloads/** leaf tier had been auto-merging it).

## Phases (research §5, condensed)

- **A — Account (owner, in flight):** pass the interview (declare VPN provider **Mullvad**; have
  exit IP ready). THEN, before any seeding: staff message declaring the shared Mullvad IP;
  create Session A (ASN-locked, home WAN → Prowlarr) + Session B ("allow dynamic seedbox IP").
- **B — Wire (dispatchable once owner hands over mam_id A/B):**
  1. Prowlarr → Add Indexer → MyAnonaMouse (Session A mam_id); test green.
  2. Seedbox-IP path: `mam-update`-style hourly caller of
     `t.myanonamouse.net/json/dynamicSeedbox.php` with Session B, egressing VLAN-30 — sidecar in
     the qBittorrent pod (mirrors the exporter-sidecar pattern) per research Q2, unless owner
     prefers pinning the gateway's Mullvad server (Q1) — recommended: BOTH.
  3. qBittorrent: `books-mam` category → save path `/data/cephfs-hdd/torrents/books/books-mam`,
     seed limits unlimited/-1, "Do nothing" on limit, never auto-delete.
  4. LazyLibrarian: consume the Prowlarr Torznab feed (no direct MAM provider); confirm
     hardlink-and-keep-seeding import (download dir + library dir on the same NFS fs).
  5. Kapowarr/comics: MAM carries some comics; F-08 re-grab list is the acceptance workload.
     32Pages deferred (Q4).
- **C — Ratio build (owner habits + a watch item):** small few-seeder freeleech batches, ≥72h
  seed always; points → 25 GB credit (Power User) → VIP; wedges hoarded. ~1 TiB/6 mo unlocks
  invite forums (Bibliotik/32P path).

## Planned (owner 2026-07-11): shepherd integration — NOT yet actionable (no invite yet)

The qbittorrent carve-out strands its bump PRs, but haynes-ops runs the **Tier-4
upgrade-shepherd** (`kubernetes/main/apps/upgrade-agent/shepherd` + `docs/renovate/README.md`)
whose whole point is hands-off/lights-out handling of exactly such stranded PRs. Once the MAM
account exists, build the compliance check INTO the shepherd instead of manual merges:

- Teach the shepherd a **MAM gate for qbittorrent PRs**: fetch MAM's Approved Clients page,
  verify the bump's target version is listed (stable, non-beta), then merge; not listed →
  leave stranded with a comment (and re-check on later runs). Record the rule where the
  shepherd reads policy (it already reads `holds.json5` before working any PR — mirror that
  pattern rather than inventing a new one).
- **Pre-check before enabling anything:** confirm the shepherd today does NOT merge stranded
  qbittorrent PRs on its own (if its remit is broader than immich majors, add qbittorrent to
  its do-not-touch policy FIRST, before the gate exists).
- Note: MAM's approved-clients page may require login — the gate may need the Session-A
  `mam_id` (read-only fetch, within the documented-automation rule) or a cached copy; decide
  at build time.

## Owner rulings (2026-07-11 — Q-01..Q-05 RESOLVED)

- **Q-01: PIN + UPDATER — pin CONFIRMED ALREADY IN PLACE (2026-07-11 eve, owner screenshot).**
  The UniFi VPN client `wg0-chicago` is a static WireGuard config (`us-chi-wg-201.conf`,
  endpoint `87.249.134.1:51820` — Mullvad relay us-chi-wg-201, Datapacket Chicago; exit
  `87.249.134.9`/AS212238) with policy VPNLan→Any. File-based = inherently pinned; NO gateway
  work remains. The hourly updater covers the only rotation source (Mullvad renumbering that
  relay).
- **Q-02: qBittorrent SIDECAR** (same macvlan netns ⇒ identical egress; exporter-sidecar
  pattern).
- **Q-03/Q-04: MAM-ONLY for now.** 32Pages and AudiobookBay stay parked here for later
  (ABB would need the UA-patched Prowlarr image; 32P needs a monthly application + Prowlarr
  definition check).
- **Q-05: USENET-FIRST, MAM fills gaps** — keeps the New-Member unsatisfied cap (20) safe.

**Remaining blockers to dispatch:** owner site-side steps (staff VPN declaration; Session A
ASN-locked from home + Session B dynamic-seedbox; hand over both mam_ids) + agent-type
discussion (standing rule). Gateway pinning is owner-present and can land after Phase B (the
updater covers the gap).

## Never-do (enforced by construction where possible — research §5)

Announce from bare WAN (probe fails closed — keep it) · seed undeclared on the shared Mullvad IP ·
share one mam_id across apps · call dynamicSeedbox.php >1/hr · delete before 72h · browse MAM from
public Wi-Fi · buy/sell invites.
