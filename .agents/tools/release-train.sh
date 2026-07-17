#!/bin/bash
# Release-train watcher v3 (dance-aware): $1 = feature PR number.
# feature merge → release PR recompute → DANCE if checks never start → merge → artifact pair.
set -u
FPR="${1:?feature PR number}"
cd /home/dev/work/about-page || { echo "FAIL: worktree missing"; exit 1; }
R=thaynes43/haynesnetwork

while :; do
  export GH_TOKEN="$(cat /creds/gh_token)"
  s=$(gh pr view "$FPR" --repo "$R" --json state,mergeStateStatus -q '.state + " " + .mergeStateStatus' 2>/dev/null || echo ERR)
  st=${s%% *}; ms=${s##* }
  [ "$st" = MERGED ] && { echo "EVENT: PR #$FPR merged"; break; }
  [ "$st" = CLOSED ] && { echo "FAIL: PR #$FPR closed without merge"; exit 1; }
  if [ "$ms" = BEHIND ]; then
    echo "EVENT: PR #$FPR is BEHIND — updating the branch"
    gh api -X PUT "repos/$R/pulls/$FPR/update-branch" >/dev/null 2>&1 || echo "WARN: update-branch API refused — manual rebase needed"
  fi
  bad=$(gh pr checks "$FPR" --repo "$R" 2>/dev/null | grep -v $'^e2e\t' | grep -c $'\tfail' || true)
  [ "${bad:-0}" -gt 0 ] && { echo "FAIL: PR #$FPR red:"; gh pr checks "$FPR" --repo "$R" | grep $'\tfail'; exit 1; }
  sleep 45
done

base=$(git -C /home/dev/work/about-page describe --tags --abbrev=0 origin/main 2>/dev/null || echo "")
rp=""; ver=""
for i in $(seq 1 30); do
  export GH_TOKEN="$(cat /creds/gh_token)"
  line=$(gh pr list --repo "$R" --state open --json number,title -q '[.[]|select(.title|startswith("chore(main): release"))][0] | "\(.number) \(.title)"' 2>/dev/null)
  n=${line%% *}
  v=$(echo "$line" | grep -o '[0-9][0-9.]*$')
  # accept the release PR only once release-please has run AFTER the feature merge
  if [ -n "$n" ] && [ "$n" != null ] && [ -n "$v" ]; then rp=$n; ver=$v; fi
  # heuristic: give release-please 60s after merge before trusting the PR content
  [ -n "$rp" ] && [ "$i" -ge 3 ] && break
  sleep 30
done
[ -z "$rp" ] && { echo "FAIL: no release PR within 15m of merge"; exit 1; }
echo "EVENT: release PR #$rp at v$ver; arming auto-merge"
gh pr merge "$rp" --repo "$R" --auto --squash >/dev/null 2>&1 || true

danced=0
while :; do
  export GH_TOKEN="$(cat /creds/gh_token)"
  s=$(gh pr view "$rp" --repo "$R" --json state -q .state 2>/dev/null || echo ERR)
  if [ "$s" = MERGED ]; then
    ver=$(gh pr view "$rp" --repo "$R" --json title -q .title | grep -o '[0-9][0-9.]*$')
    echo "EVENT: release PR #$rp merged, v$ver tagging"
    break
  fi
  [ "$s" = CLOSED ] && { echo "FAIL: release PR #$rp closed"; exit 1; }
  checks=$(gh pr checks "$rp" --repo "$R" 2>&1)
  if echo "$checks" | grep -q "no checks reported"; then
    if [ "$danced" -eq 0 ]; then
      echo "EVENT: no checks on the release branch (GITHUB_TOKEN push) — doing the close/reopen dance"
      gh pr close "$rp" --repo "$R" >/dev/null 2>&1
      gh pr reopen "$rp" --repo "$R" >/dev/null 2>&1
      gh pr merge "$rp" --repo "$R" --auto --squash >/dev/null 2>&1 || true
      danced=1
    fi
  else
    bad=$(echo "$checks" | grep -v $'^e2e\t' | grep -c $'\tfail' || true)
    [ "${bad:-0}" -gt 0 ] && { echo "FAIL: release PR #$rp red:"; echo "$checks" | grep $'\tfail'; exit 1; }
  fi
  sleep 60
done

ACC="application/vnd.oci.image.manifest.v1+json,application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.v2+json"
for i in $(seq 1 60); do
  TOK=$(curl -s "https://ghcr.io/token?scope=repository:${R}:pull" | jq -r .token)
  dg=$(curl -sfI -H "Authorization: Bearer $TOK" -H "Accept: $ACC" \
    "https://ghcr.io/v2/${R}/manifests/v${ver}" 2>/dev/null | tr -d '\r' | awk -F': ' 'tolower($1)=="docker-content-digest"{print $2}')
  if [ -n "$dg" ]; then
    sig="sha256-${dg#sha256:}.sig"
    if curl -sf -o /dev/null -H "Authorization: Bearer $TOK" -H "Accept: application/vnd.oci.image.manifest.v1+json" \
      "https://ghcr.io/v2/${R}/manifests/${sig}" 2>/dev/null; then
      echo "EVENT: artifact pair ready, v${ver} image ${dg} + .sig present. Bump haynes-ops now."
      exit 0
    fi
  fi
  sleep 30
done
echo "FAIL: artifact pair for v${ver} not complete within 30m"
exit 1
