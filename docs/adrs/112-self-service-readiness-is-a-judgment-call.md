# ADR-112: Self-service readiness is the owner's judgment, not a count

- **Status:** Accepted (owner clarification, 2026-10-12)
- **Date:** 2026-10-12
- **Deciders:** Tom Haynes
- **Amends:** [ADR-111](111-seerr-issue-bridge-and-self-service-readiness.md) C-05 (the readiness gate), which this ADR
  supersedes. ADR-111's other consequences stand.
- **Design:** [DESIGN-055](../designs/055-self-service-media-repair.md) D-12, Q-04 and Q-09. Plan: PLAN-077 P3 and P8.

## Context and problem statement

ADR-111 C-05 made "fix it yourself on haynesnetwork.com" the rule only after a counted gate: an agent replays Cases A,
B and C as a non-admin account, then the next 3 real Seerr issues are Self-Served with no staff help (DESIGN-055 Q-04).
Implementing it needed a nightly outcome classifier, a streak, a replay checklist and a second question (Q-09: does an
Unfixable issue restart the count). At about 1.3 issues a month, three consecutive clean outcomes is also a noisy
signal: one odd report resets months of evidence while saying nothing about whether the platform works.

On 2026-10-12 the owner clarified that readiness is not an exact science.

## Decision

The owner's clarification, 2026-10-12: "The gate is a judgment call, not a count. The intention is to keep building haynesnetwork.com until it can handle the kinds of problems people actually report, then steer users to fix things themselves instead of staff fixing them. Working practice: every new Seerr issue is worked through haynesnetwork.com's self-service tools first, as a user would. When a tool fixes it, the reply teaches the user that tool. When no tool can, staff fix it by hand and the missing capability is added to the plan. The owner decides when coverage is good enough to make self-service the default."

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | **Supersedes ADR-111 C-05.** There is no counted gate: no replay requirement, no streak, no Self-Served, Staff-Assisted or Unfixable classification, no `outcome` column, `ticket_outcomes` table, nightly digest line or readiness view. DESIGN-055 Q-09 is moot. |
| C-02 | **Working practice.** Every new Seerr issue is worked through haynesnetwork.com's self-service tools first, as a user would. When a tool fixes it, the reply teaches the user that tool. When none can, staff fix it by hand, note it on the issue in `/admin`, and the missing capability is added to the plan. |
| C-03 | **What stays.** The Seerr Issue mirror, the title-page banner, the `/r/seerr/<id>` link, the comment and resolve writes (ADR-111 C-01..C-04) and an `/admin` Seerr issues list showing each issue, its linked repairs (which tool fixed what, read from the app's own records) and a staff note. |
| C-04 | **The rule.** The owner decides when coverage is good enough to make self-service the default. ADR-111's Q-05 ruling is what "default" then means: Seerr issue filing stays open, every new issue gets the fix-it-yourself comment, and staff step in only after a self-service attempt has failed or when no remedy fits. |
| C-05 | Good: the program is steered by real reports and the owner's judgment, and no machinery exists only to compute a number. |
| C-06 | Bad: there is no automatic signal that coverage is good enough. The owner reads the `/admin` list and the plan's growth of missing capabilities instead. |

## More information

- PRD R-271 drops from Must to Should: the Must was the counted gate, and what remains (a lightweight admin list and a working practice) is not load-bearing. US-19 and AC-44 are reworded to match; glossary T-312 and T-313 are redefined.
- Precedent for amending an Accepted ADR: ADR-007 amended by ADR-016 (an `Amended by` line on the old ADR, the new
  decision in a new ADR).
