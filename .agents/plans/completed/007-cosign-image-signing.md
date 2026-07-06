# PLAN-007: Cosign image signing — keyless (GitHub OIDC) sign + Kyverno enforce

- **Status:** Completed (2026-07-06) — v0.7.0 released signed (Rekor-logged, in-run verified,
  .sig on GHCR); Kyverno dedicated Enforce policy live-validated: signed admitted (probe +
  production rollout), unsigned denied (pod + Deployment).
- **Satisfies:** ADR-006 C-04 (`docs/adrs/006-hosting-and-deployment.md:75`) · ADR-009 C-04
  release-workflow note (`docs/adrs/009-ci-and-pr-flow.md:50`) · new **ADR-016** (image
  signing approach) · OPS-004 reconciliation (`docs/ops/004-deploy-runbook.md`)
- **Depends on:** none (independent ops slice; no product code, no DB, no UI — can run any
  time during the day, in parallel with 002–006)
- **TODO source:** backlog O-3 (Kyverno cosign gotcha, `.agents/HANDOFF.md:72`)

## Goal

Sign every published `ghcr.io/thaynes43/haynesnetwork` image with **keyless cosign
(GitHub Actions OIDC → Fulcio/Rekor)** in the same workflow run that pushes it, `cosign
verify` it in-run as a gate, then extend the cluster's existing Kyverno cosign policy
(`haynes-ops` `verify-thaynes43-images.yaml`, AUDIT today) to cover `haynesnetwork*` and
flip it to **Enforce** once a signed digest is confirmed admitted. Closes the ADR-006 C-04
gap so this app's images can never be swapped for an unsigned one on our own repo path.

## Context the driver must not miss (read before touching anything)

1. **The publish moved.** OPS-004 §1/§1a still says `ci.yml`'s `build-image` job publishes on
   `v*` tags and documents a `RELEASE_PLEASE_PAT` re-push dance. That is **stale** — commit
   `4aefdd6` (#37) moved the GHCR push into `release-please.yml`, which builds+pushes **in the
   same run** it cuts a release, using `GITHUB_TOKEN` (`.github/workflows/release-please.yml:28-59`).
   `ci.yml`'s `build-image` is now **build-only validation, never publishes** (`ci.yml:63-111`,
   `IMAGE_PUSH: 'false'`). **The cosign sign+verify step belongs in `release-please.yml`, after
   the `docker/build-push-action@v6` step** — that is the only place a real image is pushed.
   Reconciling OPS-004 to reality is part of this plan's DoD.
2. **Keyless needs `id-token: write`.** `release-please.yml` permissions today are
   `contents: write` / `pull-requests: write` / `packages: write` (`release-please.yml:7-10`).
   Keyless cosign mints an OIDC token from the Actions runner → **add `id-token: write`**.
3. **The Kyverno policy already exists** (`haynes-ops`
   `kubernetes/main/apps/kyverno/policies/app/verify-thaynes43-images.yaml`). It is
   `background: false`, `failurePolicy: Ignore`, `failureAction: Audit`, and today scopes
   **only** `ghcr.io/thaynes43/upgrade-agent*` + `upgrade-shepherd*` with a keyless attestor
   whose `subject` is `https://github.com/thaynes43/haynes-ops/.github/workflows/*` and
   `issuer: https://token.actions.githubusercontent.com` (lines 32-47). `haynesnetwork` is
   **NOT** covered. Extending it = add our imageReference **plus** a second attestor/subject
   for **this** repo's workflow OIDC identity (`.../haynesnetwork/.github/workflows/*`) — the
   signer identity is the repo+workflow that runs `cosign sign`, i.e. `release-please.yml` on
   `haynesnetwork`, not `haynes-ops`.
4. **Sign by digest, not tag.** `build-push-action` pushes both `:vX.Y.Z` and `:latest`
   (`release-please.yml:46-48`). Give that step an `id` and sign
   `ghcr.io/thaynes43/haynesnetwork@${{ steps.build.outputs.digest }}` once — the digest
   covers every tag that points at it. Kyverno verifies at admission by digest.

## Docs-first artifacts to author (same PR as the workflow change)

- **NEW ADR-016 — "Container image signing: keyless cosign via GitHub OIDC."** MADR 3.0,
  authored **and ratified (Accepted)** by Fable 5 (owner-approved). Copy `docs/adrs/000-template.md`.
  - **Decision:** sign `haynesnetwork` images with **keyless** cosign (Fulcio short-lived
    cert from the Actions OIDC token, transparency log = public Rekor) in `release-please.yml`;
    verify in-run; Kyverno admits by matching the GitHub OIDC `subject`+`issuer`. **No
    long-lived private key, no `COSIGN_PRIVATE_KEY`/`COSIGN_PASSWORD` secret to store or
    rotate** — this is the deciding driver.
  - **Considered options:** (A) keyless GitHub-OIDC cosign *(chosen)*; (B) key-based cosign
    with a 1Password-held keypair injected as Actions secrets; (C) no signing / keep Kyverno
    audit forever.
  - **Consequences (C-NN):** ties into ADR-006 C-04 (this is its resolution); records that
    the signer identity is load-bearing config shared with the `haynes-ops` Kyverno policy —
    renaming `release-please.yml` or moving the sign step to another workflow **breaks
    admission** unless the policy `subject` glob is updated in lockstep (cross-repo coupling,
    same failure-class as ADR-009 C-05's required-check-name drift). Records dependence on
    public Sigstore infra (Fulcio/Rekor) availability at **admission** time (`background:
    false`), mitigated by `failurePolicy: Ignore` (fail-open) until enforce is proven.
  - Supersede note: none — this is the **first** signing ADR; it *fulfills* the plan ADR-006
    C-04 and ADR-009:50 both anticipated.
- **PRD-001 edit:** add one supply-chain requirement (next free `R-NN`) under the
  hosting/ops requirements — "Published images are cryptographically signed (keyless cosign);
  the cluster admits only signed `haynesnetwork` images once enforcement is on." Mark **Must**.
  IDs are stable — append, never renumber (`CLAUDE.md`).
- **DDD/glossary** (`docs/domain-driven-design/001-ubiquitous-language.md`): add normative
  terms in the same change — **keyless signing**, **Fulcio**, **Rekor (transparency log)**,
  **attestor/subject (Kyverno)**, **admission verification**. (No new bounded context; this
  is pure ops/supply-chain vocabulary.)
- **OPS doc — reconcile + extend.** Two edits:
  - **Rewrite OPS-004 §1/§1a** to match the real pipeline: publish happens in
    `release-please.yml` on `release_created` via `GITHUB_TOKEN` (delete the stale
    `build-image`/`RELEASE_PLEASE_PAT` re-push narrative, or clearly mark it superseded), and
    document the new **cosign sign+verify** step + the `id-token: write` permission. Update the
    "confirm the image exists" block to also show `cosign verify …`.
  - **NEW `docs/ops/006-image-signing.md`** (Accepted): the operator runbook — how keyless
    signing works here, the exact `cosign verify` invocation (subject/issuer/rekor), the
    cross-repo Kyverno coupling, the **AUDIT→Enforce switch procedure**, and how to read the
    Kyverno admission report. Cross-link from `docs/README.md` and `.agents/HANDOFF.md:72`
    (flip the gotcha from "plan a signing step" to "signed; enforce switch lives in OPS-006").

## Data model / Domain / API / UI

**None.** This slice touches no `packages/db` schema, no `packages/domain` single-writers, no
tRPC router, no `apps/web` page. The single-writer guard list
(`packages/domain/__tests__/no-direct-state-writes.test.ts`), the arr-write import
confinement (`packages/domain/__tests__/arr-write-import-guard.test.ts`), and the
`packages/db/src/schema/enums.ts` CHECK-constraint source-of-truth are **untouched** — call
this out explicitly in the PR description so a reviewer/agent does not expect them.

## Workflow / CI changes (`.github/workflows/release-please.yml`)

1. **Add** `id-token: write` to the top-level `permissions` block (`release-please.yml:7-10`);
   keep `contents: write` (release), `pull-requests: write` (release PR), `packages: write`
   (GHCR push).
2. **Add `id: build`** to the existing `docker/build-push-action@v6` step
   (`release-please.yml:50-59`) so its `outputs.digest` is available.
3. **Add `sigstore/cosign-installer@v3`** step (pinned), guarded on
   `steps.release.outputs.release_created == 'true'` like every other publish step.
4. **Add a `cosign sign` step** (same guard): keyless (cosign v2 default; `--yes` to skip the
   confirmation prompt) over the **digest**:
   `cosign sign --yes ghcr.io/thaynes43/haynesnetwork@${{ steps.build.outputs.digest }}`.
   GHCR auth is already established by the `docker/login-action@v3` step
   (`release-please.yml:34-39`); cosign pushes the signature to the same registry path.
5. **Add a `cosign verify` gate step** (same guard, runs after sign) asserting the OIDC
   identity — `--certificate-identity-regexp` matching
   `^https://github.com/thaynes43/haynesnetwork/.github/workflows/` and
   `--certificate-oidc-issuer https://token.actions.githubusercontent.com`. A verify failure
   **fails the job** so an unsignable release is loud, not silent.

Keep every new step behind the `release_created` guard so PR and non-release `main` pushes
stay no-ops (mirrors the existing publish steps).

## Ops — Kyverno policy coordination (sibling `haynes-ops` repo)

Edit `kubernetes/main/apps/kyverno/policies/app/verify-thaynes43-images.yaml`:

1. **Add** `"ghcr.io/thaynes43/haynesnetwork*"` to `imageReferences` (line 32-34). Because the
   signer identity differs per source repo, either (a) give `haynesnetwork*` its **own
   `verifyImages` rule / attestor** whose `keyless.subject` is
   `https://github.com/thaynes43/haynesnetwork/.github/workflows/*`, or (b) add a second
   `attestors[].entries[]` keyless entry with that subject under a shared rule — **decide in
   ADR-016** (option (a) is cleaner: per-repo rule, independent enforce flip). `issuer` and
   `rekor.url` stay `token.actions.githubusercontent.com` / `rekor.sigstore.dev`.
2. **Enforce switch:** leave `failureAction: Audit` on the `haynesnetwork` rule **until** a
   signed digest is confirmed admitted (see Verification), then change **that rule** to
   `failureAction: Enforce`. Keep it a **one-field, per-rule** switch so upgrade-agent/shepherd
   enforcement timing stays independent. Flux reconcile via the OPS-004 §2 commands.
3. This is a **manual-merge** area — do not add `kyverno/**` to any autoMerge glob
   (`haynes-ops` `.../kyverno/kyverno/app/ocirepository.yaml:13`). Follow the existing
   AUDIT→Enforce discipline in `haynes-ops` `.agents/runbooks/kyverno-enforce-verify.md`.

**Secrets:** keyless needs **no secret** — no `COSIGN_*` key, nothing new in 1Password / the
`haynesnetwork` ExternalSecret contract (OPS-004 §5). GHCR auth reuses the in-run
`GITHUB_TOKEN`. Reference names only; commit no values (`CLAUDE.md` rule 7).

**e2e stub:** none — no external system reaches `apps/web`; nothing to stub for hermetic e2e.

## Open decisions Fable 5 must make (authorized to decide + record as ADR-016 / Q-NN)

1. **Keyless vs key-based** — recommend **keyless** (no key to store/rotate; matches the
   existing `haynes-ops` policy's keyless attestor). Record as the ADR-016 decision.
2. **Flip Enforce now vs after first signed release is confirmed admitted** — recommend
   **stage it**: ship signing + policy-coverage (still AUDIT) first, cut a signed release,
   confirm the Kyverno admission report shows the signed digest passing, **then** flip that
   one rule to Enforce in a follow-up `haynes-ops` commit. Record the chosen sequencing.
3. **Shared-rule second-attestor vs dedicated `haynesnetwork` rule** in the Kyverno policy
   (see Ops step 1) — recommend a **dedicated rule** for an independent enforce flip.
4. **Pin `latest`?** Whether to also verify `:latest` or rely solely on the digest signature
   (digest signature already covers all tags) — recommend digest-only, note in OPS-006.

## Verification

**In-workflow (the release run):**
- `cosign sign` succeeds; `cosign verify` (identity-regexp + issuer) passes as a job gate.

**Manual, post-release (owner absent — run from the driver's shell):**
```bash
# 1. Signature exists + identity is ours (public Rekor, keyless):
cosign verify ghcr.io/thaynes43/haynesnetwork:vX.Y.Z \
  --certificate-identity-regexp '^https://github.com/thaynes43/haynesnetwork/.github/workflows/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
gh api /users/thaynes43/packages/container/haynesnetwork/versions \
  --jq '.[].metadata.container.tags[]' | grep vX.Y.Z   # tag published
```
- **2. Kyverno admits the signed image (AUDIT phase):** deploy the signed `vX.Y.Z` to staging
  via OPS-004 §2, then read the policy report — the `haynesnetwork` pod's `verifyImages`
  result is **pass** (not fail) in AUDIT. Use the report/query patterns in `haynes-ops`
  `.agents/runbooks/kyverno-enforce-verify.md` (check-1 block-count query + admission-controller
  logs). Confirm zero admission blocks.
- **3. After flipping Enforce:** re-deploy the signed digest → pod **admitted**. Then prove the
  guard bites: attempt to admit an **unsigned** image on our path (e.g. a scratch pod
  referencing an unsigned `ghcr.io/thaynes43/haynesnetwork`-path tag, or a deliberately
  unsigned test build) in a throwaway namespace → **denied at admission** with the
  `verify-thaynes43-images` policy named in the event. Clean up the probe.

**Live Playwright (real staging, after the signed image is running):** the signing change is
invisible to the UI, so the journey is a **regression smoke** proving the signed+admitted
image serves correctly against `https://haynesnetwork.haynesops.com` and the real backends:
OIDC sign-in round-trip → dashboard renders the permissioned catalog → `/api/health` 200.
Confirms enforce did not wedge the rollout.

## Definition of Done

- ADR-016 Accepted; PRD-001 `R-NN` added; glossary terms added; OPS-004 reconciled; OPS-006
  authored; `HANDOFF.md:72` gotcha updated — all in the **same PR** as the workflow change.
- `release-please.yml` signs + verifies; local merge gate green
  (`pnpm lint && pnpm lint:css && pnpm typecheck && pnpm test && pnpm build` — all no-ops for
  this ops-only change but must pass); branch `ci/cosign-image-signing` → PR → required checks
  (`lint-and-typecheck`, `test`, `build`) green → squash-merge.
- A real signed release cut; `cosign verify` passes; signed digest **admitted** by Kyverno on
  live staging.
- `haynes-ops` policy extended to cover `haynesnetwork*`; enforce flip either applied (with the
  unsigned-rejection test passing) **or** staged with a clearly-documented one-field switch in
  OPS-006 per the open-decision outcome.
- Plan marked Completed + `git mv .agents/plans/007-cosign-image-signing.md
  .agents/plans/completed/`.

## Out of scope

- Signing the **other** `ghcr.io/thaynes43/*` images (appdaemon, todos-for-dues, etc.) — the
  policy comment (`verify-thaynes43-images.yaml:8-11`) tracks those separately.
- SBOM generation / SLSA provenance attestations (`cosign attest`) — signing only; note as a
  future ADR in OPS-006.
- Changing `ci.yml`'s build-only `build-image` job (`ci.yml:63-111`) — it never publishes, so
  nothing to sign there.
- Any DB/domain/API/UI change.

## Rollback

- **Workflow:** revert the `release-please.yml` commit — publish reverts to unsigned; harmless
  while Kyverno is AUDIT.
- **Enforce:** if a signed image is wrongly denied, flip the `haynesnetwork` rule back to
  `failureAction: Audit` in `haynes-ops` and `flux reconcile` (OPS-004 §2) — admission fails
  open (`failurePolicy: Ignore`) so a Sigstore outage never wedges deploys; the enforce flip is
  the only failure-closing surface and it is a single-field revert.
- **No secrets to unwind** (keyless).
