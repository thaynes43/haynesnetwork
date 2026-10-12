# ADR-111: Seerr issues bridge to self-service, and a readiness gate decides when fixing it yourself becomes the rule

- **Status:** Proposed
- **Date:** 2026-10-12
- **Deciders:** Tom Haynes (owner goal, 2026-10-12: steer Plex users away from filing Seerr issues for staff and toward
  fixing problems themselves, and make that a hard rule only once the platform reliably fixes what they report).
  Drafted by Opus 5.5. Open owner questions: DESIGN-055 Q-02 (Seerr writes), Q-04 (the gate's threshold), Q-05 (what
  the rule does once the gate passes).
- **Design:** [DESIGN-055](../designs/055-self-service-media-repair.md) D-10..D-12. Plan: PLAN-077 phases P3, P7, P8.
- **Amends (when its writer lands):** hard rule 4's Seerr write list (CLAUDE.md) gains the issue comment and the
  issue resolve (C-03), beside ADR-093 C-11's watchlist enrollment and `animeTags` preflight.

## Context and problem statement

Seerr is where the household reports problems. Read-only facts, 2026-10-12 (Seerr 3.5.0):

- 4 issues since 2026-07-11, all resolved by staff (3 video, 1 other). Issues 2, 3 and 4 are the three cases of
  ADR-109. Two people filed the last three.
- 18 Seerr users, all Plex accounts. The 17 who are not the admin hold exactly Seerr's default permissions, which
  include `MANAGE_ISSUES`, so any of them can file, resolve or delete any issue.
- 10 of the 18 have a haynesnetwork.com account (matched by email); both recent reporters do not. A first sign-in with
  Plex creates the account in the Default role with no approval gate (R-03), and Authentik admits any Plex account
  that shares one of our servers.
- haynesnetwork reads no Seerr issues. Seerr's webhook to the app is enabled but sends media events only (types
  bitmask 204: approved, available, declined, auto-approved), never issue events.
- The app's Seerr key acts as Seerr user 1, the owner's admin account, unless a request names another user in
  `X-API-User` (upstream `server/middleware/auth.ts`).
- haynesnetwork's own Helpdesk has 1 ticket ever (a rejected test); Fix ran twice in 90 days.

So the steering channel has to start where people already report, reach people who have no account, and say plainly
when the platform can handle a report. Making "fix it yourself" a rule before the platform can fix the reported kinds
would only move the work back to staff with an extra step.

## Decision drivers

- Meet reporters in Seerr; do not ask them to learn a new intake first.
- Seerr is the source of truth for its issues (the *arr doctrine, applied): the app mirrors, it does not own them.
- Any Seerr write is confined to `packages/domain`, audited, idempotent, and never posted as the owner's account
  unless he says so.
- The rule is earned by evidence, and the evidence is counted the same way every time.

## Considered options

1. **Status quo.** Staff read Seerr issues and fix by hand.
2. **Turn each Seerr issue into a Helpdesk ticket.** Two records of one report, and the ticket flow still ends at staff.
3. **A Seerr Issue mirror** (read-only, near real time) shown on the title page and in admin, with deep links into the
   Repair Guide, an optional comment and resolve through a dedicated Seerr user, and a measured readiness gate.
4. **Switch off issue reporting in Seerr now** and point people to haynesnetwork.com. Premature: until ADR-109 ships,
   the platform cannot fix what was reported.

## Decision outcome

Chosen option: **3**, because it reaches every reporter where they are, keeps Seerr authoritative, and produces the
evidence the rule needs. Option 4 remains available as the gate's outcome (Q-05).

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | **The Seerr Issue mirror** (T-311): a `seerr-issues` sync mode reads `GET /api/v1/issue` every 10 minutes and on each issue webhook (issue types added to the existing webhook), stores one row per issue (type, status, season, episode, media ids, the ledger item, the reporter's Seerr id and app user when the email matches, the first message, comment count), and never treats a webhook body as state: a webhook only triggers a fresh read of that issue. |
| C-02 | **Surfaces:** the title page shows an open Seerr report for that title or episode with the Repair Guide preselected for it; `/admin` lists Seerr issues with their linked repairs and outcome. The reporter's name is shown to admins only. |
| C-03 | **Writes are open** (DESIGN-055 Q-02). If approved: one comment per new issue with the fix-it-yourself link, and a resolve with a one-line note when the linked repair completes, both as a dedicated Seerr user through `X-API-User`, through a single writer that records each write before and after the call and never comments twice on one issue. The bridge never deletes, reopens or edits an issue or another person's comment. |
| C-04 | **Reporter onboarding** (DESIGN-055 D-11): the deep link opens the title page with the guide preselected; signing in with Plex creates the account (R-03) and returns to the link. Seerr's own comment notification is the delivery channel; the app adds none. |
| C-05 | **The readiness gate** (T-313): every Seerr issue and every Helpdesk media ticket is counted Self-Served (T-312), Staff-Assisted or Unfixable by the same rule, shown in `/admin` and the nightly digest. The threshold (Q-04) and what the rule does once it passes (Q-05) are owner decisions. |
| C-06 | Good: every report gets a path to a fix within minutes, including from people with no account, and the owner can see whether self-service works before he makes it the rule. |
| C-07 | Bad: one more dependency on Seerr's API, which changes between Seerr releases. Contract tests and the stub Seerr pin the reads and writes used. |
| C-08 | Bad: any Seerr user can resolve or delete an issue (default `MANAGE_ISSUES`), so a resolve is a fact the mirror records, not proof of a fix. The gate counts outcomes from the app's own repair records, not from Seerr status. |

## More information

- Builds on DESIGN-005 D-14 (Seerr request attribution by email), ADR-026 and DESIGN-012 (webhook ingestion; the
  Seerr parser already reads issue fields), ADR-050 and ADR-061 (Helpdesk tickets and their locator), ADR-093 C-11
  (the existing Seerr writes and their confinement), ADR-109 (the Repair Guide).
- PRD R-269..R-271; glossary T-311..T-313.
