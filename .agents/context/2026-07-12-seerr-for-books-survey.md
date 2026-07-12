# PLAN-033 — "Seerr for books": candidate survey + adopt-vs-build verdict

- **Date:** 2026-07-12
- **Author:** survey subagent (web research + read-only cluster recon). **No live config was
  changed anywhere; no grab was triggered; MyAnonaMouse was not contacted in any way** (all MAM
  facts come from `docs/ops/013-mam-books-acquisition.md` + `2026-07-11-mam-rules-scrape.md`).
  Cluster access was read-only (`kubectl exec cat/grep`, `context haynes-ops`, ns `downloads`).
- **For:** `.agents/plans/033-books-requests-wanted.md` (owner restated the need 2026-07-11
  late-eve: *"I'm really looking for a Seerr type app where you request these things"* — a
  request flow for BOOKS / EBOOKS / AUDIOBOOKS / COMICS the way Overseerr serves movies/TV; he
  has no Goodreads/Hardcover account). Feeds the **Books Automation Saga** (PLAN-032) adopt-vs-
  build decision.
- **Normative basis / prior art:** OPS-013 (the LL+MAM+Kapowarr as-built), PLAN-039/ADR-054 (the
  MAM compliance governor), `.agents/context/2026-07-11-books-list-sources-research.md` (the LL
  internals + list-engine recon this builds on), CLAUDE.md hard rules 4 (*arrs are source of
  truth), 5 (Authentik OIDC only), 6 (role/permission mutations audited in-tx).
- **Deployed build inspected (read-only):** `deploy/lazylibrarian` in ns `downloads`, image
  `linuxserver/lazylibrarian:version-40a389ea`, source at `/app/lazylibrarian/lazylibrarian/`,
  config `/config/config.ini` (103 lines), DB `/config/lazylibrarian.db`.

---

## 0. TL;DR

- **The landscape is real but thin, and every purpose-built "Seerr for books" is
  ebook+audiobook only — none covers comics.** The honest four candidates are **Libreseerr**,
  **Shelfarr**, **AudioBookRequest**, and **SeerrNG**; the mainline Seerr/Jellyseerr/Ombi have
  **no book support** in 2026.
- **Only ONE candidate can front OUR exact LazyLibrarian instance as a pure request broker:
  Libreseerr** (it drives LL's API, marks wanted, owns no deletes/imports, inherits our
  usenet-first + PLAN-039 governor for free). Every other candidate either **owns its own
  acquisition pipeline** (Shelfarr, AudioBookRequest — they *are* the *arr, with their own
  Prowlarr/download-client/imports; adopting one means running a **second** book stack parallel
  to LL+MAM+governor, breaking hard rule 4 and **bypassing the MAM compliance governor**) or
  needs a Readarr-family backend we don't run (SeerrNG → Bookshelf/Readarr).
- **LazyLibrarian ALREADY has native multi-user + a "request" surface** — a real `users` table
  with a per-user permission bitmask (guest/friend/admin), **trusted-header proxy auth**
  (`PROXY_AUTH` + `X-WEBAUTH-USER/EMAIL/FULLNAME` + `PROXY_REGISTER` auto-provision — the
  Authentik forward-auth pattern), and two thin "request" paths. But its "request" is weak: a
  low-privilege user's *Request to Download* button just **emails the admin** (no queue, no state,
  no audit), and the only real want-write is giving a user `perm_status` so they mark **Wanted
  directly with no approval gate**. No requested→approved→grabbed state machine, no per-request
  attribution, and its admin-panel UI is not a Seerr-style discovery experience.
- **Verdict = build the request flow into the Books Automation Saga (in-app), adopt nothing as
  the production requester.** Only an in-app build satisfies all four estate constraints at once:
  Authentik **OIDC** (not trusted-header), haynesnetwork's **Postgres roles + in-tx audit** (hard
  rule 6), a proper **request→approve→track state machine with attribution**, and the **MAM-cap
  throttle** the governor needs (Q-02 quota is a live compliance requirement, not a nicety). The
  build is **small**, because it reuses the LL API write/read seam PLAN-032 Track-2 already needs
  (`addbookbyisbn` / mark-wanted / status-read) and the metadata search PLAN-032 already scoped
  (Google Books key already in 1P). **Study Libreseerr's UX as a reference; do not deploy it.**
- **The wanted-not-on-disk view is a LazyLibrarian/Kapowarr *read* regardless of any requester**
  — decouple it and ship it first; it is the cheap, high-value half and needs no adopt decision.
- **Comics: nothing to adopt. No comic requester exists** — Kapowarr has no request front-end,
  and the archived Overseerr's Kapowarr request never shipped.

---

## 1. Q1 — What exists today as a "Seerr for books" (enumerated + evaluated)

### 1.1 LazyLibrarian's OWN built-in multi-user / request capability (pod-sourced)

LL is not single-purpose — it has a genuine multi-user layer, inventoried directly from the
deployed source:

- **User accounts are real.** `dbupgrade.py` L230 creates
  `users (UserID, UserName, Password, Email, Name, Perms INTEGER, HaveRead, ToRead, …)`. Accounts
  are gated by the `USER_ACCOUNTS` config bool (`configdefs.py` L42; **currently OFF** on our
  instance — single-admin, greenfield). `webServe.py` exposes `user_register` (L853),
  `user_login` (L959), `user_admin` (L1053), `user_update` (L859).
- **Permission levels are a bitmask** (`__init__.py` L97-116). The meaningful ones:
  `perm_search` (512 — search GoogleBooks/Goodreads for titles), `perm_status` (1024 — **change
  book status wanted/skipped**), `perm_download` (4096), plus per-media page perms
  (`perm_ebook` 64, `perm_audio` 32, `perm_comics` 8192). Composite roles:
  `perm_guest = download+series+audio+ebook+magazines+comics`;
  `perm_friend = guest + search + status`; `perm_admin = 65535`.
  **So a "friend" can search AND mark a title Wanted** — which is the closest thing to a request.
- **Two "request" paths, both thin:**
  1. **`request_book` (webServe.py L3462) — the low-privilege "Request to Download" button.**
     For a logged-in user it does **not** touch book status at all — it composes a message
     (title, author, requester name/email, IP) and **emails it to `ADMIN_EMAIL`**
     (`notifiers.email_notifier`). No queue, no DB row, no state, no audit — a glorified
     contact form. The user is told "you will receive a reply by email."
  2. **`perm_status` direct-want.** A friend-level user with `perm_status` flips a title to
     **Wanted directly** via the normal status control — **no approval gate**, no attribution
     beyond whatever the search flow stamps. It then rides LL's normal search → usenet-first
     `dlpriority` + the PLAN-039 governor (same engine OPS-013 documents).
- **Auth story — proxy header, not OIDC.** `webServe.py` L295-312: if `PROXY_AUTH` is set, LL
  reads the `PROXY_AUTH_USER` header (default **`X-WEBAUTH-USER`**), looks the user up, and if
  `PROXY_REGISTER` is set **auto-creates** them from `X-WEBAUTH-FULLNAME`/`X-WEBAUTH-EMAIL`. This
  is exactly the **Authentik proxy-provider / forward-auth outpost** trusted-header pattern (same
  family as Authelia). It is **not native OIDC** — LL never speaks OAuth; it trusts headers a
  reverse proxy injects. Config `[Proxy]` section exists (`configdefs.py` L85-92) but is **unset**
  on our instance. Native login is username/password (local accounts).
- **Coexistence:** it *is* the backend — zero collision by definition. Comics are covered
  (`perm_comics` + comics tab), but LL drives **its own** comic search, not Kapowarr.
- **Verdict:** the bones exist (users, per-media perms, Authentik-frontable proxy auth) and it
  is the *only* candidate with any comics multi-user surface — but the request UX is a dated
  admin panel with no real request/approve/track/audit, the low-priv path is email-the-admin,
  and exposing LL's admin UI to members is risky. Usable as a **fallback**, not the product the
  owner pictured.

### 1.2 Libreseerr (`github.com/zamnzim/Libreseerr`) — the only true LL front-end

- **Media:** ebook + audiobook. **No comics.**
- **Backend:** **explicitly LazyLibrarian** (+ Readarr + Bookshelf) — *"Confirmed compatible with
  LazyLibrarian."* Drives the backend's API to submit a request and mark it wanted; **owns no
  deletes/imports/library management** — a pure request-broker layer. It polls the backend for
  status (Processing / Downloading / Completed / Error).
- **Auth:** local accounts + **OIDC** (with optional auto-provision + IdP-redirect bypass) + LDAP.
  OIDC means it *could* sit behind Authentik.
- **Request flow:** request → sent straight to LL → wanted. **No admin approval workflow** (flows
  directly; there is no requested→approved gate).
- **State/API:** stores everything in **flat JSON files** (`config.json`, `requests.json`,
  `users.json`) — **no external REST API** to read request state from another app.
- **Maturity:** ~58 stars, 5 forks, ~124 commits, v0.9.0 (Apr 2026), effectively **single
  maintainer**. Young; thin bus factor.
- **Verdict:** the closest architectural fit (fronts our exact LL, no pipeline collision) and the
  best *reference* for the discovery-search-over-LL UX — but its identity/roles/attribution live
  in its **own JSON store outside** haynesnetwork's Postgres audit model (against hard rule 6's
  intent), it has **no approval gate** (against Q-01/Q-02 needs), and it duplicates the roles
  surface haynesnetwork already owns. **Marginal adopt at best; better as a UX reference.**

### 1.3 Shelfarr (`github.com/Pedro-Revez-Silva/shelfarr`) — polished, but its own *arr

- **Media:** ebook + audiobook. **No comics.**
- **Backend:** its **OWN acquisition pipeline** — searches indexers via Prowlarr/Jackett/NZBHydra2,
  downloads via qBittorrent/Deluge/Transmission/SABnzbd/NZBGet, plus **direct sources (Anna's
  Archive, Z-Library, LibriVox)**; delivers into Audiobookshelf / BookOrbit / Grimmory. It does
  **not** drive LazyLibrarian or Readarr — **it *is* the book *arr.**
- **Auth:** **OIDC/SSO with Authentik and Keycloak named explicitly**, TOTP 2FA, RBAC — the
  strongest auth story of the set.
- **State/API:** REST `/api/v1` with **scoped per-user tokens**; exposes request states + wanted
  backlog. Best programmatic surface of the set.
- **Maturity:** ~240 stars, 27 forks, v0.34.2 (2026-07-10), **110 releases** — the most active and
  polished candidate. Ruby.
- **Verdict:** the best *software*, but the **worst coexistence fit for us.** Adopting Shelfarr
  means running a **second, parallel book-acquisition stack** with its own Prowlarr config, its
  own qBittorrent categories, and its own MAM wiring — it would **bypass the PLAN-039 governor
  entirely** (unbounded member demand hitting MAM with no unsatisfied-cap enforcement — a direct
  compliance risk per OPS-013 §6), duplicate everything OPS-013 built, and violate hard rule 4
  (the *arrs are the source of truth; we do not stand up a rival). **Do not adopt** unless we
  intend to *replace* LL+MAM wholesale — which we do not.

### 1.4 AudioBookRequest (`github.com/markbeep/AudioBookRequest`)

- **Media:** **audiobook ONLY** (no ebook, no comic).
- **Backend:** its **own pipeline** — Prowlarr for search + its own download client, Audible for
  discovery, Audiobookshelf for library check/scan. *"Not intended as a full replacement for
  Readarr/Chaptarr."* Does not drive LL.
- **Auth:** **OIDC** + local (Admin / Trusted / User tiers).
- **State/API:** REST endpoints; request backlog visible.
- **Maturity:** ~678 stars, 24 forks, v1.10.5 (May 2026), 316 commits — the **healthiest
  community** of the set. Python/Jinja, GPL-3.0, single maintainer.
- **Verdict:** healthiest project but **audiobook-only** (doesn't meet the ebook/comic need) and
  **own-pipeline** (same governor-bypass collision as Shelfarr). Not a fit as the primary.

### 1.5 SeerrNG (`github.com/snapetech/seerrng`) — Seerr fork with books

- **Media:** movies/TV/music/ebook/audiobook. **No comics.**
- **Backend for books:** **Bookshelf** (Hardcover variant recommended) / Readarr-compatible APIs
  — **not LazyLibrarian.** Needs a Readarr-family backend we don't run.
- **Auth:** Plex/Jellyfin/Emby media-server auth; OIDC not clearly documented.
- **State/API:** has an API (`/api-docs`), request states, approval workflow.
- **Maturity:** ~6 stars, 1 fork — a very obscure fork; book support self-described as *"usable
  but evolving."* Bus-factor risk.
- **Verdict:** would require standing up **Bookshelf/Readarr** (a second acquisition stack →
  same collision as Shelfarr) *and* it is an obscure 6-star fork. **Not a fit.**

### 1.6 The mainline requesters — no books in 2026

- **Ombi:** movies/TV/music only. Book requests remain an **unbuilt feature request**, explicitly
  parked "until Readarr matures" — and Readarr was **retired**, so this will not arrive.
- **Overseerr:** **archived by its owner 2026-02-15.** Dead.
- **Jellyseerr → Seerr:** Overseerr + Jellyseerr **merged into "Seerr"** (`seerr-team/seerr`,
  Feb 2026). Book support is **still an open issue** (#1682 / #955); a **music** preview image
  exists in testing (`seerr/seerr:preview-music-support`) but **books are not even in preview**.
  No book request path on mainline Seerr today.

### 1.7 Backends (not requesters — context for the saga)

- **Readarr — retired** (Servarr team, 2025; unusable metadata). Existing installs still run.
- **Bookshelf** (`pennydreadful/bookshelf`) — the actively-maintained Readarr revival (Goodreads-
  or Hardcover-tagged metadata). A *backend* (the *arr), not a requester.
- **Chaptarr** — Readarr fork distributed as **closed-source Docker images** ("code too messy to
  publish"), crippled metadata server, no BYO metadata. **Avoid** (unauditable).
- **rreading-glasses** — drop-in replacement for Readarr's dead metadata service. Backend plumbing.

These are relevant only if the saga ever chose a Readarr-family backend — which it has not; LL +
Kapowarr are the acquisition layer.

---

## 2. Q2 — The wanted-not-on-disk view (backlog read)

**Key architectural finding: the wanted view is decoupled from the request front-end. It is
always a *read* of LazyLibrarian (+ Kapowarr) state, whatever requester (if any) sits on top.**

- **LazyLibrarian** holds the real, queryable backlog: `books.Status = 'Wanted'` /
  `books.AudioStatus = 'Wanted'`, with the `Requester` / `AudioRequester` provenance columns
  (the list/user that wanted it — see the PLAN-032 recon). Readable via LL's **API** (`api.py`)
  and directly from `lazylibrarian.db`. haynesnetwork already has the read-only-LL access pattern
  from PLAN-023's books-ledger sync, so mirroring wanted state is a solved shape (mirror-only,
  hard rule 4 extended — no write-back for the *view*).
- **Kapowarr** (comics) exposes wanted/monitored volumes+issues over its own *arr-style API — the
  comics half of the backlog read.
- **The candidates' own state:** Shelfarr and AudioBookRequest expose request state via
  `/api/v1`; **Libreseerr does not** (JSON files, no external API) — but since Libreseerr just
  marks wanted **in LL**, haynesnetwork would read the *same* backlog **from LL directly** anyway.
  So a requester adds nothing to the read-view problem.

**Answer:** yes — the top LL-compatible path (LL native + Libreseerr) exposes the backlog, and
haynesnetwork can read it, **via LazyLibrarian's API/DB, not via the requester.** Build the wanted
view as a LL/Kapowarr read; it is requester-independent and should ship first.

---

## 3. Comparison matrix

| Candidate | ebook | audio | comic | Backend it drives | Fronts OUR LL? | Auth | Own API / state read | Owns deletes/imports? | Governor-safe? | Maturity (stars / last rel / bus factor) |
|---|---|---|---|---|---|---|---|---|---|---|
| **LL native (ours)** | Y | Y | Y* | *is* LazyLibrarian | **IS LL** | local + **proxy-header (Authentik forward-auth)**; no OIDC | LL API/DB (wanted state) | no (backend) | **Yes** (native path) | mature app, dated UX; request = email-admin / direct-want, no approval/audit |
| **Libreseerr** | Y | Y | N | **LazyLibrarian** / Readarr / Bookshelf | **YES (broker)** | local + **OIDC** + LDAP | JSON files, **no ext API** | **no** | **Yes** (rides LL) | ~58★, v0.9.0 Apr'26, solo — young |
| **Shelfarr** | Y | Y | N | **its own** (Prowlarr + DL clients + direct src) → ABS/Grimmory | no | **OIDC (Authentik/Keycloak)**, 2FA, RBAC | **REST /api/v1**, per-user tokens | **YES (own *arr)** | **NO — bypasses governor** | ~240★, v0.34.2 Jul'26, 110 rel — most active |
| **AudioBookRequest** | N | Y | N | **its own** (Prowlarr + DL client) → ABS | no | **OIDC** + local (3 tiers) | REST endpoints | **YES (own *arr)** | **NO — bypasses governor** | ~678★, v1.10.5 May'26 — healthiest community |
| **SeerrNG** | Y | Y | N | **Bookshelf / Readarr** (not LL) | no | Plex/Jellyfin/Emby; OIDC unclear | API `/api-docs` | via backend | needs 2nd stack | ~6★, obscure fork — evolving |
| **Ombi** | N | N | N | — (books unbuilt) | — | local/Plex/OIDC | — | — | — | books never shipped; waiting on dead Readarr |
| **Seerr (Jellyseerr+Overseerr)** | N | N | N | — (books open issue) | — | Plex/Jellyfin/Emby + OIDC | API | — | — | books not even in preview; Overseerr archived Feb'26 |

\* LL native covers comics via its *own* comic search, **not Kapowarr**.

---

## 4. Q3 — Adopt-vs-build verdict

**Recommendation: adopt nothing as the production requester → build the request flow into the
Books Automation Saga (in-app), reusing the LL API seam. Keep Libreseerr as a UX reference only.**

### Why not adopt

Rank the estate constraints: **(a)** Authentik **OIDC** for user-facing auth (hard rule 5);
**(b)** roles + **in-transaction audit in haynesnetwork's Postgres** (hard rule 6); **(c)** the
**MAM compliance governor** must gate all member-driven demand (OPS-013 §6 / PLAN-039 — the
unsatisfied cap is a real account-safety limit); **(d)** hard rule 4 — LL/Kapowarr are the single
source of truth, we do not stand up a rival acquisition stack.

- **Shelfarr / AudioBookRequest fail (c) and (d) hard.** They *are* book *arrs — own Prowlarr,
  own download clients, own imports, own MAM wiring — so adopting one runs a **second acquisition
  pipeline in parallel to LL+MAM+governor that the governor cannot see or throttle.** That is the
  single biggest compliance risk in the whole books program (unbounded member requests → MAM
  grabs with no unsatisfied-cap enforcement). Non-starter, however polished Shelfarr is.
- **SeerrNG fails (d)** (needs Bookshelf/Readarr, a second stack) **and** is a 6-star fork.
- **Libreseerr is the only clean coexister** (broker over our LL, no deletes/imports, inherits
  the governor for free) **but fails (b)** — its roles/attribution/audit live in its own JSON
  store, outside haynesnetwork's Postgres audit model — has **no approval gate** (fails Q-01/Q-02),
  and duplicates the identity surface haynesnetwork already owns. Deploying it means a second
  login, a second roles model, and un-audited want-writes. Marginal at best.
- **LL native** could technically serve members behind Authentik forward-auth (`PROXY_AUTH` +
  `X-WEBAUTH-USER` + `PROXY_REGISTER`, friend perms → mark Wanted) with **zero new software** —
  but it is trusted-header not OIDC, has **no approval/audit/state machine**, its low-priv request
  is email-the-admin, and exposing LL's admin UI to members is a poor member experience and a
  surface risk.

### Why build (and why it is small)

Only an **in-app build** satisfies (a)+(b)+(c)+(d) simultaneously: OIDC via Authentik (already
wired for every haynesnetwork surface), roles + in-tx audit in Postgres (hard rule 6, the Bulletin
action-grant precedent for request/approve), a proper **requested→approved→grabbed→on-disk→denied
state machine with per-request attribution**, and a **request quota/throttle** that plugs into the
governor (Q-02). Crucially it is **not greenfield**:

- The **write seam already exists in the saga's plan.** PLAN-032 Track-2 already builds the
  LL-write machinery (`addbookbyisbn` / mark-wanted) + metadata search (Google Books key in 1P).
  The request approval is *the same write* PLAN-033 §Shape-2 describes — approve → write the want
  into LL → it rides usenet-first + the governor. So requests are a **small addition on top of
  list-automation Track-2**, not a new pipeline.
- The **read seam (wanted view) is requester-independent** (§2) and should ship first as a
  LL/Kapowarr mirror — cheap, high-value, no adopt decision needed.
- **Reference, don't adopt, Libreseerr:** copy the *pattern* (search a metadata source → show
  results → one-click request → poll backend status), implemented with haynesnetwork's own OIDC,
  roles, audit, and the Postgres request rows.

### Where it lives

Per the owner's lean (PLAN-032), the durable acquisition logic (LL API client, metadata search,
governor-aware throttle) belongs to the **standalone books-automation application**; haynesnetwork
owns the **user-facing request UI + approval + attribution/audit + the wanted view** and calls the
saga app's API. The request write-back into LL is the **new confined write surface**
(`@hnet/books/write`) PLAN-033 §Shape-2 flagged — its own ADR + import-confinement guard.

---

## 5. Q4 — Comics honesty

**No requester covers comics / Kapowarr. Plainly: there is no "Seerr for comics."**

- Every purpose-built book requester surveyed (Libreseerr, Shelfarr, AudioBookRequest, SeerrNG) is
  **ebook + audiobook only** — none integrates Kapowarr or Mylar.
- **Kapowarr has no request front-end.** It is a *arr-modeled comic manager (add a volume → it
  tracks/grabs issues); there is no member-facing request/discovery layer for it.
- The one historical attempt — an Overseerr "Kapowarr support" discussion (#3766) — **never
  shipped, and Overseerr is now archived (2026-02-15).**
- **LL native** is the *only* thing here with a comics multi-user perm (`perm_comics` + comics
  tab), but it drives **LL's own comic search, not Kapowarr** — so it doesn't help the Kapowarr
  library either.
- **Implication:** comics requests can only come from an **in-app build that writes to Kapowarr's
  API** (add-volume / monitor), as a **later saga increment**. There is nothing to adopt. Near
  term, comics stay on Kapowarr volume-completion + manual adds (as PLAN-032 already scoped).

---

## 6. Recommended next steps for the saga (what to do with this)

1. **Ship the wanted-not-on-disk VIEW first** as a LL+Kapowarr read (mirror-only; hard rule 4
   extended). Requester-independent, high value, no adopt decision. Uses the existing read-only LL
   access from PLAN-023.
2. **Build the request FLOW in-app**, layered on PLAN-032 Track-2's LL-write machinery: OIDC +
   Postgres roles/audit + request state machine + approval + governor-aware quota (Q-02). New
   confined write surface `@hnet/books/write` (own ADR).
3. **Do not deploy any candidate.** Study Libreseerr for the UX pattern only.
4. **Comics:** build-only, later increment (write to Kapowarr's API). No adopt path exists.
5. If a **zero-build stopgap** is ever wanted before the saga app lands: LL native multi-user
   behind Authentik forward-auth (`PROXY_AUTH`/`X-WEBAUTH-USER`/`PROXY_REGISTER`, friend perms) is
   the fallback — but flag its no-approval/no-audit/dated-UI limits and the risk of exposing LL's
   admin UI to members.

---

## Sources

- **Cluster (read-only, `haynes-ops` / ns `downloads`):** `deploy/lazylibrarian`
  `/app/lazylibrarian/lazylibrarian/{__init__.py,webServe.py,configdefs.py,dbupgrade.py,multiauth.py,auth.py}`,
  `/config/config.ini`. LL perms bitmask `__init__.py` L97-116; `request_book` `webServe.py` L3462;
  proxy-auth `webServe.py` L295-312; `[Proxy]` defaults `configdefs.py` L85-92; `users` schema
  `dbupgrade.py` L230; `USER_ACCOUNTS` `configdefs.py` L42.
- Libreseerr (LL/Readarr/Bookshelf, OIDC/LDAP, JSON store, no approval): https://github.com/zamnzim/Libreseerr
- Shelfarr (own pipeline, OIDC Authentik/Keycloak, /api/v1, ABS/Grimmory): https://github.com/Pedro-Revez-Silva/shelfarr · https://shelfarr.org/
- AudioBookRequest (audiobook-only, own pipeline, OIDC): https://github.com/markbeep/AudioBookRequest · https://docs.elfhosted.com/app/audiobookrequest/
- SeerrNG (Seerr fork + books, Bookshelf/Readarr backend): https://github.com/snapetech/seerrng
- Ombi (no book support; waiting on Readarr): https://features.ombi.io/suggestions/120488/implement-ebook-requests · https://features.ombi.io/suggestions/133588/support-for-lazylibrarianreadarr
- Seerr merge + book support status (open, not in preview): https://docs.seerr.dev/blog/seerr-release/ · https://github.com/seerr-team/seerr/issues/1682 · https://store.elfhosted.com/blog/2026/02/17/overseerr-and-jellyseerr-merge-into-seerr/
- Overseerr archived (2026-02-15) + Kapowarr request discussion (never shipped): https://github.com/sct/overseerr/discussions/3766
- Readarr retired + Bookshelf revival + Chaptarr closed-source concern: https://github.com/pennydreadful/bookshelf · https://lemmy.world/post/43516286 · https://dietpi.com/forum/t/readarr-has-been-retired-what-about-lazylibrarian-instead/24105 · https://feedback.ultra.cc/p/readarr-is-retired-but
- Kapowarr (comics *arr, no request layer): https://noted.lol/kapowarr/ · https://store.elfhosted.com/product/kapowarr/
- MAM compliance facts: `docs/ops/013-mam-books-acquisition.md` + `.agents/context/2026-07-11-mam-rules-scrape.md` (no live MAM access performed for this doc).
