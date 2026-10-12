# PLAN-075: Agent-owned watch recommendations

- **Status:** In progress
- **Date:** 2026-10-11
- **Depends on:** completed Watch Companion and connector plans
- **Docs:** ADR-107, DESIGN-054; PRD-001 R-242/R-244/R-245/R-261

1. Record docs-first contracts and amend glossary/bounded context.
2. Remove membership scoring/pagination bias; expose cached scopes.
3. Add factual batch checks/context; preserve isolation and writes.
4. Validate focused tests/required CI, address available review findings, squash-merge.
5. Release/deploy through haynes-ops GitOps; verify read-only live MCP results.
6. Commit completion evidence and move the plan to completed.

CPU constraint: no burners, stress tools or wide parallel/looped tests. Run tests serially under
`nice -n 19`; required CI provides broad validation.
