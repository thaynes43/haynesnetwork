# OPS-014 — haynes-ops collection writes (the Kometa auto-merge runtime secret + bootstrap)

- **Status:** Prerequisite NOT yet provisioned (2026-07-18). The app code path (ADR-072 / DESIGN-042
  PR4b) is built and merged; the runtime credential + the haynes-ops bootstrap wiring below MUST land
  before the Movies/TV write path functions in the cluster. Until then the Movies/TV `/collections`
  tabs read the mirror + the managed include honestly and degrade to `reachable: false` on a write.
- **Scope:** How the haynesnetwork app writes the app-owned Kometa managed include to the `haynes-ops`
  GitOps repo (open a bot PR, auto-merge the safe case), and the one-time bootstrap the repo needs.
- **Normative basis:** ADR-072 (direct-add + Kometa auto-merge), DESIGN-042 D-02/D-04/D-09/D-10,
  `.agents/plans/052-collection-manager-integration.md` (PR4b).
- **Repos:** app write client `@hnet/haynesops` (this repo); target config in `haynes-ops`
  (`kubernetes/main/apps/media/kometa/app/config`).

---

## 1. The runtime secret (⚠ MUST be provisioned)

The app writes to `haynes-ops` at RUNTIME (when a user adds/edits/removes a Movies/TV collection). It
needs a GitHub credential the app pod can read. **No such runtime secret exists today** — the dev-env
bot token is an agent/CI credential, not an app-pod secret.

**Required env var:** `HAYNESOPS_WRITE_TOKEN`

- A **GitHub App installation token** (preferred) or a **fine-grained PAT** scoped to the `haynes-ops`
  repo with **`contents: read/write`** + **`pull_requests: read/write`**. An App token is preferred
  because App-authored PR events TRIGGER the required CI check (a raw `GITHUB_TOKEN` push does not — the
  auto-merge waits on that check, DESIGN-042 D-10).
- Delivered as an **ExternalSecret** (1Password `HaynesKube` vault, hard rule 7) mounted into the
  `haynesnetwork` Deployment env. Never in git.

**Optional (non-secret) overrides** — all defaulted, only set to change the target:
`HAYNESOPS_REPO` (default `thaynes43/haynes-ops`), `HAYNESOPS_BASE_BRANCH` (default `main`),
`HAYNESOPS_KOMETA_CONFIG_DIR` (default `kubernetes/main/apps/media/kometa/app/config`),
`GITHUB_API_URL` (default `https://api.github.com`),
`HAYNESOPS_KOMETA_CHECK_NAME` (default `Kometa Validate Managed Files - Success` — the ONE check-run the
auto-merge gate resolves against by name; DESIGN-042 D-10. Set it only if the validate workflow's job name
changes in haynes-ops).

Absent the token, `assertHaynesopsEnv` throws `HaynesopsConfigError` naming `HAYNESOPS_WRITE_TOKEN`
(never its value); a Movies/TV write surfaces that honestly and a Libretto (Books/Audiobooks) write is
unaffected (the approve path resolves the bundle lazily).

## 2. The haynes-ops bootstrap (one-time, human GitOps PR)

The app owns exactly TWO files and never edits a hand-written sibling (DESIGN-042 D-02/D-09). They must
be REGISTERED once, by hand, in `haynes-ops`:

1. Create the two app-owned includes (empty stubs are fine — the app regenerates them):
   - `kubernetes/main/apps/media/kometa/app/config/hnet-managed-movies.yml`
   - `kubernetes/main/apps/media/kometa/app/config/hnet-managed-tv.yml`
   - An empty stub is a header + `collections: {}` (what the compiler emits for zero recipes).
2. Register both in `app/kustomization.yaml` `configMapGenerator.files` (so Flux mounts them at
   `/config/git`).
3. Append each to its library's `collection_files` in `app/externalsecret.yaml` (the `config.yml` seed):
   `HOps Movies` → `- file: config/git/hnet-managed-movies.yml`; `HOps TV Shows` →
   `- file: config/git/hnet-managed-tv.yml`. **Note:** the seed only re-applies on a `config.yml`
   re-seed (delete `/config/config.yml` on the PVC), because Kometa self-rewrites that file — a one-time
   op when this bootstraps.
4. Add a required CI check that runs Kometa `--validate-file` against the pinned image (v2.4.4) on the
   two managed files for PRs that touch them (DESIGN-042 D-09). **This is the gate the app auto-merge
   waits on** — until it exists, `getChecksConclusion` returns `none` and the app leaves EVERY PR for a
   human merge (the safe default; nothing auto-merges without a green gate).

## 3. What the app does at runtime (as-built)

1. Compile the enabled recipes → the app-owned managed include (pure, `@hnet/domain` compiler).
2. Open a bot-authored branch `hnet-collections/<slug>` + commit the file + open a PR (`@hnet/haynesops`).
3. **Auto-merge** (squash) only when ALL FOUR D-10 conditions hold: within-cap, grouping-only
   (find-missing OFF), the PR diff touches ONLY the managed include, and the `--validate-file` gate is
   green. Otherwise leave the PR for a human (over-cap materialization + find-missing enable always
   human-merged).
4. Flux applies the merged config; the next Kometa run (`collections` CronJob, `30 6 * * *`) produces
   the Plex collection; `collections-sync` mirrors it back with `provenance: kometa`. The app row
   reconciles to `live` when the produced collection appears in the mirror (matched by title — Q-05).

The merged PR is the audit trail; a bad recipe is a `git revert`. The confined `@hnet/haynesops/write`
surface is import-guarded to `packages/domain` (the arr-write-import-guard test).
