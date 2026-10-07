#!/usr/bin/env bash
# The book-pipeline paths whose changes make the Playwright suite a MERGE GATE (issue #742, ADR-100).
#
# Reads changed file paths on stdin, one per line (renames: list both names). Exits 0 and prints the
# matching paths when at least one is a pipeline path; exits 10 and prints nothing when none is. Any other exit
# status is a crash (bash gives 1 under `set -e`/`set -u`), and e2e.yml fails closed on it: it is never read as
# "not gated" (ADR-102).
# `--self-test` checks the rules below against fixed examples (run it after editing PIPELINE_PREFIXES).
#
# Keep the list NARROW: it is the code whose breakage the unit suites cannot see because the e2e stubs
# drive the real push/sync path end to end (W-06: a red e2e sat on main through five releases).
set -euo pipefail

PIPELINE_PREFIXES=(
  'packages/domain/'
  'packages/sync/'
  'packages/arr/'
  'packages/lazylibrarian/'
  'packages/goodreads/'
  'packages/books/'
  'packages/kapowarr/'
  'packages/downloads/'
  'packages/libretto/'
  'packages/db/'
  'packages/test-utils/'
  'packages/api/src/routers/integrations.ts'
  'packages/api/src/routers/books.ts'
  'packages/api/src/routers/book-fix.ts'
  'apps/web/e2e/'
  'apps/web/playwright.config.ts'
  'apps/web/app/(app)/integrations/'
  '.github/workflows/e2e.yml'
  '.github/workflows/e2e-suite.yml'
  'scripts/e2e-gate-paths.sh'
)

is_pipeline_path() {
  local path=$1 prefix
  # Markdown never reaches the suite (a package README, say), so it never gates (ADR-102).
  [[ $path == *.md ]] && return 1
  for prefix in "${PIPELINE_PREFIXES[@]}"; do
    [[ $path == "$prefix"* ]] && return 0
  done
  return 1
}

if [[ ${1:-} == --self-test ]]; then
  fail=0
  expect() { # expect <yes|no> <path>
    if is_pipeline_path "$2"; then got=yes; else got=no; fi
    if [[ $got != "$1" ]]; then echo "self-test FAIL: $2 expected $1 got $got" >&2; fail=1; fi
  }
  expect yes 'packages/domain/src/books/push.ts'
  expect yes 'packages/sync/src/goodreads-sync.ts'
  expect yes 'packages/lazylibrarian/src/client.ts'
  expect yes 'apps/web/e2e/integrations.spec.ts'
  expect yes 'apps/web/app/(app)/integrations/goodreads/goodreads-client.tsx'
  expect yes 'packages/api/src/routers/integrations.ts'
  expect yes 'packages/api/src/routers/book-fix.ts'
  expect yes 'packages/test-utils/src/harness.ts'
  expect no 'packages/api/src/routers/ledger.ts'
  expect yes 'scripts/e2e-gate-paths.sh'
  expect no 'docs/adrs/100-e2e-gates-the-book-pipeline.md'
  expect no '.agents/HANDOFF.md'
  expect no 'packages/ui/src/button.tsx'
  expect no 'packages/domainx/src/a.ts' # a prefix must end at a directory boundary
  expect no 'apps/web/app/(app)/library/page.tsx'
  expect no 'CHANGELOG.md'
  expect no 'packages/domain/README.md' # Markdown inside a pipeline package does not gate
  exit "$fail"
fi

matched=0
while IFS= read -r path; do
  [[ -n $path ]] || continue
  if is_pipeline_path "$path"; then
    echo "$path"
    matched=1
  fi
done
[[ $matched == 1 ]] && exit 0
exit 10
