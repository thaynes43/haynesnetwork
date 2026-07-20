# 2026-07-20 — ytdrivarr research: the Q-03 donor audit (Peloton port target + plugin contracts)

Opus research deliverable for PLAN-025 Q-03: audit of `thaynes43/ytdl-sub-config-manager`
(public, latest merge `dd3e51c`, deployed as `0.7.0`). Companion:
[[2026-07-20-ytdrivarr-q02-source-matrix]]. Feeds the ADR + design doc. Condensed from the
agent report; the full transcript lived in the session.

## TL;DR (per the owner's *arr extension-point ruling)

The donor's own "generic/plugin" abstraction is ASPIRATIONAL — `StrategyLoader` (string-import
DI), `ScraperFactory`, a `MediaSourceStrategy` ABC exist, but the `Config` dataclass, the run
loop, and every config key are Peloton-hardcoded (the `Activity` enum is literally Peloton
disciplines). "Port behind the plugin seam" = BUILD the seam, not reuse the donor's. Central
spread fact: upstream ytdl-sub already downloads ANY yt-dlp URL via generic presets — a
YouTube "source" is just `name → URL` under a preset; **Peloton is the outlier needing a
credentialed browser, a scraped catalog, and a minted bearer before a downloadable URL even
exists.** URL-list sources should be CORE first-class; plugins are the exception for
credentialed/scraped sources. (The owner's own donor issue #3 says the same — the multi-source
vision predates PLAN-025.)

## Code quality (verifying "old, hard to work with")

Decent engineering in the wrong shape, not sloppy: ~9.2k LOC src + ~13.9k tests, 87% coverage,
11 merged PRs Sept–Dec 2025. Pain: Peloton-hardcoding despite generic aspiration · god-files
(directory_validator 896, metrics 771, file_manager 709…) · stringly-typed importlib DI
(silently continues on load failure) · inherent browser-scrape brittleness · dead weight
(Windows lock cruft, a 732-LOC old-implementation parity file). NO http server / health /
metrics — a pure batch CLI (text summaries into logs + PR bodies).

## The Peloton logic (the port target)

- **Runtime:** batch CLI; python:3.13-slim + chromium + chromium-driver + git + ffmpeg; the
  10PM daily CronJob, 6Gi (Chromium), Forbid/Never/backoffLimit 0.
- **Auth:** headless Selenium login with FIXED `time.sleep`s (zero WebDriverWait anywhere),
  hardcoded field names, no MFA/captcha/retry; success test = "login" not in URL.
- **Bearer minting (most fragile):** navigates a player page, CDP-injects JS monkey-patching
  fetch/XHR to sniff `Authorization: Bearer` to api.onepeloton.com + polls CDP network logs;
  ≤15s wait; **capture failure = RuntimeError = whole run fails** → downloader keeps running
  an aging token → downloads silently stop (no alarm). Writes `cookies.txt` + `bearer.txt` to
  NFS.
- **Scrape:** per-activity class pages, dynamic scrolling ≤250×3s (~12 min), `classId` hrefs,
  `data-test-id` title/subtitle selectors, `·` split for instructor; dedup vs existing ids;
  25/activity/run cap.
- **Season/episode mapping:** season = raw duration-minutes parsed from the title
  (`^(\d+)\s*min`); episode = 1 + max across BOTH disk (.info.json / S{s}E{e} folder parse)
  AND the existing subscriptions YAML; bootcamp-variant folder collapsing. LATENT
  inconsistency: an unused rounding default (nearest 5 min) disagrees with the live raw-value
  path.
- **Output:** ytdl-sub entries `Plex TV Show by Date` → `= {Activity} ({min} min)` →
  `{Title} with {Instructor}` → `{download: player URL, overrides: dir/season/episode}` (the
  live 1,454-line subscriptions.yaml); `__preset__` injects cookiefile + `${PELOTON_BEARER}`.

## Port vs discard

**PORT (harden en route):** login/session/scrape/metadata extraction · bearer/cookie minting
(+ explicit waits, retries, health signal) · episode-numbering across disk+subs · activity
folder mapping + YAML emission shape · stale-subscription history (15-day timeout — likely
CORE state, not Peloton-specific).
**DISCARD/REPLACE:** the GitHub PR write-back (service-owned DB per Q-04) · the Peloton
Config dataclass (→ core config + per-plugin settings schemas) · string-import DI (→ typed
registry) · most of the 896-line disk-repair layer (largely repairs self-inflicted damage;
keep at most an optional library-repair capability) · metrics.py text summaries (→ structured
telemetry) · platform cruft.
**UNTOUCHED until cutover:** both downloader CronJobs, the app read surfaces, the poster guard.

## Deployment / secrets / integration map

- ns `downloads`, three Kustomizations: the config-manager (donor image, 1P item
  `peloton-scraper`: PELOTON_USERNAME/PASSWORD + GITHUB_REPO_URL/TOKEN) · `ytdl-sub-peloton`
  downloader (*/15; 1P item `peloton`: a static PELOTON_BEARER that looks VESTIGIAL — the real
  bearer comes from NFS `bearer.txt`; confirm before removing) · `ytdl-sub-youtube` downloader
  (*/15; the hand-edited git YAML ytdrivarr takes over).
- App side (all read-only today, ADR-038/041/047): `ytdlsubRouter` (Plex-direct, no ledger
  table — only migration 0032's section CHECK), the poster proxy, the browser UI, and the
  poster guard living APP-side (`runPelotonPosterGuard`, durable PNGs in `@hnet/sync` assets,
  `poster_guard_applications` ledger, its own :37 cron). The `edit` permission rung EXISTS
  (`SECTION_PERMISSION_LEVELS`) but nothing consumes it; roles grid renders ytdlsub as
  toggle-only with an in-code "flips to tri per PLAN-025" note. Integration template =
  `@hnet/libretto` (barrel/read/write split, confined write, arr-write-import-guard) — a new
  `@hnet/ytdl` follows it exactly.

## The plugin contracts (C1–C8, each sized YouTube-trivial ↔ Peloton-full)

- **C1 capability declaration:** id/kind/settings-schema/`test()` + opt-in capabilities.
  YouTube declares almost nothing; Peloton declares auth+scrape+tokenMint+assets. Capability
  NEGATION keeps YouTube trivial.
- **C2 auth/session + secrets:** core injects ESO material, persists session artifacts,
  delivers short-lived credentials into the downloader's reach. YouTube: no-op. Peloton: the
  full credential lifecycle.
- **C3 discovery/config emission:** `discover(ctx) → SubscriptionEntry[]`; CORE owns YAML
  assembly + dedup + persistence. Entries carry download/overrides/per-source ytdl_options.
- **C4 scheduling:** YouTube event-driven (re-emit on admin edit); Peloton cron + a
  bearer-freshness SLA.
- **C5 state:** per-plugin durable namespace. YouTube's state IS the user-editable source
  list (what Edit mutates); Peloton's is machine state (bearer, history, dedup, runs).
- **C6 per-item remediation (Fix parity — WHY the *arr shape):** YouTube = stateless
  re-download; Peloton = auth-gated re-fetch needing a live session.
- **C7 health/telemetry (biggest gap vs today):** per-plugin health + test probe + run
  telemetry; Peloton needs bearer-age + selector-drift alarms (today's silent-stall failure
  mode).
- **C8 assets (optional; OPEN):** Peloton generates thumbnails + owns poster durability
  (three art fragilities); YouTube none. FORK: fold the app-side poster guard into the
  service or leave it — decide in the ADR.
- **RUNTIME FORK (shapes C2–C7 transport):** Peloton requires Python+Selenium+Chromium (6Gi);
  if the core is TS, heavy plugins argue for OUT-OF-PROCESS job-dispatched workers (core
  enqueues a scrape job in the plugin's own container; URL-list sources run in-core). An
  explicit ADR decision.

## Migration inventory (cutover order candidate)

1. YouTube YAML → service (cleanest first cut; exercises C1/C3/C5, no auth) · 2. Peloton
pipeline → plugin · 3. write path: git-PR → service-owned emission (de-noises haynes-ops
history — the bot churns a 1,454-line file daily) · 4. poster guard placement (C8 fork) ·
5. per-item Fix (C6, new capability) · 6. consume the `edit` rung via `@hnet/ytdl/write`
(roles grid toggle→tri).

## Surprises

Aspirational plugin seam (build, don't reuse) · vestigial static PELOTON_BEARER secret ·
bearer hard-fail silent-stall blast radius · three Peloton art fragilities vs zero for
YouTube · the donor is genuinely maintained (re-SHAPING, not rescuing) · daily bot-churned
git history · owner's issue #3 already envisioned multi-source ("Peloton took a lot of custom
logic…"; lists Nebula).
