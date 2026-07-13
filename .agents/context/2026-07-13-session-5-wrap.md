# 2026-07-13 — Session 5 wrap (Sunday: sister-test fixes, the WebKit login crisis, books batch)

Resume point for Monday morning (owner shut down ~01:00; Fable weekly reset 08:00). Read with
`.agents/HANDOFF.md` (top block). Sessions: 4 = Sat night (governor/link-previews), **5 = Sunday
midday → Mon 01:00 (this one)**. Owner tested with his SISTER — real second-user feedback all day.

## Releases shipped (all live + verified on prod)

- **v0.46.1** — link-preview OG tags resolved to localhost in prod (metadataBase origin fix;
  unstuck PR #231 which was BEHIND with auto-merge armed). Discord embed verified by owner.
- **v0.46.2** — embed copy trimmed to end at "members only." (owner embed review; one-constant
  change + test + DESIGN-004 D-20). The Discord ALT chip = alt-text indicator (`og:image:alt`),
  kept for accessibility.
- **v0.46.3** — **nav overlap on narrow phones** (PR #238: sister's sub-375px phone; root cause =
  ADR-037's 5th tab overflowed `.topbar__nav`, theme toggle sat on "Metrics"; fix = CSS-only
  horizontal scroll rail, 320px regression spec, DESIGN-004 D-08 amendment) + **F-06 book-cover
  latency** (PR #237: `/api/books/cover` had no memoization/variants — Kavita covers ~309KB/tile;
  now ABS upstream-resized WebP variants + `booksCoverCache()` byte-capped LRU + ETag; warm repeat
  9ms. RESIDUAL owner lever: Kavita admin → Media → "Save Media As" = WebP re-encodes Kavita's own
  covers; no app change needed to benefit).

## THE WEBKIT LOGIN CRISIS (owner-critical: "advertising the site") — PARTIALLY fixed; ESCALATED

**~01:00 CORRECTION — the compat-mode fix below verified green in Playwright's WebKit builds but
does NOT fix the owner's real Safari 18.3.1 (re-tested: still spins).** The TRUE root cause is in
the upstream #19814 thread (RCA comment 2026-06-30): authentik ≥2025.12 ships **native CSS
nesting** (in flow-*.css AND JS-embedded component styles); old WebKit's bug **#290102** crashes
the WebContent process on the next Lit `setAttribute` style-invalidation — CSS-engine-level,
no console errors, unaffected by ShadyDOM. Affected: iOS/iPadOS ~16.6–18.3.x, macOS Safari ~17.6;
**current OS versions are fine (WebKit fixed it)**. No upstream mitigation shipped (2026.5.4
silent; no PR). **PLAN-042 REWRITTEN with the RCA + three options** — A: OUR asset
nesting-lowering post-process (RCA-author-verified recipe; dispatchable, needs owner ruling),
B: upstream watch/file-it, C: user-side OS updates (owner + sister devices). Compat mode stays
ON meanwhile (harmless, helped some engines). Owner rules Monday. Original (partial) fix record:

- **Symptom:** infinite spinner on the Authentik login for iPad Safari, Kiosker Pro (WKWebView),
  and desktop Safari 18.3.1 private mode. Chrome fine. (Private mode was only "the tell" — normal
  Safari had a session cookie that skipped the flow page.)
- **Root cause (Fable agent, evidence-first):** Authentik **2026.5.3's flow-interface SPA crashes
  the WebKit 18.x renderer** at boot, before the first executor API call — upstream
  **goauthentik/authentik#19814** class (iOS 18.3.x login crash, introduced ≥2025.12). Proven:
  Loki showed the owner's Safari loading flow HTML 4× with zero executor calls; Playwright WebKit
  18.2 reproduced a native "Target crashed" 3/3; injecting `window.ShadyDOM={force:true}` (what
  compat mode does) pre-verified the fix. CSP/storage/Cloudflare ruled out.
- **Fix:** `compatibility_mode: true` on all four login-surface flows — haynes-ops **`571c7a65`**
  (`blueprints/20-hnet-flows.yaml`). Flux + the worker's blueprint watcher applied it **without
  kubectl** (~7 min). Verified live: WebKit 18.2 / WebKit 26.5 / Chromium / Firefox all render the
  form and advance past stage 1.
- **Side effect fixed same night:** ShadyCSS scope-classes outranked the brand sheet → login went
  PatternFly blue. **Green restored** via targeted `!important` on the load-bearing brand
  declarations in `blueprints/10-hnet-brand.yaml` — haynes-ops **`0d9699a`** (Opus agent);
  verified 3 engines WITH the crash-fix regression gate; after-screenshots sent to the owner
  (ratification informal — he moved on).
- **Residuals:** (a) identification-stage **Plex-first ordering + divider** are also dead under
  ShadyDOM — local form sits above the Plex button (pre-existing compat side effect; local button
  now correctly ghost-de-emphasized; fixable with the same scope-class technique, OR self-heals at
  the PLAN-042 revert — owner hasn't ruled); (b) OPS-009 Safari TOTP-ENROLLMENT caveat likely
  shares the root cause (authenticator-setup flows aren't blueprint-managed) — enroll in Chrome
  until the upstream fix; (c) blueprint-instance `successful` API check = formality, empirical
  proof solid. **PLAN-042 (filed, #239)** owns the upstream-fix watch → owner-present upgrade →
  compat revert → 4-engine re-verify. OPS-009 amendment in this wrap's PR records the workaround.

## Books: sister-driven fixes + the Maas batch (all cluster-side, no release)

- **Matilda root cause CLOSED** (morning): English re-grab had worked; a pre-pipeline **German**
  epub (Rowohlt 2016) shared the series folder and **Kavita merges all files in a series folder
  into one series** → members kept opening German. Quarantined + rescan → English-only. Audiobook
  already in ABS (2013 English, ~4h19m). PLAN-041 Q-02 note merged (#232).
- **F-09 epub repairs (Opus agent):** Kavita's 25 failing epubs → **15 repaired in place**
  (`version="1.1"` declarations; verified as new Kavita series), **3 zip-corrupt quarantined**
  (Skyward / Sweet and Deadly / Skin in the Game — re-grab list), **7 other-defect documented**
  (package-version + EPUB3-nav classes), Foundation.epub thumbnail diagnosed (valid JPEG; Kavita
  hands the OPF-guide XHTML to libvips; fix = set cover in Kavita UI). Backups in
  `books/quarantine/f09-originals/`.
- **Sister: "Throne of Glass is in German" — CONFIRMED + batch run (owner "Run #3"):** both fat
  ToG audio folders were the German HörbucHHamburg narrations (293/337 tracks) → quarantined
  (`books/quarantine/german-audio/`). English audio existed only for books 2/4/6. **Maas batch
  (7 books) registered via keyed-GB volume ids → LL `addBook`/`queueBook`/`searchBook`:** LANDED
  same night — **Kingdom of Ash audiobook (the sister's ask, ENG M4B)** + Empire of Storms audio +
  Crown of Midnight/Tower of Dawn/Assassin-and-the-Underworld epubs; Kavita+ABS rescanned. **Still
  in LL's retry queue:** Throne of Glass bk1 (epub+audio), Heir of Fire audio, Kingdom of Ash epub
  (first candidates: a VIP-only MAM torrent + a dead usenet article — LL retries on its 6h cycle).
- **Google Books truths (saga design input, twice-proven):** the GB key from a prior session IS
  wired (`media-stack` 1P → LL `gb_api`) and works; the throttling was (a) my keyless direct calls
  and (b) GB's OWN 503 "backendFailed" bursts which hit KEYED calls too → **retry/backoff is
  mandatory** on every GB touch. LL API gotcha: `searchItem` searches authors/ISBNs — **`findBook`
  or direct GB-volume-id → `addBook` is the title path** (the batch used the latter). LL image
  lacks calibre (`No ebook-convert found`) — conversion nit for F-10/saga.
- **Governor state:** the batch pushed books-mam to ~19 torrents, unsatisfied > 15 → **gate CLOSED
  (correct behavior)**; usenet unaffected; torrents mature ~Tue eve and the gate self-reopens.
- **F-10 filed (owner-ordered):** library-wide English-language audit (Audiobooks/EBooks/Comics) —
  German strays are systemic. Method + adjacent sweeps recorded in the polish-loop note (#239).

## Ops events

- **kubectl/Omni auth outage** mid-evening (`authcode-browser … context deadline exceeded` — token
  expired, interactive browser re-auth required). Owner re-auth'd via `! kubectl …` in-session.
  During the outage the Grafana fallback verified the v0.46.3 rollout (rule 4 works). Flux applied
  the compat-mode blueprint with no kubectl at all.
- **Kavita local-login break-glass** (used to unblock iPad reading pre-fix): kavita.haynesnetwork.com
  password form, `hnetadmin` + 1P `kavita` item. Password auth verified enabled.

## Model/budget notes

- Probes all clean (Fable 5 echoes; later probes switched to **`model: opus`** to spare the Fable
  budget — verifies the exact override path of Opus dispatches; zero Fable spend). No coordinator
  flip observed this session. No post-stop resumes attempted (countermeasures untested tonight —
  all four agents ended cleanly on arm-auto-merge-then-END or report-back briefs).
- **Agent scorecard:** F-09 repair (Opus) ✓ · F-06 covers (Fable) ✓ #237 · nav overlap (Opus) ✓
  #238 · WebKit login (Fable) ✓ 571c7a65 · brand green (Opus) ✓ 0d9699a. Release trains ×3
  (close/reopen dance needed each time; up-to-date-branch rule trips every stacked PR — expect
  `gh pr update-branch` after each merge).
- Budget at wrap: Fable ~97%, all-models 7d ~95% — **hard reset Mon 08:00**; owner monthly cap was
  81% on Jul 12 with usage-credits ON.

## Monday queue (owner's standing "go hard" plan + tonight's additions)

1. **PLAN-029 build** (unchanged #1): Opus data/domain + Fable sort/filter UX; needs only the go.
2. **Books Automation Saga scoping** — now with tonight's inputs (GB retry mandate, searchItem
   gotcha, calibre gap, language audit, requests validated by REAL sister-requests-by-text).
3. **F-10 English audit** (owner-ordered) — Opus-able, governor-paced; also sweeps F-09 leftovers
   + azw3 strays. F-08 comic re-grabs still first content workload.
4. PLAN-038 + polish; **PLAN-042 check** is standing (any session, minutes).
5. Owner-side: SMTP (F-04, the 1P blocker); qB 5.2.1 on MAM Approved Clients; ratify "Helpdesk";
   green-login screenshots ratified? Plex-first-ordering follow-up yes/no; Kavita "Save Media As
   WebP" toggle (F-06 residual).
