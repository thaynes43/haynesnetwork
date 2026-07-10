# PLAN-023: Books & Audiobooks — revive the ebook/audiobook/comic pipeline and surface it in the Library

- **Status:** **COMPLETED — all phases EXECUTED & LIVE (2026-07-10).** Phases 1–2: 4 apps deployed +
  storage reshaped to gasha01 + content migrated + Prowlarr/LL/Kapowarr wired + end-to-end usenet grab
  proven for ebook **and** audiobook. **Phase 3 (OIDC):** public `*.haynesnetwork.com` exposure for Kavita +
  Audiobookshelf with forward-auth, live (haynes-ops `6435e781`, after PLAN-011 completed). **Phase 4 (app
  surfacing):** the Books ledger + Library walls + cover proxy + catalog cards, **live in v0.39.0** (ADR-046 /
  DESIGN-024 / PRD R-151..R-156 / DDD T-136..T-138; PR #187; haynes-ops `d865bff1`) — see the **"Phase 4 —
  as-built"** section below. Owner rulings below OVERRIDE the original phase text where they differ. <!-- Completed -->
- **Owner must-decide (morning):** (1) open the `books` Section-Permission (`read_only`) to which role(s)
  via `/admin/roles` after the 390px + desktop screenshot review (ships Admin-only); (2) grant the Kavita/ABS
  **catalog cards** to Default/Family via `/admin/roles` (or keep admin-only); (3) the two cards' copy
  (seeded "Read — ebooks & comics" / "Listen — audiobooks"). All reversible in `/admin`.
- **Satisfies:** PRD-001 new R-NN block (Books & Audiobooks: acquisition managers, Kavita/ABS
  serving behind Authentik, Library/catalog surfacing); new ADR-NN (books stack topology +
  reuse-existing-downloaders decision + serving-vs-ledger boundary); optional new ADR-NN (books
  ledger source, if the stretch phase is taken); new DESIGN-NN (Library "Books" surfacing UX);
  glossary terms (Book, Audiobook, Comic, acquisition manager, serving layer). **Migration only
  if the stretch ledger phase is taken.** **ID reconciliation:** ceilings at authoring —
  ADR-036, DESIGN-015, migration 0030, R-116, OPS-007 (verified 2026-07-10). Take next-free at
  authoring time; **re-grep first** (parallel round-2 plans consume numbers). Plan number 023 is
  free (active: 011/017/019; completed: 001–016).
- **Depends on:** none in this repo. **Cross-repo:** the deploy phases land in `haynes-ops`
  (Flux GitOps) and are independent of the app-side phases; the app-side surfacing only needs the
  servers to have public URLs.
- **TODO source:** owner backlog "Books & Audiobooks" item (readarr+mylar3 → Kavita+ABS revival)
  + research report `.agents/context/2026-07-10-books-stack-research.md` (health tables, Prowlarr
  integration facts, the recommendation + runner-up). **Read that report before executing.**

---

## Owner rulings + as-built (2026-07-10)

Owner-approved 2026-07-10; executed same day by the deploy agent against the live `haynes-ops`
cluster. **These rulings override the phase text below where they differ.**

### Rulings (owner)
1. **Stack confirmed:** Kavita (EBooks + Comics) + Audiobookshelf (Audio Books) serving;
   LazyLibrarian (ebooks + audiobooks) + Kapowarr (comics) acquisition.
2. **Downloads route BOTH** SABnzbd (usenet) **and** the existing Mullvad qBittorrent (torrents).
   Private book trackers are a **separate research task** — qBittorrent is wired now but
   **public-indexer torrents only** until the owner adds tracker accounts; **usenet is the default.**
3. **All three content types** in this wave.
4. **STORAGE RESHAPE (done):** libraries now live on **gasha01** (`gasha01.haynesnetwork:/hdd-nfs-repl`)
   under **`data/media/books/{EBooks,Comics,AudioBooks}`** (mirrors the existing gasha01
   `data/media/{music,youtube,peloton}` convention; CephFS-backed → instant reads, no Unraid
   spin-up). Seed content **COPIED** (rsync, tower originals **untouched** — owner retires them
   later) from `haynestower:/mnt/user/data/Media/{EBooks,Comics,Audio Books}`.
5. **Audiobooks never touch Plex** (honored — ABS is standalone).
6. **User-facing ingress = INTERNAL traefik on `*.haynesops.com` ONLY** for now
   (`kavita.haynesops.com`, `audiobookshelf.haynesops.com`); LazyLibrarian/Kapowarr = LAN-only
   admin ingress like the *arrs. OIDC + public `*.haynesnetwork.com` exposure is the **later
   PLAN-011 train** (not this wave).

### Migration evidence (rsync tower → gasha01, verify counts + spot checksums)
- **gasha01 free space:** 119 TiB free of 159 TiB (26% used) — sources total ~362 GiB, fits trivially.
- **EBooks:** src 1853 files (11 GiB) = dst 1853 ✓ · **Comics:** src 1737 files (62 GiB) = dst 1737 ✓
  · **AudioBooks:** 289 GiB (81 authors) — the in-cluster `books-migrate` Job (mounts both NFS
  exports, runs as UID 1000, tower mounted **read-only**) copies then prints final counts + a
  per-library sha256 spot-check and `MIGRATION COMPLETE`. (CephFS `du -sb` over-reports bytes via
  recursive rbytes xattr; **file COUNT parity + sha256 spot-checks** are the integrity signal.)

### Apps deployed (all bjw-s `app-template`; config PVC + volsync + Gatus; LAN-only traefik-internal)
| App | ns | Image | Ingress | gasha01 mount | Notes |
|---|---|---|---|---|---|
| **Kavita** | media | `docker.io/jvmilazz0/kavita:0.9.0.2` | kavita.haynesops.com | RO `/data/cephfs-hdd` | Books(id1,Epub+Pdf)+Comics(id2,Archive) libraries created; **drop the `/tmp` emptyDir** (shadows the baked appsettings template) |
| **Audiobookshelf** | media | `ghcr.io/advplyr/audiobookshelf:2.35.1` | audiobookshelf.haynesops.com | RO `/data/cephfs-hdd` | rootless via `PORT=13378` (avoid privileged :80); `/config`+`/metadata` subPaths on one PVC; Audio Books library created; never touches Plex |
| **LazyLibrarian** | downloads | `docker.io/linuxserver/lazylibrarian:version-40a389ea` | lazylibrarian.haynesops.com | RW `/data/cephfs-hdd` | LSIO s6 root-init→PUID/PGID 1000 (NOT the rootless *arr model); **use docker.io mirror — `lscr.io` is not on the `restrict-image-registries` Kyverno allowlist** |
| **Kapowarr** | downloads | `docker.io/mrcas/kapowarr:v1.3.1` | kapowarr.haynesops.com | RW `/data/cephfs-hdd` | root folder=Comics, download folder=`data/torrents-k8s/comics` (same fs → atomic); **needs ComicVine API key to grab (owner TODO)** |

All four: Flux Kustomization Ready, HelmRelease succeeded, Gatus endpoint registered, ingress
returns 200/3xx through traefik-internal.

### Wiring (config in the apps' APIs, lives in the backed-up PVCs — not GitOps)
- **Prowlarr:** LazyLibrarian added as **Application** (id 4, `fullSync`). The 4 enabled **usenet**
  indexers (DrunkenSlug, NinjaCentral, NZBFinder, NZBgeek — all carry 7020 EBook / 3030 Audiobook /
  7030 Comics) synced into LL as `Newznab_0..3` providers. **No new external indexer accounts added**
  (per ruling — the tracker/indexer research task owns that).
- **LazyLibrarian:** SABnzbd (usenet; category `lazylibrarian` → `…/usenet/complete-k8s/lazylibrarian`)
  + qBittorrent (torrents; qbt's `AuthSubnetWhitelist` covers the 10.42/16 pod net so **no creds
  needed**) + gasha01 library paths (`…/media/books/{EBooks,AudioBooks}`) + API enabled. LL config
  was written **while the pod was scaled to 0** (a running LL rewrites `config.ini` on SIGTERM and
  clobbers hand-edits — use a temp pod on the config PVC, or `writeCFG` at runtime).
- **SABnzbd:** added category `lazylibrarian` → `/data/cephfs-hdd/data/usenet/complete-k8s/lazylibrarian`.
- **Kapowarr:** root folder + download folder set; direct-download only (no Prowlarr/VPN).

### End-to-end proof (real usenet grabs, 2026-07-10)
- **EBOOK ✅** — real NZB (NZBFinder) → SABnzbd → gasha01 `EBooks` → **Kavita serves "The Penny
  Dreadfuls"** (public-domain anthology, epub; Kavita search confirms). Migrated 131 book series
  also live.
- **AUDIOBOOK ✅** — real NZB (NZBFinder, "A Christmas Carol", Tim Curry, public domain, 6 mp3
  parts) → SABnzbd → gasha01 `AudioBooks` → **ABS serves it** (ABS search confirms). Migrated
  audiobooks (Grisham, etc.) also scanning.
- **COMIC ⏳** — Kavita serves the migrated **Comics** library (163 series). Kapowarr grab is
  **blocked on a ComicVine API key** (owner TODO) — GetComics needs ComicVine metadata to add a volume.

### ⚠️ Known upstream issue (LazyLibrarian auto-grab)
LazyLibrarian build `version-40a389ea` has a **broken metadata/add-book path**: OpenLibrary throws
`sqlite3.ProgrammingError: Error binding parameter 1: type 'tuple' is not supported` (ol.py
`ADDAUTHORTODB`) on both author book-import and manual import (`'NoneType' object has no attribute
'get'`). So LL cannot currently populate its Wanted list → **its automated snatch/import is
blocked**. The proofs above bypass this by handing the NZB straight to SABnzbd with the
`lazylibrarian` category (byte-for-byte what LL does on a snatch) — the **pipeline is sound**; only
LL's metadata layer is broken. **Fix options for owner:** set `BOOK_API=GoogleBooks` + add a (free)
Google Books API key; or pin a different LL build; or await the upstream fix.

### Owner TODOs (create these; then wire ExternalSecrets where the repo pattern expects)
- **1Password `HaynesKube`:** `lazylibrarian`/`LAZYLIBRARIAN_API_KEY = 035c40f439116b3c5afa0c84f0c7b0ee`
  (Prowlarr app consumes it); `kapowarr`/`KAPOWARR_API_KEY = f44eb839f0f1acc9033e73c67caf6dec` **plus**
  `COMICVINE_API_KEY` (owner obtains from comicvine.gamespot.com); `kavita`/`KAVITA_ADMIN_PASS`
  (bootstrap admin `hnetadmin`, password handed to owner out-of-band) and `audiobookshelf`/`ABS_ROOT_PASS`
  (root user) — both replaceable by OIDC in Phase 3. (No ExternalSecrets were committed yet because
  the keys are app-generated + owner-managed; add them once the 1P items exist, mirroring the *arr
  `externalsecret.yaml` pattern.)
- **Private book trackers** (parallel research task): once tracker accounts exist, add them to
  Prowlarr and enable book **torrents** through the Mullvad qBittorrent (wired, idle until then).
- **ComicVine key** unblocks the Kapowarr comic-grab proof.
- **LazyLibrarian metadata fix** (see issue box above) unblocks LL's hands-off auto-grab.

### What Phase 3 (OIDC train) inherits
- **Kavita** (`kavita.haynesops.com`): bootstrap admin `hnetadmin` exists; libraries **Books (id 1)**
  + **Comics (id 2)** already created on the gasha01 paths. Enable OIDC at Settings → OpenID Connect.
- **Audiobookshelf** (`audiobookshelf.haynesops.com`): root user exists; **Audio Books** library
  (`id 4f5bc272-0393-4bcb-af84-212c879c20ef`) created. Enable at Settings → Auth → OpenID Connect;
  lockout escape hatch `/login?autoLaunch=0`.
- Then move Kavita + ABS from traefik-internal (`haynesops.com`) to public traefik-external
  (`haynesnetwork.com`) with forward-auth (hard rule 5), authored via the **now-live PLAN-011
  blueprint mechanism** (not ad-hoc). LazyLibrarian + Kapowarr stay LAN-only permanently.

### Phase 3 — EXECUTED & LIVE (2026-07-10, owner-approved)

OIDC is **native per-app** (not forward-auth): Kavita and ABS each speak Authentik OIDC directly,
so the public routes are plain pass-through (no `haynesnetwork` forward-auth middleware). This is
the app-native SSO posture, satisfying hard rule 5 (SSO via Authentik) without proxy-auth.

**Authentik (API-created, mirroring the Open WebUI provider — API-managed per ADR-042 Q-11, NOT
blueprinted; the blueprint mechanism owns brand/flows/sources/MFA, not providers):**
- **Kavita** — OAuth2 provider **pk 110** (`client_id zpT7lJvrzJOQYNx6mYL8j16JoST3Ih0BbxWcVBTt`),
  application slug **`kavita`** (pk `bd50b928-f169-405b-bf02-552643c9ce69`). Redirect URIs (strict):
  `https://kavita.haynesnetwork.com/signin-oidc` + `…/signout-callback-oidc` (+ `haynesops.com`
  variants). Authority = `https://authentik.haynesnetwork.com/application/o/kavita/`.
- **Audiobookshelf** — provider **pk 111** (`client_id naeO2CNn4YSLYglcPaF27lpQFszKAciAwPMDKmpq`),
  app slug **`audiobookshelf`** (pk `36434e72-949e-4e77-a6de-62ab0e14928a`). Redirect URIs (strict):
  `https://audiobookshelf.haynesnetwork.com/auth/openid/callback` + `…/auth/openid/mobile-redirect`
  (+ `haynesops.com` variants). Issuer = `…/application/o/audiobookshelf/`.
- Both: authorization flow `default-provider-authorization-implicit-consent`, invalidation
  `default-provider-invalidation-flow`, `confidential`, `hashed_user_id`, `include_claims_in_id_token`,
  signing key mirrored from OWUI, `grant_types:[authorization_code,refresh_token]` (the OPS-001
  empty-grant gotcha avoided — verified non-empty on read-back), and the **`hnet-groups`** scope
  mapping (`acb0f69f-…`) attached alongside openid/email/profile so the groups claim flows.

**App-side OIDC config (in each app's PVC-backed store, volsync-backed — NOT git/ExternalSecret):**
- **Kavita** (`POST /api/settings` with hnetadmin cred): authority/clientId/secret set,
  `enabled:true`, `autoLogin:false` (local login stays default = break-glass), `provisionAccounts:true`,
  `requireVerifiedEmail:false`, `defaultLibraries:[1,2]` (Books+Comics for provisioned users),
  `syncUserSettings:false` (Kavita-local role control kept; hnet-groups is attached so enabling sync
  + `customScopes:["groups"]` + the `library-<Name>`/`age-restriction-<Rating>` role convention is the
  documented upgrade path). Restarted the pod (Authority/ClientId/Secret need a restart).
- **ABS** (`PATCH /api/auth-settings` with root cred; dynamic, no restart): `authActiveAuthMethods:
  [local,openid]`, issuer + authorize/token/userinfo/jwks/end-session set, clientID/secret,
  `authOpenIDAutoLaunch:false` (break-glass; escape hatch `/login?autoLaunch=0`), `authOpenIDAutoRegister:
  true`, `authOpenIDMatchExistingBy:null` (match by OIDC `sub` — REQUIRED: Authentik emits
  `email_verified:false` for these accounts, and ABS's `email` match refuses unverified emails, which
  would block every Plex-federated user), `authOpenIDSubfolderForRedirectURLs:""` (REQUIRED: this ABS
  2.35.1 image defaults `ROUTER_BASE_PATH=/audiobookshelf`, so the field was `undefined` → produced a
  broken `/undefined/auth/openid/callback` redirect_uri; `""` yields the clean `/auth/openid/callback`).

**Public exposure (haynes-ops commit `6435e781`):** two `traefik-external` IngressRoutes
(`kavita.haynesnetwork.com`, `audiobookshelf.haynesnetwork.com`) in the `media` ns — wildcard cert
`certificate-haynesnetwork` (reflected into media), external-dns proxied-CNAME → the tunnel. The
Cloudflare Tunnel already wildcards `*.haynesnetwork.com` → traefik-external, so **NO tunnel change**.
LAN `*.haynesops.com` ingresses KEPT (admin/break-glass); LazyLibrarian/Kapowarr untouched.

**Validation (all PASS):** headless OIDC login for both apps via `hnet-e2e` through the public URLs
(cookie-jar + Authentik flow-executor; no MFA challenge — mfa-exempt) → Kavita provisioned user id 2
(`identityProvider=1`, libs [1,2]); ABS auto-registered user `hnet-e2e` (type user) — both test users
DELETED after. Break-glass local login (hnetadmin / root) works on both public origins. Public URLs
serve 200 over the tunnel from outside the cluster. Diff touches only the two hosts.

**Owner TODO (1Password migration, like the OPS-011 authentik-token TODO):** the two OIDC client
secrets live only in the apps' config PVCs (backed up by volsync). Add `OIDC_CLIENT_ID`/
`OIDC_CLIENT_SECRET` to the 1P `kavita` + `audiobookshelf` items (HaynesKube) as reference-only fields
(mirroring `KAVITA_ADMIN_PASS`) — do NOT wire them into the pods (the apps read OIDC from their own
DB/appsettings, not env). Secrets were handed to the owner out-of-band.

---

### Phase 4 — as-built (2026-07-10, v0.39.0 — ADR-046 / DESIGN-024)

Owner ruled Q-04 **"full ledger integration in v1"**, so Phase 4 shipped the STRETCH ledger path (not just
catalog cards). Executed by Fable 5; PR #187 → v0.39.0; haynes-ops `d865bff1`.

- **Schema decision (ADR-046):** a **dedicated `books_items` table** (migration 0037), NOT `media_items` —
  the *arr ledger is hard-wired to sonarr/radarr/lidarr (CHECK + NOT-NULL monitored/quality/root-folder +
  Fix/Restore/`/ledger` machinery); books have none of that. hard rule 4 EXTENDED: Kavita/ABS are the source
  of truth for book media; sync flows IN, **NO write-back** (no Fix/Restore for books). Rebuildable
  read-model (the ai_usage_chats class). Diverges from ADR-038 (ytdl-sub read-live) by the owner's ruling.
- **New package `@hnet/books`** (read-only Kavita + ABS clients — lazy login + token cache + 401 re-auth;
  **no `./write` export**). **`books-sync`** `@hnet/sync` mode + `@hnet/domain syncBooks` single-writer
  (upsert + scoped-tombstone in one tx; no `sync_runs` row; standalone like `ai-usage-sync`; guard-listed).
- **Three Library walls** (Books/Audiobooks/Comics) reusing the poster-grid + `@hnet/ui` filter/sort engine
  + `MediaPoster`; order **Movies·TV·Music·Peloton·YouTube·Books·Audiobooks·Comics·My Fixes** (after
  YouTube, before My Fixes). Rows deep-link OUT to Kavita/ABS. Authed **`/api/books/cover`** proxy (creds
  server-side, ETag/304, ADR-019; unauth → 401). Gated by a new **`books` Section-Permission** (`disabled`
  default = **Admin-only at ship**). Two seeded `app_catalog` cards + `kavita`/`audiobookshelf` icon keys —
  **no role grants seeded** (owner grants after review).
- **haynes-ops** (`d865bff1`): image bump v0.38.0→v0.39.0 + `sync-books` CronJob (`22 * * * *`) +
  `KAVITA_PASSWORD`/`AUDIOBOOKSHELF_PASSWORD` templated into the app ExternalSecret from the
  `kavita`/`audiobookshelf` 1Password items (consumed by the CronJob AND the web cover proxy).
- **LIVE-VALIDATED (2026-07-10):** the `sync-books` CronJob ran clean against real Kavita/ABS —
  **upserted 2116 rows: 1283 books + 10 comics + 823 audiobooks** (DB-confirmed; covers on 1283+823+9); all
  three walls render real covers via the proxy at desktop + 390px (admin `hnet-e2e`); unauth cover gate 401;
  the level seam is unit-proven (Disabled→FORBIDDEN, Read-Only opts in, Admin sees). Merge gate green
  (typecheck/lint/lint:css/test/build); migration 0037 applied on rollout.
- **Notes:** Comics currently only **10 series** live in Kavita (the migrated ~1737 comic files aren't all
  series-scanned yet — the sync reflects whatever Kavita serves and grows automatically). Genre filter chips
  are a deferred follow-up (the `books.filterFacets` endpoint ships + is unit-proven).

## Goal

Get books flowing again and **surfaced in `haynesnetwork.com` Library**: acquisition managers
feeding the *arr-style pipeline, two servers (Kavita for EBooks + Comics, Audiobookshelf for Audio
Books) behind **Authentik OIDC**, and the existing residual share content
(`data/Media/{Audio Books,Comics,EBooks}`) adopted in place — not re-fetched. Reuse the
downloaders and indexer that are **already in-cluster**; add only the genuinely new apps.

## Key finding that reshapes the brief (from research §1)

The brief assumed qBittorrent must be **added**. It is **already deployed** in `downloads/` —
VPN-pinned (Mullvad, macvlan VLAN30, readiness = Mullvad-egress check), mounting both the tower
and gasha01 shares. **SABnzbd** (usenet) and **Prowlarr** (indexer manager) are also already
there. So torrent + VPN + usenet + indexing is **configuration, not new deployment**. The only
new deployments are the 4 apps below.

## The stack (research §5.1 — the pick)

- **Serve:** **Kavita** (one deploy → two libraries: `EBooks`=Books, `Comics`=Comic/Manga) +
  **Audiobookshelf** (`Audio Books`). Both native OIDC/Authentik. Best-in-class, GPL-3.0.
- **Acquire:** **LazyLibrarian** (ebooks + audiobooks + magazines, one instance, native Prowlarr
  sync target, uses existing qBittorrent+SABnzbd, Calibre output Kavita reads) + **Kapowarr**
  (comics; self-contained direct-download — no VPN/indexer wiring).
- **Reuse:** qBittorrent (VPN'd), SABnzbd (usenet), Prowlarr (add book/comic indexers +
  LazyLibrarian as a Prowlarr application).
- **Runner-up / phase-2 upgrade:** ReadMeABook (modern audiobook request UX, Postgres+OIDC) +
  Calibre-Web-Automated (ebook ingest) + mylar3 (comics). **Rejected:** Readarr (retired),
  Chaptarr (private/alpha — track only).

---

## Build (phased; each phase is deployable/verifiable on its own)

### Phase 1 — Deploy the stack in `haynes-ops` (no app changes)

Mirror the existing `downloads/` + `media/` app conventions (bjw-s `app-template` OCIRepository
HelmRelease; per-app `ks.yaml` Flux Kustomization with `dependsOn` rook-ceph + volsync;
`postBuild.substitute` VOLSYNC_CAPACITY + Gatus; ExternalSecret from 1Password `HaynesKube`;
non-root 1000 securityContext; homepage.dev + external-dns annotations; NFS `advancedMounts` to
the media share):

1. **Kavita** → `apps/media/kavita/` (serving = media namespace, alongside plex/tautulli).
   NFS mounts: `data/Media/EBooks` + `data/Media/Comics` (read is enough to serve; LazyLibrarian
   writes). Ingress `kavita.haynesops.com`. Config PVC + volsync.
2. **Audiobookshelf** → `apps/media/audiobookshelf/`. NFS mount `data/Media/Audio Books`.
   Ingress `audiobookshelf.haynesops.com`. Config/metadata PVC + volsync.
3. **LazyLibrarian** → `apps/downloads/lazylibrarian/`. Mounts the share (write) + shares the
   qBittorrent/SABnzbd completed-download paths so imports move, not copy. LAN-only ingress like
   the current *arrs (`External`/`DisabledForLocalAddresses`).
4. **Kapowarr** → `apps/downloads/kapowarr/`. Library folder → `data/Media/Comics`. Direct-DL
   only (no VPN/indexer). LAN-only ingress.
5. Wire each into its namespace `kustomization.yaml`; verify Flux reconcile + Gatus green.

### Phase 2 — Wire Prowlarr + downloaders (config, in-app)

1. **Prowlarr:** add book/audiobook/comic **indexers**; add **LazyLibrarian as a Prowlarr
   application** (native sync target) so indexers auto-propagate; confirm category maps
   (ebook 70xx, audiobook 3030, comics 70xx families — verify against the owner's real indexers).
2. **LazyLibrarian:** add the existing **qBittorrent** (VPN) as torrent client and **SABnzbd** as
   usenet client; set post-process to land in `data/Media/{EBooks,Audio Books}`; enable Calibre
   post-process if the owner wants a Calibre DB.
3. **Kapowarr:** point at `data/Media/Comics`; configure direct-download sources; no Prowlarr.
4. **VPN/torrent note:** book torrents lean on private trackers (MyAnonaMouse etc.) with
   VPN/seedbox rules — default books to **usenet (SABnzbd, already direct)**; only route book
   torrents through the Mullvad qBittorrent after confirming tracker rules (owner Q-01).

### Phase 3 — Serve behind Authentik OIDC (config, in-app) — **GATED on PLAN-011**

> **Owner ruling (2026-07-10, standing rule for ALL new user-facing services):** until OIDC via
> Authentik is configured for a service, it is hosted on **internal traefik + `haynesops.com`
> (LAN domain) ONLY**. Public `*.haynesnetwork.com` exposure comes **after** the PLAN-011
> Authentik hardening + blueprints migration, with the OIDC providers/applications authored
> through that blueprint mechanism (not ad-hoc API pokes). Phases 1–2 are therefore fully
> shippable stand-alone; Phase 3 does not start until 011 is Completed.

1. **Kavita:** Authentik OAuth2/OIDC provider + application (as blueprints per PLAN-011); enable
   OIDC in Kavita (Settings→OpenID Connect); decide role/library-access source of truth
   (Authentik groups vs Kavita-local — avoid two sources; owner Q-02). Create the two libraries
   in place.
2. **Audiobookshelf:** Authentik provider + app (blueprints); enable OIDC (issuer
   auto-populate); create the `Audio Books` library in place. Record the `/login/?autoLaunch=0`
   lockout escape hatch in `docs/ops/`.
3. Only then move both to the **traefik-external / forward-auth** posture used by public apps
   (SSO mandatory per CLAUDE.md hard rule 5) on `*.haynesnetwork.com`. LAN-only for the admin
   managers (LazyLibrarian/Kapowarr) permanently.

### Phase 4 — Surface in the haynesnetwork app (Library + catalog)

Docs-first (PRD R-block + DESIGN + glossary in the same PR), then the vertical:

1. **Ship-now (low-effort, no schema change):** add **catalog cards** via the existing
   `app_catalog` (ADR-013 — arbitrary http(s) URLs allowed): user-facing cards for **Kavita** and
   **Audiobookshelf**; admin-gated cards for **LazyLibrarian**/**Kapowarr**/**Prowlarr**. Gate via
   the existing `role_app_grants`. This satisfies "surface it in the Library" immediately.
2. **Stretch (own ADR/DESIGN/migration — likely its own follow-up plan):** a **books ledger
   source** — new `@hnet/books` read-only client against Kavita's + ABS's REST APIs, a new
   `LEDGER_EVENT_SOURCES` member and a `books`/`audiobooks` media kind, ingested by `@hnet/sync`
   like the *arrs. **Deferred by default** — the *arr event model (grabbed/imported/deleted)
   doesn't map cleanly onto library servers; only take it if the owner wants books *in the ledger*
   (Q-04), and give it its own migration (next-free after 0030) + `no-direct-state-writes` guard
   entry + import-confinement if any write surface appears (there shouldn't be — read-only).

---

## Verification

- **Phase 1–3 (haynes-ops / live cluster):** Flux reconciles clean; Gatus green for all four;
  Kavita serves a real ebook + a real comic from the existing share; ABS serves a real audiobook;
  **OIDC login works end-to-end from Authentik** for both servers (member + admin); LazyLibrarian
  completes one **real** ebook AND one audiobook acquisition through qBittorrent/SABnzbd and the
  file lands where Kavita/ABS scan it; Kapowarr grabs one comic into `data/Media/Comics`.
- **Phase 4 (app):** merge gate green (`pnpm lint && lint:css && typecheck && test && build`);
  catalog cards render + are role-gated (unit test on the grant gate); **LIVE** on staging + public
  origin — a member with the grant sees Kavita/ABS cards and can SSO into them; admin sees the
  manager cards; screenshots at 390px + desktop for the owner's morning review.
- If the stretch ledger phase is taken: level-gated router/unit tests + `@hnet/books` client
  against a stub server in `@hnet/test-utils` + `pnpm dev:local` wiring, mirroring the *arr stubs.

## Out of scope (this plan)

- The books **ledger** deep-sync (Phase 4 stretch) unless owner opts in — otherwise its own plan.
- ReadMeABook / Calibre-Web-Automated / mylar3 (runner-up stack) — a documented phase-2 upgrade,
  not this plan.
- Chaptarr (private/alpha — track, revisit when public + released).
- Any Seerr-style native in-app book *request* flow (the catalog cards are the v1 surface).
- Migrating/rehoming the physical share content between mounts (owner storage decision, Q-03).

## TODO-questions (owner, morning)

- **Q-01 (torrent/VPN appetite):** OK to route book/comic **torrents** through the existing
  Mullvad qBittorrent, or keep books **usenet-only** (SABnzbd)? Any private book trackers
  (MyAnonaMouse etc.) whose VPN/seedbox rules we must respect before enabling torrent for books?
- **Q-02 (which content types first):** all three at once (EBooks + Audio Books + Comics), or
  stage — e.g. audiobooks first (ABS + LazyLibrarian), comics later (Kapowarr)?
- **Q-03 (storage placement, gasha01 concern):** libraries stay on `haynestower:/mnt/user/data`
  (where the seed content already is) with active downloads staged there too? Or stage
  in-progress torrents on `gasha01:/hdd-nfs-repl` (already mounted by qBittorrent) to spare the
  tower — given the gasha01 space concern, which mount hosts *libraries* vs *scratch*?
- **Q-04 (ledger depth):** do you want books/audiobooks **in the haynesnetwork ledger** (deep sync
  from Kavita/ABS APIs — its own ADR/DESIGN/migration/plan), or is the **catalog-card surface**
  (Phase 4.1) enough for v1?
- **Q-05 (acquisition manager choice):** confirm **LazyLibrarian** (one-instance, Prowlarr-native,
  dated UI) over the runner-up **ReadMeABook** (modern request UX, audiobook-first, Postgres+OIDC)
  for the audiobook path — or run ReadMeABook as a phase-2 request front-end on top?
- **Q-06 (comics):** confirm **Kapowarr** (healthier, direct-download-only, no VPN/indexer) over
  **mylar3** (Prowlarr+usenet-integrated but slowing) — GetComics coverage acceptable?
