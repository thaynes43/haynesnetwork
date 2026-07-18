# 2026-07-18 — PR4b: Kometa (Movies/TV) collections write path + auto-merge (SHIPPED on branch)

Realizes **ADR-072** + **DESIGN-042** (D-02/D-04/D-05/D-07/D-09/D-10, Q-05/Q-06 resolved-at-build) per
**PLAN-052 PR4b**, on top of PR4a (#393). Branch `feat/kometa-collections-write`. No migration (0068 is the
books agent's; the Kometa recipe source of truth is the app-owned managed file in git, not a table).

## What landed

- **New package `@hnet/haynesops`** — the confined haynes-ops GitOps write client. Barrel exports
  errors + `assertHaynesopsEnv`; `/read` (getFile base64, listOpenManagedPrs by `hnet-collections/`
  branch namespace, getChecksConclusion roll-up) and `/write` (branch → commit → PR → getPrFilePaths →
  waitForChecks → squashMergePr). Import-confined to `packages/domain` — the arr-write-import-guard test
  is EXTENDED for `@hnet/haynesops/write`.
- **Compiler** (`@hnet/domain/kometa-compiler.ts`, pure): `KOMETA_BUILDER_TYPES` allowlist (the six
  single-ref builders, added to `@hnet/db`); `validateKometaRef` (shape + canonicalize; id-lists yield a
  count, URL/id yield null); `previewKometaRef` (canary-first, NO egress); `compileManagedFile` /
  `parseManagedFile` (byte-stable, idempotent, round-trippable via a `# hnet-recipes:` manifest comment);
  `HNET_MANAGED_LABEL` namespace marker (reserved in `deriveCollectionCategory` — classifier version → 3).
- **Orchestrator** (`@hnet/domain/kometa-collections.ts`): `getKometaCollectionsOverview` (reads the
  managed file back + the DESIGN-035 mirror + open PRs; reconciles live/pending_run by normalized title;
  degrades reachable:false), `upsertKometaCollection` (validate → cap assert → recompile → open PR →
  auto-merge per D-10 → same-tx audit), `materializeKometaCollection` (over-cap, human-merged),
  `deleteKometaRecipe`, and `evaluateKometaAutoMerge` (the pure four-condition D-10 policy).
- **Router** (`collections.*`): `overview`/`validate`/`upsert`/`remove` route Movies/TV → Kometa,
  Books/Audiobooks → Libretto; `requestOverride` sizes Kometa refs via previewKometaRef;
  `approveCollectionOverride` (in tickets.ts) branches provider → `materializeKometaCollection` for a
  Kometa payload (human-merged PR, ticket completes with the PR URL). `KometaRecipeError` →
  UNPROCESSABLE_CONTENT (appCode `KOMETA_RECIPE_INVALID`). `remove` gained a required `mediaType`.
- **UI** (`collections-client.tsx` + `lib/collections.ts`): Movies/TV tabs render LIVE (available:true) —
  Kometa builder options in the composer, honest `pending next collection run` state, an "Awaiting merge"
  band for open PRs, and no Run-now (Kometa has no per-recipe apply). Composer/remove send `mediaType`.

## Auto-merge (D-10) — as-built
`evaluateKometaAutoMerge` fires only when ALL: within-cap (assert passed, not a materialization) AND
grouping-only (find-missing OFF) AND the PR diff touches ONLY the managed include AND the `--validate-file`
CI gate is green. `getChecksConclusion` returns `none` until the CI workflow exists → **every PR is left
for a human until the gate is wired** (safe default). Over-cap materialize + find-missing always human.

## ⚠ Runtime prerequisite (FLAGGED — not provisioned)
`HAYNESOPS_WRITE_TOKEN` (a GitHub App install token / fine-grained PAT with contents+PR write on
haynes-ops) does NOT exist as an app-pod secret. Plus the haynes-ops BOOTSTRAP (register the two
`hnet-managed-*.yml` files in kustomization + externalsecret `collection_files` + a `--validate-file` CI
gate). Both documented in **docs/ops/014-haynesops-collection-writes.md**. Absent the token, Movies/TV
writes surface the honest degrade; Books/Audiobooks are unaffected (approve resolves the bundle lazily).

## Build decisions to flag for the owner
- **Cap for Kometa is only provable for id-list builders** (tmdb_movie/show, tvdb_show). A non-admin
  add of a URL/collection-id builder (imdb_list, tmdb_collection_details, tvdb_list_details) cannot be
  proven within-cap without egress, so it routes to the over-cap ticket (human-merged) — never
  auto-merged. Admins bypass. (Q-06 canary-first.)
- **Delete auto-merges** (managed-file-only, grouping-only, CI-green) — a removal only shrinks the file.
  The produced Plex collection is ORPHANED (not deleted); the `also delete` option is recorded for audit
  but Kometa hard-delete semantics are UNVERIFIED (D-03) — orphan-only in v1.
- **Reconcile is by normalized title** (mirror `created_by: kometa` + title match → live). A finer
  label→recipe-id sync join is deferred (a `collections-sync` dependency).

## For PR4c (find-missing grant + cron)
- The Kometa knob is wired for OFF only. PR4c flips `radarr_add_missing`/`sonarr_add_missing` via a
  find_missing-gated `collections.setFindMissing`; the compiler already emits `<arr>_add_missing: true` +
  `<arr>_search: true` when a recipe's `findMissing` is true, and `evaluateKometaAutoMerge` already forces
  those edits to the HUMAN-merge path. Build the /admin grid + the per-collection knob + cron force-search.

## Tests / gates
Compiler golden + allowlist + round-trip (`kometa-compiler.test.ts`); auto-merge matrix + orchestrator
paths + overview reconcile + honest degrade (`kometa-collections.test.ts`, embedded PG); git-client dance
(`@hnet/haynesops/__tests__/client.test.ts`, stub fetch); router wiring + forbidden + provider routing
(api `collections.test.ts`); guard extension. Full typecheck/lint/lint:css/test/build green.
