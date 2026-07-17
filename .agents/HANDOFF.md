# HANDOFF — cold-start resume point

> The single resume point for agents. A fresh session should be able to orient from **only this
> file + `CLAUDE.md`**. Update this in the same change as any milestone. Derive current state from
> the top down; you should not have to reconcile anything.

## ▶ NEXT SESSION — start here (written 2026-07-17 ~02:15 UTC — COLD-START HANDOFF; owner present, directives below are HIS)

**Site live at https://haynesnetwork.com — v0.68.0 live-verified.** Thursday totalled SEVEN
deployed releases (v0.62.0 About page → v0.68.0 collections/breaker/wanted-sort bundle; v0.67.0
tagged but image-superseded during a GitHub API partial), EIGHT plans to completed/ (049, 037,
050, 053, 057, 051, 055, 056), and **LIBRETTO** (github.com/thaynes43/libretto, AGPL, fully
stateless "Kometa for books") from design → M1 → M2 → DEPLOYED (media ns, pod healthy, real
Kavita+ABS targets authenticated).

**▶ OWNER DIRECTIVES for the next session (2026-07-17 ~01:50, near-verbatim): "plenty of Opus
usage so you can go hard dispatching them" —**
1. **Build out book collections** (Opus wave): curate/mirror more Kavita/ABS collections, more
   Libretto recipes, scope PLAN-052 (manager UI binds Libretto's live contract).
2. **Easy SAB grabs to build the library** (Opus wave): usenet-first acquisition sweep — the
   pairing backfill (1,519 candidates, 25/hr cap, env-tunable) + missing-list pushes; grow the
   book library aggressively while it's cheap.
3. **MAM bonus points/VIP:** owner has "a TON" and can buy VIP but "IDK what it means" —
   RESEARCH what VIP/wedges/upload credit do to seed obligations + what the governor can then
   afford (feeds PLAN-040's rank knob). OWNER-DIRECTED spends only.
4. **A FABLE agent plans TRUE SSO (PLAN-058, escalated): "SINGLE sign in"** through the site
   and every app it supports — auto-login everywhere, retire per-app "Log in with Plex"
   (Seerr/Tautulli are the named immersion breaks). Inventory → per-app remediation design.

**LIBRETTO state + the ONE known gap:** first real recipe ran (id `harry-potter`, manual,
saved): Hardcover builder returned the series PERFECTLY ordered (10 works incl. #0.5/#1.5);
run honest `warn`, **matched 0/10 — Kavita epubs expose NO scheme'd OPF ISBNs (the documented
M2 caveat) so identifier-only matching cannot hit.** NEXT: implement DESIGN-037 **D-04's
flagged conservative title fallback** (the ADR-065 noise-stripped-title + author matcher;
`matchedVia` flagged) in the Libretto repo, redeploy (`:latest`, restart pod), re-apply the
recipe → expect ~6-7/10 (Sorcerer's≠Philosopher's is an honest US/UK miss) → ordered reading
list lands in Kavita → the site mirrors it at :27. Ops: pod `libretto` (media), secret
`libretto-secret` (1P: libretto item + KAVITA_API_KEY in media-stack [a dedicated Kavita auth
key] + ABS token from audiobookshelf item), API via media-ns Jobs envFrom libretto-secret,
base http://libretto.media.svc.cluster.local:8080, Bearer LIBRETTO_API_KEY.

**COMICS (Kapowarr) — mid-repair, FINISH FIRST:** root cause of never-downloading: getcomics
429s everything (1,500+/6h; FlareSolverr absent). FlareSolverr DEPLOYED (downloads ns) but
first pod hit runAsNonRoot-vs-named-user — **UID fix PR haynes-ops #2079 (runAsUser 1000)
was merging at handoff; VERIFY it rolled**, then wire: PUT
kapowarr.downloads:5656/api/settings {"flaresolverr_base_url":
"http://flaresolverr.downloads.svc.cluster.local:8191"} (KAPOWARR_API_KEY in hnet secret,
frontend-ns job), DELETE /api/activity/queue/1 (wedged Scott Pilgrim), POST /api/system/tasks
{cmd:"auto_search", volume_id:3} (Hobbit) + volume_id:4 (Invincible TRADES cv 39340, added
tonight for the owner's son — 25 vols). SUCCESS = /api/activity/history gains its
FIRST-EVER entry. Later: Kapowarr Library Import over the Mylar3-era comics folders.

**07:00 UTC GB reset chain:** the two owner Fix Failed rows (Dead Ever After, Whispers) —
v0.68.0's retry pass (rides goodreads-sync hourly, 10/run) completes them automatically →
tell the owner → his ONE green UI Fix test → **THE FLIP: setRoleBookActions fix_book → all
roles + open the `integrations` section** (the standing #1). Owner may also raise the GB
daily quota in Cloud Console (Books API → Quotas; default 1,000/day).

**Kavita/SSO tonight:** FGTVMan fixed (Login+Bookmark+Download) + **Default Roles landed**
(future members provision working); owner's SSO acct maps to hnetadmin (break-glass =
OIDC-down fallback only); auto-login + role-sync-via-Authentik deferred INTO PLAN-058.

**Tooling:** the hardened release-train watcher is now IN-REPO at
`.agents/tools/release-train.sh` (usage: `bash .agents/tools/release-train.sh <PR#>`;
dance-aware [release-PR checks never start on GITHUB_TOKEN pushes → close/reopen],
BEHIND-aware [update-branch API], e2e-tolerant [advisory lane ignored]). New stall classes
learned: DIRTY needs a manual rebase; never run two watchers on one PR; never merge docs PRs
mid-train; a GitHub API PARTIAL (endpoint-family HTML 5xx, status page green) kills
release-please in 10-20s — recovery = any nudge commit to main (bot cannot rerun/dispatch).
Union-resolving parallel-track rebases: journal entries REBUILD as JSON (never text-union),
guard regex lines MERGE (never concatenate), verify brace balance + typecheck before every
`rebase --continue`.

### Prior top block (Thursday late evening)

## ▶ NEXT SESSION — start here (written 2026-07-16 LATE evening — the Libretto + scoreboard evening, owner present)

**Site live at https://haynesnetwork.com — v0.66.0 running; v0.67.0/v0.68.0 queued behind tonight's
GitHub API partial degradation (recovered; the wrap commit you are reading retriggers
release-please).** Evening shipped/staged, owner present throughout:

- **PLAN-057 scoreboard → completed (v0.66.0 LIVE):** estate play badges on the dashboard
  (all THREE Tautullis, 10-min memo, SSR-only; live-proven totals movie 3,480 · show 25,270 ·
  artist 2,316 · 18,922 hours). Label fix (Movies watched · TV episodes watched · Music plays)
  merged, rides v0.67.0.
- **PLAN-051 books collections mirror → merged #332 (v0.67.0 pending):** ADR-066, migration
  0056, Kavita collections + reading lists (ORDERED) + ABS collections on the three book walls;
  scoped-review MEDIUM (pagination-header fallback) fixed; deploy adds `sync-books-collections`
  CronJob :27. books.ts shares the latent header-fallback gap — follow-up in the plan file.
- **PLAN-055 GB quota breaker → merged #333 (release pending):** ADR-067, migration 0057,
  `gb_quota_state` singleton + guardedGbResolve seam; fixes QUEUE on dead quota + hourly retry
  pass (10/run) rides goodreads-sync; enrichment one-line skip; pairing mint cap preserved.
  **THE FLIP (books fix_book + integrations) is gated on: v0.68.0 deployed → owner one green
  Fix → flip both.** Root cause of the owner's two Fix Failed: GB DAILY quota (1,000/day
  default) exhausted; owner may raise it in Cloud Console (Books API → Quotas).
- **PLAN-056 wanted sort → merged #334 (release pending):** the pinning was DESIGN-029
  amendment-1's deliberate head-of-stream concat; now a server-side UNION with honest per-sort
  keys + All · Wanted only · Hide wanted `.seg` (`?wanted=`); DESIGN-029 amendment 3.
- **LIBRETTO M2 → merged (repo #2):** real Kavita/ABS targets (marker-in-description ownership
  VERIFIED writable everywhere; Kavita ISBN per-chapter with the OPF-scheme caveat),
  hardcover_series builder, 89 tests. **Deploy staged:** publish workflow merged (first run
  failed in the GitHub window — renudged), haynes-ops PR #2076 OPEN + gated on
  ghcr.io/thaynes43/libretto:latest existing. Owner filled 1P: HARDCOVER_TOKEN, NYT_API_KEY,
  LIBRETTO_API_KEY (libretto item), KAVITA_API_KEY (media-stack; a DEDICATED 'libretto' Kavita
  auth key, not the OPDS one), ABS token reused from the audiobookshelf item. Go-live: image →
  merge #2076 → check ESO sync → pod /health → first recipe (Hardcover series → ordered Kavita
  reading list). M2 flags: Kavita reading-list reorder base needs one live pass; sync account
  needs Promote for household visibility.
- **Owner items DONE tonight:** trash window → 7 days (audited setAppSetting job);
  Haynestower play totals on the About page (NAS Tautulli via the existing estate key);
  collection-visibility note ruled fine-as-is; PLAN-053 buckets ruled (six, crew→Director,
  show-all).
- **GITHUB INCIDENT DOCTRINE (~21:50–00:00 UTC):** a PARTIAL API degradation — one endpoint
  family (repos/runs-list/jobs/check-runs) returned HTML 5xx while PR/merge/GraphQL/workflows
  endpoints worked; status board stayed green. Fingerprint: release-please runs fail in
  10-20s; PR checks fine; images never appear. The bot CANNOT `gh run rerun` NOR
  `workflow_dispatch` (Resource not accessible by integration) — the recovery lever is a
  NUDGE COMMIT to main (docs PR), which retriggers release-please idempotently (it re-creates
  a merged-but-untagged release). Wrap commits double as nudges.

### Prior top block (Thursday evening)

## ▶ NEXT SESSION — start here (written 2026-07-16 evening — the collections + pairing day, owner present)

**Site live at https://haynesnetwork.com — latest release v0.64.0, live-verified.** Thursday ran the
owner's "churn through something good" directive as TWO PARALLEL TRACKS, both shipped + live-validated:

- **PLAN-037 Collections → completed/ (v0.63.0, #316/#314/haynes-ops #2072).** Mirrored Plex
  collections (ADR-064 — the owner DOCTRINE: external software is ALWAYS the collections source
  of truth, the app only syncs; extends hard rule 4), Collections group-by view on Movies/TV.
  LIVE: first sync mirrored **461 collections / 7,910 members** from HOps Plex; the
  adversarial-review paging hardening exercised immediately (two 1,300-member Kometa collections
  truncation-flagged, never reconciled). `sync-collections` CronJob :57. Follow-up: paged member
  reads for >1000-member collections.
- **PLAN-050 Pairing → completed/ (v0.64.0, #317/#318/haynes-ops #2073).** Book⇄audiobook format
  pairing (ADR-065): conservative full-title matcher (review-hardened vs franchise mispairs),
  dual consume buttons, coverage badges, system wants (origin='pairing'), estate-wide auto-mint
  PACED 25/run (owner ruling). LIVE: first run **paired 321, queued 1,519 candidates, minted the
  exact 25 cap; 24 unmintable on the exhausted GB daily quota** (designed degradation — resumes
  at the 07:00 UTC reset). `sync-format-pairing` CronJob :32. Residual: GB-429 circuit breaker.
- **v0.62.0/v0.62.1 (overnight + morning): the About/Help page** (PLAN-049 completed/) + the
  owner's copy-tone pass (rules now in memory: no em-dashes, no names, "cluster" not k8s, links
  everywhere).
- **Roadmap ratified + researched:** PLAN-051 (Kavita/ABS collections mirror — queued),
  PLAN-052 (collection-manager integration — scope-ready; git-PR write path, --validate-file
  gate, --run-files run-now), **PLAN-053 (Collection Type facet — READY TO BUILD, both Qs
  resolved: six buckets, crew folds into Director; wall shows all, chips filter)**, and the
  PLAN-043 books app: **named LIBRETTO (owner 2026-07-16), headless API-first service + minimal
  built-in UI — DESIGN PHASE OPEN.** Kometa deep research filed
  (`.agents/context/2026-07-16-kometa-integration-research.md`).

**EVENING ADDENDUM (same day):** **PLAN-053 → completed/ (v0.65.0)** — six-bucket Collection
Type classifier + Type chips, live with all 461 collections classified. **LIBRETTO IS BORN:**
repo github.com/thaynes43/libretto (AGPL-3.0, owner-created), design ratified through THREE
owner rulings (SQLite → then FULLY STATELESS Kometa-style — the targets are the state store,
LL is the acquisition ledger, YAML recipes, no DB ever — DESIGN-037 amended #324), **M1
walking skeleton MERGED with green CI** (46 tests, contract REST surface, marker-based
ownership, fake target; M2 next = real Kavita/ABS clients + the Kavita description-field
spike + Hardcover series builder). Owner provisioned HARDCOVER_TOKEN + NYT_API_KEY (1P
`libretto`, HaynesKube; NYT secret NOT needed). New stall class for the train doctrine:
**DIRTY** (real conflict — a feature branch racing its own docs PR on the same plan file;
watcher detects BEHIND but DIRTY needs a manual rebase). Train also learned: never run two
watchers on one PR (double-dance risk — TaskStop the old one first).

**NEXT (owner-agreed order):** finish any Libretto design docs in flight → PLAN-053 build →
PLAN-051 → PLAN-052. Libretto design runs parallel to hnet builds (separate repo, docs-only).

**Release-train doctrine (hardened today, script at scratchpad/release-train-v3.sh):** the
watcher is now dance-aware (release-PR checks never start on GITHUB_TOKEN pushes — close/reopen),
**BEHIND-aware** (branch protection requires up-to-date branches; auto-merge silently stalls —
the watcher now calls update-branch), and **e2e-tolerant** (e2e is advisory; local ground truth
2026-07-16: 156/156 pass — the CI e2e lane red is environmental). Lesson: never merge docs PRs
while a train is mid-flight (knocks the release PR BEHIND). Parallel-track rebases: migration
journal entries + guard regex families + SYNC_RUN_KINDS CHECKs conflict — the SECOND track's
CHECK rebuild must be the UNION of kinds; union-resolve regex lines by MERGING not concatenating.

**Owner items still open from the overnight block:** THE FLIP (books fix_book + integrations
section), Haynestower play totals (Q-06 TODO slot), Panels-iOS + Plex-language-recipe
validation (About page flags), trash_default_window_days → 7 if wanted, collection-existence
visibility note (DESIGN-035 D-03 — item-level access surfaces an HOps collection title to
non-HOps users; confirm or tighten).

### Prior top block (Wednesday overnight)

## ▶ NEXT SESSION — start here (written 2026-07-16 ~06:00 UTC — Wednesday overnight run, owner asleep)

**Site live at https://haynesnetwork.com — latest release v0.62.0, deployed + health-verified.**
The owner directed the overnight build at cold start: the **About/Help page — PLAN-049 SHIPPED
(v0.62.0, feat #307 + release #306 + haynes-ops #2068)**: an inverted "About haynesnetwork.com"
tile above a perforated rule on the dashboard (R-206) + the ungated mobile-first `/about`
accordion (R-207) — intro + haynes-ops pane, then Plex Servers / Fix & Activity / Tickets /
Trash (reads the LIVE `trash_default_window_days`) / Requests / Goodreads / Kavita / ABS /
Plex best practices / Plexamp, all in the owner's voice from three Opus fact sheets (code,
external docs, play totals). ADR-063 / DESIGN-034 / R-206..207. Live proof: pod Running
v0.62.0, `/api/health` 200, unauth `/about` → `/login`; authenticated visuals = hermetic
screenshots (the sanctioned substitution; sent to the owner's session).

**OWNER MORNING QUEUE (answers via remote-control; page edits are quick PRs):**
1. **Review /about live** + the 5 screenshots in-session. Feedback → polish PRs.
2. **THE FLIP (still #1):** books `fix_book` via `setRoleBookActions` after your Fix UI test —
   **and now also flip the `integrations` section to member roles** (PLAN-049 Q-07): the About
   page teaches everyone Goodreads, but the tab is still Admin-only.
3. **Q-06 Haynestower play totals:** NOT obtainable in-cluster (the two Tautullis watch
   PlexOps/K8plex only; Haynestower history lives on the NAS). Your NAS Tautulli → Libraries
   shows per-section total plays — text the three numbers, they slot into a ready TODO.
4. **Q-04 Panels-on-iOS steps** (flagged in-page until you test) · **Q-05 Plex language
   recipe** (flagged; research verdict: **Plex has NO "prefer original language" option** —
   recipe = auto-select ON + Preferred audio English + Subtitle Mode "Shown with foreign
   audio"; manual per-title pick persists). · **Trash window:** code default is **21 days**;
   if you want 7, set `trash_default_window_days` — the page reads the live value.

**Working-rule lessons (tonight — release-train, BOTH new):** (1) **release-please can RACE
GitHub's commit indexing** — the run triggered by a merge computed the release WITHOUT that
merge's commit (#306 opened as 0.61.1 missing the feat); fix = any fresh push to main
recomputes (we used the queued fix.ts stale-comment cleanup, #308). (2) **Release-PR checks
NEVER start on release-please's own push** (GITHUB_TOKEN pushes don't trigger workflows) —
auto-merge sits BLOCKED with "no checks reported" forever; **the dance = `gh pr close` +
`gh pr reopen` (App-token events DO trigger CI) + re-arm auto-merge.** Any release watcher
must include the dance before waiting on the merge. Flux names: source `haynes-ops`
(flux-system), kustomization+hr `haynesnetwork` (frontend); deploy = `haynesnetwork-main`.

**Estate (overnight checks):** MAM governor: the gate **reopened overnight then re-paused
05:34 UTC** (15 unsatisfied / threshold 15; 15 seeding <72h; 0 downloading) — correct; it
reopens as the Maas six mature. CoBaB audio + Foundation ebook remain OWNER-DIRECTED next-batch
grabs. **GB quota still 429 at 05:41 UTC** — resets midnight Pacific (07:00 UTC); the Hobbit
comic re-classify check (`comicsRouted≥1`) belongs to the first post-07:00 goodreads-sync (a
log watcher may already be armed — check /tasks). The Other Emily / Kingdom of Ash / Hornet
Flight straggler checks: still owed. **Model-watch:** all three Opus dispatches
transcript-verified `opus-4-8`; the documented SendMessage-resume flip reproduced exactly
(resumed fact-sheet agent tail ran Fable — accepted knowingly, assembly-only tail).

### Prior top block (Wednesday night)

## ▶ NEXT SESSION — start here (written 2026-07-15 Wednesday NIGHT — overnight cold start)

**Site live at https://haynesnetwork.com — latest release v0.61.0, live-verified.** Wednesday shipped
FIVE releases (v0.57.0 → v0.61.0), all from the in-cluster dev-env pod, owner remote-controlling.
Read the midday block below for the morning/afternoon detail; tonight's state:

**LIVE tonight (v0.61.0):**
- **PLAN-041 books/audiobooks/comics Fix (ADR-062/DESIGN-033, #304):** Fix button on
  `/library/books/[id]` (reason modal → audited `book_fix_requests` → confined LL/Kapowarr re-grab;
  migration 0052; 25/user/hr books budget; one-open-per-item). **ADMIN-ONLY — ⚠ THE Q-01 FLIP IS
  THE #1 OPEN ITEM:** owner tests the Fix in the UI, then `setRoleBookActions` grants `fix_book`
  to all roles (owner ruling: "if it works it'll be available to everyone... just don't want to
  forget to flip it"). Live-validated (fix c7a0fe19, PHM, controlled fire+revert).
- **Fix budget 25/user/hr** — both *arr (#303, Opus-dispatched) and books.
- **v0.60.0 ticket media locator + v0.59.0 digest/comic-fix + v0.58.0 ticket emails + v0.57.0
  goodreads sweep** — all validated earlier (midday block).

**THE ABS EVENING INCIDENT (closed, midday-block addendum):** web player flush-on-abrupt-close eats
progress (server-proven); **AudioBooth adopted** (`audiobooth://oauth` in ABS mobile redirect URIs,
SSO verified); 810 audiobooks language-patched; upstream sendBeacon issue DRAFTED not filed
(owner's call). Tell mia: AudioBooth, or pause-before-close. Kavita ebook reading UX: due a look at
OPDS readers (Yomu) — Kavita's web reader has no real pagination feel (owner hit it on PHM; the
epub itself is FINE — retail epub3; it was reader Layout Mode, but even 1-Column "sucks" per owner).

**OVERNIGHT/TOMORROW QUEUE (owner cold-starting overnight):**
1. **THE FLIP** (after owner's UI test of the Fix — one `setRoleBookActions` call per role + a
   screenshot check; then move PLAN-041 → completed/).
2. **Morning checks:** GB quota RESET (the Hobbit comic should re-classify + route on the next
   goodreads-sync — verify comicsRouted≥1); MAM gate reopened overnight? (Maas 6 matured Wed eve —
   check governor unsatisfied; CoBaB audio `Yp9GDwAAQBAJ` + Foundation ebook `Q-41ugEACAAJ` are the
   owner-ruled next-batch candidates, OWNER-DIRECTED grabs only); The Other Emily audio re-search
   (fired Wed) — landed? Also Kingdom of Ash ebook + Hornet Flight ebook wants.
3. **Builds:** PLAN-040 (governor admin knob — scoped, next release-sized item); PLAN-043 saga next
   phases (scope WITH the owner); F-11 English spot-check; the member-persona e2e red; epub-QA
   detection spike (Q-06, deferred); Mode-2 quarantine-assist ADR (Q-07, deferred).
4. **Owner items:** ABS upstream issue (draft ready); nightly digest fires 21:05 (first real one
   whenever failures exist); PLAN-035 admin email = admin@haynesnetwork.com confirmed.

**Working rules addenda (tonight's lessons):** haynes-ops main is PR-only now (branch+PR+auto-merge;
flux-local checks ~3min) · OPS-004 §1b sig-probe needs `Accept: application/vnd.oci.image.manifest.v1+json`
· HelmRelease upgrade LAGS the kustomization apply — reconcile hr again + re-read before declaring
a stall · release-train pattern: single background watcher does dance→merge→run→pair · GH_TOKEN
stale in shells (`export GH_TOKEN="$(cat /creds/gh_token)"`) · a REAL coordinator Fable→Opus flip
happened 2026-07-15 ~22:50 — the OWNER caught it (probes can't); he reset via /model; keep watching
· one full-suite embedded-PG boot flake (plex-registry) — rerun before diagnosing.

### Prior top block (Wednesday midday)

## ▶ NEXT SESSION — start here (written 2026-07-15 Wednesday midday, owner-present remote-control session)

**Site live at https://haynesnetwork.com — latest release v0.57.0, live-verified.** Wednesday-morning
session (first from the in-cluster dev-env pod): the queue's #1/#2/#3 all executed with the owner
present. State:

- **v0.57.0 SHIPPED + LIVE-VALIDATED** (#289 → release PR #286 → haynes-ops PR #2063): the LL-status
  reconcile was a **silent no-op since PLAN-044** (the deployed LL build `version-40a389ea` has NO
  `getBook` command; the tolerant schema ate the 405) — now reads ONE `cmd=getAllBooks` map per sync.
  Plus the owner-directed **Skipped-want usenet-first sweep**: raw-`Skipped` live wants are re-queued +
  re-searched each sync (SAB takes the load; MAM gap-fills only when its gate is open; `Ignored`/`Matched`
  never swept — the dead-end Missing UX keys on `Ignored` now). **Validated in prod: `requeued:10`,
  LL both-Skipped 14→4** (the 4 left are LL-native F-10 deferred items, correctly untouched), governor
  steady (15/15, gate closed, 0 downloading). DESIGN-028 amendment documents it.
- **SMTP (F-04) UNBLOCKED ✅** — owner created the 1P `smtp` item (SMTP_HOST/PORT/USER/PASS/FROM,
  HaynesKube vault, estate-shareable); wired into `haynesnetwork-secret` via haynes-ops PR #2063 and
  **ExternalSecret synced clean** (field names validated). PLAN-035 + the PLAN-048 nightly digest are
  now buildable.
- **PLAN-044/045/046/047/048 RATIFIED (owner, 2026-07-15) → filed to `completed/`.**
- **Owner rulings closed:** Orwell essays = **DROP** (recorded in the F-10 audit; quarantine keeps the
  file); haynes-ops-bypass request withdrawn.
- **MAM landings verified (morning scorecard):** RUN-5 batch + overnight all landed (Grey e+a, Never a,
  Hooked e+a, RPO e+a, PHM e+a, Skin in the Game e, QoAD a, Drums of Autumn re-import 07:38, Pillars of
  the Earth e). **Stragglers:** The Other Emily (a) downloaded-but-not-imported ~17h (watch); Heir of
  Fire (a) re-set to Wanted (LL retrying); Kingdom of Ash (e) still Wanted; Hornet Flight (e) 2 fails,
  retrying. CoBaB (a) + Foundation (e) stay budget-deferred (owner-batch when the gate reopens — the 6
  Maas torrents mature Wed evening).
- **Doctrine updates (learned live):** (1) **haynes-ops main is now BRANCH-PROTECTED** — PR + flux-local
  checks required; "forward-only commits to main" is DEAD, use branch → PR → auto-merge (worked in ~4 min);
  (2) OPS-004 §1b sig-probe needs `Accept: application/vnd.oci.image.manifest.v1+json` or GHCR 404s a
  signature that EXISTS; (3) the dev-env pod's kubectl SA has scoped writes (pod delete, HR/GitRepo patch
  → in-pod `flux reconcile`, job create → CronJob triggers); Playwright must target
  `haynesnetwork.haynesops.com` (prod hostname unreachable in-cluster); GH_TOKEN in-shell goes stale —
  re-export from `/creds/gh_token`.
- **Watch/investigate:** Kapowarr `/volumes` HTTP 500 routing "The Hobbit" comic (persistent across
  runs); The Other Emily import; GB 503 bursts (known, retried); e2e-red member-persona investigation
  (unchanged); Goodreads facet lag (reconcile fix may improve it — re-check before scoping).
- **PLAN-035 SHIPPED + LIVE-VALIDATED (v0.58.0, same day):** email outbox channel (ADR-060 /
  DESIGN-031 / migration 0049) — admin-on-create to admin@haynesnetwork.com (owner-confirmed the only
  deliverable mailbox) + author opt-in (user-menu toggle, default OFF) + per-channel disabled-safe
  drainer. Prod validation ticket 5c94e8e1 delivered `sent:2, failed:0` over the real Google relay.
  NOTE the HelmRelease upgrade LAGS the kustomization apply — re-run `flux reconcile helmrelease
  haynesnetwork -n frontend` and re-read the deploy image before declaring a roll stuck.
- **AFTERNOON CLEANUP RUN (owner-directed, all four DONE):** (1) The Other Emily — LL cannot import
  the multi-part "Chapterized" torrent layout (silent postprocess skip + importBook false; debug-log
  proven); snatch reset to Wanted + re-searched, seeding payload intact. WATCH: it may re-grab the
  same torrent. (2) Kapowarr Hobbit — SQLite "database is locked" (pod restarted) + the REAL bug:
  GB-outage declassified comics — fixed (durable comic_status, #295); Hobbit reclassifies when GB
  quota resets (GB hit its DAILY 429 today — go easy on manual goodreads-sync). (3) **Nightly
  failure digest SHIPPED (v0.59.0)** — `failure-digest` CronJob 21:05 + email channel; validated
  live (clean ledger ⇒ silent). (4) **PLAN-038 SHIPPED (v0.60.0)** — ADR-061 locator + compose
  leaf-or-scope drill; migration 0051 DELETED pre-locator tickets (Q-03); live locator ticket
  c2a20a02 ("Gray" S1, safe to close); ytdlsub/books targets deferred (DESIGN-032 Q-04).
  Coverage note: Goodreads 52%→85% after the sweep. Releases today: v0.57.0→v0.60.0.
- **EVENING INCIDENT (closed same night): ABS progress loss + missing Matilda.** Root cause =
  the ABS WEB player's flush-on-abrupt-close (session in memory; persists only on periodic sync /
  clean Pause; killed tab ⇒ nothing — owner repro'd both directions). NOT the app / storage / a
  stale restore (the 07-10 volsync bootstrap seeded an EMPTY first-deploy repo — setup-wizard
  timeline proves it; pre-existing history never existed). mia's "lost" history was never written
  (iOS-Safari short sessions). FIXES: **AudioBooth adopted** (native iOS client; `audiobooth://oauth`
  added to ABS `authOpenIDMobileRedirectURIs`, SSO verified — OPS-012 addendum) · 810/844
  audiobooks patched language=English via ABS API (the Language facet was hiding items — the
  "missing Matilda"; mirror resynced) · upstream sendBeacon issue DRAFTED not filed (owner's call)
  · household guidance: native app or pause-before-close. Both Opus investigation agents were
  clean dispatches (transcript-verified opus-4-8).
- **Next builds queue:**
  PLAN-038 (scoped), PLAN-040, F-11 spot-check, PLAN-043 next phases (scope with owner).

### Prior top block (Tue-night wrap → Wednesday cold start)

**Site live at https://haynesnetwork.com — latest release v0.56.0, live-verified.** The Mon-eve →
Tue-night run shipped **ELEVEN releases (v0.47.0 → v0.56.0)**. Chronicles, in reading order:
`.agents/context/2026-07-14-session-6-wrap.md` (overnight: v0.47–v0.50) →
`.agents/context/2026-07-14-tuesday-daytime-wrap.md` (+ its evening/late-night addenda:
v0.50.1–v0.56.0). Memory is indexed.

**What is LIVE now (the compressed map):**
- **Library**: views/grouping + per-user sort/filter + watch/read facets + A–Z rail (PLAN-029,
  ADR-051/052/053); group-card art (ABS author portraits, genre glyphs, ADR-041 idioms).
- **Integrations** (avatar menu): Goodreads per-user linking → ALL-shelves auto-acquisition
  (owner's no-gate ruling) → LL both formats / comics → Kapowarr (ADR-055/056/057); wanted items
  inline in Library walls as Movies-anatomy cards + wanted DETAIL pages w/ per-format Force-Search
  (#264); **ENABLED FOR ALL ROLES (owner, DB-verified Tue night)**.
- **The card system** (PLAN-047, ADR-058): typed BaseCard family in `apps/web/components/cards`,
  ESLint anatomy guard, card-gallery drift-CI — extend via typed props + gallery entries, NEVER fork.
- **Activity** (PLAN-048, ADR-059/DESIGN-030): Library→Activity tab, all sources (books/LL+SAB,
  *arrs, Kapowarr), per-source failure isolation, role-gated actions
  (`role_activity_action_grants`), clickable cards, Fix-grammar live progress (adaptive 2.5s/5s
  poll), live-state-precedence (`formatLiveWins` — an active grab never reads "Missing").
- **Nav** (v0.56.0, DESIGN-004 D-22): 4-tab bar Home·Library·Tickets·Trash (fits 320px);
  Integrations+Metrics in the avatar menu (role-gated); **Helpdesk→Tickets RATIFIED**
  (HELPDESK_NAME flip; routes/grants untouched).
- **Books pipeline**: import contract fixed + documented (OPS-013 §11: `sab_cat=lazylibrarian`;
  the 42-stranded incident → 39 imported); F-10 language purge done (58 quarantined, 57 re-grabs);
  **MAM gate OPEN** (Tue ~22:30Z cascade; 6 Maas torrents mature Wed eve; LL retries the 7
  poisoned titles overnight — check landings in Activity).
- **Ops doctrine (hardened Tue)**: deploy gate = ARTIFACT PAIR (OPS-004 §1b); release-dance
  guardrails incl. the autorelease-label check (§1c); HelmRelease remediation retries 10; kyverno
  alert = sustained-denial only; WebKit login mitigation stands (OPS-009 — re-audit lowering
  suspects on authentik image bumps).

**WEDNESDAY QUEUE:**
1. **Owner ratification sweep** → on thumbs-up, file PLAN-044/045/046/047/048 to `completed/`
   (all live; screenshots reviewed in-chat throughout Tuesday).
2. **Verify overnight MAM landings** (the 7 poisoned titles + 3 F-09 corrupt + old ToG queue) via
   Activity/LL history; governor should breathe (re-close near cap) on its own.
3. **Owner rulings open:** Orwell essays queue-or-drop (GB `PqGMFPCiBEsC`); Tickets-page h1
   doubling — trim on request; Q-03 comics-activity gate (rides `books`; one-field flip);
   qB 5.2.1 on MAM Approved Clients; Kavita "Save Media As"=WebP; Safari TOTP retest;
   **SMTP (F-04) = still the ONE 1P blocker** (unlocks PLAN-035 + the 048 nightly digest);
   someday: MAM "Not Connectable" IPv4 (Mullvad has no port-forward).
4. **Next builds:** PLAN-043 saga next phases (content-sync/coverage, book⇄audio pairing, Trakt
   research); PLAN-038 (scoped, dispatchable); PLAN-040; F-11 post-import English spot-check
   (Opus-able); the e2e-red-on-main member-persona investigation (library tabs hidden in the
   hermetic stack — evidence lists in the 047 scratchpad); Goodreads status-filter facets still
   bucket by snapshot (display is live-true; facet lag = saga item).

**Working rules (as updated Tuesday — full text in `haynes-ops/zprompt.md`):** every turn ends
with the reply · model watch: probe before every dispatch/merge/mutation + transcript
ground-truth Opus dispatches (two transient override flips Tue; retries cleared both) ·
**UX gate:** reference-pinned briefs + agent side-by-side proof + coordinator visual diff BEFORE
any UX deploy (`ux-reference-anatomy-gate`) · release train per OPS-004 §1b/1c + un-strand
watchers · haynes-ops pull-first/forward-only; flux names source=`haynes-ops`,
kustomization=`cluster-apps`, helmrelease=`haynesnetwork -n frontend`.

### Prior top block (session-6 overnight wrap)


**Site live at https://haynesnetwork.com; latest release v0.49.0 (three shipped Monday:
v0.47.0 → v0.48.0 → v0.49.0, all live-verified).** Session 6 ran Mon 18:00 → Tue ~03:00 on the
fresh weekly budget. **Full chronicle: `.agents/context/2026-07-14-session-6-wrap.md`** — read
it. Headlines: **PLAN-029 SHIPPED COMPLETE (v0.47.0)** — released_at + per-user prefs +
watch/read seam (#243, Opus) + the whole views/grouping/facets/A–Z UX (#245, Fable), owner
ratified; **group-card ART (v0.48.0, #249)** — ABS author portraits + genre glyph tiles (owner
ran "Match all authors" overnight — VERIFY the live author wall); **THE WEBKIT LOGIN CRISIS
CLOSED** — owner ruled Option A, the nesting-lowering initContainer shipped (markers → 0),
**compat mode REVERTED, old-WebKit native 3/3 green, Plex-first ordering self-healed** (his
hard criterion), `%(theme)s` fixed, upstream comment POSTED (goauthentik#19814), PLAN-042 →
completed/ (watch: re-audit lowering "suspects" on authentik image bumps — OPS-009);
**F-10 EXECUTED** — 58 foreign quarantined (content-scanned, not tags), 57 English re-grabs
queued (34 landed same night), **LL→SAB was silently 404-ing and got fixed live**
(`SAB_SUBDIR=''`), German re-poisoning blocked (REJECT_WORDS hardened; **7 titles need
MAM-English when the gate reopens ~Tue eve**), Orwell-essays ruling OPEN; **the INTEGRATION
TAB SAGA founded (PLAN-043) + its Goodreads MVP BUILT AND DEPLOYED (PLAN-044, v0.49.0)** —
app-side shelf-RSS sync, no-gate Missing flow, coverage %, manual search, comics parked;
`sync-goodreads` CronJob `:41` + LL/GB keys wired (haynes-ops `dddd2126`).

**TUESDAY #1 — PLAN-044 LIVE ACCEPTANCE (owner-present, ~15 min):** /integrations as admin →
link `goodreads.com/haynesnetwork` (user id **202652880**, to-read shelf PUBLIC, 6 items incl.
2 comics) → run `sync-goodreads` → verify LL Wanted both formats + coverage math + Missing/
"Search again" (audited) + comics parked + governor untouched → move PLAN-044 to completed/.
Then: F-10 tail (gate reopens ~Tue eve → the 7 MAM-English titles; F-11 spot-check candidate),
next builds (PLAN-038 dispatchable; saga next phases), standing owner items (SMTP F-04, qB
5.2.1 Approved Clients, Helpdesk ratify, Kavita WebP, Safari TOTP retest, MAM "Not Connectable"
IPv4 = Mullvad-no-port-forward decision someday).

**Mechanics (fresh confirmations):** release image builds ride the release-please run on main
(NO tag runs — don't watch for them); flux source = `haynes-ops`, kustomization =
`cluster-apps`; every release PR needs close/reopen; up-to-date-branch strands everything —
run un-strand watchers. Probes all clean all session; the model-switch rules below stand.
Prior session context below ↓

**Site is live at https://haynesnetwork.com; latest release v0.46.3.** Session 5 ran Sunday midday
→ Monday 01:00 — the owner tested with his SISTER (real second-user feedback) and everything she
hit got fixed same-day. **Full chronicle: `.agents/context/2026-07-13-session-5-wrap.md`** — read
it; the headline items: **v0.46.1** (OG-localhost fix) → **v0.46.2** (embed copy "members only.")
→ **v0.46.3** (sister's **nav-overlap on sub-375px phones**, PR #238 + **F-06 cover latency**
WebP/LRU, PR #237); **THE WEBKIT LOGIN CRISIS — PARTIALLY fixed, ESCALATED at 01:00**
(compat mode `571c7a65` + brand green `0d9699a` verified in Playwright engines, but the owner's
REAL Safari 18.3.1 still crashes — TRUE root cause per upstream #19814 RCA: **native CSS nesting
in authentik ≥2025.12 + WebKit bug #290102**, CSS-engine crash immune to ShadyDOM; current-OS
WebKit is fixed, old iOS/macOS crashes; **PLAN-042 REWRITTEN — owner must rule Monday between
A: our asset nesting-lowering mitigation (dispatchable, RCA-verified recipe) / B: upstream
watch / C: users update OS**; compat mode stays ON meanwhile); **Matilda + Throne-of-Glass German strays root-caused** (Kavita merges series-folder
files; German audio quarantined; the 7-book Maas batch landed **Kingdom of Ash audio (the
sister's ask)** + 4 more same-night; ToG bk1/Heir-of-Fire audio/KoA epub in LL's retry queue);
**F-09 epubs repaired** (15 fixed / 3 quarantined / 7 documented); **F-10 English-language audit
filed (owner-ordered)**; the MAM **gate is CLOSED post-batch (correct)** — reopens as torrents
mature ~Tue eve. GB truths for the saga: the key IS wired and 503-bursts hit keyed calls anyway →
retry/backoff mandatory; `searchItem`≠title search (use GB-volume-id → `addBook`). Prior session
context below ↓

Session 4 (Sat eve →
Sun 1am): fixed the MAM pipeline live (qB queueing trap + backwards provider priority — twice;
Prowlarr's fullSync LL application OWNS LL's provider config), shipped **PLAN-039 MAM governor
(v0.45.0, live-validated)** and **branded link previews (v0.46.0)**, ran the list-sources
research (#221) + the Seerr-for-books survey (#227 — verdict: **adopt nothing**, build in the
saga), filed PLAN-040/041, escalated **PLAN-032 → the Books Automation Saga** (owner leans to a
SEPARATE application; own API; app UI = config/monitoring), and proved the pipeline end-to-end
with the **Matilda English re-grab** (Q-06 happy-path closed; GB 503-burst/no-retry = saga design
input). Full chronicle: `.agents/context/2026-07-12-session-4-wrap.md`. The owner is testing over
the weekend and will report fixes/polish.

**Monday plan (owner-stated: "go hard" after the Fable reset, Mon 08:00):**
1. **PLAN-029 build** — DESIGN COMPLETE (ADR-051/052/053 + DESIGN-026 Accepted). Owner's standing
   lean: **Opus** on the data/domain layer (`released_at` sync-add, per-user prefs table,
   watch-state mapping) + a **Fable agent** on the sort/filter UX. Needs only the green light.
2. **Books Automation Saga scoping session** — the separate-app architecture (list engine driving
   ebooks/audiobooks/comics the Kometa way, requests in-app per the #227 verdict, wanted-view
   first, comics-source hunt, PLAN-040/041 fold-in) — now with session-5's inputs: GB retry
   MANDATORY even keyed, `searchItem`≠titles, calibre missing from the LL image, and REAL
   requests already arriving by sister-text.
3. **F-10 English-language audit** (owner-ordered, Opus-able, governor-paced) — also sweeps the
   F-09 leftovers (3 corrupt re-grabs + 7 other-defect epubs), azw3-only strays, and empty
   folders. F-08 comic re-grabs remain the first comic workload.
4. **PLAN-042 RULING (elevated — the owner is advertising the site):** old-WebKit visitors
   (iOS ~16–18, older macOS Safari) crash on the login page and compat mode does NOT cover them.
   Rule between Option A (build our asset nesting-lowering mitigation — dispatchable, recipe in
   the plan), B (upstream watch / file the fix upstream), C (accept old-OS breakage). Then
   **PLAN-038** + owner-test feedback fixes.

**Owner-side (surface Monday):** **SMTP (F-04) is the ONE known 1Password blocker** — Google
Workspace app password + `noreply@haynesnetwork.com` alias into a 1P item (unblocks PLAN-035 +
estate email). MAM: **gate CLOSED post-batch (correct)** — ~19 in books-mam, reopens as torrents
mature ~Tue eve; NO manual grabs meanwhile; verify qB 5.2.1 on Approved Clients. Login page:
ratify the restored **brand-green screenshots** + rule on the Plex-first-ordering follow-up
(fix now with the same technique vs wait for the PLAN-042 revert). Kavita admin lever for
cover weight: Media → "Save Media As" = WebP (F-06 residual). Standing: ratify "Helpdesk" vs
"Tickets"; usage-credits toggle is ON (weekly-cap overflow spends the credit balance).

**Model-switch watch (CRITICAL — now BOTH directions):** the Fable→Opus coordinator safeguard
(owner is the backstop; probe before every dispatch/PR-merge/cluster-mutation) **plus the new
finding: ANY post-stop continuation of a subagent — SendMessage resume OR self-resume via its own
background watcher — re-resolves to the session model (Fable), silently dropping `model: opus`.**
Proven twice 2026-07-11/12. Countermeasures (now standard): dispatch prompts end with "arm
`gh pr merge --auto` then END, never wait on CI"; transcript ground-truth
`grep -o '"model":"[^"]*"' <output-file> | sort | uniq -c` when a finished agent shows new
activity; TaskStop a flipped continuation and the coordinator takes the tail. See
`[[subagent-resume-loses-model-override]]` + `[[fable-safeguard-model-switch]]`.

---

- **Last updated:** 2026-07-15 ~00:45 — **TUESDAY FULL-DAY WRAP.** Eleven releases
  v0.47.0→v0.56.0 (library overhaul → Goodreads/Integrations saga MVP+hub → card system →
  Activity complete+reactive → nav restructure/Tickets); import pipeline rescued; WebKit crisis
  closed; F-10 executed; MAM gate OPEN Tue night; integrations all-roles; ops doctrine hardened
  (artifact-pair gate, dance guardrails, alert retune). Plans 044–048 BUILT+LIVE pending the
  owner ratification sweep. Chronicles: session-6 wrap + tuesday-daytime wrap (+addenda).
- **Prior milestone:** 2026-07-14 ~03:00 — **SESSION-6 WRAP (Monday "go hard").** v0.47.0
  (PLAN-029 complete: #243+#245) + v0.48.0 (group-card art #249) + v0.49.0 (PLAN-044 Goodreads
  MVP #253 + haynes-ops `dddd2126` CronJob/secrets) all live-verified. PLAN-042 CLOSED (Option
  A built + compat reverted + upstream comment posted; completed/). F-10 executed (58
  quarantined / 57 re-grabs / 34 landed; LL→SAB SAB_SUBDIR fix; 7 await MAM ~Tue eve; Orwell
  ruling open). Integration Tab Saga founded (PLAN-043; PLAN-033 subsumed). PLAN-044 ACTIVE
  pending Tuesday live acceptance. Chronicle: `.agents/context/2026-07-14-session-6-wrap.md`.
- **Prior milestone:** 2026-07-13 ~01:00 — **SESSION-5 FINAL (Sunday: the sister-test day).**
  v0.46.1 (OG localhost) + v0.46.2 (embed copy) + v0.46.3 (sister's nav overlap #238 + F-06
  cover WebP/LRU #237) all live-verified. WebKit login crisis: compat-mode workaround
  (`571c7a65`) + brand-green re-win (`0d9699a`) shipped and engine-verified, then **ESCALATED —
  real Safari ≤18.3.x still crashes; RCA = authentik's native CSS nesting + WebKit #290102;
  PLAN-042 rewritten, owner rules Monday (options A/B/C)**. Books: Matilda closed (#232); F-09
  epubs repaired (15/3/7); German ToG audio quarantined; Maas batch landed **Kingdom of Ash
  audio** + 4 more (3 titles in LL retry); F-10 English audit filed (owner-ordered, #239); GB
  key confirmed wired, 503-bursts hit keyed calls (retry mandatory; `searchItem`≠titles). MAM
  gate CLOSED post-batch (correct; reopens ~Tue eve). kubectl/Omni outage mid-session
  (owner re-auth'd; Grafana fallback proven). Chronicle:
  `.agents/context/2026-07-13-session-5-wrap.md`.
- **Prior milestone:** 2026-07-12 — **SESSION-4 WRAP (the books-pipeline night).** MAM live fixes
  (queueing trap; provider priority via the Prowlarr-fullSync ownership discovery — OPS-013
  corrected twice); **PLAN-039 governor COMPLETED v0.45.0** (ADR-054/DESIGN-027/0041/
  `@hnet/downloads`; live-proven 13→14 unsatisfied across the real Matilda grab); **link-preview
  branding v0.46.0** (DESIGN-004 D-20; one-constant copy; `/og` banner; `?v=2` to bust Discord's
  embed cache); list-sources research #221 + Seerr-for-books survey #227 (adopt nothing);
  PLAN-040/041 filed; **PLAN-032 escalated → Books Automation Saga** (separate-app lean);
  PLAN-033 survey done; Matilda END-TO-END proof (GB 503/no-retry = saga input); the
  subagent-resume model-flip mechanism found + countermeasures standardized. Chronicle:
  `.agents/context/2026-07-12-session-4-wrap.md`.
- **Prior milestone:** 2026-07-11 — **BOARD AUDIT + SESSION-3 WRAP.** Filed to `completed/`:
  PLAN-036 (history contract v0.43.1), PLAN-034 (Helpdesk v0.44.0), PLAN-031 (MAM acquisition Phase B),
  PLAN-021 (AI/Open WebUI — shipped earlier, filed in the audit). Deleted 3 stale active duplicates
  (023/027/034 pre-completion copies). PLAN-029 design docs merged (plan stays ACTIVE for the build).
  Milestone detail for the MAM pipeline ↓.
- **Prior milestone:** 2026-07-11 — **PLAN-031 MAM BOOKS ACQUISITION — PHASE B COMPLETE + LIVE
  (cluster-only; no app-repo/version change).** MyAnonaMouse is wired into the books pipeline end
  to end. **haynes-ops PR #2024 (merged):** `myanonamouse` ExternalSecret (two 1P session cookies
  — Session A ASN-locked→Prowlarr, Session B dynamic-seedbox→updater) + a **`mam-update` sidecar**
  in the qBittorrent pod (3rd container; shares the macvlan netns so `dynamicSeedbox.php` egresses
  the exact Mullvad exit qBittorrent announces from). The sidecar confirms `mullvad_exit_ip:true`
  before every call (fail-closed), self-throttles to ≤1/hr, and **persists the rotating `mam_id`
  cookie** to a config-PVC subpath (seeded from 1P on first run only). Pod rolled **3/3, readiness
  green**; updater logged `Completed: registered seedbox IP 87.249.134.9`. **Live imperative
  config** (in each app's PVC/DB, like the rest of the *arr stack): Prowlarr **MyAnonaMouse**
  indexer (id 17, `Test` green from the home ASN, seed criteria left empty); qBittorrent
  **`books-mam`** category → `/data/cephfs-hdd/torrents/books/books-mam` (seed-forever via
  globally-disabled limits + Pause-not-delete; anonymous off; private DHT/PEX auto-disable intact;
  port 50469 + readiness untouched); LazyLibrarian **`[Torznab_0]` MAM** provider (enabled,
  **USENET-FIRST** `dlpriority=100`, routes to `books-mam`, `KEEP_SEEDING`=copy-and-hold, per-provider
  seed limits 0 so LL sends no share cap). **End-to-end proof (1 authorized freeleech grab):** *Lee
  Child EBOOKS PACK* (MAM t/151785, 34.5 MB, `dvf=0`) → downloaded 100% into `books-mam` → **MAM
  tracker status `Working`** (announces from the Mullvad exit accepted, not unregistered) → left
  **seeding indefinitely**. As-built runbook + break-glass: **`docs/ops/013-mam-books-acquisition.md`**.
  **Deferred (owner-present):** pin the VLAN-30 gateway's Mullvad server (the updater covers rotation
  meanwhile). **Owner-side:** regular MAM login, batch pacing under the New-Member cap (20), verify
  5.2.1 on the Approved Clients page. Next books items: PLAN-039 (cap-aware governor), first
  freeleech batches, F-08 comic re-grabs.
- **Prior milestone:** 2026-07-11 — **PLAN-034 HELPDESK TICKETS COMPLETE, live (v0.44.0, feat PR #210 +
  release PR #209).** The Bulletin **Messages board is now the "Helpdesk"** — a household MEDIA-ISSUE
  ticket system (site bugs go to GitHub; the intake copy says so). The **name is a Fable proposal the
  owner ratifies at screenshot review** — it is ONE constant (`HELPDESK_NAME` in `apps/web/lib/
  bulletin.ts`); a rename to "Tickets" touches no stored value/route/grant. **Domain (ADR-050, migration
  0040):** `tickets` + APPEND-ONLY `ticket_events` (creation `null→open` + every transition, optional
  HOUSEHOLD-VISIBLE note) + `ticket_replies` (flat thread); state machine **`open ⇄ in_progress →
  complete | rejected`** — complete TERMINAL, rejected RE-OPENS (matrix `TICKET_TRANSITIONS`, enforced
  under a row lock → CONFLICT); **`DROP TABLE messages`** (owner ruling Q-03 — test data; the Feed +
  grant tables untouched). **Permissions ride the EXISTING grants (option H, zero new machinery):**
  create = message-action `post`, transitions = `moderate` ONLY (Q-02 — the author can't move their own
  ticket), view/detail/REPLY = the `messages` sub-view grant (any member may chime in), household
  visibility (Q-01 — no hidden rows, no moderator-only fields). **Q-04:** `createTicket` enqueues a
  `ticket_created` Pushover outbox row in the SAME tx (ADR-034 C-01), drained by the existing `*/13`
  notify-outbox CronJob, deep-linking `/bulletin/ticket/<id>`. **UX (the owner's poster-wall lean):**
  Helpdesk is the FIRST tab (Feed second; `?tab=messages` aliases); the wall is a `.twall` poster grid
  (3-up at 390px) — linked titles show their poster (ADR-019 proxy), non-media tickets show their
  intake-CATEGORY icon tile (playback/audio/subtitles/quality/missing/other, `ticket-glyphs.tsx`), the
  STATE bakes on as a colored corner puck (open=warning dot · in_progress=info half-ring ·
  complete=accent check · rejected=muted slash + grayscale) + a badge, reply counts + compact dates;
  state filter CHIPS with counts replace All/Visible/Hidden/Deleted; **compose never stacks above the
  list** — a "New ticket" **Modal** (title · category icon grid · linked-title picker · details), and
  success pushes the new ticket's `/bulletin/ticket/[id]` DETAIL (the movie-detail idiom: hero + staff
  transition buttons whose Modals carry the optional reason + Report + History timeline + reply
  thread). DESIGN-004 **D-19** honored (tabs/drill-ins push; chips replace); ADR-015 reflow-free;
  tokens-only. **Docs:** ADR-050 / DESIGN-012 **D-10..D-13** / PRD **R-160..R-164** / DDD
  **T-145..T-148**. **Tests:** domain `tickets.test.ts` — the FULL 4×4 matrix (const AND DB-enforced) +
  the outbox SAME-TX proof in BOTH directions (committed together; a forced enqueue failure rolls the
  ticket back); api `communication.test.ts` — the permission matrix (author-FORBIDDEN transitions,
  feed-only FORBIDDEN replies, moderator-needs-post create, illegal-edge CONFLICT, household detail);
  db 0040 block (CHECKs + the messages DROP); e2e `helpdesk.spec.ts` (member-files → staff-transitions-
  with-reasons → member-replies → reject/re-open → wall + filters) GREEN. **Live proof (prod v0.44.0):**
  `/api/health` 200; rollout clean (no kyverno sig denial); `to_regclass` shows the 3 ticket tables +
  `messages` NULL; **4 owner-authored EXAMPLE tickets seeded through the app's own writers and LEFT as
  onboarding examples (Q-03)** — Top Gun: Maverick (playback, open) · Severance (audio, in_progress +
  staff note + reply) · Oppenheimer (subtitles, complete + resolution) · a non-media "website bug"
  (other, rejected with the GitHub-routing note); 7 events + 1 reply + the 4 queued same-tx pings;
  unauth gates 307/401. **haynes-ops = image bump ONLY** (`398ce0ff`). **OWNER's morning:** ratify
  "Helpdesk" vs "Tickets" at the screenshot review (12 hermetic shots captured — wall/compose/detail ×
  desktop/390 × dark/light); the 4 Pushover pings that announced the example tickets are the live Q-04
  proof. **Known seam (backlogged):** the hermetic e2e stack seeds NO `media_plex_matches`, so a
  non-admin's `ledger.search` is gated EMPTY by THE INVARIANT (ADR-047 cold-start deny) — the
  pre-existing advisory-e2e red on main; the helpdesk spec routes the picker through the admin, and the
  harness should someday seed matches to restore member library journeys estate-wide.
- **Prior milestone:** **PLAN-036 HISTORY-NAVIGATION CONTRACT COMPLETE, shipped (v0.43.1,
  fix PR #206 + release PR #207).** Browser **Back/Forward now behave like SCREEN navigation.** Every
  `?tab=`-driven hub switched tabs with `router.replace`, so a tab switch rewrote the current history
  entry and Back exited the app screen; now **screen-level tab switches `router.push`** (keeping
  `{ scroll: false }`) so each tab visit is a history entry — **Back restores the prior tab WITH the
  URL-synced filter state its entry carried** (refinement edits still replace-in-place within that
  entry), Forward re-applies. **Six `selectTab` sites converted to push:** Library kind tabs, Bulletin
  Feed/Messages, Metrics sub-tabs, Trash tabs (incl. the Overview jump-to-kind cards), Trash-settings
  tabs, Ledger tabs. **Left `router.replace` (unchanged):** refinements (filter chips / sort / debounced
  search / pagination via `patchParams`; the Feed `?src`/`?media` segs; the Ledger Runs `?kind=` filter)
  and canonicalizing redirects (Metrics + Trash-settings bare/unknown-`?tab` normalization; the retired
  Trash `?tab=batches` fold) — a redirect must not mint a history entry. **D-09 search semantics
  unchanged except the tab dimension; no visual change; ADR-015 untouched; deep links + tab-switch
  scroll preserved.** DESIGN-004 **D-19** carries the contract (no new ADR/PRD/migration/glossary).
  **Tests:** new `apps/web/e2e/history-navigation.spec.ts` reproduced the defect (pre-fix: Back landed
  on `/` for all four hubs) then asserts the contract (Library TV→Movies→Back⇒TV filters intact→Forward
  ⇒Movies; back-restores-tab for Bulletin/Metrics/Trash); full local bar + CI required checks green on
  #206/#207. **haynes-ops = image bump ONLY** (`71655484`, v0.43.0→v0.43.1; no new CronJob/secret).
  **Deploy note:** Siderolabs-Omni K8s API was unreachable from the build host at deploy time (known
  intermittent kubectl outage) — the bump is pushed and Flux reconciles it cluster-side; public
  `/api/health` = 200; live rollout-to-v0.43.1 confirmation deferred until the Omni API path returns.
- **Prior milestone:** **PLAN-027 ROLES-GRID CLARITY + BULLETIN FEED/MESSAGES VIEW GRANTS
  COMPLETE, live (v0.43.0, PR #204).** `/admin/roles` stopped offering no-op permission levels: a
  per-section **capability map** (`apps/web/lib/role-sections.ts`, derived from the gating code) renders
  a 2-state **Enabled/Disabled** control for **Bulletin / Metrics / ytdl-sub / Books** (they only ever
  gate `read_only`) and KEEPS **Edit/Read-only/Disabled** for **Ledger** (bulk add-&-search) + **Trash**
  (rule editing + Trash settings need `edit`). The stored `SECTION_PERMISSION_LEVELS` enum + DB values are
  UNCHANGED ("Enabled" persists `read_only`); a future real Edit flips one map entry. **Bulletin Feed vs
  Messages** is now separately grantable per role via a new `role_bulletin_view_grants` table (row-per-view,
  `setRoleBulletinViews` single-writer, audited `update_bulletin_views` in-tx, guard-listed; migration
  0039) — **server-enforced**: `communication.feed` needs the `feed` grant, `communication.messages.*`
  the `messages` grant (`bulletinViewProcedure`); a role without a view gets FORBIDDEN and no such sub-tab.
  Resolution is **default-ON** (no rows ⇒ both views — ADR-026 C-02; present rows narrow; Admin implies
  both), so only the **Default** role is narrowed (seeded `messages`-only by 0039 — the Feed is
  Family/Friends chatter); Family/Friends/custom keep both, none silently lose the Feed. The `/admin/roles`
  Bulletin cell = Enabled/Disabled dropdown + **[Feed][Messages] checkboxes** (greyed when Disabled) + the
  message-action badge (ADR-015 reflow-free, no new hex). ADR-049 / DESIGN-004 **D-18** + DESIGN-012 D-09 /
  R-159 / T-143 (Bulletin View Grant) + T-144 (Section Capability Map). **Live proof:** `/api/health` 200 on
  v0.43.0; migration 0039 applied; **prod DB** `role_bulletin_view_grants` = { Default → messages } + 2
  other non-admin roles no-row (⇒ both); a Default persona's `/bulletin` calls ONLY
  `communication.messages.list` (never `feed`) and shows NO Feed tab; 390 + desktop screenshots via
  `e2e/support/capture-roles-bulletin.ts`. Tests: `packages/api communication.test` (messages-only ⇒ feed
  FORBIDDEN; feed-only ⇒ messages FORBIDDEN), `packages/domain bulletin-view-permissions.test` (default-both
  + Default seed), `packages/db migrations.test` (0039 CHECK + seed). **haynes-ops = image bump ONLY**
  (`5d00db5e`; no new CronJob/secret). Batched with the MOTD markdown/glyph redesign (DESIGN-004 D-17) in the
  same v0.43.0 release.
- **Prior milestone:** **PLAN-030 SEASON POSTERS + TV EPISODE THUMBNAILS COMPLETE, live
  (v0.41.0, PR #198).** Every Season row on a show-detail page now shows the season POSTER as a small 2:3
  icon (reserved box, ADR-015 reflow-free; no icon when absent) — **TV** from the ADR-047
  `media_plex_matches` → the show's Plex season art; **Peloton** from the live k8plex duration posters
  (the restored PLAN-024 art, now VISIBLE). TV expanded seasons gain **episode thumbnails** (the ADR-041
  `still` variant), merged onto the *arr rows by `(season, episode)` number (`episodeNumber` now on
  `ledger.children`). New READ-ONLY `ledger.plexSeasons`/`ledger.plexEpisodeArt` (re-gate + degrade to
  `available:false`/no-icons on unmatched/inaccessible/Plex-down) + `ytdlsub.detail.seasons[].posterUrl`.
  **THE INVARIANT (ADR-047) holds for art:** TV art rides a **signed, item-scoped** `/api/library/plex-art`
  proxy reference — an HMAC over `(mediaItemId, serverSlug, thumb, size)` minted only after the per-item
  gate passes, re-verified AND access-rechecked by the proxy — so an inaccessible sibling title's art on
  the same server is never served (`signPlexArtRef`/`verifyPlexArtRef`, `resolveArtMatchForItem`,
  `resolvePlexArtUpstream`). One source (Plex via the match, NO TMDB). **NO migration**; reuses the ADR-041
  transcode/LRU/ETag path on the MATCHED server (server-scoped ETag/LRU key). Signing secret =
  `BETTER_AUTH_SECRET` (mint+verify in one Next process). ADR-048 / DESIGN-005 D-22 + DESIGN-017 D-09 amend
  / R-158 / T-142. **Live proof:** `/api/health` 200 on v0.41.0; `/api/library/plex-art` 401 unauth
  (deployed + session-gated); 390px + desktop dark/light screenshots of the season-poster row + episode
  stills (`e2e/support/capture-season-art.ts` against the hermetic stub stack). **haynes-ops = image bump
  ONLY** (`746b1c45`; no new CronJob/secret). Tests: `packages/api/__tests__/library-plex-art.test.ts`
  (sig tamper-rejection + matched-server transcode) + `ledger-plex-art.test.ts` (season posters + episode
  stills end-to-end + withheld-item NOT_FOUND) + the `resolveArtMatchForItem` gate + Peloton season poster.
- **Prior milestone:** **PLAN-028 "Watch/Listen/Read here" ACCESS-AWARE DEEP LINKS COMPLETE,
  live (v0.40.0 + v0.40.1).** Every Library drill-in now deep-links to the app that serves the title, and
  ALL Plex-backed content is gated to the caller's accessible Plex libraries **server-side** (THE
  INVARIANT — ADR-047/DESIGN-025/R-157/T-139..T-141, PR #192 + fix #194). The **`media_plex_matches`**
  cache (migration 0038; one row per **(media_item, plex_library)** — mirrored titles get several) is
  resolved by the new **`plex-match`** sync mode by shared GUID (radarr tmdb→imdb, sonarr tvdb→imdb,
  lidarr mbid) — hourly haynes-ops CronJob `sync-plex-match` (`52 * * * *`; reuses PLEX_*_TOKENs, no new
  secret). **Live match rate:** radarr 5,445/9,564 (57%) · sonarr 840/1,026 (82%) · lidarr 4,428/7,208
  (61%) → 17,071 rows; unmatched = wanted/missing items never in Plex (gated by their kind's home
  libraries, NO link — hidden only by access, never by match state). **v0.40.1 gotcha (remember this):**
  Plex OMITS the external `Guid` array from `/library/sections/{key}/all` unless **`includeGuids=1`** —
  the first sweep matched 0/17,269 (root-caused live from the pod; one-line fix on
  `listSectionContentsPage`). **THE GATE:** `resolveLibraryAccessGate` REUSES `effectiveAllowedLibrariesForUser`
  (ADR-024; admin ⇒ unrestricted) + a per-(kind,instance) candidate-library derive; EXISTS-subquery WHERE on
  `ledger.search/detail/events/children/wanted/filterFacets`, `ledgerAdmin.browse/count`, the JSONL export,
  AND `/api/posters/[id]` (the art-by-id leak closed); ytdl-sub gets a per-k8plex-library gate
  (`accessibleYtdlsubLibraries`) under the section knob; a withheld library's TAB hides (server-resolved
  in /library page.tsx). **Deliberate owner-approved tightening:** non-admin Library visibility now
  follows the role→library grant matrix (Default currently holds all *arr-feeding libraries, so members
  see no change until the owner withholds one). **Owner UX amendment shipped:** posters ALWAYS open the
  detail page (no wall jump-outs); ↗-marked PRIMARY buttons — ONE **"Watch on Plex — <library>"** per
  accessible library; NEW **`/library/books/[id]`** detail pages ("Read in Kavita" / "Listen on
  Audiobookshelf"; books gating unchanged). **Live invariant proof** (hnet-e2e-member on a throwaway role
  deliberately withholding HOps Music, set up via the app's own audited writers, then fully restored):
  ZERO items via search/text-query/pagination/facets/wanted; 404 on direct-id detail/events/children AND
  the poster proxy (accessible control 200); **Music tab ABSENT** (390px + desktop screenshots); the
  accessible movie showed BOTH library buttons. Unit proof: `packages/api/__tests__/library-access.test.ts`
  (zero-leak per endpoint + admin/server-all/no-grants/multi-library) + `packages/sync/__tests__/plex-match.test.ts`.
  Also landed: the 57P01 teardown-flake hardening (pool 'error' listeners in all four test-harness
  helpers — the flake hit 3 CI runs in a row before it). haynes-ops `86578465` (bump + CronJob) +
  `8dfecca4` (v0.40.1). Cosign/kyverno note: a fresh release can be denied "no signatures found" for a
  few minutes (sig propagation + kyverno cache) — re-`flux reconcile helmrelease --force` after ~5 min
  clears it. Prior milestone — PLAN-023 Phase 4 (below).
- **Prior:** 2026-07-10 — **PLAN-023 Phase 4 Books & Audiobooks LIBRARY LEDGER COMPLETE, live
  (v0.39.0).** Books/Audiobooks/Comics are now first-class **Library** content: a one-way synced MIRROR of
  **Kavita** (Books=EBooks + Comics) and **Audiobookshelf** (Audio Books) in a **dedicated `books_items`
  table** (owner ruling Q-04 "full ledger integration in v1") — NOT `media_items` (ADR-046: books have no
  monitored/quality/root-folder/Fix semantics; overloading the *arr ledger would corrupt its invariants +
  drag books into /ledger's Fix/bulk-add). hard rule 4 EXTENDED: Kavita/ABS are the source of truth for
  book media; sync flows IN, **NO write-back** (no Fix/Restore for books). New read-only **`@hnet/books`**
  package (Kavita + ABS clients, lazy login + token cache + 401 re-auth; **no `./write` export**). New
  **`books-sync`** mode + `@hnet/domain syncBooks` single-writer (upsert + scoped-tombstone in one tx; no
  `sync_runs` row; standalone like `ai-usage-sync`; guard-listed). Three **Library walls** (poster grid +
  filter/sort engine + `MediaPoster`) after YouTube, before My Fixes — order **Movies·TV·Music·Peloton·
  YouTube·Books·Audiobooks·Comics·My Fixes**; rows deep-link OUT to Kavita/ABS. Authed **`/api/books/cover`**
  proxy (creds server-side, ETag/304; ADR-019 posture; unauth → 401). Gated by a new **`books`
  Section-Permission** defaulting **`disabled`** = ships **Admin-only** (owner opens per role after review).
  Two seeded `app_catalog` cards (Kavita, Audiobookshelf) + `kavita`/`audiobookshelf` icon keys — **NO role
  grants seeded** (owner grants Default/Family after review). migration **0037** (books_items + section/sync
  CHECK rebuilds + catalog seed). **LIVE-VALIDATED (2026-07-10):** the `sync-books` CronJob ran clean
  against real Kavita/ABS — **upserted 2116 rows: 1283 books + 10 comics + 823 audiobooks** (DB-confirmed;
  covers on 1283+823+9); all three walls render real covers via the proxy at desktop + 390px (screenshots
  captured, admin `hnet-e2e`); unauth cover gate 401; level seam unit-proven (Disabled→FORBIDDEN, Read-Only
  opts in, Admin sees). Docs: **ADR-046 / DESIGN-024 / PRD R-151..R-156 / DDD T-136..T-138**; PR #187 →
  v0.39.0; haynes-ops `d865bff1` (image bump + `sync-books` CronJob `22 * * * *` + KAVITA_PASSWORD/
  AUDIOBOOKSHELF_PASSWORD in the ExternalSecret from the `kavita`/`audiobookshelf` 1P items). **OWNER
  MUST-DECIDE (morning):** (1) open the `books` section (`read_only`) to which role(s) via `/admin/roles`
  after the screenshot review; (2) grant the Kavita/ABS **catalog cards** to Default/Family (or keep
  admin-only) — both reversible in `/admin`; (3) the two cards' copy ("Read — ebooks & comics" / "Listen —
  audiobooks"). Note: comics currently only 10 series live in Kavita (import still catching up — the migrated
  1737 files aren't all series-scanned yet); genre filter chips are a deferred follow-up (the
  `books.filterFacets` endpoint ships + is unit-proven). Prior milestone — PLAN-026 Authentik role portal (below).
- **Recent:** 2026-07-10 — **PLAN-026 Authentik user/role PORTAL COMPLETE, live (v0.38.0).**
  haynesnetwork now **writes Authentik group membership** — a role change propagates to every
  Authentik-backed app (Open WebUI today; Kavita/ABS later), for **every** Authentik identity incl.
  Plex-external + never-logged-in. Two import-confined write surfaces (`@hnet/authentik/write`,
  `@hnet/openwebui/write`, arr-write-guard extended) driven only by the domain orchestrators
  (`provisionSyncedTier` / `assignRolePortal`). **Roles gain a `synced_tier` flag** — creating one
  auto-creates the Authentik group (name = role lowercased) + the same-named OWUI group + an owned-groups
  allowlist entry. **THE GUARDRAIL:** membership is written ONLY for allowlisted owned groups
  (`AuthentikGroupNotOwnedError` before any external call) — never flows/stages/policies/providers/brands
  or `mfa-exempt`/`authentik Admins`; **group deletion is out of scope**. Assigning a role to an app user
  flips membership + `assignRole`; assigning to an Authentik-only identity writes the group + parks a
  **`pending_role_assignments`** row consumed on first login (keyed by **email** — the OIDC sub is a
  `hashed_user_id`). Exclusive across owned tier groups. External writes append a `authentik_group_audit`
  ledger (plex_share_audit class); local changes are same-tx `permission_audit`. A `sync-authentik-users`
  CronJob (`7,27,47 * * * *`) mirrors the directory for `/admin/users` (source badges + role assignment);
  `/admin/roles` gains the synced-tier toggle. **Dedicated Authentik service account `hnet-portal`**
  (user pk 246; RBAC role `hnet-portal` = view_user/view_group/add_group/add_user_to_group/
  remove_user_from_group — **least-privilege verified**: users/groups 200, providers/flows 403; use an
  **`intent:api`** token, NOT the service_account `app_password` one) → cluster secret
  **`haynesnetwork-authentik-token`** (`AUTHENTIK_API_TOKEN`; the app NEVER uses the homepage token).
  **Acceptance a/b/c/d PASSED on PROD:** Friends synced tier created (Authentik + OWUI `friends`);
  mikebi12 (pk 109) → `friends` (left `family`) + pending row + audit; hnet-e2e temp-in-friends → headless
  OIDC → OWUI **"Adding user to group friends"** → cleaned up; mfa-exempt write refused. Docs: **ADR-045 /
  DESIGN-023 / OPS-011 / PRD R-144..R-150 / DDD T-129..T-135**; migration 0036; PR #183 → v0.38.0;
  haynes-ops `20640caa`. **Owner TODO (nicety):** migrate `AUTHENTIK_API_TOKEN` into 1Password + the
  ExternalSecret (currently a cluster-created secret, the `haynesnetwork-webhook` precedent). Prior
  milestone — PLAN-024 Peloton poster guard (below).
- **Recent:** 2026-07-10 — **PLAN-024 Peloton poster guard COMPLETE, live (v0.36.0).** The k8plex
  **HOps Peloton** posters are now durable: a one-time restore reapplied all 88 show/season posters, and a
  new **`poster-guard`** `@hnet/sync` mode (hourly haynes-ops CronJob `sync-poster-guard`, `37 * * * *`)
  **re-applies only DRIFTED posters** and records each in an append-only **`poster_guard_applications`**
  ledger (drift baseline + audit; single-writer, guard-listed; no `sync_runs` row). The durable override
  PNGs live **git-versioned in the app image** (`packages/sync/assets/peloton-posters/`, resolved by live
  show title / season index) — **ADR-043 chose git-in-image + a DB ledger over the owner's DB-`bytea`
  lean** (three ADRs reject poster bytes in the DB; the "PLAN-004 stores poster bytes" basis was false — it
  stores references). **Owner-flagged:** if you'd prefer the DB/NAS as the byte home, it's a one-file seam
  (`createFilePosterAssetSource`). Poster upload is a new **confined** Plex write (`@hnet/plex` write
  subpath, domain-only). **Live-validated:** baseline reapplied 88; re-run idempotent (0); drift test
  restored one clobbered season byte-identically + wrote a `drift` row (ledger 88 initial + 1 drift). Docs:
  **ADR-043 / DESIGN-021 / OPS-010 / R-137..R-140 / T-124..T-125**; PR #175 → v0.36.0; haynes-ops
  `d5ab51d0`. **Unmapped (by design, not guessed):** season index 75 (4 shows) + index 0 "Specials" (2);
  `outdoor-poster.png` unused (no Outdoor show). Prior milestone — PLAN-011 Authentik hardening (below).
- **Recent:** 2026-07-10 — **PLAN-011 Authentik hardening COMPLETE (owner-present): config-as-code
  blueprints + native-account MFA, live.** The Authentik login estate (brand · flows · sources · MFA) is
  now **GitOps blueprints** in `haynes-ops` (`…/network/authentik/app/blueprints/`, one file per concern,
  mounted onto the worker as a ConfigMap) — a **drift-zero** baseline (`10`/`20`/`30`, proven to change
  nothing on apply) with **native-account MFA** (`40-hnet-mfa`) on top. Native (internal-type) accounts —
  `thaynes`, `akadmin`, hand-created locals — now present a **WebAuthn passkey or TOTP** on the
  **username+password** path (enroll on first challenge; friendly chooser "Passkey (recommended)" /
  "Authenticator app (6-digit codes)"). **Plex-source logins are never challenged** (login-only source
  flow — owner ruling: `thaynes`' Plex path accepted, Plex 2FA covers it); the **`mfa-exempt`** group
  (`hnet-e2e`, `hnet-e2e-member`) skips MFA **fail-closed** so Playwright stays green. Owner enrolled a
  **1Password passkey + TOTP backup** on `thaynes` (round-trip verified). **Credentials now:** `akadmin`
  password **rotated + valid in 1Password** (the stale-bootstrap gotcha is GONE; akadmin is break-glass and
  MFA-enrolls on next interactive login); `hnet-e2e` / `hnet-e2e-member` passwords rotated (owner-stored in
  1P); the API token stays in the 1P `homepage` item; provider `client_secret` in the 1P `haynesnetwork`
  item. Live-verified: all four blueprints report `successful`; the MFA stage reads `configure` +
  `[totp, webauthn]`. **Client caveat:** Safari/WebKit fails the TOTP-setup flow — use Chrome (server
  healthy throughout). Docs: **ADR-042 / OPS-009 / R-133..R-136 / T-121..T-123**; haynes-ops PR #2014 +
  `a8bd665b`/`42347d80`/`58355768`. **Open:** Q-10 (akadmin: keep break-glass-with-MFA vs disable
  interactive login), Q-11 (blueprint the OIDC provider/app for full GitOps). Prior milestone — the
  ytdl-sub UX package (below).
- **Prior:** 2026-07-10 — **ytdl-sub UX package (the owner's morning-review fixes to PLAN-022).**
  One release, three items (ADR-041 / DESIGN-017 D-07..D-09 / R-131..R-132 / T-120; **no migration**):
  **(1) Wall perf** — the `/api/ytdlsub/poster` proxy now serves **fixed-size WebP variants** from
  k8plex's own photo-transcode endpoint (closed `size=grid|still` allow-list; original-art fallback on
  a transcode miss), memoized in an in-process byte-capped `ThumbLruCache` (NOT a store) with a strong
  `(size, thumb)` ETag → browser 304s. Measured pod→k8plex: **Peloton wall 29.3 MB → 46 KB (630×)**,
  YouTube 6.9 MB → 856 KB (8×). `MediaPoster` tiles fade in over the reserved 2:3 box (ADR-015-safe).
  **(2) Tab order** — Movies | TV | Music | Peloton | YouTube | **My Fixes last** (D-08).
  **(3) Read-only drill-in** — poster tiles click through to `/library/ytdlsub/[library]/[ratingKey]`:
  show → collapsible seasons → **lazily-loaded** episodes (title · air date · duration + a 16:9
  `size=still` thumb), via new `@hnet/plex` `getMetadataItem`/`listMetadataChildren` reads and
  `ytdlsub.detail`/`ytdlsub.episodes` (both `ytdlsubProcedure`-gated AND **section-confined** by
  `librarySectionID` — a cross-library ratingKey is found:false). No ledger, no actions, no write
  surface. The `ytdlsub` section is **still Admin-only** (no role rows as of this change — the owner's
  flip is still pending, plan Q-03), and the durable-poster sink (PRD **Q-06**) remains open — ADR-041
  C-07 keeps the override seam ready, nothing here makes it harder.
  Prior milestone — **PLAN-019 Metrics → Hardware sub-tab + SMART alerting shipped (v0.34.0), live** (below).
- **Prior:** 2026-07-10 — **PLAN-019 Metrics → Hardware sub-tab + SMART alerting shipped
  (v0.34.0), live.** The 017-scaffolded **Hardware** tab is now wired: an **UNGATED** (owner ruling —
  `full` and `limited` see the same payload) read off the live in-cluster Prometheus via a new
  `@hnet/metrics` `getHardwareMetrics`. Four groups: the headline **NVMe endurance** panel (per-pool
  framing — **Cache-apps** mirror [critical appdata, 57–60% worn] vs **Cache-staging** [expendable, over
  rated endurance but *holding*: spare 100%, 0 media errors] — wear odometer + projection-to-90% with a
  graceful "insufficient history" until it accrues + the real EOL signals), a **Drive health** table (a
  sleeping array disk emits no series → shown "asleep", never red), **Node load**, and a **Proxmox
  host→VM showcase** (in-place expander, ADR-015 exception). **SMART alerting** (ADR-040 / DESIGN-020,
  R-130): a **`smart-alerts` sync mode** + `evaluateSmartAlerts` single-writer + **`smart_drive_state`**
  table (migration 0033) — critical-only, transitions-only paging via the PLAN-016 `notification_outbox`
  (new `smart_degraded`/`smart_recovered` event types). **Baseline-on-first-sight NEVER pages** the known
  staging state; only NEW deterioration does; enqueue + state update commit in one tx. Live-proven on
  prod: a `smart-alerts` run over REAL Prometheus baselined **43/43 drives, enqueued 0**; a second run
  baselined 0 / enqueued 0 (no re-page). Sources (pve-exporter + node-exporter + smartctl) already
  scraped → **haynes-ops change was the image bump only**; **glances deferred** (ADR-040 Q-01).
  **OWNER FOLLOW-UPS:** (1) add a **`smart-alerts` CronJob** in haynes-ops (mirror the notify-outbox
  schedule) to run detection on a schedule — the mode ships in the image but no CronJob exists yet;
  (2) the parallel **ytdl-sub UX PR (#168) also claimed "ADR-040"** — it must renumber (mine merged
  first). ADR-040 / DESIGN-020 / R-129–R-130 / T-117–T-119 / migration 0033.
- **Prior:** 2026-07-10 — **PLAN-020 Metrics → Network sub-tab shipped (v0.33.0), live.**
  The 017-scaffolded **Network** tab now renders off the live in-cluster Prometheus via a new
  `@hnet/metrics` `getNetworkMetrics` read (which REUSES `getNetworkOverview` for the WAN meters —
  one denominator) + a `metrics.network` procedure. **`limited`** = the two WAN upload/download
  **usage-vs-capacity** meters + a **7-day WAN throughput history sparkline** (the only value-add
  over the Overview). **`full`** ADDS **infrastructure-performance** groups — per-gateway/switch/AP
  **CPU·mem·load**, **WAN health** (gateway speedtest + internet-path latency), per-uplink caps, and
  **site rollup COUNTS** (APs/switches/gateways/connected-device count) — each with an "Open in
  Grafana ↗" deep-link to the UniFi-Poller boards (Network Sites / USW / UAP; the **Client-Insights
  board is deliberately NOT linked**). **HARD PRIVACY INVARIANT — no client identities at ANY
  level** — enforced by construction: the allow-listed `network.ts` query module is the single place
  any `unpoller` series is named, and the unit test *"network privacy invariant — the allow-listed
  PromQL module"* proves every query names only `unpoller_(site|device|wan)_*` and matches none of
  the deny substrings (`unpoller_client_`/`_remote_user_`/`_info`/`mac`/`hostname`/`rssi`/`signal`);
  the `limited`/`full` payload is disjoint and server-authoritative (`includeInfra` — `limited` never
  fetches or receives the infra grain). UniFi device names (an AP "Garage") are infrastructure,
  allowed at `full`; the only client-adjacent number is the aggregate station COUNT. **NO migration /
  NO write surface** — rides 017's `metrics` section + `metrics_level`; ADR-039 **refines** (does not
  supersede) ADR-037 C-03/C-04. Pod-verified live: unauth `metrics.network` = 401; the v0.33.0 pod →
  Prometheus returns real WAN 46339 B/s up / gateway CPU 42.7% / 7 APs via the app's exact PromQL.
  Docs: ADR-039 / DESIGN-019 / R-127..R-128 / T-114..T-116. **OWNER's morning:** authenticated
  full-vs-limited visual confirm (SSO-gated; hermetic admin screenshots are the sanctioned
  substitution — desktop + 390px, dark/light); Q-01 promote PoE/port-errors/radio/topology? The
  `metrics` section still ships **Admin-only until the owner flips a role to `limited`**.
  Prior milestone — **PLAN-018 Metrics → Apps sub-tab shipped (v0.32.0), live.**
  The 017-scaffolded **Apps** tab now renders four curated, phone-friendly groups off the live
  in-cluster Prometheus via a new `@hnet/metrics` `getAppsMetrics` read + a `metrics.apps`
  procedure: **Collection** (radarr/sonarr/lidarr totals · monitored · missing · upgrades),
  **Acquisition pipeline** (queue · grabs/hr · health), **Download clients** (SABnzbd
  `sabnzbd`/`sabnzbd-fast` lanes + qbittorrent/slskd reachability — the collection wave's new
  exporters), **Indexers/Prowlarr** (fleet · response times · query rate) — each with a muted
  "Open in Grafana ↗" deep-link (`d/arr-library-overview`, `d/downloads-clients-indexers`,
  OPS-008). **Both-levels** (no *arr/downloader series names a user) with the full-only seam kept
  present-but-empty (`requesterActivity`, ADR-037 C-03) for a future requester panel. **NO
  migration / NO new ADR / NO guard edit** — rides 017's section + level model; visibility is
  still the `metrics` section (**Admin-only until the owner's flip**). Pod-verified live: totals
  9564/114118/55507 match Prometheus; unauth `metrics.apps` = 401. **OWNER's morning:** Q-01
  fast-lane split at `limited`? Q-02 bazarr panel group (sidecar live, not panelled)? Q-03 keep
  all 3 Grafana boards? Docs: DESIGN-018 / OPS-008 / R-125..R-126 / T-113.
  Prior milestone — **PLAN-022 ytdl-sub Library sub-tabs shipped (v0.31.0), live.**
  Two new **Library** sub-tabs (Peloton, YouTube) surface the k8plex ytdl-sub libraries
  (`HOps Peloton` / `HOps YT`), read **DIRECTLY** from the Plex server via a new
  `PlexReadClient.listSectionContents` — **no ledger sync** (this content has no *arr; ADR-038).
  Gated by the new **`ytdlsub`** Section Permission (`disabled` no-row default ⇒ **ships
  Admin-only**); posters stream through a session- + section-gated Plex-thumb proxy
  (`/api/ytdlsub/poster`, extends ADR-019) with a `MediaPoster` fallback tile. Migration 0032 (one
  CHECK rebuild) verified live; the deployed pod reads real k8plex data (12 Peloton / 71 YouTube
  shows). **OWNER's morning actions:** screenshot review → flip role(s)' `ytdlsub` to `read_only`
  (plan Q-03); answer the durable-poster sink (PRD **Q-06** — store deferred; resilient display
  shipped). Docs: ADR-038 / DESIGN-017 / R-121..R-124 / T-110..T-112.
  Prior milestone — **PLAN-017 Metrics section foundation (v0.30.0), live on staging:** a top-level
  **Metrics** section (nav after Bulletin) with an Overview (WAN usage-vs-capacity meters + cluster
  load/memory + storage snapshot), per-role **Full/Limited** (`roles.metrics_level`), and the
  read-only **`@hnet/metrics`** Prometheus client. Migration 0031 verified live. **Ships
  Admin-only** — the OWNER's morning action opens it to Default(limited) + verifies the Limited
  view live. Docs: ADR-037 / DESIGN-016 / R-117..R-120 / T-106..T-109. Q-02: download capacity
  seeded **2256 Mbps provisionally** — owner to confirm.
  Prior milestone — session-2 wrap: **v0.29.0 (signed), live at https://haynesnetwork.com**; every
  published image is keyless-cosign-signed under a Kyverno **Enforce** policy; the trash automation
  loop is armed AND proven in production (first real sweep 2026-07-09). Every buildable plan
  **002–017** is shipped, deployed, and live-validated. Session-2 chronicle:
  `.agents/context/2026-07-10-session-wrap.md`.

## Current state

**What this is.** haynesnetwork is the SSO front door for `*.haynesnetwork.com` — an Authentik-OIDC
(Plex-primary) web app giving Haynes-Plex users a permissioned dashboard, Plex library self-service,
and media fix/ledger/trash tooling backed by the *arr stack. Ten `@hnet/*` workspace packages
(+ **metrics** — a read-only Prometheus client, ADR-037):
**db** (Drizzle + Postgres 16), **domain** (single-writer logic; audit/ledger rows written in the
same tx as the mutation), **arr** (Sonarr/Radarr/Lidarr; `/write` import-confined to domain),
**plex** (server + plex.tv XML-ACL sharing; `/write` import-confined, ADR-017), **sync** (one-way
*arr→ledger + all the CronJob sync modes), **auth** (Better Auth + Authentik OIDC), **api** (tRPC
routers), **ui** (token-themed `data-theme` components; `tokens.css` = the only hex), **test-utils**
(embedded-PG16 + stub harness).

**Release train.** Conventional commits → **release-please** opens the release PR → merge tags `v*`
→ CI builds `ghcr.io/thaynes43/haynesnetwork`, **keyless-cosign-signs by digest + verifies in-run**
(the verify step **retries** on GHCR signature-propagation lag rather than red-flagging — see the
cosign-verify flake note below) → **manually bump the image tag in the sibling `haynes-ops` repo**
(`kubernetes/main/apps/frontend/haynesnetwork/app/helmrelease.yaml`) → **Flux reconciles** →
`kubectl` context **`haynes-ops`** to observe. There is **no Flux image automation** — deploy is the
manual tag bump. Runbook: `docs/ops/004-deploy-runbook.md`.

**Workflow.** GATE A is executed (PR flow). `main` is branch-protected: branch `<type>/<slug>` → PR
→ required checks `lint-and-typecheck`, `test`, `build` green → squash-merge. `e2e` is advisory.
Local merge gate mirrors CI: `pnpm lint && pnpm lint:css && pnpm typecheck && pnpm test && pnpm build`.
`pnpm dev:local` boots the whole app with no Docker (embedded PG16 + stub OIDC/*arr/Seerr) on :3000.

**Board status.** All release-sized plans **001–016 are in `.agents/plans/completed/`** (see
`.agents/plans/README.md`). Post-016, session 2 shipped v0.14.1→v0.29.0 as a run of owner-feedback
batches that hardened the trash automation loop into a proven production pipeline. Nothing buildable
is queued; the next session is owner-directed (agenda below).

## The trash automation pipeline — as-built and PROVEN

**First production sweep ran 2026-07-09 23:45 ET: 14/15 deleted, 90.7 GiB reclaimed.** The one
survivor was **honestly guardian-skipped** because it left the rule pool mid-window (the guardian
re-checks eligibility at the deletion gate — correct behavior, not a bug). Seerr entries for the
deleted items were cleared via **forceSeerr**; the **Pushover** run summary was delivered. This is
the loop working end-to-end against real Radarr/Sonarr/Maintainerr/Plex/Seerr.

The pipeline is a **separation of responsibilities**: *rules promote candidates, the app schedules
deletion, humans rescue.* Four layers:

1. **Rules (Maintainerr, source of truth for the candidate pool).**
   - **Movies:** IMDb rating **< 6.0** & votes **≥ 100** & **never-watched-on-HaynesOps** & **NOT a
     media request** → **~685 candidates**.
   - **TV:** rating **< 6.0** → **~8–13 candidates**.
   - `deleteAfterDays 9999` + `arrAction 0` (DO_NOTHING) so **Maintainerr never deletes on its own** —
     the app owns deletion timing. The **SAFE audit enforces Maintainerr aging invariants** so a rule
     pool can never self-delete out from under the app (v0.27.0).

2. **Pools → per-kind tabs.** `/trash` is **Overview · Movies · TV · Recently Deleted · Activity**.
   The pending walls are **poster walls served from a Postgres read-model** (`trash_candidates`,
   ADR-035, migration 0027) — *not* live Maintainerr crawls (that was the 9.5s→148ms fix; see the
   incident log). Candidates are **paginated**, **strategy-sorted** ("Next up" mirrors the deletion
   strategy), refreshed on an **8h Maintainerr cadence label** plus a **5-min post-save refresh**.

3. **Batches.** Admins **create** a batch with **GB- or count-targeting**, the **admin gate is ON**,
   deletion happens in **green-light windows**. Users get **family save windows** to rescue posters.
   An admin can **force-expire mid-window** behind a **typed confirmation** (audited). The **sweep
   runs at :45 hourly** (CronJob) and only ever deletes **expired, green-lit** batches. One open
   batch per kind is the enforced invariant.

4. **Notifications (Pushover).** Fired on **created / green-lit / final-warning (2h before) /
   day-before / swept**. Delivery uses an **all-day window by default** now (was 18–22). Transactional
   `notification_outbox` enqueued in the same tx as the transition; a `notify-outbox` CronJob drains it.

**Space policy (armed).** Over-target mode: **80% target vs 78.8% live**, **7-day cooldown**,
**minCandidates 10**, **per-kind caps**. A continuous mode is also available. The policy is
**propose-only** — it drafts batches into the normal admin gate; it never deletes or promotes.

**Separation-of-responsibilities ruling (owner-settled this session):** rules promote / the app
schedules / humans rescue. There is **NO requester guardian keep** — a requested item shows an
**info badge only** (it does not block deletion). The **recently-watched keep is retained** (real
protection). Cross-server watch visibility on the walls is **informational, not protection**.

## Roles

- **Admin ×2** — full control.
- **Family (KAH517)** — view + save/unsave + restore + window rescue.
- **Default** — view + save/unsave.
- **Mobile admin fully works** — Users role-select, the roles editor, and all settings are
  portrait-safe (fixed this session; the role editor works on phones).

## Owner's remaining personal items

- **MFA** — ✅ DONE (PLAN-011, 2026-07-10): native-account MFA live via Authentik blueprints; owner
  enrolled a 1Password passkey + TOTP backup. See the top block + ADR-042 / OPS-009. Only Q-10
  (akadmin interactive-login policy) / Q-11 (blueprint the OIDC provider/app) remain.
- **Optional Cloudflare WAF / HSTS** — deferred; the zone-scoped token was never provided, so this
  stays owner-gated.
- **Zscaler categorization** — RESOLVED (owner's request approved).

## NEXT SESSION AGENDA (owner-stated)

1. **Larger site features** (owner will direct).
2. **Authentik MFA hardening + blueprints/GitOps migration** — ✅ DONE (PLAN-011, 2026-07-10).
   The login estate is now config-as-code blueprints in `haynes-ops`
   (`kubernetes/main/apps/network/authentik/app/blueprints/`) with native-account MFA live; the
   executed record (objects, pks, apply/verify/rollback, the Safari caveat, credential locations) is
   **`docs/ops/009-authentik-blueprints-and-mfa.md`** and the decision is **ADR-042**. The branding-era
   API seed (`docs/ops/authentik-apply-seed/` + `docs/ops/001-authentik-provisioning.md`) remains the
   content-rollback source and the record for the still-API-managed OIDC provider (Q-11).

## Morning check owed

**Kometa runs at 6:30 AM.** Verify it does **not** re-import the 14 deleted movies. All 14 are below
the chart vote floors, so it shouldn't — but confirm. **Lever if it does:** set
`radarr_add_missing: false` per chart in Kometa config.

## Known flakes / backlog

- **57P01 CI flake** — embedded-PG teardown race hits `packages/auth` and `packages/sync`
  (`incremental-sync.test.ts`). **Rerun protocol:** just re-run the failed job; it's non-deterministic
  teardown, not a real failure.
- **Catalog keyboard-reorder e2e (T-8)** — known flaky.
- **Family-window e2e** — serial-state flake.
- **Rules tuning v2** — owner-requested: bring in **non-IMDb metrics** (the current pool is
  IMDb-rating-driven). Not yet built.
- **Recently-Deleted "By: System"** for cron sweeps — consider crediting the human who green-lit the
  batch instead of the cron actor.
- **`notification_outbox` cleanup** — old `saved_reason` / `requested_override` columns are now
  unread; candidates for a cleanup migration.

## Where to look

- **Docs index:** `docs/README.md`. Invariants: `packages/domain/README.md` (single-writer,
  audit-in-same-tx, arr-write import confinement).
- **Deploy:** `docs/ops/004-deploy-runbook.md` (manual tag bump in `haynes-ops`; the 1Password
  `haynesnetwork` secret contract).
- **Local verify (no Docker):** `docs/ops/003-local-verification.md`. Tests run embedded PG16 — never
  SQLite/MySQL; `@embedded-postgres/linux-x64` MUST stay in `pnpm-workspace.yaml` `allowBuilds`.
- **Cutover / edge:** `docs/ops/005-root-domain-cutover.md` (Executed). Post-cutover watch items live
  there.
- **Image signing / break-glass:** `docs/ops/006-image-signing.md` (dedicated Enforce policy;
  rollbacks must target signed tags v0.7.0+).
- **Trash wall perf (ADR-035 read-model):** `.agents/context/2026-07-09-trash-wall-perf.md`.
- **Session-2 full chronicle:** `.agents/context/2026-07-10-session-wrap.md`.

## History

- **Session-2 chronicle (v0.14.1→v0.29.0):** `.agents/context/2026-07-10-session-wrap.md`.
- **Session-1 board build (plans 002–016, v0.5.0→v0.22.0):** as-built records in
  `.agents/plans/completed/`; the pre-session-2 HANDOFF narrative is preserved in git history.
- **Bootstrap → v0.3.1 (waves 1–11) + historical gotchas:**
  `.agents/context/2026-07-04-waves-1-11-archive.md`. Kickoff decisions:
  `.agents/context/2026-07-03-kickoff.md`. Consolidated backlog:
  `.agents/context/2026-07-05-backlog-recon.md`.
