# ADR-020: Container image signing — keyless cosign via GitHub OIDC

- **Status:** Accepted
- **Date:** 2026-07-06
- **Deciders:** Tom Haynes (owner) · ratified by Fable 5 (autonomous run, KICKOFF mandate)

## Context and problem statement

`haynesnetwork` ships as one GHCR image (`ghcr.io/thaynes43/haynesnetwork`) published from
`release-please.yml` in the same run that cuts a release, using the in-run `GITHUB_TOKEN`
(`packages: write`) — no PAT, no tag re-push (ADR-006, ADR-009, OPS-004 §1a). ADR-006 C-04
left an explicit gap: a pure tag/digest bump to a **malicious image on our own repo path**
passes Kyverno's registry allow-list (`restrict-image-registries`) and the manifest diff
scope, because both only check *where* the image lives, not *who built it*. Nothing today
proves the deployed digest was actually produced by our CI.

The sibling `haynes-ops` cluster already runs a Kyverno `verifyImages` policy
(`verify-thaynes43-images.yaml`) that closes exactly this gap for the highest-trust images
(`upgrade-agent`, `upgrade-shepherd`) using a **keyless cosign** attestor — it admits a pod
only if the image carries a cosign signature whose Fulcio certificate identity is that
repo's GitHub Actions workflow. `haynesnetwork` is **not** covered by that policy and its
images are **not** signed. This ADR decides how we sign them and how the cluster verifies
them, resolving the ADR-006 C-04 gap and the release-workflow note at ADR-009:50.

## Decision drivers

1. **No long-lived secret to store or rotate.** A private signing key would be a new
   `COSIGN_PRIVATE_KEY`/`COSIGN_PASSWORD` secret in 1Password + the Actions secret store,
   with its own rotation and leak surface (CLAUDE.md rule 7). We want signing with nothing
   new to guard.
2. **Match the estate.** The existing `haynes-ops` Kyverno policy already verifies **keyless**
   GitHub-OIDC attestors; adding `haynesnetwork` under the same mechanism keeps one verify
   model, not two.
3. **Prove build provenance, not just registry.** The signature must bind the image digest to
   *our* workflow identity so a swapped image on our own repo path is rejected.
4. **Sign in the one place a real image is pushed** — `release-please.yml` on
   `release_created` — and gate the release on a successful in-run verify so an unsignable
   release fails loudly.
5. **Fail open until proven.** Admission-time verification reaches public Sigstore infra
   (Fulcio/Rekor); it must not wedge deploys during a Sigstore outage before we have
   confidence, so enforcement is staged behind an audit phase and a fail-open webhook.

## Considered options

- **Option A (CHOSEN) — Keyless cosign via GitHub Actions OIDC → Fulcio/Rekor.** The runner
  mints a short-lived OIDC token (`id-token: write`); cosign exchanges it for an ephemeral
  Fulcio signing certificate, signs the digest, and records the signature + certificate in
  the public Rekor transparency log. Kyverno admits by matching the certificate's OIDC
  `subject` (the workflow ref) + `issuer`. **No private key exists at rest.**
- **Option B — Key-based cosign with a 1Password-held keypair injected as Actions secrets.**
  Deterministic offline verify (no Sigstore dependency at admission), but adds
  `COSIGN_PRIVATE_KEY` + `COSIGN_PASSWORD` to 1Password and the Actions secret store, with
  rotation, and diverges from the estate's keyless attestor. Rejected: the secret-at-rest and
  rotation burden is exactly what driver 1 rejects, for no benefit the estate needs.
- **Option C — No signing; keep Kyverno in Audit forever.** Rejected: leaves the ADR-006 C-04
  gap permanently open — an image swap on our own path is never rejected, only (at best)
  audited.

## Decision outcome

Chosen option: **Option A — keyless cosign via GitHub OIDC.**

- **Signing (`.github/workflows/release-please.yml`).** After the existing
  `docker/build-push-action@v6` push step (which now carries `id: build`), and only when
  `steps.release.outputs.release_created == 'true'`:
  1. `id-token: write` is added to the top-level `permissions` (alongside `contents`/
     `pull-requests`/`packages: write`) so the runner can mint the OIDC token.
  2. `sigstore/cosign-installer@v3` installs cosign (v2, keyless by default).
  3. `cosign sign --yes ghcr.io/thaynes43/haynesnetwork@${{ steps.build.outputs.digest }}`
     signs **by digest** — the digest signature covers both `:vX.Y.Z` and `:latest`, and is
     exactly what Kyverno verifies at admission. GHCR auth reuses the in-run `docker/login`
     session; cosign pushes the signature to the same registry path.
  4. `cosign verify …@<digest> --certificate-identity-regexp
     '^https://github.com/thaynes43/haynesnetwork/\.github/workflows/'
     --certificate-oidc-issuer https://token.actions.githubusercontent.com` runs as a job
     gate — a verify failure fails the release job.
- **Admission (`haynes-ops` `verify-thaynes43-images.yaml`).** Add a **dedicated `verifyImages`
  rule** (not a second attestor bolted onto the existing rule) scoping
  `ghcr.io/thaynes43/haynesnetwork*`, whose keyless attestor `subject` is
  `https://github.com/thaynes43/haynesnetwork/.github/workflows/*` (this repo — the signer),
  `issuer: https://token.actions.githubusercontent.com`, `rekor.url:
  https://rekor.sigstore.dev`. A **dedicated rule** (Option (a) of the plan) is chosen over a
  shared rule with a second attestor so the enforce flip for `haynesnetwork` is independent of
  the `upgrade-agent`/`upgrade-shepherd` timing.
- **Staged enforcement.** Ship signing + policy coverage with the `haynesnetwork` rule at
  `failureAction: Audit`. Cut a signed release, confirm the Kyverno report shows the signed
  digest **passing** in audit, **then** flip **only that rule** to `failureAction: Enforce` in
  a follow-up `haynes-ops` commit. The switch is one field, per-rule. The webhook stays
  `failurePolicy: Ignore` (fail-open) so a Sigstore outage never wedges deploys. Procedure and
  the exact diff live in OPS-006.
- **No secret.** Keyless needs no `COSIGN_*` key — nothing new in 1Password, the
  `haynesnetwork` ExternalSecret contract (OPS-004 §5), or the Actions secret store.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: resolves ADR-006 C-04 — an image swapped on our own `ghcr.io/thaynes43/haynesnetwork` path is rejected at admission (once enforced) because it lacks a signature carrying our workflow's OIDC identity. |
| C-02 | Good: no signing key at rest — no `COSIGN_PRIVATE_KEY`/`COSIGN_PASSWORD` to store, inject, leak, or rotate (CLAUDE.md rule 7). Fulcio certs are ephemeral; trust roots in the public transparency log. |
| C-03 | Good: uses the same keyless attestor model the `haynes-ops` Kyverno policy already verifies for `upgrade-agent`/`upgrade-shepherd` — one verify mechanism across the estate, not two. |
| C-04 | Bad (load-bearing coupling): the signer identity — the `release-please.yml` workflow ref on **this** repo — is shared config with the `haynes-ops` Kyverno `subject` glob. Renaming/moving the sign step to another workflow file, or moving the repo, **breaks admission** unless the policy `subject` is updated in lockstep (same failure-class as ADR-009 C-05 required-check-name drift). Recorded in OPS-006. |
| C-05 | Neutral/Bad: admission verification depends on public Sigstore infra (Fulcio/Rekor) reachable at admission time (`background: false`). Mitigated by `failurePolicy: Ignore` (fail-open) — a Sigstore outage degrades to unverified admission, never a deploy freeze; the enforce flip is the only failing-closed surface and is a one-field revert. |
| C-06 | Neutral: signing by digest (not tag) means the digest signature covers every tag pointing at it — no need to sign or verify `:latest` separately (OPS-006 open decision #4: digest-only). |
| C-07 | Neutral: `id-token: write` broadens `release-please.yml`'s token scope. It is used only to obtain the Fulcio cert; it does not grant repo write and is scoped to this workflow. |

## More information

- **Resolves** ADR-006 C-04 (`docs/adrs/006-hosting-and-deployment.md`) and fulfills the
  release-workflow signing note at ADR-009:50 (`docs/adrs/009-ci-and-pr-flow.md`). Neither is
  superseded — this is the first signing ADR and completes what both anticipated.
- **Plan:** `.agents/plans/007-cosign-image-signing.md` (PLAN-007). The plan's placeholder
  "ADR-016" is stale — 016 was taken by the Bazarr subtitle Fix and 017 by Plex library
  sharing; this decision landed as **ADR-020** (018/019 reserved for the in-flight
  library-metadata plan). PLAN-007's open decisions #1 (keyless), #2 (stage enforce), #3
  (dedicated rule), #4 (digest-only) are all recorded above.
- **PRD:** R-73 (supply-chain — signed images, cluster admits only signed once enforced).
- **Glossary:** DDD-001 T-59 keyless signing, T-60 Fulcio, T-61 Rekor, T-62
  attestor/subject, T-63 admission verification.
- **Ops:** OPS-004 §1/§1a reconciled to name the sign+verify step and `id-token: write`;
  new OPS-006 is the operator runbook (verify invocation, cross-repo coupling, Audit→Enforce
  switch). Cluster policy: `haynes-ops`
  `kubernetes/main/apps/kyverno/policies/app/verify-thaynes43-images.yaml`.
- **Out of scope:** signing the other `ghcr.io/thaynes43/*` images; SBOM / SLSA provenance
  attestations (`cosign attest`) — a future ADR (noted in OPS-006); SHA-pinning all Actions
  (the workflow follows the repo's floating-major-tag convention today).
