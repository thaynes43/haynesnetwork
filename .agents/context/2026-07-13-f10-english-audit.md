# 2026-07-13 — F-10 English-language audit — RUN LOG (BLOCKED on kubectl/Omni auth outage)

**Status: NOT EXECUTED.** The owner-ordered library-wide English audit (Audiobooks / EBooks /
Comics) could not run this session. Every path to the live media estate is closed by the
kubectl/Omni auth outage combined with no locally-available app credentials. This note is the
run log: what was tried, the reachability facts it established (useful to the next run), the
method (unchanged, staged for the post-re-auth run), F-09 leftover status from records, the
last-known LL/governor state, and the owner prerequisites to unblock.

**Zero changes were made to the media estate** — no quarantine moves, no LL queue entries, no
MAM/qBittorrent/Prowlarr touches, no rescans. Every hard constraint is satisfied vacuously.

---

## 1. The blockage (evidence)

### 1a. kubectl / Omni auth is dead — interactive-only, not repairable here
- `~/.kube/config` has two contexts, **both** `oidc-login get-token` (interactive browser):
  - `haynes-ops` → issuer `https://haynes.na-west-1.omni.siderolabs.io/oidc`
  - `haynes-edge` → issuer `https://omni.haynesops.com/oidc`
  - No static-token / client-cert user exists on either.
- Cached token `~/.kube/cache/oidc-login/f5b8…eccf` is **expired** (`exp 1783956966`, ~8.5 h stale
  at run time `1783987582`). `kubectl version` / `get ns` / `get pods` all **hang** (the exec
  plugin falls through to `authcode-browser`, waiting on `0.0.0.0:8000` for a browser that will
  never come) — the exact `authcode-browser … context deadline exceeded` outage the brief names.
- Per the brief: **do not attempt auth repair.** Confirmed dead, moved on.
- Consequence: **no `kubectl exec`** (⇒ no reading epub OPF `dc:language`, no inspecting on-disk
  filenames / narrator markers, no moving files to quarantine, no triggering scans on the pods)
  and **no `kubectl port-forward`** (⇒ internal-only services unreachable).

### 1b. No cluster network from the WSL host
- `getent hosts kavita.media.svc.cluster.local` (and other `*.svc.cluster.local`) do not resolve.
  There is no in-cluster path even for services that have no public ingress.

### 1c. No app credentials available locally
- `.env.local` carries only `DATABASE_URL`, `BETTER_AUTH_URL`, `OIDC_DISCOVERY_URL` — nothing for
  the book apps.
- `packages/books/src/config.ts` + `.env.example`: the app authenticates to Kavita as **`hnetadmin`**
  and ABS as **`root`**, with `KAVITA_PASSWORD` / `AUDIOBOOKSHELF_PASSWORD` sourced from the
  **1Password `kavita` / `audiobookshelf` items → cluster ExternalSecret**. Those passwords are
  not present in any local env, and there is **no `op` (1Password) CLI** installed/authed on this
  host. No cached Kavita/ABS/LL API keys, tokens, or passwords anywhere in `~` or shell history.

### 1d. Reachability probe results (the useful part for next run)
| Endpoint | Result | Notes |
|---|---|---|
| `https://kavita.haynesnetwork.com/api/health` | **200** | only open endpoint; all data needs API key/JWT |
| `https://kavita.haynesnetwork.com/` | 200 | OIDC-gated UI |
| **`https://audiobookshelf.haynesnetwork.com/status`** | **200** | **correct ABS host**; `serverVersion 2.35.1`, `authMethods [local, openid]`, `authOpenIDAutoLaunch:true` |
| `https://audiobookshelf.haynesnetwork.com/api/libraries` | **401** | needs bearer token |
| `https://abs.haynesnetwork.com/…` | **000** | **wrong host** — does not resolve/serve; the brief/polish-loop's loose "abs.haynesnetwork.com" should read **`audiobookshelf.`** |
| `lazylibrarian` / `prowlarr` / `qbittorrent` / `kapowarr` `.haynesnetwork.com` | **000** | **no public ingress** — internal-only, need cluster access |
| `https://haynesnetwork.com/` | 307 | OIDC redirect |

**Net:** the two reachable book apps (Kavita, ABS) are 401 without credentials I don't have;
LazyLibrarian (the only sanctioned re-grab surface) has no public route at all. Detection AND
remediation are both blocked.

---

## 2. Method (unchanged — staged for the post-re-auth run)

Nothing about the proven method changed; it simply needs cluster/app access to run.
- **EBooks:** read `dc:language` from each epub's zip OPF (the Matilda/Maas sweep-script pattern);
  flag azw3-only titles (invisible to Kavita); check **series folders file-by-file** (Kavita merges
  all files in a series folder into one series — one foreign file poisons the series; a series-level
  language tag is not sufficient — the Matilda lesson).
- **Audiobooks (ABS):** `metadata.json` + ID3/publisher heuristics (**HörbucHHamburg = German tell**)
  + track-name language.
- **Comics (Kavita):** filename / ComicInfo metadata pass.
- **Remediate (field-proven loop):** quarantine the foreign copy under `books/quarantine/<concern>/`
  (**move + rescan, never delete**; one subfolder per concern, mirroring `german-audio/` and
  `f09-corrupt/` / `f09-originals/`) → LL English re-grab (**keyed GB volume-id → `addBook` →
  `queueBook`/`searchBook`, with mandatory 503 retry/backoff** — GB `backendFailed` bursts hit keyed
  calls too) → Kavita and/or ABS rescan. **LL is the only re-grab surface**; usenet-first works now,
  MAM re-engages itself when the governor reopens the gate.
- **Ambiguity rule:** quarantine only clear-cut foreign items (definitive language evidence);
  bilingual/unclear → owner question, untouched.

---

## 3. Audit results — all blocked

| Kind | Scanned | Foreign found | Quarantined | Re-grabs queued | Ambiguous-left-alone |
|---|---|---|---|---|---|
| Audiobooks (ABS) | 0 (BLOCKED) | — | — | — | — |
| EBooks (Kavita) | 0 (BLOCKED) | — | — | — | — |
| Comics (Kavita) | 0 (BLOCKED) | — | — | — | — |

- **azw3-only strays:** not enumerable without file/API access — deferred to next run.
- **Empty folders:** not enumerable — deferred.
- **Old-format duplicates beside fresh imports:** not enumerable — deferred.
- No fabricated findings: every figure above is honestly zero/blocked.

---

## 4. F-09 leftover status (from records — NOT re-verified live this run)

Sourced from `2026-07-11-polish-loop.md` (F-09) and `2026-07-13-session-5-wrap.md`; could not be
re-checked against the estate this session.
- **3 zip-corrupt quarantined epubs** in `books/quarantine/f09-corrupt/`: **Skyward**,
  **Sweet and Deadly** (0-byte), **Skin in the Game** → English re-grabs **still to be queued**
  (the session-5 wrap's LL retry queue lists only the ToG/Maas items, not these three).
  **Could not queue** this run (LL unreachable). Re-grab candidates for the next run.
- **7 other-defect epubs, untouched** (a distinct defect class): 5× "Unsupported EPUB version 1.0"
  package attributes + 2× EPUB3 nav-structure. Documented as their own future polish item.
- **Backups** of all F-09-touched originals: `books/quarantine/f09-originals/`.
- `Foundation.epub` thumbnail nit (valid JPEG; Kavita hands the OPF-guide XHTML to libvips) — left
  untouched, reads fine; fix = set/lock cover in Kavita UI.

---

## 5. LL / governor — last-known state (from records, NOT observed this run)

I could not reach LazyLibrarian or the governor (internal-only; kubectl dead), so nothing below was
observed — it is the carried-forward state, recorded so the next run knows the baseline:
- **MAM gate CLOSED** post-Maas-batch (~19 torrents in `books-mam`, unsatisfied > 15, maturing
  ~Tue eve; the governor reopens it itself). Usenet flows regardless.
- **LL retry queue** (on LL's 6h cycle): Throne of Glass bk1 (epub + audio), Heir of Fire audio,
  Kingdom of Ash epub. **Do not disturb** (unchanged — nothing was touched).
- The `No ebook-convert found` calibre gap in LL's image persists (list conversion candidates as
  findings; never attempt conversion) — no candidates gathered this run.

---

## 6. Owner questions / prerequisites to unblock (next run)

- **Q-01 (the unblocker):** Owner re-auth of Omni/kubectl is required — an interactive
  `oidc-login` browser flow (the owner did this earlier in session 5 via `! kubectl …`). That single
  action restores `kubectl exec` (file access for OPF/quarantine) **and** in-cluster reach to
  LazyLibrarian, and lets the F-10 method run start-to-finish. **Re-dispatch F-10 after re-auth.**
- **Q-02 (hardening, owner's call):** consider a non-interactive read path for audit agents so a
  future Omni outage doesn't fully block a read-plus-LL-queue audit — e.g. surface the Kavita/ABS
  API keys (or an `op` service-account token scoped to `kavita`/`audiobookshelf`) into a gitignored
  local env. Optional.
- **Q-03 (doc hygiene):** the ABS public host is **`audiobookshelf.haynesnetwork.com`**, not
  `abs.haynesnetwork.com` (the latter 000s). Worth correcting in the polish-loop/F-10 shorthand so
  the next agent doesn't chase the dead host.

---

## 7. What was NOT done (constraints honored trivially)

No MAM grabs, no qBittorrent adds, no Prowlarr MAM-indexer toggle, no LL retry-queue disturbance,
no quarantine moves, no rescans, no deletions — the estate was never reached, let alone modified.
No auth repair attempted. No app code / haynes-ops / other plans / HANDOFF touched. No release.
