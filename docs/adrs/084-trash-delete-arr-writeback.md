# ADR-084: Trash deletes write back unmonitor + blocklist; removal tombstones add import-list exclusions

- **Status:** Proposed
- **Date:** 2026-08-20
- **Deciders:** Tom Haynes

## Context and problem statement

The 2026-08-19 NZB Finder duplicate-download incident
(`.agents/context/2026-08-19-nzb-dupe-loop-incident.md`) exposed a structural gap: when media
leaves the library while its *arr record stays monitored — or when a whole series/movie is
removed from the *arr while list automations still want it — the automation layer re-acquires
it. Re-grabs of previously-downloaded releases hit SABnzbd's persistent duplicates database,
and before the Fail-mode fix they looped invisibly against the indexers (an account-
termination threat). Even with Fail mode, unwanted re-acquisition wastes grabs, bandwidth,
and indexer goodwill.

Two distinct leak paths exist:

1. **App-owned deletes** (space-policy batch sweep, manual trash actions): the file is
   deleted but the *arr item stays monitored, so RSS/search re-grabs it.
2. **Full *arr removals** (the unattributed series removals of Aug 2026: T.O.T.S.,
   Los Pingüinos de Madagascar, The Rookie ×2, Monster): the *arr record is gone, but
   Kometa's list-driven `add_missing` re-adds anything a dynamic chart list resurfaces —
   silent add/delete churn.

Owner directives (2026-08-19/20): "we should be ignore listing anything the trash deletes";
"list automations should not be able to silently re-add and *arrs shouldn't just grab the
releases, but it would be ideal if people could still re-grab them via Seerr."

## Decision drivers

- Deleted-on-purpose media must not silently re-download (waste + indexer risk).
- Deliberate human re-requests through Seerr MUST keep working — protection may not create
  an un-requestable dead zone.
- Hard rule 4 confines *arr write-backs to an explicit, audited list; any expansion needs an
  ADR and the domain single-writer pattern.
- The sync is one-way (*arr → ledger); any write-back triggered from sync-observed state must
  not turn the sync itself into a writer.

## Considered options

1. Unmonitor only, app deletes only.
2. Unmonitor + blocklist on app deletes; import-list exclusion on sync-detected full
   removals. **(chosen)**
3. Unmonitor + blocklist + exclusions on every delete path including Maintainerr's own
   deletes (intercepted app-side).

## Decision outcome

Chosen option: **2** — owner-ruled 2026-08-20 (AskUserQuestion session): "Unmonitor +
blocklist" for the write-back shape, and full-removal protection via exclusions with the
explicit Seerr-re-request carve-out.

- **D-1 (app deletes):** when the trash/space-policy deletes media files, the same domain
  transaction writes back to the owning *arr: **unmonitor** the episode/movie/album AND
  **blocklist the exact deleted release** (the release that produced the deleted file).
  Monitoring-driven auto-grabs stop; the identical release cannot be re-grabbed even if
  monitoring is later re-enabled.
- **D-2 (full removals):** when the sync's tombstone flow observes a series/movie vanished
  from the *arr, a follow-up write (through the domain single-writer, NOT inside the sync
  read path) adds an ***arr import-list exclusion* for it. Kometa checks the exclusion list
  before `add_missing` (verified live: its cron-time reads of the exclusion endpoint), so
  list automations cannot silently re-add. Seerr adds directly via the *arr API and does not
  consult exclusions, so **human re-requests keep working** (D-3's acceptance criterion).
- **D-3 (Seerr carve-out, binding acceptance criterion):** a Seerr re-request of an excluded
  or unmonitored item must succeed end to end: re-add (or re-monitor), search, grab a
  non-blocklisted release, import. Encoded as a test against the stub Seerr + stub *arrs.
- **D-4:** every write-back writes an audit row in the same transaction (hard rule 6), and
  hard rule 4's write-back list is amended in the same PR that lands the first writer.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: trash-deleted media cannot silently re-download; the Aug-2026 loop class is closed at the source, not just at SAB. |
| C-02 | Good: Kometa churn (add → delete → re-add) is broken by exclusions while Seerr re-requests stay live — the owner's exact spec. |
| C-03 | Good: audit rows make every write-back attributable (unlike the Aug-2026 removals). |
| C-04 | Bad: the exclusion list grows over time and needs an admin surface (or at least visibility) to prune — otherwise a once-deleted show is hard to re-adopt via lists. |
| C-05 | Bad: blocklist entries for deleted releases accumulate in the *arrs; harmless but noisy. |
| C-06 | Risk: exclusion writes keyed off tombstones must debounce *arr outages (a flapping *arr must not mass-exclude); the tombstone flow's existing liveness guards gate the writer. |
| C-07 | Open (Q-01): should the app also unmonitor/exclude on removals it performed via the failsafe-restore reversal path? (Likely yes for symmetry; decide in design.) |

## More information

- Incident + evidence: `.agents/context/2026-08-19-nzb-dupe-loop-incident.md`
- Amends the hard rule 4 write-back list (CLAUDE.md) when implemented; write-backs go through
  `@hnet/arr/write` (import-confined to `packages/domain`).
- Related: ADR-073 (space policy / trash), ADR-083 (queue janitor — consumes the errored-grab
  fallout this ADR prevents), DESIGN-046.
- Cluster-side companions (same incident): SAB `no_dupes=3` (Fail) on both instances;
  `SonarrSeriesRemoved` PrometheusRule + the `arr-library-audit` Grafana dashboard
  (haynes-ops PR #2536) for timestamped removal records.
