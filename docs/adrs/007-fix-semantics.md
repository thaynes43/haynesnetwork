# ADR-007: Fix semantics — mark-failed + search with a mandatory reason taxonomy

- **Status:** Accepted
- **Amended by:** ADR-011 (2026-07-04): Fix gains a media-hierarchy scope; season Fix is a roll-up orchestration.
- **Amended by:** ADR-016 (2026-07-06): reason `missing_subtitles` routes to Bazarr subtitle search (no blocklist/delete/re-grab) and is not offered for Music.
- **Date:** 2026-07-03
- **Deciders:** Tom Haynes (with agent input)

## Context and problem statement

The core media feature is **Fix**: a user finds a broken item (won't play, wrong language,
bad quality) in the ledger and triggers remediation without asking the admin (PRD-001 R-43).
Remediation is executed against the owning *arr — Sonarr (`sonarr.media.svc:8989`), Radarr
(`radarr.media.svc:7878`), or Lidarr (`lidarr.media.svc:8686`) — which manages downloads and
imports. The naive approaches fail in characteristic ways: triggering a search alone does
nothing when a file already sits on disk satisfying the quality profile, and deleting the
file alone lets the *arr re-grab the exact same bad release. We must define precisely what
Fix does, what the user must supply, and what record it leaves behind (R-44..R-47).

## Decision drivers

1. Fix must actually dislodge the bad file **and** prevent the same release from
   returning (R-44).
2. The owner wants data on *what goes wrong* with grabs — reasons are collected for
   analysis, not just free text (R-45).
3. Fix is user-triggered and therefore must be audited, attributable, and rate-guarded
   (R-46, R-47).
4. Use the *arrs' own mechanisms — they remain the source of truth (ADR-008); this app
   orchestrates, it does not reimplement blocklists or search.

## Considered options

- **Option A** — Mark the offending grab **failed** in the *arr's history (which
  blocklists that release), then trigger an automatic search; fall back to
  delete-file(s) + search when no grab history exists.
- **Option B** — Search-only: trigger a new search and let the *arr sort it out.
- **Option C** — Delete the file(s) + search, always.
- **Option D** — No automation: Fix files a ticket for the admin.

## Decision outcome

Chosen option: **Option A** — it is the only option that both removes the bad file from
contention and stops the *arr from re-grabbing the identical release, using first-party
*arr semantics (history mark-failed → blocklist → replacement search).

- **Primary path (AC-07):** locate the item's most recent grab in the owning *arr's
  history; call the history mark-failed endpoint (the *arr blocklists that release and
  removes the file from its wanted state); then trigger the *arr's search command for a
  replacement.
- **Fallback path (AC-08):** when no grab history exists (e.g. manually imported or
  pre-*arr content), delete the file(s) via the *arr API and trigger a search. This cannot
  blocklist, so a re-grab of the same release is possible — recorded as a known limitation
  on the fix record.
- **Mandatory reason (R-45):** every Fix requires a reason from a fixed taxonomy — *won't
  play / corrupt*, *wrong language*, *wrong version/quality*, *missing subtitles*, *wrong
  content entirely* — or *Other* with required free text. Reasons are stored for later
  analysis of failure patterns (which indexers/qualities/languages go bad).
- **First-class records (R-46):** a Fix request is a durable row: requester, ledger item,
  reason, the exact *arr actions taken and their responses, and an outcome tracked over
  time (replacement grabbed/imported, observed via ledger sync — ADR-008). Admins see all
  fix requests; users see their own history and status.
- **Abuse guard (R-47):** per-user rate limits on Fix, a fixed default constant in
  Phase 2 (PRD-001 Q-05), admin-configurable later.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: mark-failed blocklists the release, so the replacement search cannot return the identical bad grab — the failure mode of Options B and C. |
| C-02 | Good: the reason taxonomy turns user complaints into structured data about what goes wrong in the pipeline. |
| C-03 | Good: every Fix is attributable and auditable end-to-end, including the raw *arr responses, which makes support and abuse review cheap. |
| C-04 | Bad: the fallback path is destructive (file deletion) and cannot blocklist; a re-grab of the same release is possible. Mitigated by recording the path taken and keeping the item in the ledger (ADR-008) so nothing is lost permanently. |
| C-05 | Bad: correctness depends on *arr history fidelity — if history was cleared, more items take the fallback path. Accepted; the fallback exists precisely for this. |
| C-06 | Neutral: outcome tracking is asynchronous — a Fix is "done" only when a subsequent sync observes the replacement import, so records carry a pending state. |
| C-07 | Neutral: taxonomy values are code-level constants initially; extending the list is a migration, which is acceptable for analytical stability. |

## More information

- PRD-001 R-43..R-47, AC-07, AC-08, US-06; Q-05 (rate-limit default).
- ADR-008 — the ledger that Fix reads from and that observes Fix outcomes; Restore is the
  other sanctioned write-back.
- Kickoff decision #5 (`.agents/context/2026-07-03-kickoff.md`) — owner-confirmed
  mark-failed + search semantics and the reason requirement.
- *arr API keys come from the 1Password `media-stack` and `lidarr` items (ADR-006 secret
  wiring).
