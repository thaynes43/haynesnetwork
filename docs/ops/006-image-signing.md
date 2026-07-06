# OPS-006: Image signing — keyless cosign + Kyverno admission

- **Status:** Accepted (signing live in `release-please.yml` as of PLAN-007; the Kyverno
  `haynesnetwork` rule + enforce flip are **deploy-time steps in `haynes-ops`**, staged below)
- **Implements:** ADR-020 (keyless cosign via GitHub OIDC), resolves ADR-006 C-04
- **Sibling repo:** `haynes-ops`
  `kubernetes/main/apps/kyverno/policies/app/verify-thaynes43-images.yaml`

How `haynesnetwork` images are signed, how to verify one, the cross-repo coupling that makes
admission work, and the **Audit → Enforce** switch. Secret *values* never appear here — keyless
signing has **no secret** (that is the point). CLAUDE.md rule 7.

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

## 4. DEPLOY-TIME — extend the Kyverno policy (`haynes-ops`, NOT applied by this repo)

> This is a **manual-merge** area in `haynes-ops` — do **not** add `kyverno/**` to any autoMerge
> glob (`…/kyverno/kyverno/app/ocirepository.yaml`). Follow `haynes-ops`
> `.agents/runbooks/kyverno-enforce-verify.md`.

Edit `kubernetes/main/apps/kyverno/policies/app/verify-thaynes43-images.yaml`. Add a **dedicated**
`verifyImages` rule for `haynesnetwork` (ADR-020: a separate rule, not a second attestor on the
existing one, so its enforce flip is independent of upgrade-agent/shepherd). Land it at
**`failureAction: Audit`** first.

### 4a. Stage 1 diff — add coverage (Audit)

```diff
       verifyImages:
         - imageReferences:
             - "ghcr.io/thaynes43/upgrade-agent*"
             - "ghcr.io/thaynes43/upgrade-shepherd*"
           failureAction: Audit
           mutateDigest: false   # we pin tag@digest in the manifests; don't rewrite
           verifyDigest: false
           required: true
           attestors:
             - count: 1
               entries:
                 - keyless:
                     # The GitHub Actions OIDC identity of our build workflows on main.
                     subject: "https://github.com/thaynes43/haynes-ops/.github/workflows/*"
                     issuer: "https://token.actions.githubusercontent.com"
                     rekor:
                       url: https://rekor.sigstore.dev
+        # haynesnetwork: signed by ITS OWN repo's release-please.yml OIDC identity — a
+        # dedicated rule so its Audit->Enforce flip is independent (ADR-020 / hnet OPS-006).
+        - imageReferences:
+            - "ghcr.io/thaynes43/haynesnetwork*"
+          failureAction: Audit
+          mutateDigest: false
+          verifyDigest: false
+          required: true
+          attestors:
+            - count: 1
+              entries:
+                - keyless:
+                    subject: "https://github.com/thaynes43/haynesnetwork/.github/workflows/*"
+                    issuer: "https://token.actions.githubusercontent.com"
+                    rekor:
+                      url: https://rekor.sigstore.dev
```

Commit + push to `haynes-ops` `main`, then reconcile (OPS-004 §2 pattern):

```bash
flux reconcile source git haynes-ops -n flux-system
flux reconcile kustomization kyverno -n flux-system --with-source   # or the policy's kustomization
```

### 4b. Confirm the signed digest PASSES in Audit

Deploy the signed `vX.Y.Z` to staging (OPS-004 §2), then read the report — the `haynesnetwork`
pod's `verifyImages` result must be **pass**, and zero admission blocks:

```bash
# Policy report for the frontend namespace — look for verify-thaynes43-images = pass on the haynesnetwork pod:
kubectl -n frontend get policyreport -o wide
kubectl -n frontend get policyreport -o json \
  | jq -r '.items[].results[] | select(.policy=="verify-thaynes43-images") | "\(.result)\t\(.resources[0].name // .subjects)"'

# No enforce-block happened (Audit never blocks, but this proves the rule is evaluating):
kubectl logs -n kyverno -l app.kubernetes.io/component=admission-controller --since=1h \
  | grep -i haynesnetwork | grep -iE 'verifyImages|signature' | tail
```

`fail` here means the signature/identity didn't match — **stop**, do not flip Enforce; re-check
§2 verify and §3 coupling.

### 4c. Stage 2 diff — flip Enforce (one field, that rule only)

Once §4b shows pass, change **only the `haynesnetwork` rule**:

```diff
         - imageReferences:
             - "ghcr.io/thaynes43/haynesnetwork*"
-          failureAction: Audit
+          failureAction: Enforce
```

Commit + reconcile as in §4a. The webhook stays `failurePolicy: Ignore` (fail-open) — a Sigstore
outage degrades to unverified admission, never a deploy freeze (ADR-020 C-05).

## 5. Prove the guard bites (after Enforce)

```bash
# 5a. The signed digest is still ADMITTED:
kubectl -n frontend rollout status deploy/haynesnetwork

# 5b. An UNSIGNED image on our path is DENIED. Use a throwaway namespace + an unsigned
#     ghcr.io/thaynes43/haynesnetwork-path reference (e.g. an old pre-signing tag), then clean up:
kubectl create ns cosign-probe
kubectl -n cosign-probe run probe --image=ghcr.io/thaynes43/haynesnetwork:<unsigned-tag> --restart=Never
#   → expect: admission DENIED naming policy `verify-thaynes43-images`.
kubectl delete ns cosign-probe
```

## 6. Rollback

- **Wrongly denied a good image** → flip the `haynesnetwork` rule back to `failureAction: Audit`
  in `haynes-ops` and reconcile (single-field revert). Fail-open (`failurePolicy: Ignore`) means
  a Sigstore outage never wedged you — enforce is the only failing-closed surface.
- **Signing itself** → revert the `release-please.yml` commit; publish returns to unsigned
  (harmless while Kyverno is Audit; would be denied under Enforce — so flip that rule to Audit
  too if you must ship unsigned).
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
