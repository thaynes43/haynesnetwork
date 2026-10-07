#!/usr/bin/env bash
# Which changed paths are CODE, i.e. can change what lint, typecheck, the unit tests, the build or the image see
# (ADR-102). A pull request with no code path skips those jobs in ci.yml; the required checks still report, as
# skipped, which satisfies branch protection.
#
# Reads changed file paths on stdin, one per line (renames: list both names). Exits 0 and prints the code paths
# when at least one path is code; exits 1 and prints nothing when every path is docs-only.
# `--image` instead prints the paths that can break the Docker build without breaking `pnpm build` (is_image_path),
# with the same exit codes: only those PRs, and the release PR, run ci.yml's `build-image`.
# `--self-test` checks the rules below against fixed examples (run it after editing either rule).
#
# The rule is an ALLOW-list of docs-only paths: anything not named here is code, so a new kind of file is checked
# by default. A path is docs-only when nothing in CI reads it:
#   - any Markdown file (`*.md`), at any depth: READMEs, CLAUDE.md, CHANGELOG.md, docs, agent notes. ESLint and
#     tsc never read Markdown and no test or app code imports one (checked 2026-10-07);
#   - anything under `docs/` (designs, runbooks and their JSON/CSS payloads; nothing in apps/ or packages/ reads them,
#     and `.dockerignore` keeps `docs` out of the image);
#   - anything under `.agents/` EXCEPT data files (`*.yaml`, `*.yml`, `*.json`): the unit tests parse
#     `.agents/owed-checks.yaml` and `.agents/books-census-holds.yaml`, so those are code;
#   - `LICENSE`, the VS Code workspace file and `.gitkeep` placeholders.
set -euo pipefail

is_docs_only() {
  local path=$1
  case $path in
    .agents/*.yaml | .agents/*.yml | .agents/*.json) return 1 ;;
    *.md) return 0 ;;
    docs/*) return 0 ;;
    .agents/*) return 0 ;;
    LICENSE | haynesnetwork.code-workspace) return 0 ;;
    .gitkeep | */.gitkeep) return 0 ;;
  esac
  return 1
}

# The Docker build fails where `pnpm build` passes only when the image's own inputs change: the Dockerfile and
# .dockerignore, the install inputs (every package.json, since the deps stage copies each one by name and a new
# package without its COPY line fails there; the lockfile, the workspace file, .npmrc), Next's config, and this job.
is_image_path() {
  case $1 in
    Dockerfile | .dockerignore | package.json | pnpm-lock.yaml | pnpm-workspace.yaml | .npmrc) return 0 ;;
    apps/*/package.json | packages/*/package.json) return 0 ;;
    apps/web/next.config.*) return 0 ;;
    .github/workflows/ci.yml) return 0 ;;
  esac
  return 1
}

if [[ ${1:-} == --self-test ]]; then
  fail=0
  expect() { # expect <code|docs> <path>
    if is_docs_only "$2"; then got=docs; else got=code; fi
    if [[ $got != "$1" ]]; then echo "self-test FAIL: $2 expected $1 got $got" >&2; fail=1; fi
  }
  expect docs '.agents/HANDOFF.md'
  expect docs '.agents/context/2026-10-06-books-rollout-adversarial-review.md'
  expect docs '.agents/context/ll-library-audit/audit.py'
  expect docs '.agents/plans/.gitkeep'
  expect docs 'docs/adrs/102-ci-minutes-budget.md'
  expect docs 'docs/ops/authentik-apply-seed/payloads/brand-c.json'
  expect docs 'CLAUDE.md'
  expect docs 'README.md'
  expect docs 'CHANGELOG.md'
  expect docs 'LICENSE'
  expect docs 'packages/domain/README.md'
  expect docs 'apps/web/README.md'
  expect code '.agents/owed-checks.yaml'
  expect code '.agents/books-census-holds.yaml'
  expect code 'packages/domain/src/books/push.ts'
  expect code 'apps/web/app/(app)/library/page.tsx'
  expect code 'apps/web/e2e/integrations.spec.ts'
  expect code 'scripts/ci-code-paths.sh'
  expect code '.github/workflows/ci.yml'
  expect code 'pnpm-lock.yaml'
  expect code 'package.json'
  expect code 'Dockerfile'
  expect code '.dockerignore'
  expect code '.env.example'
  expect code '.release-please-manifest.json'
  expect code 'release-please-config.json'
  expect code 'docsx/a.md.ts' # `*.md` means the extension, and `docs/` is a directory boundary
  expect_image() { # expect_image <yes|no> <path>
    if is_image_path "$2"; then got=yes; else got=no; fi
    if [[ $got != "$1" ]]; then echo "self-test FAIL (image): $2 expected $1 got $got" >&2; fail=1; fi
  }
  expect_image yes 'Dockerfile'
  expect_image yes 'packages/newpkg/package.json'
  expect_image yes 'apps/web/package.json'
  expect_image yes 'package.json'
  expect_image yes 'pnpm-lock.yaml'
  expect_image yes 'apps/web/next.config.ts'
  expect_image no 'packages/domain/src/books/push.ts'
  expect_image no 'packages/domain/src/package.json.ts'
  expect_image no 'apps/web/app/(app)/library/page.tsx'
  exit "$fail"
fi

if [[ ${1:-} == --image ]]; then
  matched=0
  while IFS= read -r path; do
    [[ -n $path ]] || continue
    if is_image_path "$path"; then
      echo "$path"
      matched=1
    fi
  done
  [[ $matched == 1 ]]
  exit
fi

matched=0
while IFS= read -r path; do
  [[ -n $path ]] || continue
  if ! is_docs_only "$path"; then
    echo "$path"
    matched=1
  fi
done
[[ $matched == 1 ]]
