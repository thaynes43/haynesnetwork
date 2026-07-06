# PLAN-001: GATE A — PR flow cutover

- **Status:** Executed 2026-07-03
- **Satisfies:** PRD-001 R-65 / ADR-009

The bootstrap stages (docs suite, scaffold, theme port, db layer, CI, Authentik
provisioning) landed as direct pushes to `main`. This gate ends that mode. This plan's
commit is the last direct push.

## What was applied

Branch protection on `main` via `gh api` (ADR-009 parameters):

- Required status checks, strict (branch must be up to date): contexts exactly
  `lint-and-typecheck`, `test`, `build` — the `e2e` job stays advisory until hardening.
- `required_pull_request_reviews: null` — solo maintainer; CI is the gate.
- `enforce_admins: true` — protection applies to admins too (verified: owner direct push
  rejected); the escape hatch is temporarily flipping this via API, consciously.
- Linear history required; force pushes and deletions blocked.
- Repo merge settings: squash-merge only (merge commits and rebase-merge disabled),
  head branches auto-deleted.

```
gh api -X PUT repos/thaynes43/haynesnetwork/branches/main/protection \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["lint-and-typecheck", "test", "build"]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
```

## Working agreement after this gate

1. Branch `<type>/<slug>` off `main` (`feat/auth-package`, `fix/tile-overflow`, ...).
2. Conventional-commit titles — they drive release-please versioning.
3. Open a PR; the three required checks must pass; squash-merge.
4. Keep branches current with `main` (strict mode rejects stale merges).
5. Docs change in the same PR as the behavior they describe (PROCESS.md).

## Success criteria

- Direct push to `main` is rejected.
- A PR with failing required checks cannot merge; green PR squash-merges cleanly.
