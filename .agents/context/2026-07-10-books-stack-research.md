# Books & Audiobooks stack — deep research (PLAN-023)

- **Date:** 2026-07-10
- **Author:** research subagent (overnight; no cluster changes, no deploys — research only)
- **For:** `.agents/plans/023-books-and-audiobooks.md`
- **Owner brief:** revive the old readarr + mylar3 → Kavita + Audiobookshelf pipeline; residual
  content already sits on the media share at `data/Media/Audio Books`, `data/Media/Comics`,
  `data/Media/EBooks`; surface it in the `haynesnetwork.com` Library. Verify Readarr's status;
  likely add qBittorrent + extend Prowlarr for book content.

> All GitHub health numbers pulled live from the GitHub REST API on **2026-07-10**. Web claims
> are cited inline. "Last commit" is the newest commit on the default (or noted) branch.

---

## 0. TL;DR recommendation (details in §5)

**Serve everything behind Authentik OIDC; reuse the downloaders/indexer already in-cluster; add
purpose-built acquisition managers per content type.**

- **Servers:** **Kavita** (EBooks + Comics/manga, native OIDC role-sync) + **Audiobookshelf**
  (Audio Books, native OIDC). Both best-in-class and still the clear leaders.
- **Acquire:** **LazyLibrarian** (ebooks + audiobooks + magazines, one instance, native Prowlarr
  app-sync) as the pragmatic Readarr replacement; **Kapowarr** for comics (replaces the fading
  mylar3). Optional modern audiobook-request UX: **ReadMeABook** (Postgres-native, OIDC) if the
  owner wants a Seerr-style swipe/request flow later.
- **Downloaders / indexer:** **NONE NEW.** qBittorrent (VPN'd, Mullvad) *and* SABnzbd *and*
  Prowlarr are already deployed in `downloads/`. Book/comic torrent + usenet + indexing is a
  config change, not a new deployment. (The brief's "add qBittorrent" assumption is already
  satisfied — see §1.)

**Runner-up acquisition:** **ReadMeABook (audiobooks) + Calibre-Web-Automated (ebook ingest) +
mylar3 (comics)** — see §5.2. **Watch, don't pick:** **Chaptarr** (§2.3).

---

## 1. What's already in the cluster (skimmed `haynes-ops`, not assumed)

The downloads namespace already carries the pieces the brief thought were missing:

| Piece | State in `kubernetes/main/apps/downloads/` | Relevance |
|---|---|---|
| **qBittorrent** | Deployed. Pinned to `network.haynesops.com/vpn: "true"` node, macvlan `static-vpn-qbittorrent` on VLAN30, **Mullvad egress**, readiness probe = `am.i.mullvad.net/connected` (503→Gatus/Pushover if the tunnel drops or leaks). Mounts BOTH shares: `haynestower:/mnt/user/data` and `gasha01:/hdd-nfs-repl`. | **Torrent + VPN already solved.** Book/comic torrents reuse this client; no new downloader, no new VPN wiring. |
| **SABnzbd** | Deployed (app + a `fast/` instance), usenet, went "direct" (no VPN). | Usenet path for books/comics — reuse. |
| **Prowlarr** | Deployed with exportarr + ServiceMonitor; LAN-only ingress; `home-operations/prowlarr:2.1.5`. | Indexer manager — extend with book/comic indexers + add LazyLibrarian/mylar as sync apps. |
| **slskd + soularr** | Soulseek stack (music). | Pattern reference only. |

Deploy conventions to mirror: bjw-s `app-template` OCIRepository HelmRelease; per-app `ks.yaml`
Flux Kustomization with `dependsOn` rook-ceph + volsync; `postBuild.substitute` for
`VOLSYNC_CAPACITY` + Gatus; ExternalSecret from 1Password; `securityContext` non-root 1000;
homepage.dev + external-dns annotations; NFS `advancedMounts` to the media share.

**Consequence for the plan:** the "downloader + VPN" cost the owner budgeted is already paid.
The real new surface is (a) 2 servers, (b) 1–2 acquisition managers, (c) Prowlarr config, (d)
app Library/catalog surfacing.

---

## 2. Acquisition — the Readarr problem and its successors

### 2.1 Readarr is retired (confirmed, not "dying")

- GitHub `Readarr/Readarr`: **`archived: true`**, last commit **2025-06-27**, **no releases**,
  3,465★. The Servarr team retired it: metadata unusable, no maintainer, the Open Library
  migration stalled. LinuxServer deprecated the image (no more `latest`/`develop`/`nightly`
  pulls). Servarr wiki now titles it "Readarr (Retired)."
  Sources: [LinuxServer deprecation notice](https://info.linuxserver.io/issues/2025-06-27-readarr/),
  [Servarr wiki (Retired)](https://wiki.servarr.com/readarr),
  [GitHub Readarr](https://github.com/Readarr/Readarr) (archived).
- **Do not deploy Readarr.** Any guide still recommending it is stale.

### 2.2 Successor matrix (acquisition side)

| Tool | Repo (host) | Scope | ★ | Latest release | Last commit | Prowlarr app-sync? | Downloaders | DB | OIDC | Health |
|---|---|---|---|---|---|---|---|---|---|---|
| **LazyLibrarian** | gitlab `LazyLibrarian/LazyLibrarian` | ebooks + audiobooks + magazines | — | rolling (no semver) | **2026-06-14** (qbit content_path) | **Yes (native)** | qBittorrent, SABnzbd, others; Calibre post-process | SQLite | No (LAN/basic-auth) | **Active, mature** |
| **ReadMeABook** | GitHub `kikootwo/ReadMeABook` | audiobooks (+ ebook "sidecar" from shadow libs) | 789 | v1.2.1 (2026-05-18) | **2026-07-07** | No (talks to Prowlarr directly, not a sync target) | qBittorrent, SABnzbd | **PostgreSQL** | **Yes (OIDC OAuth)** | **Active, modern** |
| **Kapowarr** | GitHub `Casvt/Kapowarr` | comics/graphic novels | 1012 | V1.3.1 (2026-03-29) | **dev 2026-07-09** | **No** (direct HTTP + file hosts) | Built-in direct DL (GetComics, MediaFire, Mega) — **no torrent/usenet** | SQLite | No | **Active** (dev branch hot; stable release lag) |
| **mylar3** | GitHub `mylar3/mylar3` | comics | 1437 | v0.8.3 (2025-08-17) | **2025-08-17** | **Yes (native, as "Mylar")** | SABnzbd + qBittorrent via NZB/torrent | SQLite | No | **Maintenance / slowing** (no commits since Aug 2025) |
| **Chaptarr** | `robertlordhood/Chaptarr` (**private**) | ebooks + audiobooks (one instance) | — | alpha, **Docker Hub only** | opaque | Renamed from Readarr in Prowlarr issue #2578 (planned) | TBD | TBD | TBD | **Alpha, source-closed** |

Sources: [GitHub API live 2026-07-10],
[LazyLibrarian GitLab](https://gitlab.com/LazyLibrarian/LazyLibrarian),
[ReadMeABook README](https://github.com/kikootwo/ReadMeABook/blob/main/README.md),
[Kapowarr](https://github.com/Casvt/Kapowarr) + [Kapowarr docs](https://casvt.github.io/Kapowarr/),
[mylar3](https://github.com/mylar3/mylar3),
[Prowlarr Supported apps](https://wiki.servarr.com/prowlarr/supported),
[Chaptarr status (rapidseedbox 2026 guide)](https://www.rapidseedbox.com/blog/guide-to-readarr),
[Prowlarr issue #2578 rename readarr→chaptarr](https://github.com/Prowlarr/Prowlarr/issues/2578).

### 2.3 Notes that decide the pick

- **LazyLibrarian is the only mature single tool that covers BOTH ebooks and audiobooks** and is
  a **first-class Prowlarr sync target** (Prowlarr's supported-apps list is *exactly*
  LazyLibrarian, Lidarr, Mylar, Radarr, Readarr, Sonarr, Whisparr — so LazyLibrarian and Mylar
  drop into the existing Prowlarr like the current *arrs do). UI is dated and it's SQLite/no-OIDC,
  but it is served behind Authentik at the ingress like Prowlarr/Lidarr already are (LAN-only /
  forward-auth), so no native OIDC is needed for an admin-only tool.
- **ReadMeABook** is the modern, nicer-UX audiobook manager: **PostgreSQL** (matches this repo's
  PG16-only rule if we ever ledger it), **native OIDC**, admin-approval request workflow, Audible
  metadata, multi-file→M4B chapter merge, qBittorrent+SABnzbd, "BookDate" AI request UI. But it is
  **audiobook-first** (ebooks are only an optional sidecar grab), it is **not** a Prowlarr sync
  target (it queries Prowlarr itself), and it exposes **no documented public REST API** for us to
  ledger. Great as a *user-facing request front-end*; not a replacement for a full ebook manager.
- **Kapowarr vs mylar3 (comics) is a real tradeoff:**
  - Kapowarr = healthier (dev branch committed 2026-07-09 vs mylar3's last commit 2025-08-17),
    modern *arr-style UI, Komga/Kavita-oriented. **But it downloads only via direct HTTP + file
    hosts (GetComics, MediaFire, Mega) — no torrent, no usenet, no Prowlarr.** So it neither uses
    the VPN'd qBittorrent nor the SABnzbd/Prowlarr the owner already runs; it's a self-contained
    island (operationally simpler — no VPN concern for comics — but coverage rides entirely on
    GetComics).
  - mylar3 = slowing but **integrates natively with Prowlarr + SABnzbd + qBittorrent**, so it
    matches the established pattern and taps usenet (comics are well-covered on usenet). Older,
    fiddlier.
  - **Pick Kapowarr** for health + UX + zero VPN/indexer wiring, keep **mylar3 as the documented
    fallback** if GetComics coverage disappoints.
- **Chaptarr** aims to be the true one-instance ebook+audiobook Readarr successor, but as of
  2026-07 its **GitHub repo is private**, it ships only a Docker Hub image + Discord, and it's
  self-described alpha/beta. **Unacceptable for a Flux-GitOps cluster with pinned, auditable,
  open-source images and a ledger integration.** Track it; revisit when it's public + released.
- **Request front-ends:** Jellyseerr/Overseerr (`seerr-team/seerr`, MIT, active, 11.8k★) still
  do **movies/TV only — no book/audiobook support** as of 2026-07. The book-request niche is
  filled by **Libreseerr** (Readarr/LazyLibrarian front-end) and ReadMeABook's own request UI.
  Since this repo's own app **is** the request/Library surface, we don't need a Seerr clone —
  we surface the servers + (optionally) a native request flow later.
  Sources: [Overseerr Readarr discussion #2665](https://github.com/sct/overseerr/discussions/2665),
  [seerr-team/seerr](https://github.com/seerr-team/seerr).

---

## 3. Serving layer — confirm best-in-class + Authentik OIDC (SSO is mandatory here)

| Server | Repo | Content | ★ | Latest release | Last commit | Native OIDC / Authentik | Verdict |
|---|---|---|---|---|---|---|---|
| **Kavita** | `Kareadita/Kavita` | **EBooks + Comics/manga** (epub, pdf, cbz/cbr; Book/Comic/Manga/LightNovel library types) | 11,138 | v0.9.0.2 (2026-05-14) | 2026-07-07 | **Yes — native OIDC** with auto-provision, **role/library/age-restriction sync on each login**; official Authentik guide | **Best-in-class ebook+comic reader; keep** |
| **Audiobookshelf** | `advplyr/audiobookshelf` | **Audiobooks** + podcasts | 13,466 | v2.35.1 (2026-05-28) | 2026-07-09 | **Yes — native OIDC** (Settings→Auth→OpenID Connect, issuer auto-populate); official Authentik + ABS guides | **Best-in-class audiobook server; keep** |
| BookLore | `booklore-app/booklore` | ebooks + comics, OPDS, Kobo/KOReader sync, built-in reader | 575 | rolling | 2026-07-10 | Partial (OIDC in progress) | Young challenger to Kavita; not yet worth switching |
| Calibre-Web-Automated | `crocodilestick/Calibre-Web-Automated` | ebook serve + **auto-ingest** (Calibre DB) | 5,880 | rolling | 2026-07-05 | Via proxy-auth (no first-class OIDC) | Strong **ebook ingest** option; pairs with Calibre; see runner-up |

- **Kavita's OIDC is the standout** for this project: it can **derive roles + library access +
  age restrictions from the Authentik token on every login** — i.e. the same "IdP is the source
  of truth" posture this repo already enforces (CLAUDE.md hard rule 5). One Kavita server hosts
  **two library types** (a "Comics/Manga" library over `data/Media/Comics` and a "Books" library
  over `data/Media/EBooks`), so ebooks + comics need only one deploy.
- **Audiobookshelf's OIDC** covers `data/Media/Audio Books`. Lockout escape hatch documented
  (`/login/?autoLaunch=0`).
- Both are GPL-3.0, single-container, heavily used, first-class `app-template`/homelab citizens.

Sources: [Kavita OIDC wiki](https://wiki.kavitareader.com/guides/admin-settings/open-id-connect/),
[Kavita↔Authentik integration](https://integrations.goauthentik.io/media/kavita/),
[Kavita OIDC discussion #2533](https://github.com/Kareadita/Kavita/discussions/2533),
[ABS OIDC docs](https://www.audiobookshelf.org/guides/oidc_authentication/),
[ABS↔Authentik integration](https://integrations.goauthentik.io/media/audiobookshelf/),
[BookLore](https://github.com/booklore-app/booklore),
[Calibre-Web-Automated](https://github.com/crocodilestick/Calibre-Web-Automated).

---

## 4. Integration with the haynesnetwork app (ledger + Library surfacing)

The app's ledger is **`*arr`-shaped**: `ARR_KINDS = ['sonarr','radarr','lidarr']`,
`LEDGER_EVENT_SOURCES = sonarr|radarr|lidarr|seerr|app|maintainerr`, events
`grabbed|imported|deleted|…` synced by `@hnet/sync` (`orchestrator.ts` → per-source runs) into
`media_metadata`/`ledger_events`. None of the book tools speaks the Sonarr v3 history API, so a
**true ledger sync is a non-trivial lift** and should NOT gate this plan:

- **Low-effort, ship-now surfacing:** the **`app_catalog`** table (ADR-013) already accepts
  arbitrary `http(s)` URLs. Add curated catalog cards → Kavita + Audiobookshelf (user-facing) and
  the acquisition managers (admin-gated). This is the "surface in the Library" win with zero
  schema change.
- **Stretch (own future plan):** a books ledger source — new `@hnet/books` read client against
  **Kavita's REST API** (full Swagger) and **ABS's REST API**, mapped into a new
  `LEDGER_EVENT_SOURCES` member + a `books`/`audiobooks` media kind. Kapowarr also has a REST API;
  LazyLibrarian has a token HTTP API. Flagged as scope-out here because the event model
  (grabbed/imported) doesn't map cleanly and it needs its own ADR/DESIGN/migration.

API-quality ranking for a *future* ledger (best→worst): **Kavita** (documented Swagger) ≈
**Audiobookshelf** (documented REST) > **Kapowarr** (documented REST) > **LazyLibrarian** (older
token/command HTTP API) > **ReadMeABook** (no documented public API).

---

## 5. Recommendation

### 5.1 The pick — one coherent stack

**Servers (behind Authentik OIDC, user-facing):**
1. **Kavita** — one deploy, two libraries: `data/Media/EBooks` (Books) + `data/Media/Comics`
   (Comic/Manga). Native OIDC role-sync against Authentik.
2. **Audiobookshelf** — `data/Media/Audio Books`. Native OIDC.

**Acquisition (admin-facing, LAN/forward-auth like the current *arrs):**
3. **LazyLibrarian** — single manager for **ebooks + audiobooks** (+ magazines). Native Prowlarr
   sync target; uses the existing qBittorrent (VPN) + SABnzbd; Calibre-compatible output that
   Kavita reads. This is the "get the pipeline flowing again" workhorse and the closest 1:1 to
   the retired Readarr, in one instance.
4. **Kapowarr** — **comics**, replacing mylar3. Self-contained direct-download (no VPN/indexer
   wiring); files land in `data/Media/Comics` for Kavita to serve.

**Downloaders / indexer — reuse, don't add:**
5. **qBittorrent** (already VPN'd) + **SABnzbd** (already usenet) + **Prowlarr** (add book/comic
   indexers; add LazyLibrarian as a Prowlarr application so indexer sync is automatic; Kapowarr
   needs none).

**App surfacing:**
6. Catalog cards for Kavita + ABS (users) and the managers (admins) now; native books ledger
   deferred to its own plan (§4).

**Why this wins:** maximal reuse of paid-for infra (downloader+VPN+indexer already exist), each
content type handled by the healthiest actively-maintained tool, both servers are best-in-class
with the exact OIDC posture this repo mandates, and it maps 1:1 onto the three existing share
folders. Only genuinely new deployments: **Kavita, Audiobookshelf, LazyLibrarian, Kapowarr**
(4 single-container apps).

### 5.2 Runner-up

**ReadMeABook (audiobooks) + Calibre-Web-Automated (ebooks, ingest+serve) + mylar3 (comics).**
Chosen if the owner prioritizes a **modern Seerr-style request UX** over one-instance simplicity:
ReadMeABook's Postgres + OIDC + swipe-to-request is the nicest audiobook front-end and fits the
repo's stack, and CWA gives hands-off ebook ingest into a Calibre DB. Costs: **two** audiobook
tools if ABS is also kept for serving, ebooks split from audiobooks across different managers,
mylar3's fading maintenance, and no single Prowlarr-native book manager. More moving parts for a
nicer request flow — reasonable as a **phase-2 upgrade** on top of §5.1, not instead of it.

### 5.3 Explicitly rejected

- **Readarr** — retired/archived (§2.1).
- **Chaptarr** — private source, alpha, Docker-Hub-only; violates the GitOps/auditability posture
  (§2.3). Re-evaluate when public + released.
- **Jellyseerr/Overseerr for books** — no book support; the app itself is the request surface.

---

## 6. Migration of existing share content

Residual content already on the share is the seed — point servers/managers at it, don't re-fetch:

- **Kavita:** create a "Books" library → `data/Media/EBooks` and a "Comics" library →
  `data/Media/Comics`; Kavita scans in place (no move). Comic metadata reads from ComicInfo.xml if
  present; ebooks from epub/opf.
- **Audiobookshelf:** create a library → `data/Media/Audio Books`; ABS scans/embeds in place.
- **LazyLibrarian / Kapowarr:** set the **root/library folder to the existing share paths** so
  imports land where the servers already scan, and so LazyLibrarian can *adopt* the existing
  ebook/audiobook files rather than duplicate them. Kapowarr's library folder →
  `data/Media/Comics`.
- **Storage placement (owner Q):** existing content is on `haynestower:/mnt/user/data`; qBittorrent
  also mounts `gasha01:/hdd-nfs-repl`. Where new downloads *land* vs where the libraries *live*
  needs the owner's call given the gasha01 space concern (see plan Q-03). Keep libraries on the
  tower share (where the seed already is); stage active torrents on whichever mount has headroom.

---

## 7. Open verification items carried into the plan

- Confirm Prowlarr's book/comic **indexer categories** for the owner's actual indexers (ebook
  7020, audiobook 3030, comics 7030 families) and that his indexers even carry book content.
- Book **torrent** sources are dominated by private trackers (e.g. MyAnonaMouse) with VPN/seedbox
  rules — usenet (SABnzbd, already direct) is the cleaner default; note MAM-style VPN constraints
  before routing book torrents through the Mullvad qBittorrent.
- Kavita OIDC **role-sync** semantics vs this app's own RBAC — decide whether Authentik groups or
  Kavita-local roles govern library access (avoid two sources of truth).

---

### Sources (primary)

- Readarr retirement: https://info.linuxserver.io/issues/2025-06-27-readarr/ ·
  https://wiki.servarr.com/readarr · https://github.com/Readarr/Readarr
- LazyLibrarian: https://gitlab.com/LazyLibrarian/LazyLibrarian · https://lazylibrarian.gitlab.io/
- ReadMeABook: https://github.com/kikootwo/ReadMeABook (README, releases)
- Kapowarr: https://github.com/Casvt/Kapowarr · https://casvt.github.io/Kapowarr/
- mylar3: https://github.com/mylar3/mylar3
- Kavita: https://github.com/Kareadita/Kavita · https://wiki.kavitareader.com/guides/admin-settings/open-id-connect/ · https://integrations.goauthentik.io/media/kavita/
- Audiobookshelf: https://github.com/advplyr/audiobookshelf · https://www.audiobookshelf.org/guides/oidc_authentication/ · https://integrations.goauthentik.io/media/audiobookshelf/
- BookLore: https://github.com/booklore-app/booklore
- Calibre-Web-Automated: https://github.com/crocodilestick/Calibre-Web-Automated
- Prowlarr supported apps: https://wiki.servarr.com/prowlarr/supported
- Jellyseerr/seerr (no book support): https://github.com/seerr-team/seerr · https://github.com/sct/overseerr/discussions/2665
- Chaptarr status: https://www.rapidseedbox.com/blog/guide-to-readarr · https://github.com/Prowlarr/Prowlarr/issues/2578
- GitHub REST API repo health snapshots pulled 2026-07-10.
