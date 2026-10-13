# CLAUDE.md — haynesnetwork

Agent/contributor guide. Read this before touching anything.

## What this project is

**haynesnetwork** is the SSO front door for `*.haynesnetwork.com` — a responsive web app
(phones, tablets, PCs) where users of the Haynes Plex ecosystem log in through
**Authentik (with Plex)** and get a permissioned dashboard of the self-hosted apps they may
use, self-service Plex library management, and media "fix"/ledger tooling backed by the
*arr stack (Sonarr/Radarr/Lidarr). Requirements live in `docs/prds/001-haynesnetwork.md`.

Two sibling repos are normative references (both in the VS Code workspace):

- `../todos-for-dues` — architecture donor: pnpm monorepo, Next.js App Router, Better Auth,
  Drizzle + Postgres, tRPC, docs-first process, CI/PR flow, release-please, Dockerfile.
- `../demo-console` — UI donor: CSS-token theming via `data-theme` on `<html>`, viewport-fit
  layout primitives, hex-lint guard, Playwright resize matrix.
- `../../haynes-ops` — the Flux GitOps repo this app deploys into (cluster context `haynes-ops`).

## Documentation-first process

**No code before docs.** The pipeline is `PRD → ADR → DDD → design → plan → code → tests`
(see `docs/PROCESS.md`). Keep docs current in the same change that alters behavior.

- Every docs folder has a `000-template.md`; **copy it to start a new doc**.
- 3-digit numbering, IDs are stable and never renumbered (`R-NN`, `US-NN`, `AC-NN` in PRDs;
  `C-NN` in ADRs; `D-NN` in designs).
- ADRs are MADR 3.0 and **immutable once Accepted** — supersede, don't edit.
- Status lifecycle: `Draft → Proposed → Accepted → (Superseded by NNN | Deprecated)`.
- The glossary `docs/domain-driven-design/001-ubiquitous-language.md` is normative — new
  domain terms must be added there in the same change that introduces them.
- **Ask rather than invent**: unknowns become explicit `Q-NN` open questions in the doc,
  not assumptions.

Agent working state lives in `.agents/` (`HANDOFF.md` is the resume point; dated notes in
`.agents/context/`; executable plans in `.agents/plans/`).

## Hard rules

1. **PostgreSQL 16 only** — never SQLite/MySQL substitution, in code or tests. Tests use an
   embedded Postgres binary (no Docker available in this WSL distro).
2. **No raw hex colors** outside `tokens.css` files — enforced by `scripts/lint-css-hex.mjs`.
   All UI color goes through `--color-*` CSS custom properties themed by `data-theme`.
3. **Catalog links are admin-curated, arbitrary URLs** — the catalog accepts any normalized
   `http(s)` URL an admin enters (any domain, including `*.haynesops.com` and external sites);
   the old `*.haynesnetwork.com`-only restriction was retired by ADR-013. (Server-side code
   may talk to in-cluster services via `*.svc.cluster.local` — that's fine and unrelated to
   user-facing catalog links.)
4. *_The *arrs are the source of truth*_ for media lists. This app's ledger is a synced copy
   plus attribution/audit — sync flows in from the *arrs; the only write-backs are the explicit
   failsafe restore and fix actions, plus the **ADR-083 queue janitor** (automated cleanup of
   errored *grabs* — queue-item remove/blocklist/retry/re-search only, never library files;
   census-first, per-class enforcement config, see DESIGN-046). **The janitor is in CENSUS
   (observe-only) rollout until PLAN-065 records L3** — check `.agents/HANDOFF.md` for the
   current ladder level; advancing it is a standing obligation, not optional. **ADR-093 adds two
   more** (DESIGN-052): the **Release Block**, one app-owned release profile per Radarr and Sonarr
   (`haynesnetwork: deleted releases (managed, do not edit)`) holding "must not contain" terms only
   (never library files, quality profiles or custom formats), written only by its single writer
   (`reconcileReleaseBlock`, D-13), which runs before each Trash delete (written and read back
   first), after deletes to remove abandoned terms, in the hourly and 15-minute upkeep (the sweep and
   registry jobs: settle, expiry, drift repair; D-25br, D-25ce, D-25cf) and from the one-off seed
   (D-15); its terms only ever come from Deleted-Release Records. And **Seerr**: the watchlist
   enrollment, one `settings/main` write per Seerr user turning watchlist sync on, behind the audited
   `seerr_watchlist_enroll` setting (D-17), plus the one-off `animeTags` preflight on **Seerr's**
   Sonarr-server settings (`PUT /api/v1/settings/sonarr/{id}` on Seerr, the whole server object
   echoed and read back; the app never writes Sonarr's own settings). **ADR-094 adds the janitor
   release block** (DESIGN-046 D-14): one app-owned release profile on Lidarr, marked by its sentinel
   term `haynesnetwork-janitor-managed-do-not-edit` (Lidarr's profiles have no name), holding whole-name
   "must not contain" terms only, written only by its single writer (`reconcileJanitorReleaseBlock`),
   which runs before each enforced `manual_match` removal (written and read back first) and in the
   janitor's hourly upkeep (drift repair, 365-day expiry); a term is written only for a release title
   that names the album's artist. All go through `@hnet/arr/write` from `packages/domain` only.
   **ADR-095 extends the janitor to the download suite** (DESIGN-046 D-15..D-20), LazyLibrarian and
   Kapowarr, each cell census until the coordinator flips it: LazyLibrarian `forceProcess` (retry, once
   per run); the SABnzbd history-job delete that lets LazyLibrarian abort a stuck snatch (SABnzbd
   downloads only, never a qBittorrent/MAM torrent); the delete of a Processed download's completed
   SABnzbd folder, only after every library copy it recorded is confirmed on disk, confined to direct
   children of the LazyLibrarian category's completed folder (never library files); and the Kapowarr
   queue removal with blocklist plus its `auto_search`. They go through `@hnet/downloads/write`,
   `@hnet/lazylibrarian/write` and `@hnet/kapowarr/write` from `packages/domain` only.
   **ADR-097 adds the Title Exclusion** (DESIGN-052 D-27, D-28; owner ruling "Block automation only", 2026-10-03): one
   Radarr (by tmdb id) or Sonarr (by tvdb id) import-list exclusion per title Trash deletes, so Kometa and the *arrs'
   import lists never add it again (a person's Seerr request still can). Written only by its single writer
   (`ensureTitleExclusions`: read the list, `POST` what is missing, read it back, audit row in the same transaction),
   before each Trash delete (the sweep, Expedite, Expire now; after identity, before the Release Block) and from the
   one-off backfill (`title-exclusion-backfill.ts`, never a title the *arr has now); it never deletes or edits an
   exclusion. Through `@hnet/arr/write` from `packages/domain` only.
   **ADR-098 adds the failed-download retry** (DESIGN-046 D-24): one search command (EpisodeSearch or MoviesSearch) per
   failed Sonarr or Radarr download, with no removal, only where the instance's `bad_release` cell is enforced and only
   while the *arr's own Redownload Failed is off; it shares the loop guard's budget of two tries per title in any 30 days with every
   other janitor search (D-23). It goes through `@hnet/arr/write` from `packages/domain` only.
   **ADR-111 C-03 adds the Seerr Issue bridge** (DESIGN-055 D-10, P7 decisions; owner ruling Q-02): one fix-it-yourself
   comment per new Seerr issue, and one resolve (an outcome note, then `POST /api/v1/issue/{id}/resolved`) once the
   Repair Request or Fix the guide ran from that report has completed and nothing linked to it is still open. Both post
   as the dedicated bridge user through `X-API-User` (never user 1, the owner's account), behind the audited
   `seerr_issue_bridge` setting, written only by `seerr-issue-writes.ts` (one `seerr_issue_writes` row per issue and kind,
   committed before the call). It never deletes, reopens or edits an issue or a comment. Through `@hnet/arr/write` from
   `packages/domain` only.
   **The owner-authorized P7 staff smoke test** (DESIGN-055 P7 decision 11) additionally creates and deletes its own
   marked fixture only, on Seerr media 10974 (The Canterville Ghost, TMDB 65465), as user 19. Its sole writer is
   `seerr-bridge-smoke.ts`, with durable intents and results through the audited `seerr_issue_bridge_smoke` setting;
   it refuses issues 1 to 4 and any issue it did not create. Its simulated repair uses the normal Repair Request
   lifecycle writers and performs no library write. Through `@hnet/arr/write` from `packages/domain` only.
   **ADR-114 adds the Watch Carry** (DESIGN-055 P4 decisions 26-34; owner ruling on #928, "Carry marks, then move"): inside
   a staff move only (`season-run`, `copy-run`, `ordering-run`, and `carry-finish` / `carry-revert`), each account's Plex
   plays and resume point (`scrobble`, `unscrobble`, `progress`) are written as that account, with the per-server token
   plex.tv lists for a friend (never stored or printed), onto the item that plays the file they watched; and a show's Plex
   episode ordering (`prefs?showOrdering`, `refresh`) is switched only inside such a carry. A snapshot is stored first, and
   every mark is one `watch_carry_marks` audit row. Through `@hnet/plex/write` from `packages/domain` only.
   **ADR-109 adds the Import Check's ManualImport** (DESIGN-055 D-07, PLAN-077 P2): one Sonarr or Radarr `ManualImport`
   command (the body their own interactive-import UI sends, `importMode: auto`) for a finished download whose import is
   blocked and whose Import Check passes, mapping its files onto the target the *arr's manual-import view, the queue and
   Title Evidence agree on; it adds files, never deletes one. Two callers: a person's queue-aware Force Search on a missing
   episode or movie (one Repair Request, `import_download`, only with the plan the person confirmed, behind the
   `import_check` remedy) and the janitor's `importable` cell (DESIGN-046 D-27, census until promoted, loop-guarded). The same
   Force Search may also remove a failed or defective download from the queue with blocklist and `skipRedownload` before its
   one search (audited in its `search_requested` event). Through `@hnet/arr/write` from `packages/domain` only.
   **ADR-109 and ADR-110 add the Episode Re-map and the Mislabel Block** (DESIGN-055 D-04, D-05, PLAN-077 P4). The
   re-map is a person's confirmed plan for one Sonarr season (one Repair Request, `remap`, behind the `episode_remap`
   remedy): one `ManualImport` per move of a file already in the series folder onto its right episodes (Sonarr re-links
   it; nothing is downloaded), in an order where every move lands on a free slot, each read back before the next, then
   `RenameFiles` for the moved files. It never deletes a file and never imports onto an episode that keeps a file it does
   not move. Staff's **Season Re-map** (DESIGN-055 P4 decisions 18 to 24, in-cluster tool only) uses the same two writes
   for a whole season by the files' own names: one file per step, a swap or rotation passing through a free parking
   episode, each file renamed and read back right after its step. The **Mislabel Block** is one app-owned Sonarr release profile (`haynesnetwork: mislabelled releases
   (managed, do not edit)`) holding "must not contain" terms that pair one series title with one release group, written
   only by its single writer (`mislabel-block.ts`): from a person's confirmed shift re-map that moved two or more files of
   that group, from the one-off adoption of Case A's hand-made profile, and in the hourly `title-check` upkeep (expiry,
   drift repair); every write is read back, terms live 365 days, at most 500. **ADR-113** adds mislabelled-name terms to
   the same profile (a number with another episode's title, a double-episode token, an alternate title of the series),
   written only by staff (`mislabel-block.ts add-name`) and the adoption, through the same single writer and read-back.
   The Title Check itself is census only and writes nothing to Sonarr. Through `@hnet/arr/write` from `packages/domain` only.
   **ADR-109 adds the Release Pick's grab** (C-02, C-06; DESIGN-055 D-06, PLAN-077 P5): one Sonarr or Radarr
   `POST /release` per press, for one missing episode or movie, of a row from the person's own Release List
   (`release_pick_lists`, read at most 25 minutes earlier), behind the `release_pick` remedy and after its Repair Request
   (`release_pick`, one unit of the hourly budget) is committed. A row the *arr approved goes back as `{guid, indexerId}`;
   every other row as the override body the *arr's own UI sends (this series and episode, or this movie, at the row's
   own quality and languages), and only when every reason is overridable (owner ruling Q-01: anyone who can use Fix, a
   missing item, within the budget; the hard-refusal list applies to everyone, admins included). It downloads, never
   deletes or blocks anything; a grab the *arr cannot file is imported through the Import Check above. Through
   `@hnet/arr/write` from `packages/domain` only.
   **DESIGN-055 P4 decision 38 adds the staff Wrong-Content Replace:** a correct release is chosen before deleting
   one or more wrong-content episode files, under one staff Fix Request (`wrong_content`, requester null) and a
   Watch Carry (migration 0106). Only after every target file's deletion is read back does the Release Pick writer
   grab the chosen releases onto those now-missing episodes. A deletion failure stops all grabs; retained files keep
   their audited watch state, and unverified deletions keep the carry open until a fresh read-back. Marks from the
   wrong content go only to its evidenced copies, or are audited as dropped after confirmed removal, never onto the
   replacement. Through `@hnet/arr/write` and `@hnet/plex/write` from `packages/domain` only.
   **ADR-109 adds the language-aware Wrong language** (C-02, C-07; DESIGN-055 D-08, PLAN-077 P6). **The Audio
   Preference**, a Plex write: a show's preferred audio language (`PUT /library/metadata/{key}/prefs?audioLanguage=`),
   on every Plex server that carries the show, only when the person's file already has the wanted audio and that
   language is the show's original one (owner ruling Q-03; Plex has no movie-level setting, Q-08); and **ADR-115** staff's
   household default (owner ruling on #955) for a show the staff audit flags: English where its files carry it, else the
   original (requester null only, `repair-guide.ts audio-scan --apply-household`). It runs behind the
   `audio_preference` remedy, after its Repair Request (`audio_preference`, one budget unit) commits, and every server is
   read back. Any other language, and every movie, gets guidance and no write. Through `@hnet/plex/write` from
   `packages/domain` only. **The Language Replace**: for one episode or a movie whose file lacks the wanted audio, behind
   the `language_search` remedy, the Fix marks the file's grab failed (never a pack that also holds other on-disk
   episodes), deletes the file and grabs, with the plain `{guid, indexerId}` body, the first release the *arr would take
   that it parsed as carrying the language. With no such release nothing is removed. Through `@hnet/arr/write` from
   `packages/domain` only.
5. **Auth is Authentik OIDC only.** No email/password, no invite tokens. Admin role is
   bootstrapped by matching the OIDC email against the `BOOTSTRAP_ADMIN_EMAILS` allowlist.
6. Role/permission mutations must write audit rows in the same transaction (see
   `packages/domain` — single-writer helpers; `packages/domain/README.md` — pattern
   borrowed from todos-for-dues). **Every `book_requests` write goes through
   `packages/domain/src/book-request-events.ts`**, which records a Request Event (`book_request_events`) in the same
   transaction (ADR-101); a repair script runs its writers inside `withRequestEventScope({ actor: 'repair', site })`.
7. Secrets never land in git: local dev uses `.env.local` (gitignored); cluster uses
   External Secrets + 1Password (`HaynesKube` vault). See `docs/ops/`.
8. **Destructive actions use the `@hnet/ui` `ConfirmButton` inline two-step confirm — never
   `window.confirm`** (ADR-014 / DESIGN-004 D-13). Explanatory / multi-field confirms (failsafe
   restore, Fix, Force-search) use a `Modal` instead.
9. **Page contents must not re-orient on interaction** (ADR-015 / DESIGN-004 D-14). An
   interaction may change color/emphasis but must NOT reflow or reposition neighbors. The only
   exceptions are deliberate in-place expansions (e.g. the catalog inline editor) and
   drag-and-drop reordering. The two-step confirm reserves width for the widest (armed) label so
   the label swap can't shift the row; armed state deepens color, never layout.
10. **Libretto (`thaynes43/libretto`, ns `media/libretto`) is a full-autonomy suite repo** —
    build/PR/merge/deploy it directly, the same standing as haynesnetwork (owner ruling 2026-07-17;
    it is no longer plan-only). It is **headless by design**: a Kometa-modeled recipe→collection
    service with a REST API and NO UI of its own — **haynesnetwork houses 100% of the collection UX**
    (catalog, manager, books Wanted-tiles). Never add UI to Libretto. It stays generic/reusable
    (Kometa-for-books), so app-specific concerns live app-side: haynesnetwork talks to it only through
    `@hnet/libretto` (read + the domain-confined write). Libretto is docs-first via its own README +
    PR description; the normative design of record is `docs/designs/037-libretto-architecture.md`
    (this repo). Libretto's own deploy (helmrelease image tag in `haynes-ops`
    `kubernetes/main/apps/media/libretto/`) is driven independently of the haynesnetwork release train.

## Workflow

- **Until GATE A** (recorded in `.agents/plans/`), bootstrap work lands directly on `main`.
- **After GATE A**: branch `<type>/<slug>` off `main` → PR → required checks
  `lint-and-typecheck`, `test`, `build`, **`e2e-gate`** green → squash-merge. **`e2e-gate` always
  reports.** It passes at once for a PR that touches no pipeline path, and mirrors the Playwright
  suite for one that does (`packages/{domain,sync,arr,lazylibrarian,goodreads,books,kapowarr,downloads,libretto,db,test-utils}`,
  the integrations/books/book-fix tRPC routers, `apps/web/e2e`, the integrations UI; the list is `scripts/e2e-gate-paths.sh`) and for the release-please PR,
  so a red e2e stops a pipeline change and the release (ADR-100, #742). **CI spends runner time only where a change
  can break something (ADR-102; public-repo Actions minutes are not billed, so ADR-104 undid its coverage cut):** a PR that changes no code path (`scripts/ci-code-paths.sh`: Markdown anywhere,
  `docs/**`, `.agents/**` except its `*.yaml`/`*.json` data files) skips lint, typecheck, tests, build and the image
  build; those required checks report as skipped, which satisfies branch protection. The advisory suite
  (`e2e-advisory`, never required) runs on every other PR that changes a code path (ADR-104); label a PR `run-e2e`
  to force it on one with no code path. Nothing runs on a push to main
  (protection is strict, so main's tree is the tree the PR tested). To run the suite on main's code, label a
  docs-only PR `run-e2e` (its merge tree has main's code); the bot token cannot dispatch workflows (403), the owner
  can (`gh workflow run e2e.yml --ref main`). A commit touching only `.agents/` and `docs/` never opens or updates
  the release PR.
  Conventional commits (`feat:`/`fix:`/`feat!:`) drive release-please versioning.
- **Claude Code PR reviewer (optional, advisory).** `.github/workflows/claude-code-review.yml` reviews every
  non-draft PR (job `Claude advisory review`) and `claude.yml` answers `@claude` mentions from
  write-access users. The review is **advisory, never a required check** (the required contexts stay
  `lint-and-typecheck`, `test`, `build`, `e2e-gate`). **Review runs are optional. Skip them when Claude Code
  usage is exhausted or the reviewer is unavailable** (owner ruling 2026-10-11, supersedes the R-05 wait).
  A pending, failed, skipped or missing Claude review does not block merge once required checks pass.
  Record the skip reason in the PR description or comment; do not retry or dispatch another reviewer to
  work around exhausted usage. Read any findings already posted before merging: fix each one, or
  answer it on the PR with a concrete reason it is wrong. It needs two things
  or it skips (green, no review): the Claude GitHub App has access to this repo, and the
  `CLAUDE_CODE_OAUTH_TOKEN` repo secret exists. Fork and Dependabot/Renovate/release-please PRs are
  skipped by design.
- Images build to `ghcr.io/thaynes43/haynesnetwork` on `v*` tags; deployment manifests live
  in `haynes-ops` under `kubernetes/main/apps/frontend/haynesnetwork/`.
- **Backlog/saga state must reach `main` — never left untracked** (owner rule, 2026-07-18).
  Any add or update to agent working state (`.agents/HANDOFF.md`, `.agents/context/`,
  `.agents/plans/`) or docs backlog gets committed and merged to `main` in the same session
  that produced it — a small `docs:`/`chore:` PR is fine, batching several notes is fine,
  leaving them untracked in a worktree is not. Pod worktrees are disposable (`agent-run`
  cleanup deletes them); untracked notes there are lost work.

## Commands

pnpm 11.9 workspace (Node >= 22). Apps live in `apps/*`; internal packages in `packages/*`
are scoped **`@hnet/*`** and export raw TS — no per-package build step. There are more than twenty
(`ls packages`); every one needs a `COPY packages/<name>/package.json` line in the Dockerfile's deps
stage (a missing line fails only the release image build, which is not a required check). The core ones:

- `@hnet/db` — Drizzle schema + migrations against Postgres 16.
- `@hnet/domain` — single-writer domain logic; audit/ledger rows written in the same
  transaction as the mutation they record.
- `@hnet/arr` — Sonarr/Radarr/Lidarr client; `@hnet/arr/write` (the write-back surface) is
  import-confined to `packages/domain`.
- `@hnet/plex` — Plex server + plex.tv sharing client (XML ACL); `@hnet/plex/write` (the
  share-mutation surface) is import-confined to `packages/domain` (ADR-017).
- `@hnet/sync` — one-way *arr → ledger sync jobs (run by the cluster CronJobs).
- `@hnet/auth` — Better Auth + Authentik OIDC wiring.
- `@hnet/api` — tRPC routers.
- `@hnet/ui` — token-themed components (`data-theme`); `tokens.css` is the only place for hex.
- `@hnet/test-utils` — embedded-Postgres + stub harness helpers.
- `@hnet/watch` — progress math, personal evidence and candidate identity checks, limited cached
  candidate hints, spoken formatting and read queries (DESIGN-049 / DESIGN-054). No MCP SDK, no writes.
  ADR-107 assigns broad recommendation research and judgment to the consuming agent; Plex/watchlist
  membership restricts choices only on explicit request.
- `@hnet/mcp` — the in-cluster MCP endpoint behind `/api/mcp` (ADR-087): consumer auth, eleven
  watch tools (ADR-107 adds `check_titles` / `viewing_context`), and the Voice Budget tests.
- `@hnet/oauth` — the pure half of the public connectors' OAuth 2.1 authorization server (ADR-091):
  metadata, validation, PKCE, token hashing and the decisions. It never touches a database; every OAuth-table
  write is a `@hnet/domain` `oauth/*` single-writer.

- `pnpm install` — install workspace deps.
- `pnpm dev` — Next.js dev server (`apps/web`) on http://localhost:3000. Needs a real
  `DATABASE_URL`/OIDC env in `apps/web/.env.local`.
- `pnpm dev:local` — the primary no-Docker way to boot the whole app: embedded Postgres 16
  (migrated + seeded), a stub OIDC provider, and stub Sonarr/Radarr/Lidarr/Seerr, all on
  http://localhost:3000. See `docs/ops/003-local-verification.md` (local verify) and
  `docs/ops/004-deploy-runbook.md` (merged PR → live staging).
- `pnpm build` — `pnpm -r build` (`next build`, standalone output).
- `pnpm typecheck` — `tsc --noEmit` in every workspace package.
- `pnpm lint` — ESLint 9 flat config in every workspace package.
- `pnpm lint:css` — hex-color guard (`scripts/lint-css-hex.mjs`; stub until the theme port).
- `pnpm test` — Vitest across packages (`@hnet/domain` has the first real test; others
  run `vitest run --passWithNoTests`).
- `pnpm format` — Prettier write across the repo.

Arriving with later tasks: `pnpm --filter web e2e` (Playwright),
`pnpm --filter @hnet/db generate|migrate` (Drizzle).
