# PLAN-075: Agent-owned watch recommendations

- **Status:** Completed
- **Date:** 2026-10-11
- **Completed:** 2026-10-12
- **Delivered:** v0.111.0
- **Depends on:** completed Watch Companion and connector plans
- **Docs:** ADR-107, DESIGN-054; PRD-001 R-242/R-244/R-245/R-261

1. Record docs-first contracts and amend glossary/bounded context.
2. Remove membership scoring/pagination bias; expose cached scopes.
3. Add factual batch checks/context; preserve isolation and writes.
4. Validate focused tests/required CI, address available review findings, squash-merge.
5. Release/deploy through haynes-ops GitOps; verify read-only live MCP results.
6. Commit completion evidence and move the plan to completed.

## Delivery evidence

- Feature [#882](https://github.com/thaynes43/haynesnetwork/pull/882), release
  [#881](https://github.com/thaynes43/haynesnetwork/pull/881) and GitOps deployment
  [haynes-ops #3828](https://github.com/thaynes43/haynes-ops/pull/3828) merged after required checks.
  The verified release image is live on three app replicas and all 24 consumer CronJobs.
- Read-only deployed checks verified eleven bounded tools, factual context, ordered external
  candidates including three outside Plex, cache-scope disclosure and no history/watchlist writes.
- Voice source [hass-sandbox #241](https://github.com/thaynes43/hass-sandbox/pull/241) and guarded
  helper [#242](https://github.com/thaynes43/hass-sandbox/pull/242) merged. Four prompt holders use
  the approved block; all original locations, unrelated data and metadata are preserved. Phone's
  active Assist-only pipeline is unchanged.
- Native restoration [haynes-ops #3829](https://github.com/thaynes43/haynes-ops/pull/3829) and
  cleanup [#3830](https://github.com/thaynes43/haynes-ops/pull/3830) merged and reconciled. The
  temporary entry, commands, ConfigMap and mount are absent. Six accepted serial voice samples
  observed no added median overhead; the sample size and rejected pre-sample attempt are recorded.

Full release/signature, CI, live and voice evidence:
[2026-10-12 context](../../context/2026-10-12-agent-owned-watch-recommendations.md).

CPU constraint: no burners, stress tools or wide parallel/looped tests. Run tests serially under
`nice -n 19`; required CI provides broad validation.
