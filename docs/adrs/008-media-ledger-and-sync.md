# ADR-008: Media ledger — *arrs are the source of truth, one-way sync, two audited write-backs

- **Status:** Accepted
- **Amended by:** ADR-011 (2026-07-04): adds Force Search as a third audited write-back and media-hierarchy action scopes.
- **Date:** 2026-07-03
- **Deciders:** Tom Haynes (with agent input)

## Context and problem statement

The app needs a durable, queryable record of the media estate: what exists, who requested
it, what was deleted when, and what is wanted but missing (PRD-001 R-40..R-42). It also
needs enough recorded detail to rebuild a Sonarr/Radarr/Lidarr instance whose database is
lost (R-50..R-52). Meanwhile the owner actively manages media lists *in the *arrs
themselves* — Sonarr (`sonarr.media.svc:8989`), Radarr (`radarr.media.svc:7878`), Lidarr
(`lidarr.media.svc:8686`) — and requests flow through Seerr (`seerr.media.svc:5055`). Two
systems holding the same lists invites divergence; we must fix the direction of truth and
the exact write-back surface.

## Decision drivers

1. The owner manages lists in the *arrs; the app must never fight that (CLAUDE.md hard
   rule 4, kickoff decision of record).
2. Disaster recovery: the ledger must be able to re-add lost items *monitored, with the
   right settings* (R-51).
3. Attribution and history (who requested what, what was deleted when) outlive the *arrs'
   own retention and belong to the app (R-41).
4. Any write to a *arr from this app must be explicit, previewed where destructive, and
   audit-logged (R-52, R-04 pattern).
5. Avoid split-brain: no reconciliation engine, no conflict resolution — one direction.

## Considered options

- **Option A** — *arrs are the **source of truth**; the app keeps a one-way-synced ledger;
  write-back is limited to two explicit, audited operations (Fix, Restore).
- **Option B** — Bidirectional sync: edits in either system propagate to the other.
- **Option C** — App as source of truth: the *arrs are configured from the app's DB.
- **Option D** — No ledger: query the *arrs live for every view.

## Decision outcome

Chosen option: **Option A** — it matches how the estate is actually operated, and it makes
the failure mode (stale copy) benign instead of catastrophic (split-brain or clobbered
*arr state).

- **Ledger (R-40):** synced *from* Sonarr, Radarr, and Lidarr — every monitored media item
  with its on-disk state, quality profile, root folder, and *arr tags. That field set is
  deliberately "enough to re-add": it is exactly what Restore needs to recreate an item
  monitored with its original settings.
- **History events (R-41):** grabs, imports, and deletions ingested from *arr history;
  request attribution joined in from Seerr's API (who requested what). Maintainerr
  enrichment (deletion attribution) is a follow-on once it runs in k8s (PRD-001 Q-04).
- **Wanted-but-missing (R-42):** items monitored but not on disk are captured and
  browsable — including their own request attribution.
- **Write-back surface — exactly two operations, both audited:**
  1. **Fix** (ADR-007): mark-failed + search, or delete + search, per its own rules.
  2. **Restore** (R-50..R-52): admin-only failsafe — diff the ledger against a live *arr
     instance, preview exactly what is missing, then re-add missing items monitored with
     their stored quality profile, root folder, and tags, producing a success/failure
     report (AC-09). Sync direction is otherwise strictly *arr → app.
- No other code path may call a mutating *arr endpoint; the API client separates read and
  write surfaces so this is enforceable in review and tests (ADR-010).

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: no split-brain by construction — there is one owner per fact, and the app's copy being stale is a refresh problem, not a data-integrity problem. |
| C-02 | Good: the ledger doubles as disaster recovery — a lost *arr DB is rebuilt from recorded settings, not from memory (US-07). |
| C-03 | Good: history and attribution live in the app's Postgres and survive *arr retention limits, migrations, and rebuilds. |
| C-04 | Bad: the ledger lags reality between syncs; views can be stale. Mitigated by re-validating against the live *arr at the moment of any write-back (Fix targets live history; Restore diffs live state in its preview). |
| C-05 | Bad: attribution quality is bounded by Seerr's records — direct-in-*arr additions have no requester. Accepted; shown as unattributed. |
| C-06 | Neutral: Maintainerr enrichment is deferred (Q-04); deletion events until then come from *arr history without richer "why" context. |
| C-07 | Neutral: sync cadence, cursoring, and schema live in the Phase 2 design doc — this ADR fixes direction and surface, not mechanics. |

## More information

- PRD-001 R-40..R-42, R-50..R-52, AC-09, US-06, US-07; Q-04 (Maintainerr timing).
- ADR-007 — Fix, the first sanctioned write-back; ADR-010 — the CI guard style used to keep
  privileged write paths confined to one package.
- CLAUDE.md hard rule 4; kickoff notes `.agents/context/2026-07-03-kickoff.md` (product
  intent: "the *arrs remain the source of truth; the app DB is synced from them").
- *arr and Seerr credentials: 1Password `media-stack` and `lidarr` items via the
  ExternalSecret defined in ADR-006.
