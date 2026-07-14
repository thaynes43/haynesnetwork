# 2026-07-14 — Session 6 wrap (Monday "go hard": PLAN-029 shipped, WebKit crisis CLOSED, F-10 executed, Integration Tab Saga born)

Session ran Mon 18:00 → Tue ~03:00 off the fresh weekly budget. Owner present all evening
(rulings by AskUserQuestion + chat), asleep for the overnight tail. THREE releases shipped and
live-verified; one saga founded; the login crisis closed for good.

## Releases (all deployed + verified: pod image, /api/health 200)

- **v0.47.0 — PLAN-029 COMPLETE** (the biggest queued build). PR **#243** (Opus: data/domain —
  `released_at` [migrations 0042], `library_preferences` [0043], per-user watch/read seam
  [0044: `user_account_map`/`user_media_watch`/`user_book_progress`]; `library.preferences.*`;
  `resolveLibraryView` URL-precedence resolver) + PR **#245** (Fable: per-(wall,level) view
  registry [14 entries], view+grouping shells [Books/Audiobooks Authors⇄All, group cards +
  drill-in], facet chips [genre/narrator/format/length, Decade + Released range, per-user
  Watched/Read gated on data], A–Z jump rail, D-19 push/replace semantics). The UX agent caught
  and fixed a latent #243 bug (books genre predicate 22P02 under the chips). Owner ratified the
  authors view from screenshots.
- **v0.48.0 — group-card ART (owner-directed follow-up)**, PR **#249**: ABS author portraits
  via new `/api/books/author-image` (ADR-041 idiom, books-gated; live pipeline proven via a
  one-author match probe), genre glyph tiles (17 stroke-glyph families; Audiobooks gains
  `?by=genre`), Peloton/YouTube/comics group art confirmed on existing proxies; Kavita person
  art documented ABSENT (0/1156 — Kavita+ feature). DESIGN-026 D-04 amended. **Owner ran ABS
  "Match all authors" overnight — verify the live author wall in the morning.**
- **v0.49.0 — PLAN-044 Goodreads requests MVP** (the Integration Tab Saga's first slice), PR
  **#253** (Opus overnight): ADR-055 / DESIGN-028 / R-178..R-184 / T-161..T-165 / migration
  0045; tables `user_integrations` + `integration_shelf_items` + `book_requests`; new packages
  `@hnet/goodreads` (RSS + vanity resolve + GB retry/backoff + comic classification) and
  `@hnet/lazylibrarian` (confined `/write`: addBook/queueBook/searchBook); `integrations.*`
  tRPC; the Integrations tab (link card, shelf + coverage %, requests/Missing wall with
  "Search again", comics parked `unroutable_reason='comic'`); stub Goodreads RSS + stub LL in
  the hermetic harness; new `integrations` section (ships Admin-only). haynes-ops `dddd2126`:
  image bump + **`sync-goodreads` CronJob (41 * * * *)** + `LAZYLIBRARIAN_API_KEY`
  (lazylibrarian 1P item) / `GOOGLE_BOOKS_API_KEY` (media-stack) in the ExternalSecret —
  secret materialization verified in-cluster. **LIVE ACCEPTANCE PENDING (owner-present):**
  link the real account → sync → verify LL wants both formats / coverage math / Missing +
  audited search / governor untouched. **PLAN-044 stays ACTIVE until that passes.**

## THE WEBKIT LOGIN CRISIS — CLOSED (PLAN-042 → completed/)

Owner ruled **Option A** Monday evening (iPad confirmed fixed by its update first — Option C
covered owned devices). A Fable agent built it same-night in haynes-ops: CSS-nesting-LOWERING
initContainers over authentik's served `/web/dist` (lightningcss `safari>=15` on CSS bundles +
acorn AST splice of JS-embedded style literals; fail-loud gate with strict-CSS-parse residual
vs logged suspects; emptyDir over the static path; image-bump-proof). Three fail-safe landing
iterations (envsubst `${` clash → $-free script; `cp -a` EPERM → `cp -r`; gate false-positives
[Mermaid/stylis + Lezer tables] → suspect-vs-residual split) — **login stayed HTTP 200
throughout**. Markers: flow CSS 33→0, flow JS 7→0, dist-wide 25 literals in 20 bundles → 0
residual. **compat mode REVERTED** (`dafdea79`); decisive verify: **old WebKit 18.x NATIVE mode
3/3 renders + advances** (the engine that crashed 3/3 pre-fix), current WebKit/Chromium/Firefox
green. **Plex-first ordering + divider SELF-HEALED** (owner's mid-flight hard acceptance
criterion — met without a CSS fix). `%(theme)s` bg pinned to `bg-c-dark.svg` (`1b11dc69`) —
the every-load 404 is gone. **Upstream comment POSTED with owner approval** (issue closed
"completed" upstream; comment = the searchable mitigation record):
goauthentik/authentik#19814 issuecomment-4964861445. OPS-009 amended (incl. the
suspects-to-re-audit-on-image-bumps list + TOTP-caveat "may be cured" note — retest owed).
Docs PR #247; plan filed to completed/.

## F-10 — executed end-to-end (audit + re-grab wave)

- **Run 1 (blocked, PR #244):** kubectl/Omni token expired → zero paths to the estate; zero
  changes; owner re-authed in-session (`! kubectl get nodes`).
- **Run 2 — the audit (PR #246):** 1374 epubs CONTENT-scanned (stopword detector — metadata
  tags proven junk), 826 audiobooks via audio-native ID3: **58 clear-cut foreign quarantined**
  → `books/quarantine/f10-language/` (33 epubs: 18 NL/7 DE/7 DA/1 FR; 25 audio, mostly German
  incl. folder-lies: Koontz "The Face"→German "The Other Emily", "Dune"→German Dune III,
  Follett→German "Never"; Foundation.epub is German). Comics 51/1733 CLEAN. Mosley "Hoerbuch"
  cluster = false positive, untouched. 3 F-09 corrupt re-grabs queued (Wanted/en — `queueBook`
  after `addBook` is MANDATORY, addBook alone lands Skipped). Kavita+ABS rescanned.
- **Run 3 — the re-grab wave (owner GO; PR #251):** 57/58 queued English (34 snatched same
  night: 22 ebook + 12 audio; 16 still Wanted; 1 ambiguous skip = Orwell essays, suggested GB
  `PqGMFPCiBEsC`, OWNER RULING OPEN). **Two estate fixes made live:** (1) **LL→SAB handoffs
  were 404-ing** (`SAB_SUBDIR=lazylibrarian` vs SAB at root) — every prior landing was
  MAM-torrent; fixed via LL writeCFG (`SAB_SUBDIR=''`, live-only config class); (2) usenet
  tried to re-serve the exact German editions → `REJECT_AUDIO`/`REJECT_WORDS` hardened with
  German markers; **7 poisoned grabs deleted from SAB + set Skipped — those 7 need MAM-English
  when the gate reopens (~Tue eve) or manual**. Forensics: "City of Heavenly Fire" audio was
  actually #4 City of Fallen Angels (re-grabbed as #4; #6 never existed on disk — separate add
  if wanted); "Eragon bk1"→Inheritance bk4; "Hammer of Eden"→Notre-Dame. Q-07 done (Leviathan
  Wakes consolidated, French folder removed, Kavita rescanned). Governor discipline verified
  throughout: MAM gate CLOSED, 19/19 unchanged, protected LL entries intact. **Caveat:** the 34
  are English-by-release-name — a post-import ID3/OPF spot-check (F-11 candidate) is advisable.

## The Integration Tab Saga (PLAN-043 master + PLAN-044 MVP — owner-founded this session)

Owner's 5-point vision (integrations tab / cross-media predictions / content-sync coverage /
books Missing / book⇄audiobook pairing) documented as **PLAN-043**; four MVP rulings locked by
grill: owner-links-first · **app-side end-to-end** (LL-native wishlists ruled out — Prowlarr
fullSync owns LL provider config) · **NO gate: wants become Missing, SAB rips, MAM governor
gates as-is** · full scope (coverage % + manual search day-1). PLAN-033 SUBSUMED. Goodreads
facts: API dead → public shelf RSS (verified live); owner account **goodreads.com/haynesnetwork
= user id 202652880**, to-read shelf PUBLIC (6 items — incl. 2 COMICS, which drove the
parked-comic request state). Docs PR #250; built same night (v0.49.0 above).

## MAM status (owner screenshot ~23:00)

Site ratio 1.886 (real 0.064 — normal freeleech-era), 19/20 unsatisfied = the governor's
threshold working, VPN registration + dynamic-seedbox IP correct, 2 FL wedges, PowerUser needs
+9.42 GiB upload. **Flag: "Not Connectable (IPv4)"** — Mullvad has no port forwarding (removed
2023), so qB is announce-only/passive; compliant but slows satisfaction. Future owner decision:
accept vs move the seedbox exit to a port-forwarding VPN (AirVPN/Proton). qB 5.2.1
Approved-Clients check STILL OWED (screenshot didn't show it).

## Mechanics learned / confirmed this session

- Release train: EVERY release PR needed the close/reopen dance; the up-to-date-branch rule
  stranded nearly every PR (`gh pr update-branch` watchers now standard); **the image build
  rides the release-please run on `main` — there is NO tag-branch workflow run** (don't watch
  for one). Flux names: source git **`haynes-ops`**, kustomization **`cluster-apps`**,
  helmrelease `haynesnetwork -n frontend` (a wrongly-named source reconcile fails SILENTLY if
  output is suppressed — the v0.47.0 deploy stalled on exactly that).
- Model watch: probes before every dispatch/merge/cluster step ALL CLEAN (Fable 5 default,
  Opus 4.8 override); no coordinator flip observed; no post-stop resume model-drops (the 042
  agent self-resumed via its own monitors mid-mission — session-model agent, so safe by
  construction; live-data updates to RUNNING agents via SendMessage worked twice).
- The owner's remote-control phone view dropped updates once (`/remote-control fable-hnet-pc`
  re-link; "sent to your phone" phrasing is wrong — files attach to the session chat).
- Agent scorecard: 029-data (Opus) ✓ · 029-UX (Fable) ✓ · 042 Option A (Fable) ✓ · F-10 audit
  ×2 + wave (Opus) ✓✓✓ · art pass (Fable) ✓ · 044 MVP (Opus) ✓. Every agent ended on
  arm-auto-merge-then-END; coordinator took all tails.

## Tuesday queue

1. **PLAN-044 LIVE ACCEPTANCE (owner-present, first thing):** open /integrations as admin →
   link `haynesnetwork` (id 202652880) → run/await `sync-goodreads` (`:41`, or
   `kubectl create job --from=cronjob/haynesnetwork-sync-goodreads` for immediacy) → verify:
   LL Wanted both formats (spot-check 3), coverage math, Missing + audited "Search again",
   comics parked, governor untouched. Then move PLAN-044 → completed/ + open the section to
   roles when he's ready (sister next).
2. **F-10 tail:** gate self-reopens ~Tue eve → the 7 MAM-English titles should grab (verify);
   Orwell ruling; consider F-11 post-import spot-check (Opus-able).
3. **Verify the live author wall** (post Match-all-authors) + owner eyeball of v0.47–v0.49 UX.
4. Next build candidates: PLAN-038 (scoped, dispatchable), saga next phases (framework/
   pairing), PLAN-040, PLAN-037; PLAN-032 saga scoping still separate.
5. Standing owner items: SMTP (F-04, the 1P blocker), qB 5.2.1 Approved Clients, Helpdesk-name
   ratify, Kavita "Save Media As" WebP, Safari TOTP-enrollment retest (likely cured by 042).
