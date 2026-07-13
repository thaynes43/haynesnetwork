# 2026-07-11 — Test/Fix/Polish loop (owner-driven, batched after in-flight agents land)

## OWNER RETURN-PASS CHECKLIST (compiled at loop end; releases v0.41.0→v0.43.0 + config)
1. ✅ Kavita auth: "Log in with Haynesnetwork" button; password login non-admin-disabled; OIDC lands
   you in ADMIN (email fix); break-glass `?forceShowPassword=true`. → TEST: OIDC login = admin.
2. ✅ ABS auth: you're admin via group claim; Auto Launch ON (login auto-redirects; `?autoLaunch=0`
   break-glass). → TEST: fresh login round-trip.
3. ✅ CSP form-action fix — the real spinner cause; Kavita/ABS OIDC completes in every browser.
4. ✅ Comic library: 50 series / 0 broken; Miles Morales renders. 24 empty + 4 corrupt quarantined
   (`books/.quarantine-*`) → your RE-GRAB list via Kapowarr (incl. Spectacular #111, Vader #41,
   Shadows of Starlight #3, Miles Morales #29 2021).
5. ✅ v0.41.0 season art: season poster icons + TV episode thumbs (you verified R&M on desktop;
   MOBILE pass pending).
6. ✅ v0.42.0 "Not on Disk" pill + Force-Search caption on detail pages. → TEST: a missing movie.
7. ✅ v0.43.0 roles grid: Enabled/Disabled for Bulletin/Metrics/ytdlsub/Books; Ledger AND Trash kept
   3-state (both have real Edit semantics — Trash deviated from plan, justified); Bulletin
   Feed/Messages checkboxes; **Default = Messages-only (Feed hidden + server-FORBIDDEN)**.
   → TEST: /admin/roles look + a Default user's Bulletin (no Feed tab).
8. ✅ Books walls infinite scroll (v0.39.1). 9. ✅ scope:host alert mute + book-stack memory bumps.
10. ✅ MOTD redesign CLOSED OUT (2026-07-11, session 4): live MOTD swapped to the markdown version
    via the audited `setMotd` domain writer (port-forward + one-shot tsx script, deleted after;
    `update_app_setting` audit row verified; attribution = owner admin id). Hermetic screenshots
    (`apps/web/e2e/support/capture-motd-live.ts`, untracked) desktop+390 × dark/light: SVG info
    glyph (no emoji), real GitHub anchor (href asserted), no raw markdown leak, no 390px overflow.
    Session Fable-served (probe echoed "You are powered by the model named Fable 5."). Note:
    dismiss version bumped → the banner re-shows once for everyone (expected on a redesign).
    ALSO verified live: ABS `/status` reports `authOpenIDAutoLaunch:true` + local kept
    (`?autoLaunch=0` break-glass) — the zprompt's "open ABS decision" is already applied (F-07).
OPEN items: F-09 epubs (Version '1.1' parse fails); Feed attribution ("unattributed"); dedupe of
Miles Morales cbr/cbz duplicates (optional); ComicTagger bulk pass (optional/later); trash
cooldown=0 test outcome (batch should have proposed at the :17 after you flipped it).

Running log of findings from the owner's walkthrough. Fix AFTER PLAN-028/030 merge (avoid
Library-file collisions) unless flagged URGENT. Each: symptom → root cause (verified) → fix.

## F-01 — Kavita OIDC "infinite spinner" on Authentik redirect  [browser-side + a real latent bug]
- **Symptom:** owner clicked "OpenID Connect" on Kavita → redirected to Authentik → infinite
  spinner; never returns to Kavita.
- **Verified:** the Authentik authorization flow COMPLETES server-side (headless executor drive
  returns xak-flow-redirect → Kavita). The spinner is the Authentik flow-INTERFACE SPA (lit web
  component) not executing the final redirect in the owner's browser — SAME class as the
  2026-07-10 login-page spinner (was Safari/WebKit; Chrome worked). **Immediate: try Chrome /
  hard-refresh.** Not a server bug.
- **BUT a REAL bug surfaced underneath (F-02).**

## F-02 — Kavita Data-Protection keys NOT persisted → "Unable to unprotect the message.State"  [REAL, fix]
- **Evidence:** Kavita log (real attempt, not synthetic): `Microsoft.AspNetCore.Authentication.
  AuthenticationFailureException: Unable to unprotect the message.State.` at 2026-07-10 21:19,
  right after the 21:12 pod restart. ZERO `key-*.xml` on the `/kavita/config` PVC → .NET DP keys
  are ephemeral (regenerated each boot).
- **Impact:** every Kavita restart invalidates in-flight OIDC state → intermittent login failures.
  Kavita restarted 3× today (2 OOMs + the 16Gi bump), which triggered the logged failure. Within a
  single stable pod lifetime logins work; across restarts they break.
- **Fix (research the exact Kavita 0.9.x knob before applying — live login path):** persist the DP
  key ring to the config PVC (Kavita should write `/kavita/config/keys` — investigate why it isn't:
  perms? config? a known Kavita issue). Ensure single-replica or a shared key ring. haynes-ops
  Kavita helmrelease/config change. Verify: `key-*.xml` present on the PVC after; a real OIDC
  round-trip succeeds; survives a pod restart.
- **Priority:** HIGH (broken user-facing login), but batch-safe — no app-repo change, no Library
  collision. Could fix ahead of the loop if owner wants.

## F-01/F-02 RESOLVED (2026-07-11) + Kavita auth hardening shipped
- **F-02 downgraded — NOT a persistent bug.** Kavita 0.9.x persists DP keys in the SQLite DB
  (`DataProtectionKeys` table on the PVC), not files — verified one durable key survives a
  `kubectl delete pod`, and a full OIDC round-trip succeeds before AND after restart. The 21:19
  "unprotect" error was a one-time in-flight-across-restart artifact (state minted before the
  restart). Nothing to fix.
- **F-01 spinner:** still browser-side (Authentik flow-interface SPA not advancing in the owner's
  browser). Try Chrome/hard-refresh. Server flow verified 5× headless.
- **Shipped (owner asks):** OIDC button renamed "Log in with Haynesnetwork" (providerName);
  password login disabled for non-admins (admins exempt by Kavita design = built-in break-glass);
  break-glass runbook committed to haynes-ops kavita/README.md (b87ef563) —
  `?forceShowPassword=true` + hnetadmin password, or the ServerSetting Key-40 SQL.
- **OPEN owner decision (F-03):** owner's Authentik identity `thaynes` = email
  `admin@haynesnetwork.com`; Kavita `hnetadmin` = email `manofoz@gmail.com` → OIDC login lands the
  owner in a NON-admin Kavita account. Fix = set hnetadmin's Kavita email to admin@haynesnetwork.com
  (one field) so OIDC auto-links to admin. Admin still reachable via password break-glass meanwhile.
- **Note:** these Kavita settings live on the PVC (ServerSetting Key 40 + appsettings.json), NOT in
  GitOps — a PVC rebuild resets them; README documents re-applying. (Candidate: move OIDC config to
  env/appsettings-in-git where Kavita supports it — future hardening.)

## F-03 RESOLVED — hnetadmin email → admin@haynesnetwork.com (2026-07-11)
- Set directly in Kavita DB (AspNetUsers, Email+NormalizedEmail+EmailConfirmed=1) via a helper pod
  after `scale deploy/kavita --replicas=0` (RWO ceph-block PVC; WAL-checkpointed; ~30s downtime).
  hnetadmin now matches the owner's Authentik `thaynes` identity → OIDC logs owner into admin.
- Root cause the UI couldn't do it: Kavita requires email-change CONFIRMATION via a link it tries
  to EMAIL — no SMTP configured → link only logged, change stays pending, UI reverts. → F-04.

## F-04 — No SMTP configured (Kavita, and estate-wide) [ROADMAP — owner's Google Workspace idea]
- **Impact:** Kavita can't send email-change confirmations, password resets, or notifications; other
  apps (Audiobookshelf, etc.) likewise. This blocked F-03's UI path.
- **Owner direction (2026-07-11):** admin@haynesnetwork.com is Google Workspace; alias a
  `noreply@haynesnetwork.com` and stand up a shared SMTP relay (owner did this for HaynesTower's
  Tautulli newsletter previously). Could add CLI tooling to manage it properly.
- **Shape:** one SMTP relay config (Workspace SMTP or a relay like Google's, app password /
  OAuth), stored in 1Password + ExternalSecret, wired into Kavita's server settings (and reusable
  by ABS + future apps). Its own small plan; enables password-reset/notification flows across the
  suite. Not urgent (OIDC-only + admin break-glass covers auth today).

## F-05 RESOLVED — Kavita OIDC "infinite Loading" spinner = CSP form-action (the REAL F-01 cause)
- **Reproduced on Chrome too** → NOT a Safari/browser quirk (my earlier F-01 "try Chrome" call was
  WRONG). Root cause: Authentik's traefik CSP (`network/authentik/app/middleware.yaml`) had
  `form-action 'self' https://omni.haynesops.com https://*.haynesops.com` — no `*.haynesnetwork.com`.
  Kavita's OIDC completes by auto-POSTing the auth response to
  `kavita.haynesnetwork.com/signin-oidc`; the browser CSP-blocked that POST → stuck "Loading" on ALL
  browsers. Headless validators passed because CSP is browser-only (a validation blind spot to note).
- **Fix (live):** added `https://*.haynesnetwork.com https://haynesnetwork.com` to form-action
  (commit 31d1d653; verified in the live CSP header). ALSO fixes Audiobookshelf's identical latent
  bug. Apps using response_mode=query (Open WebUI, the main app) were never affected.
- **Lesson:** headless OIDC validation cannot catch CSP/browser-enforced failures — add a note to
  future OIDC dispatches to check CSP form-action for form_post providers.

## F-06 RESOLVED — Book/Comic/Audiobook cover thumbnails load slower than Movies/TV (2026-07-12)
- **Fix:** ADR-041 idiom ported to `/api/books/cover` — ABS covers now request the upstream-sized
  300px WebP variant (~20 KB JPEG → ~10–14 KB, original as the non-memoized fallback tier) and BOTH
  sources memoize hot covers in an in-process byte-capped `ThumbLruCache`; strong ETag/304 + auth
  gates unchanged. DESIGN-024 D-05 amended with the measurements.
- **Root cause (measured live 2026-07-12):** every request re-fetched upstream (zero server-side
  memoization; ABS ~70–140 ms each), and Kavita covers are ~309 KB median PNGs (`series-cover`
  ignores resize params) vs ~10–20 KB Movies/TV tiles — a 50-tile Books/Comics wall ≈ 13–15 MB.
- **Residual (ops lever, owner decision):** Kavita first-paint stays ~300 KB/tile until Kavita
  itself re-encodes covers — its admin setting Media → "Save Media As" = WebP regenerates them ~10×
  smaller; the proxy benefits with no further change.
- **Original observation (2026-07-11):** Movies/TV covers "chase the scroll fairly closely" (cached
  *arr posters via ADR-041 proxy); Book covers lag noticeably.

## F-07 RESOLVED — ABS auth hardening (2026-07-11)
- Owner IS admin via a dedicated `abs_role` Authentik scope mapping (`hnet-abs-role`) → ABS
  `authOpenIDGroupClaim=abs_role`; `authentik Admins`/`abs-admin` groups → admin. Shared `hnet-groups`
  claim untouched (Kavita/OWUI unaffected).
- Local NOT hard-disabled (ABS 2.35 hard-disable LOCKS OUT root — no admin exemption unlike Kavita).
  Instead: **Auto Launch ON** (owner toggled in UI 2026-07-11) → login page auto-redirects to
  Authentik (OIDC-only feel), local kept, `?autoLaunch=0` = root break-glass. Reversible.
- ABS auth settings live on the PVC (absdatabase.sqlite), not git. Seed doc:
  docs/ops/012-audiobookshelf-oidc-hardening.md (uncommitted).

## F-08 RESOLVED — comic library repaired: 50 series, 0 broken (2026-07-11)
- Miles Morales mystery: the broken series was a Kavita MERGE of the (2019)/(2022)/(2023) folders;
  cover missing because the initial Comics scan never completed (10/72 folders indexed) + ONE truly
  corrupt file (`...29 (2021).cbr`, RAR chain breaks @4000901 → the SharpCompress error). Forced full
  rescan after cleanup: 1733 files → 50 series, 0 broken; 1293 renders a cover.
- Quarantined (reversible, tower untouched): 24 EMPTY folders → `books/.quarantine-empty-comics/`;
  4 corrupt archives → `books/.quarantine-bad-comics/` (Spectacular Spider-Man #111 '86, Darth Vader
  #41, High Republic Shadows of Starlight #3, Miles Morales #29 2021 — single-issue gaps to re-grab).
- Kapowarr CANNOT write ComicInfo.xml (open FR Casvt/Kapowarr#50); coverage today 438/1737 (25%).
  ComicTagger bulk pass = later/optional (risky in-place); re-grabs backfill metadata naturally.
- OWNER: re-acquire the 24 quarantined series + 4 issues via Kapowarr; optional dedupe of 1293's
  cbr/cbz duplicates.

## F-09 — EBooks: some epubs fail Kavita parsing [RESOLVED 2026-07-12, cluster-only]
- Kavita's 25 failing epubs decomposed: **15 repaired in place** (the `version="1.1"` XML-declaration
  class — declaration rewritten to 1.0 with a proper zip rebuild, mimetype-first preserved; all 15
  verified as new Kavita series post-scan), **3 zip-corrupt quarantined** (`books/quarantine/
  f09-corrupt/` — Skyward, Sweet and Deadly [0-byte], Skin in the Game; re-grab candidates), **7
  left untouched** (a DIFFERENT defect class: "Unsupported EPUB version 1.0" package attributes ×5 +
  EPUB3 nav-structure ×2 — its own future polish item). Foundation.epub diagnosed (thumbnail-only:
  Kavita hands the OPF guide's XHTML titlepage to libvips; the cover JPEG itself is valid; fix =
  set/lock cover in Kavita UI or repoint the OPF guide — left untouched, book reads fine). Backups
  of all touched originals: `books/quarantine/f09-originals/`.

## F-10 — Library-wide English-language audit (Audiobooks / EBooks / Comics) [owner-ordered 2026-07-13, NEW]
- **Owner directive (2026-07-13 night):** audit ALL of Audiobooks, EBooks, and Comics to verify
  every item is English. Trigger: German strays are SYSTEMIC, not one-off — Matilda (German epub
  beside the English re-grab) and then BOTH Throne of Glass audiobook folders turned out to be the
  German HörbucHHamburg narrations (sister-reported).
- **Method (proven this weekend):** epubs — read `dc:language` from the zip OPF (the Matilda/Maas
  sweep script pattern); audio — ABS `metadata.json` + ID3/publisher heuristics (HörbucHHamburg =
  German tell) + track-name language; comics — filename/metadata pass. Remediate with the
  field-proven loop: quarantine the foreign copy (`books/quarantine/…`, never delete) → LL re-grab
  English (keyed GB resolve → `addBook` by volume id → `queueBook`/`searchBook`, WITH 503
  retry/backoff — GB 503-bursts hit KEYED calls too, twice-proven) → Kavita/ABS rescan.
- **Also sweep while in there:** azw3-only titles (invisible to Kavita — Maas had 4), empty title
  folders (Assassin and the Underworld was empty), old-format duplicates left beside fresh imports,
  the F-09 leftovers (3 quarantined corrupt epubs to re-grab + the 7 other-defect files), and the
  `No ebook-convert found` preprocessor nit (calibre missing from the LL image — a sidecar or image
  swap would enable azw3→epub conversion instead of re-grabs).
- All grabs are governor-paced (MAM gate closed ~2026-07-13 00:00 after the Maas batch; usenet
  flows regardless; torrents mature ~Tue eve). Feeds PLAN-041 (books Fix) + the Books Automation
  Saga (language preference + metadata retry are design inputs).

## Phase-3 bucket (tomorrow, post-polish) — owner-directed
- SMTP/email integration (F-04) → Phase 3 plan bucket (owner 2026-07-11).

## (add findings below as the walkthrough continues)
