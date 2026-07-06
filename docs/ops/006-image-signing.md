# OPS-006: Image signing — keyless cosign + Kyverno admission

- **Status:** Accepted — **shipped & live-validated 2026-07-06** (v0.7.0, the first signed
  release). Signing is live in `release-please.yml` (PLAN-007); admission **Enforce** is live in
  `haynes-ops` as the dedicated ClusterPolicy `verify-haynesnetwork-images`.
- **Implements:** ADR-020 (keyless cosign via GitHub OIDC), resolves ADR-006 C-04
- **Sibling repo:** `haynes-ops`
  `kubernetes/main/apps/kyverno/policies/app/verify-haynesnetwork-images.yaml`

How `haynesnetwork` images are signed, how to verify one, the cross-repo coupling that makes
admission work, and how the shipped **Enforce** policy was live-validated. Secret *values* never
appear here — keyless signing has **no secret** (that is the point). CLAUDE.md rule 7.

## 0. What happens, in one breath

The release-please run that publishes `vX.Y.Z` also **signs it, keyless**: no private key
exists anywhere. GitHub Actions mints a short-lived OIDC token (`id-token: write`); cosign
trades it for an ephemeral **Fulcio** certificate bound to *this repo's workflow ref*, signs
the image **digest**, and records the signature + cert in the public **Rekor** transparency
log. The cluster's Kyverno policy admits a `haynesnetwork` pod only if its image digest carries
a signature whose Fulcio cert identity is our workflow — proving CI built it, not an attacker who
swapped a tag on our own repo path (the ADR-006 C-04 gap).

## 1. The signing step (this repo — already shipped)

`.github/workflows/release-please.yml`, all gated on `steps.release.outputs.release_created == 'true'`:

- `permissions:` includes **`id-token: write`** (plus `contents`/`pull-requests`/`packages: write`).
- `docker/build-push-action@v6` carries `id: build` → exposes `steps.build.outputs.digest`.
- `sigstore/cosign-installer@v3` installs cosign v2 (keyless by default).
- `cosign sign --yes ghcr.io/thaynes43/haynesnetwork@${{ steps.build.outputs.digest }}` —
  **sign by digest**, never by tag. The digest signature covers `:vX.Y.Z` **and** `:latest`.
- `cosign verify …@<digest> --certificate-identity-regexp
  '^https://github.com/thaynes43/haynesnetwork/\.github/workflows/'
  --certificate-oidc-issuer https://token.actions.githubusercontent.com` — an in-run **gate**;
  a verify failure fails the release job.

GHCR auth reuses the run's `docker/login-action@v3` session (`GITHUB_TOKEN`, `packages: write`);
cosign pushes the `.sig`/cert to the same registry path. **No `COSIGN_*` secret**, nothing in
1Password or the `haynesnetwork` ExternalSecret (OPS-004 §5).

## 2. Verify a signed image (run from any shell with cosign)

```bash
cosign verify ghcr.io/thaynes43/haynesnetwork:vX.Y.Z \
  --certificate-identity-regexp '^https://github.com/thaynes43/haynesnetwork/\.github/workflows/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

- **Identity** (`--certificate-identity-regexp`) = the signer: this repo's `release-please.yml`
  workflow ref. **Issuer** = GitHub's OIDC provider. Rekor defaults to the public
  `https://rekor.sigstore.dev`.
- A pass prints the verified signature payload; a non-zero exit = no signature, wrong identity,
  or wrong issuer. This is the **same assertion Kyverno makes at admission** — if this passes,
  the enforced policy will admit the digest.
- Digest-only is intentional (ADR-020 C-06 / open-decision #4): `:latest` is **not** verified
  separately — its digest is the signed one.

## 3. Cross-repo coupling — the load-bearing config (ADR-020 C-04)

The signer identity is shared config across **two repos**:

| Where | Value |
|-------|-------|
| Signer (this repo) | `release-please.yml` workflow ref, `…/haynesnetwork/.github/workflows/…` |
| Verifier (`haynes-ops`) | Kyverno attestor `subject: https://github.com/thaynes43/haynesnetwork/.github/workflows/*` |

**Renaming `release-please.yml`, moving the sign step to another workflow, or moving the repo
breaks admission** unless the Kyverno `subject` glob is updated in lockstep — same failure-class
as ADR-009 C-05 (required-check-name drift). If you change either side, change both in the same
change window and re-run §5's verify.

## 4. Admission enforcement — the dedicated ClusterPolicy (`haynes-ops`, shipped & live)

> This is a **manual-merge** area in `haynes-ops` — do **not** add `kyverno/**` to any autoMerge
> glob (`…/kyverno/kyverno/app/ocirepository.yaml`). Follow `haynes-ops`
> `.agents/runbooks/kyverno-enforce-verify.md`.

`haynesnetwork` verification is its **own ClusterPolicy**, `verify-haynesnetwork-images`
(`kubernetes/main/apps/kyverno/policies/app/verify-haynesnetwork-images.yaml`, wired into that
dir's `kustomization.yaml`) — **not** a second `verifyImages` entry or attestor on the shared
`verify-thaynes43-images` policy (which stays Audit for upgrade-agent/shepherd). It ships at
**spec-level `validationFailureAction: Enforce`** (plus entry-level `failureAction: Enforce`),
`background: false`, and a fail-open webhook (`failurePolicy: Ignore`). See §4b for *why* it is a
dedicated policy — that is the finding of the day.

### 4a. The shipped policy (live in the cluster, verbatim)

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: verify-haynesnetwork-images
spec:
  background: false
  validationFailureAction: Enforce
  webhookConfiguration:
    failurePolicy: Ignore
  rules:
    - name: verify-haynesnetwork
      match:
        any:
          - resources:
              kinds:
                - Pod
      verifyImages:
        - imageReferences:
            - "ghcr.io/thaynes43/haynesnetwork*"
          failureAction: Enforce
          mutateDigest: false
          verifyDigest: false
          required: true
          attestors:
            - count: 1
              entries:
                - keyless:
                    subject: "https://github.com/thaynes43/haynesnetwork/.github/workflows/*"
                    issuer: "https://token.actions.githubusercontent.com"
                    rekor:
                      url: https://rekor.sigstore.dev
```

Land/change it manually, then reconcile (OPS-004 §2 pattern):

```bash
flux reconcile source git haynes-ops -n flux-system
flux reconcile kustomization kyverno -n flux-system --with-source
```

### 4b. Why a dedicated policy — the `validationFailureAction`-override gotcha (finding, 2026-07-06)

The first cut of this coverage was a *nested* `verifyImages` entry on the shared
`verify-thaynes43-images` policy carrying only entry-level `failureAction: Enforce`. **It did not
enforce.** On **Kyverno v1.18.1** the server defaults the shared policy's *spec-level*
`validationFailureAction` to **`Audit`**, and that spec-level `Audit` **overrides** the
per-`verifyImages`-entry `failureAction: Enforce` — an unsigned image was **admitted with only a
warning**. A standalone ClusterPolicy that sets **spec-level `validationFailureAction: Enforce`**
is unambiguous, and it keeps `haynesnetwork`'s enforce decision independent of the still-Audit
upgrade-agent/shepherd coverage. (Kept here as the gotcha; the policy header comment records it too.)

### 4c. Confirm the signed digest PASSES (PolicyReport)

The signed `vX.Y.Z` deploy produces a **pass** in the frontend namespace PolicyReport — for a
Deployment the autogen rule is what evaluates:

```bash
kubectl -n frontend get policyreport -o wide
kubectl -n frontend get policyreport -o json \
  | jq -r '.items[].results[]
           | select(.policy=="verify-haynesnetwork-images")
           | "\(.rule)\t\(.result)\t\(.message)"'
# → autogen-verify-haynesnetwork   pass   verified image signatures
```

A `fail`/`warn` here means the signature or identity didn't match — re-check §2 verify and §3
coupling before assuming the policy is at fault.

## 5. Prove the guard bites — live-validated 2026-07-06 (v0.7.0)

All four checks passed against the shipped Enforce policy:

```bash
# 5a. The signed v0.7.0 image is ADMITTED — a bare pod on the signed digest comes up:
kubectl -n frontend run signed-probe \
  --image=ghcr.io/thaynes43/haynesnetwork:v0.7.0 --restart=Never   # → admitted
kubectl -n frontend delete pod signed-probe

# 5b. An UNSIGNED image on our path is DENIED — for BOTH a bare Pod AND a Deployment:
kubectl create ns cosign-probe
kubectl -n cosign-probe run probe \
  --image=ghcr.io/thaynes43/haynesnetwork:v0.6.1 --restart=Never   # pre-signing tag, unsigned
#   → Error … admission webhook "mutate.kyverno.svc-ignore" denied the request:
#     … blocked due to the following policies … verify-haynesnetwork-images
kubectl -n cosign-probe create deployment probe-deploy \
  --image=ghcr.io/thaynes43/haynesnetwork:v0.6.1
#   → the Deployment is rejected outright by the same
#     admission webhook "mutate.kyverno.svc-ignore" denied the request … blocked …
#     verify-haynesnetwork-images (autogen rule) — no pod is ever admitted
kubectl delete ns cosign-probe

# 5c. Production is ADMITTED and healthy on the signed digest:
kubectl -n frontend rollout status deploy/haynesnetwork   # → successfully rolled out
```

> **Caveat — Enforce denies on a transient verify failure.** Verification reaches the registry +
> Sigstore *at admission*. A transient outage there (observed once:
> `failed to verify image … Get "https://ghcr.io/v2/": context canceled`) makes Enforce **deny
> that one admission** — verification failing closed, which is *distinct* from
> `failurePolicy: Ignore` (that only fails **open** when the **webhook itself** is unreachable).
> The owning controller retries and self-heals — the ReplicaSet/Job simply re-creates the pod — so
> a blip does not wedge a rollout. **Rollbacks must target a signed tag (v0.7.0+): pre-signing tags
> (≤v0.6.1) are now rejected by Enforce.** Break-glass = revert the policy commit in `haynes-ops`
> (see §6).

## 6. Rollback

- **Wrongly denying a good image / need to ship an unsigned tag** → **revert the policy commit**
  in `haynes-ops` (drop `verify-haynesnetwork-images` from the kustomization, or flip its
  spec-level `validationFailureAction` to `Audit`) and reconcile. With a dedicated policy this is
  the whole break-glass — there is no shared rule to untangle.
- **A transient Sigstore/registry blip** is *not* a rollback trigger — the controller re-creates
  the pod and the retry verifies (see the §5 caveat). `failurePolicy: Ignore` additionally fails
  open if the webhook itself is down.
- **Signing itself** → revert the `release-please.yml` commit; publish returns to unsigned. That
  is now **deploy-affecting**: an unsigned image is **denied** under Enforce, so flip the policy to
  Audit (above) in the same window if you must ship unsigned.
- **No secret to unwind** (keyless).

## 7. Out of scope / future

- Signing the other `ghcr.io/thaynes43/*` images — the policy header comment tracks those
  separately (appdaemon is next, in hass-sandbox).
- **SBOM / SLSA provenance attestations** (`cosign attest`) — signing only for now; a future ADR.
- SHA-pinning every Action (the workflow follows the repo's floating-major-tag convention today).

## Related

- ADR-020 (the decision), OPS-004 (deploy runbook — §1 sign step, §1a verify-before-deploy).
- `haynes-ops` `.agents/runbooks/kyverno-enforce-verify.md` (the estate's Audit→Enforce
  discipline + admission-block queries).
