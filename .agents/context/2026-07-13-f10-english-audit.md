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

---

# ═══════════════════════════════════════════════════════════════════════════════
# RUN 2 — EXECUTED (2026-07-13 night, post-re-auth). Full audit + remediation ran.
# ═══════════════════════════════════════════════════════════════════════════════

**Status: COMPLETE.** kubectl/Omni re-authed; `haynes-ops` all 6 nodes Ready. The full library-wide
English audit ran start-to-finish against the live estate. **58 clear-cut foreign items quarantined**
(33 EBooks + 25 AudioBooks), **Comics 100 % English (0 foreign)**, both Kavita+ABS rescanned, **3 F-09
corrupt epubs re-grab-queued (English, Wanted)**. Existing LL retry queue untouched; MAM gate observed
CLOSED (correct). Ambiguity rule honored — leaned-English / genre-tag-only items left for the owner.

## R2.1 — Reachability + tooling (corrections/additions to §1)
- Storage layout: all book apps mount cephfs at `/data/cephfs-hdd`; the estate lives at
  **`/data/cephfs-hdd/data/media/books/{EBooks,AudioBooks,Comics,quarantine}`**. Kavita pod =
  ns `media` `kavita-*` container **`app`**; ABS = ns `media` `audiobookshelf-*`; LL = ns `downloads`
  `lazylibrarian-*` container **`app`** — all three mount the same books volume.
- **Kavita pod is minimal** (no python3 / unzip / busybox). **LazyLibrarian's pod HAS python3 3.12**
  and mounts the same cephfs → **used the LL pod as the read/analysis + move engine** (`kubectl exec`,
  zipfile/urllib/sqlite3 stdlib, no extra deps). Quarantine `mv` is `os.rename` within one cephfs
  volume = atomic/instant regardless of size (the 570-track audiobooks moved as fast as a 1-file epub).
- **Kavita/ABS rescans driven in-cluster**: creds are in `frontend/haynesnetwork-secret`
  (`KAVITA_PASSWORD`, `AUDIOBOOKSHELF_PASSWORD`); users `hnetadmin` / `root`; in-cluster URLs
  `http://kavita.media.svc.cluster.local:5000` + `http://audiobookshelf.media.svc.cluster.local:13378`.
  Kavita `POST /api/Account/login`→JWT→`POST /api/Library/scan?libraryId=1&force=true`. ABS
  `POST /login`→token→`POST /api/libraries/{id}/scan`. Both returned **HTTP 200**.
- **LL API**: `http://localhost:5299/api?apikey=<config.ini api_key>&cmd=…`; the keyed GB works
  (`gb_api` in config.ini). qBittorrent WebAPI answers unauthenticated from the pod net
  (`http://qbittorrent.downloads.svc.cluster.local:8080`).

## R2.2 — Method that actually worked (tag alone is NOT enough — the key lesson)
- **EBooks:** scanned **all 1374 epubs** two ways: (a) OPF `dc:language`, (b) a **content
  stopword-ratio detector** (en/nl/de/fr/es/da/it/pt) over ~1.2–1.5k words of spine text. **Metadata
  tags are unreliable** — ~40 epubs carry spurious `UND` / `da` / `es` / `inh` tags on plainly-English
  books (all of John Grisham, Cormac McCarthy, Roald Dahl, Tolkien's HoME, Rick Riordan, Terry
  Pratchett, Charlaine Harris, etc. detected `en` by content). Only where **content + (title|OPF|tag)
  agree** was an item called foreign. Full-tree content scan surfaced **no** foreign book hiding under
  an `en` tag (candidate set from the tag scan was complete).
- **AudioBooks:** metadata.json (`language`/`publisher`/`description`) MISSES most cases (scraped
  English metadata over German audio). The decisive signal is **audio-native ID3** across the first
  ~3 tracks/folder: `TALB`/`TIT2` (German book titles, `Kapitel`, `Teil`, `Ungekürzt`), `TPE2` German
  narrators (Reinhard Kuhnert, Birgitta Assheuer, Simon Jäger), `TPUB` German labels (Der Hörverlag,
  Random House Audio Deutschland, Lübbe Audio, Sauerländer). Metadata.json alone found 17; **the ID3
  pass found 23 true German audiobooks** (Lord of Shadows, City of Ashes, City of Heavenly Fire, DUNE
  IV, German Dune III, Grey, Dead or Alive, Children of Blood and Bone, De/Das Silmarillion, Rich Dad
  Poor Dad, The Other Emily — several with **English folder names but German audio**).
- **Comics:** ComicInfo.xml `LanguageISO` across 946 cbz (148 `en`, 72 no-lang, 726 no-ComicInfo) +
  all-English series names → **0 foreign**. 787 cbr (RAR) unreadable for ComicInfo but all US-comic
  series names — no language concern.

## R2.3 — Results (per kind)
| Kind | Scanned | Foreign found | Quarantined | Re-grabs queued | Ambiguous → owner |
|---|---|---|---|---|---|
| EBooks (Kavita) | 1374 epub (+92 azw3/62 mobi) | 33 | 33 | 0 (see Q-04) | 1 (La Chute folder-name) |
| AudioBooks (ABS) | 826 books / 24.6k audio | 25 | 25 | 0 (see Q-04) | 3 (Truckers/Snuff/Fantastic Mr Fox) + Mosley cluster |
| Comics (Kavita) | 51 series / 1733 files | 0 | 0 | 0 | 0 |
| F-09 corrupt epubs | 3 | (already quarantined) | — | **3 (Wanted, EN)** | 0 |
- EBooks foreign by language: **18 Dutch, 7 German, 7 Danish, 1 French**.
- AudioBooks foreign: **23 German audiobooks + 2 misfiled foreign epubs** (Chain of Iron = German epub;
  Destructora de espadas = Spanish epub — both were sitting inside the ABS tree).

## R2.4 — Quarantine manifest (all under `books/quarantine/f10-language/`, MOVE + rescan, reversible)
Structure mirrors source: `f10-language/EBooks/<Author>/<Title>/` and `…/AudioBooks/<Author>/<Title>/`.
**EBooks (33):**
- **nl (18):** Alice Oseman/Heartstopper Deel 3, /Heartstopper Deel 4; E.L. James/Grey; Ken Follett/
  {De schemering en de dageraad, Het eeuwige vuur, Nacht van het kwaad, Nachtwakers, Nooit, Op vleugels
  van de adelaar, "The Hammer of Eden…" (EN title, NL text), The Man From St Petersburg (EN title, NL),
  The Modigliani Scandal (EN title, NL), Val der titanen}; Tom Clancy/{De ogen van de vijand, In het
  vizier, Operatie Rode Storm, Patriot Games (EN title, NL), Op leven en dood}.
- **de (7):** Alice Oseman/Solitaire; Cassandra Clare/Lady Midnight (The Dark Artifices)…; Christopher
  Paolini/{Eragon (Inheritance, Book 1)…, "Learning Disabilities ; 7 +E" (junk name, German Paolini)};
  E.L. James/Mais Livre; Isaac Asimov/Foundation (**OPF title "Das Foundation Projekt"** — F-09's
  "reads fine" = renders, NOT English); Julia Quinn/"Buscando esposa (Spanish Edition)…" (**OPF title
  "Wie bezaubert man einen Viscount" — actually GERMAN**, misnamed folder).
- **da (7):** Eoin Colfer/Airman; George Orwell/A Collection of Essays…; George R.R. Martin/Aces High;
  Herman Melville/{Israel Potter, Typee, White Jacket}; Ursula K. Le Guin/Malafrena.
- **fr (1):** Frank Herbert/Dune (French Dune epub).

**AudioBooks (25):**
- **German audio (23):** Alice Oseman/I was born for this… (Sauerländer Audio); Cassandra Clare/
  {Chroniken der Unterwelt 06. City of Heavenly Fire, Lord of Shadows, Queen of Air and Darkness (570
  trk, Der Hörverlag), The Last Hours Chain of Gold… (Der Hörverlag), The Mortal Instruments 2 - City
  of Ashes}; Christopher Paolini/{Die Weisheit dea Feuers, Eragon, Murtagh - The World of Eragon (RHDE)};
  Dean Koontz/"The Face…" (audio = German "The Other Emily – Die Doppelgängerin"); Dennis E. Taylor/
  Outland (RHDE); Diana Gabaldon/Outlander (German Band 04 "Der Ruf der Trommel", narr. Assheuer);
  E.L. James/"Grey - Fifty Shades… as Told by Christian" (German audio); Frank Herbert/{DUNE IV - Der
  Gottkaiser des Wüstenplaneten, Dune (folder "Dune" holds German Dune III)}; George R.R. Martin/
  {Nightflyers…, Wild Cards…01, Wild Cards…02}; J.R.R. Tolkien/De Silmarillion (German "Das
  Silmarillion", Der HoerVerlag); Ken Follett/"Pour rien au monde…" (French folder name, **German audio
  "Never - Die letzte Entscheidung"**, Lübbe); Robert T. Kiyosaki/Rich Dad Poor Dad… (German); Tom
  Clancy/Dead or Alive (German, "Kapitel 001"); Tomi Adeyemi/Children of Blood and Bone (German "Band
  01 - Goldener Zorn").
- **Misfiled foreign epubs in ABS (2):** Cassandra Clare/Chain of Iron (German epub, det de:0.21);
  Victoria Aveyard/"Destructora de espadas…" (Spanish epub).
- Empty author folders left after moves (harmless, not deleted): EBooks/Isaac Asimov,
  AudioBooks/Alice Oseman, AudioBooks/Tomi Adeyemi.

## R2.5 — LL re-grabs queued + governor/LL state observed
- **F-09 corrupt (explicit mandate) — 3 English re-grabs queued** via GB-volume-id → `addBook` →
  `queueBook` → `searchBook` (503 backoff fired twice, recovered): **Skyward** (Brandon Sanderson, GB
  `RPq0DwAAQBAJ`), **Sweet and Deadly** (Charlaine Harris, `vcpmEQAAQBAJ`), **Skin in the Game** (Taleb,
  `xTFMtAEACAAJ`). All three now **Status=Wanted, BookLang=en** in LL (verified in
  `/config/lazylibrarian.db`). NOTE: `addBook` alone lands books as **`Skipped`** — must follow with
  `queueBook` to reach `Wanted` (searchBook won't act on Skipped). Corrupt+original backups remain in
  `books/quarantine/f09-corrupt/` and `…/f09-originals/` (untouched).
- **Existing LL retry queue UNTOUCHED:** `getWanted` = Throne of Glass + Kingdom of Ash (as briefed).
- **Governor / MAM:** qBittorrent `books-mam` = **19 torrents, all 19 unsatisfied** (<72h / maturing
  ~Tue eve) → over the pause threshold (15) → **gate CLOSED (correct)**. Usenet unaffected. Did not
  touch the Prowlarr MAM indexer or governor CronJob.

## R2.6 — Adjacent sweeps
- **azw3/mobi-only titles (invisible to Kavita): 146** (Kavita only indexes epub). Conversion
  candidates, but **LL image has no calibre — NOT converted** (per constraint), listed only. Notable
  **foreign** stray among them: `EBooks/Dennis E. Taylor/Potomu chto nas mnogo` = **Russian** ("We Are
  Legion" translation) `.mobi`. Big clusters: Tom Clancy (~24 mobi guided-tours), Kim Stanley Robinson
  (~11), James S.A. Corey Expanse origins/novellas (~9), Douglas Adams, Roald Dahl, Veronica Roth.
- **Empty / no-book EBooks title folders: 60** — includes the expected-empty F-09 shells (Skyward,
  "Sweet and Deadly by Harris…", Skin in the Game — epubs live in `f09-corrupt/`), plus foreign-titled
  empties (Charlaine Harris/{Allemaal dood, Echt dood}, John Grisham/{De onschuldigen, Domarens Brev},
  Ken Follett/Der Mann aus St. Petersburg). All harmless (no content). +1 ABS phantom:
  `AudioBooks/J.R.R. Tolkien/Der Herr der Ringe - Die zwei Türme` = metadata.json+cover only, **no
  audio** (German-titled empty ABS entry — reported, not moved).
- **Mixed-format title dirs: 4** — Roald Dahl/Matilda (azw3+epub+mobi), Sarah J. Maas/{Crown of
  Midnight, The Assassin and the Underworld, Tower of Dawn} = the session-5 English re-grabs landed
  beside old azw3/mobi. Old-format duplicates; Kavita prefers the epub. Low-priority cleanup.
- **F-09 leftovers:** 3 corrupt = re-grab-queued (above). The **7 other-defect epubs** (5× "Unsupported
  EPUB v1.0" package attrs + 2× EPUB3-nav) remain **untouched/in-library** (readable; distinct defect
  class; calibre-less image = no in-place fix) — carried forward as their own polish item.

## R2.7 — Owner questions / decisions (Q-04…Q-07)
- **Q-04 (the big one — English re-grab batch, owner GO):** the 58 quarantined foreign items leave real
  gaps (the ONLY Foundation/Eragon-ebook/Dune-ebook, and the Queen of Air and Darkness / Murtagh /
  Outlander-bk4 audio, etc. are now absent). Per the brief's SCOPE only the **3 F-09 corrupt** were an
  explicit queue mandate; re-grabbing **58** more is a **major acquisition wave** (governor gate closed,
  ratio economy, "audit not crawl-storm") → **held for an owner GO** rather than auto-queued. The full
  per-title candidate list is R2.4. On GO, run them usenet-first via LL (GB-volume-id → addBook →
  queueBook → searchBook, 503 backoff) — small paced batches.
- **Q-05 (ambiguous audio, left untouched):** `Terry Pratchett/Truckers` and `Terry Pratchett/Snuff`
  carry a **Dutch genre tag `Luisterboek`** but English album/track titles and (Truckers) `COMM=eng` —
  evidence leans English; not quarantined. `Roald Dahl/Fantastic Mr Fox` = `luisterboek` genre but
  **TPUB "BBC Worldwide" + English titles → English** (spurious genre). Confirm on the player?
- **Q-06 (Walter Mosley "Hoerbuch" cluster — FYI, NOT foreign):** ~25 Walter Mosley audiobooks carry
  genre `Hoerbuch` but **every substantive tag (album/title/artist) is English** — a German genre label
  on English audio (same false-positive class as the bad epub tags). Left untouched. Several have
  `n=1` single-file oddities (possible completeness issue, not language) — flagged for a later check.
- **Q-07 (naming oddity, left untouched):** `EBooks/James S.A. Corey/La Chute du Léviathan - The Expanse
  9` has a **French folder name but the epub is ENGLISH** (OPF title "Leviathan Wakes", US-copyright
  text). Rename the folder; content is fine.
- Carry-over: the **calibre gap** in LL's image (azw3/mobi→epub) would rescue the 146 azw3/mobi-only
  strays without re-grabs — a sidecar/image-swap is the durable fix (design input for the Books Saga).

## R2.8 — What was done (all constraints honored)
Quarantine = MOVE only (`books/quarantine/f10-language/…`), never delete; Kavita+ABS rescanned after.
Only the 3 explicit F-09 re-grabs queued (via LL, usenet-first). **No MAM grabs, no qBittorrent adds,
no Prowlarr indexer/governor toggles, no disturbance to LL's ToG/Kingdom-of-Ash queue, no deletions.**
Ambiguous items left for the owner. No app code / haynes-ops / other plans / HANDOFF touched. No release.

---

# ═══════════════════════════════════════════════════════════════════════════════
# RUN 3 — ENGLISH RE-GRAB WAVE (2026-07-13 late night; owner GO, Q-04 ruled YES). EXECUTED.
# ═══════════════════════════════════════════════════════════════════════════════

**Status: COMPLETE.** All 58 RUN-2 quarantined foreign items processed via **LazyLibrarian
usenet-first** (MAM gate CLOSED throughout — MAM never touched). **57 English re-grab wants queued
(all verified `Status`/`AudioStatus=Wanted`, `BookLang=en`)**; **1 skipped-ambiguous** (Orwell
essays). A blocking pipeline defect (LL→SAB) was found and fixed, which is what let usenet-first
actually land. At exit: **34 wants Snatched (English, downloading), 16 Wanted (awaiting an English
source), 7 Skipped** (usenet served the German/wrong edition → caught, removed from SAB, flagged for
MAM/manual). Q-07 folder consolidation done + Kavita rescan.

## R3.1 — Title identification (folder names lie — OPF/ID3 is truth)
Read OPF `dc:title`+ISBN from all 33 quarantined epubs and `metadata.json`+ID3 (`TALB/TIT2/TPE2/TPUB`)
from all 25 audiobook folders to resolve the ACTUAL English work behind each foreign/junk folder name.
Notable corrections vs the RUN-2 folder-name manifest:
- Paolini `Eragon (Inheritance, Book 1)` folder → OPF "Eragon 04 - Das Erbe der Macht" = **Inheritance (bk4)**.
- Paolini `Learning Disabilities ; 7 +E` (junk) → OPF "Der Auftrag des Aeltesten" = **Eldest (bk2)**.
- Follett `The Hammer of Eden…` folder → OPF "Notre-Dame…" = **Notre-Dame** (short history), NOT Hammer of Eden.
- E.L. James `Mais Livre` → OPF "003…Freed" = **Freed**.
- Julia Quinn `Buscando esposa` (OPF "Wie bezaubert man einen Viscount") = **The Viscount Who Loved Me** (Bridgerton #2).
- Follett Dutch→English (GB-ISBN confirmed): Nacht van het kwaad = **Winter of the World**; Het eeuwige
  vuur = **A Column of Fire**; Nachtwakers = **Hornet Flight**; Val der titanen = Fall of Giants; Nooit
  = Never; Op vleugels van de adelaar = On Wings of Eagles.
- Clancy Dutch→English (GB-ISBN confirmed): De ogen van de vijand = **Against All Enemies**; In het
  vizier = **Locked On**; Op leven en dood = **Dead or Alive**; Operatie Rode Storm = Red Storm Rising.
- AUDIO ID3 corrections: Koontz `The Face` folder = German **The Other Emily** (Die Doppelgängerin);
  Herbert `Dune` folder = German **Children of Dune** (Dune III); Gabaldon `Outlander` = **Drums of
  Autumn** (Band 04); Paolini `Die Weisheit dea Feuers` = **Brisingr**; Wild Cards Band 01 "Vier Asse"
  = **Wild Cards (#1)**, Band 02 "Der Schwarm" = **Aces High (#2)**.
- **Clare `Chroniken der Unterwelt 06. City of Heavenly Fire` folder → all 88 tracks' ID3 =
  City of Fallen Angels (TMI #4).** The folder was mislabeled #6; re-grabbed the ACTUAL content
  **City of Fallen Angels (#4)**. **Owner note:** if you want #6 (City of Heavenly Fire) too, it needs a
  separate add — a #6-named English audiobook was never actually present (that entry was #4 German audio).
- The 2 "AudioBook" folders that were actually **misfiled foreign EPUBs** → queued as EBOOK wants:
  **Chain of Iron** (Clare) and **Blade Breaker** (Aveyard, ex-"Destructora de espadas").
- 4 titles quarantined in BOTH formats → one LL book, both eBook+AudioBook wants: **Grey, Aces High,
  Never, Dead or Alive**.
- GB lookups: keyed (LL `gb_api`), `langRestrict=en`, mandatory retry/backoff. LL's *internal* GB fetch
  during `addBook` has **no** backoff, so 503 "backendFailed" bursts walled the add phase → needed **3
  resumable passes** to add all 53 books. (Design input: the add path should retry GB too.)

## R3.2 — Queue (LL, verified) — the proven pattern held
53 distinct English books added (`addBook&wait`) → 57 wants set (`queueBook`, `type=eBook|AudioBook`)
→ **all verified `Wanted` + `BookLang=en`** → `searchBook` fired per want. Baseline LL Wanted
(ToG E+A, Kingdom of Ash E, Heir of Fire A, Skyward/Sweet and Deadly/Skin in the Game E) **untouched**.

## R3.3 — PIPELINE FIX (LL→SAB) — required to make usenet-first land
`searchBook` FOUND usenet NZBs but EVERY handoff failed: `Unable to connect to SAB … JSONDecodeError`.
Root cause: LL `SAB_SUBDIR = lazylibrarian` → POST `…/lazylibrarian/api` → **HTTP 404** (SAB is healthy
at root `/api`, v5.0.4; the LL apikey is valid at root). Config default is empty; `lazylibrarian` was
wrong. This latent bug hadn't mattered because prior batches (Maas) landed via MAM **torrents**; with
the MAM gate CLOSED, usenet-via-SAB is the ONLY path, so it blocked everything.
- **Fix (live, LL `writeCFG` — LL config is on the PVC, live-only, NOT GitOps): `SAB_SUBDIR = ''`.**
  Re-fired searches → `… sent to SAB successfully`. **Revert:** `writeCFG SAB_SUBDIR=lazylibrarian group=SABnzbd`.

## R3.4 — LANGUAGE GUARD (LL grabs don't filter language → German re-poison risk)
LL matches usenet results by title/author and does **not** filter grab language, so several AUDIO
searches pulled the exact German editions F-10 removed, and 2 ebooks grabbed the wrong English edition:
Grey audio "von Christian selbst erzählt", Never audio "Die letzte Entscheidung (Gekürzt)", The Other
Emily "Die Doppelgängerin", Queen of Air **und** Darkness "ungekürzt", Children of Blood and Bone "Band
01"; Foundation ebook → "Second Foundation" (bk3), Grey ebook → "Fifty Shades of Grey" (original).
- **Mitigation:** (a) hardened `REJECT_AUDIO`/`REJECT_WORDS` with safe German/abridged tokens
  (ungekürzt/ungekrzt, gekürzt/gekrzt, hörbuch, hörverlag, lesung, dunklen, mächte/mchte, entscheidung,
  erzaehlt, deutsch, german, goldener, zorn, doppelgängerin, und, …; defaults `epub,mobi`/`audiobook,mp3`
  preserved) — LL word-level reject, applied at search AND post-process; (b) **deleted the 7 German/wrong
  NZBs from SAB** (usenet downloader — no MAM/ratio implication), marked their `wanted` rows Failed, and
  set the 7 wants **Skipped**. Flagged for owner: usenet serves German/wrong for these → re-queue via
  **MAM (English) when the gate reopens ~Tue**, or manual.

## R3.5 — State at exit (of 57 queued wants)
| Outcome | eBook | Audio | total |
|---|---|---|---|
| **Snatched** (English, downloading) | 22 | 12 | **34** |
| **Wanted** (no accepted English usenet result yet) | 10 | 6 | **16** |
| **Skipped** (usenet German/wrong → removed + flagged) | 2 | 5 | **7** |
- The 7 Skipped: **Foundation (E)**, **Grey (E+A)**, **Never (A)**, **Queen of Air and Darkness (A)**,
  **The Other Emily (A)**, **Children of Blood and Bone (A)**.
- **Skipped-ambiguous, never queued (1):** Orwell **"A Collection of Essays"** — no clean single-title
  English GB match (only broad "Essays"/"Fifty Essays"/collected omnibuses). Owner picks the edition;
  suggested `PqGMFPCiBEsC` (Penguin "Essays", comprehensive).
- 16 Wanted (retry on LL cycle / land via MAM when gate reopens): Lady Midnight (E), Airman (E), Dune (E),
  Aces High (E+A), White-Jacket (E), Notre-Dame (E), On Wings of Eagles (E), The Evening and the Morning
  (E), The Man from St. Petersburg (E), Winter of the World (E), I Was Born for This (A), Murtagh (A),
  Drums of Autumn (A), Nightflyers (A), Rich Dad Poor Dad (A).
- **Caveat:** the 34 "English" Snatched are trusted by release NAME; content language not byte-verified
  post-download (German-marked releases WERE caught). Recommend a post-import spot-check / small F-11 audio
  pass once these import.

## R3.6 — Q-07 (folder rename) DONE
`EBooks/James S.A. Corey/La Chute du Léviathan - The Expanse 9/` held an **English "Leviathan Wakes"
(Expanse #1)** epub (OPF title "Leviathan Wakes", ISBN 9780316129084, English text "Prologue: Julie / The
Scopuli had been taken eight days ago…"; the `pt` lang tag was spurious). The library already had a
**"Leviathan Wakes"** folder holding only a `.mobi` (invisible to Kavita). A bare rename would collide, so
**consolidated**: moved the epub → `Leviathan Wakes/James S.A. Corey - Leviathan Wakes.epub` (convention
name, beside the mobi) and removed the empty French folder. **Kavita "Books" library force-rescanned (HTTP
200).** Bonus: this also rescued a mobi-only-invisible Leviathan Wakes.

## R3.7 — Constraints honored
- **LazyLibrarian only.** MAM gate observed **CLOSED** throughout (LL Torznab MyAnonaMouse `Enabled=0`;
  qBittorrent `books-mam` **19/19 unsatisfied at start AND exit — unchanged**). **No MAM grabs, no
  qBittorrent adds, Prowlarr MAM indexer untouched, governor untouched.** Usenet (4 Newznab providers) + SAB only.
- Existing LL Wanted/retry entries (ToG / KoA / Heir of Fire / 3×F-09) unchanged.
- Quarantined foreign files untouched (nothing deleted from `quarantine/`).
- SAB deletions = the 7 wrong/German usenet grabs only.
- **LL live-only config changes (all reversible):** `SAB_SUBDIR=''` (fix), `REJECT_AUDIO` + `REJECT_WORDS`
  German/abridged tokens added. No app code / haynes-ops / other plans / HANDOFF touched. No release.

---

# ═══════════════════════════════════════════════════════════════════════════════
# RUN 4 — STRANDED-IMPORT INCIDENT + FIX (2026-07-14). Owner: "queued books never arrive."
# ═══════════════════════════════════════════════════════════════════════════════

**Status: RESOLVED.** RUN 3 fixed LL→SAB *sending* (`SAB_SUBDIR=''`) but the completed usenet books
still never imported: **42 downloads completed in SAB but stranded at SAB's completed-dir root**, while
LL's post-processor watched an empty dir. Root cause was a **missing SAB category** (LL sent jobs with no
category). Fixed the category, **rescued the 42 (39 imported)**, audited REJECT_WORDS, triaged the 94
Failed grabs. Pipeline contract now documented in `docs/ops/013-mam-books-acquisition.md` §11.

## R4.1 — Diagnosis (verified live)
- **The two-mount split:** SAB's `complete_dir` root is `/data/haynestower/usenet/complete-k8s`
  (`haynestower` NFS, 482 T); LL watches `download_dir = /data/cephfs-hdd/data/usenet/complete-k8s/lazylibrarian`
  (gasha01 cephfs, 159 T) — **different underlying storage.** LL mounts only cephfs; SAB mounts both.
- **No category ⇒ stranded.** LL `[SABnzbd]` had `sab_host/port/api` but **no `sab_cat`**, so LL sent jobs
  with no category → SAB completed them under the `*` root on haynestower (`cat:*`, plus a few dir-less
  `cat:audio`) → LL's cephfs watch dir stayed empty ("Compiled 0 total items" every 10-min cycle).
- **DB state at entry:** `wanted` = **42 Snatched (all SABNZBD)** / 94 Failed / 6 Seeding (MAM torrents).
  All 42 confirmed `Completed` in SAB history (`nzo_id`→`storage`, 42/42 match at the haynestower root).
- **Second latent bug (SAB v5 history archive):** LL confirms completion via `mode=history&nzo_ids=<id>`,
  which in SAB 5.0.4 returns **0** once a job archives (needs `&archive=1`) → LL's Pass-3 timeout Failed
  the 42 mid-rescue (`DLResult "… Progress: 0%"`). Fresh completions are caught before archiving, so the
  category fix suffices going forward; the archive quirk only affected this aged backlog.

## R4.2 — Fix step 1: the category/dir contract (live, reversible)
- **LL:** `writeCFG&group=SABnzbd&name=SAB_CAT&value=lazylibrarian` → `readCFG` = `[lazylibrarian]`,
  persisted to `config.ini` (`sab_cat = lazylibrarian`). One category for both types (`use_label` returns
  the single value; no comma). **Revert:** `writeCFG SAB_CAT='' group=SABnzbd`.
- **SAB:** the `lazylibrarian` category **already existed** with `dir =
  /data/cephfs-hdd/data/usenet/complete-k8s/lazylibrarian` (absolute cephfs, mirroring the `lidarr`→music
  category that proves the shared cephfs mount) — no SAB change needed; verified by API read-back.
- Contract now == LL `download_dir`. Not GitOps (LL config is PVC/live-imperative). Full contract table
  in OPS-013 §11.2.

## R4.3 — Fix step 2: rescue the 42 stranded downloads (MOVE only, verified)
- Match set derived from the **42 Snatched `DownloadID`s** (not by listing the root) → naturally excludes
  the ~6 German/wrong-edition orphans (`Queen of Air und Darkness [ungekrzt]`, `Grey … erzaehlt`,
  `Children of Blood and Bone Band 01`, `Second Foundation`, `Fifty Shades of Grey`, `The Other Emily`)
  and SAB's category subdirs (`comics/ebooks/movies/tv`). Left untouched.
- **Moved 42 folders (628 files, 7.08 GB)** haynestower root → cephfs `lazylibrarian/` from the **SAB pod**
  (only pod mounting both trees). Cross-NFS ⇒ **copy + verify byte/file counts + remove source** (never
  delete before verify). First attempt via `shutil.copytree` failed on `copystat` (`Errno 524 ENOTSUPP` —
  cephfs rejects metadata preservation) and **rolled back cleanly with sources intact**; redone with
  data-only `shutil.copyfile` → 42/42 moved, 0 failed.
- **Import bypass** for the archived-history detection gap: set the 42 `wanted` rows `Source='DIRECT'`
  (LL trusts the row as 100 %) + `Status='Snatched'`, then `forceProcess`.
- **Dotted scene-name fix:** 6 grabs (`Tom.Clancy.Red.Storm.Rising.1987…`, Melville×2, Julia Quinn,
  Patriot Games, Blade Breaker) scored < `NAME_RATIO` (90) because `_normalize_title` preserves dots
  (one token). Renamed folders dots→spaces **and** aligned each `NZBtitle` to the spaced form (LL compares
  those two) → all matched (96–97). Silmarillion audiobook renamed to its clean title (88→match).

## R4.4 — Import results (verified in LL DB + on disk + rescans)
| Outcome | eBook | Audio | total |
|---|---|---|---|
| **Processed** (imported; book flipped to **Open**) | 27 | 12 | **39** |
| **Failed** — genuine content/type mismatch (left for LL re-search) | 1 | 2 | **3** |
- Books flipped **Snatched→Open**: 27 ebook-Open + 12 audio-Open (matches). On disk:
  `media/books/EBooks` **+85 files**, `AudioBooks` **+498 files**. Files land at
  `…/EBooks/<Author>/<Title>/…` and `…/AudioBooks/<Author>/<Title>/…`.
- **3 mismatches** (set `Failed`, book→`Wanted` to re-search): *Lord of Shadows* (audiobook want, grab was
  an epub), *Heir of Fire* audio (empty folder — the epub was consumed by its ebook want), *Hornet Flight*
  (ebook want, grab was mp3s). Their folders left in the download_dir (never deleted).
- **Rescans triggered (HTTP 200):** Kavita `Books`(id 1) + `Comics`(id 2); ABS `Audio Books`
  (`4f5bc272-…`). Creds from `frontend/haynesnetwork-secret` (`hnetadmin` / `root`), in-cluster URLs.

## R4.5 — REJECT_WORDS audit (verdict: word-boundary, `und` SAFE, NO change)
- LL matches reject words via `word in get_list(result_title.lower())` — **whitespace-tokenized
  word-membership, NOT substring** (`resultlist.py:212`; `formatter.get_list` splits on whitespace after
  folding `,`/`+`). Verified live: `und` = False for `Foundation`/`Thunder`/`Sound`, True only for a
  standalone `und` token. The coordinator's substring-danger premise does **not** hold for this LL — the
  list (incl. `und`, `goldener`, `zorn`) is safe as-is. **No REJECT_WORDS/REJECT_AUDIO change made.**
- Blind spot noted (not a bug): dot-separated scene names are one token, so reject words don't filter them.

## R4.6 — Failed-grabs triage (94, report-only)
| Class | count | note |
|---|---|---|
| "Failed to send nzb to SAB" | **80** | stale — pre-RUN3 `SAB_SUBDIR=lazylibrarian` 404; mostly duplicate Throne-of-Glass retries; cured, will re-search |
| F10 language/edition removed (RUN 3 guard) | 6 | deliberate |
| Dead NZB — par2 repair failed | 5 | genuinely incomplete usenet posts |
| Prowlarr 500 / aborted / RAR-verify | 3 | transient/corrupt |
- By indexer (send-time only, not a provider fault): NZBgeek 45, DrunkenSlug 32, NinjaCentral 8, NZBFinder 8, MAM 1.
- No fix warranted beyond steps 1–3 — the 85 % dominant class is already cured by the SAB config fixes.

## R4.7 — Constraints honored / residuals
- **MAM/qBittorrent/Prowlarr/governor untouched** (torrents on the MAM path not involved; usenet-only leg).
  LL **provider** sections untouched — only `SAB_CAT` (download-client config) changed, plus per-row
  `Source`/`NZBtitle`/`Status` edits on the rescued items. **No deletions** (moves + copy-verify only;
  the 4 leftover mismatch/residual folders left in place). No music/Lidarr category or dir touched.
- **App repo = DOCS ONLY** (OPS-013 §11 + this RUN 4). No code / haynes-ops / HANDOFF / release.
- **Residuals:** (a) 3 content/type mismatches will re-search on LL's cycle; (b) SAB v5 archived-history
  detection gap is latent — future grabs are caught pre-archive, but a very slow/large grab could re-strand
  (rescue idiom in §11.3); (c) `No ebook-convert found` (calibre absent from LL image) persists — cosmetic.
