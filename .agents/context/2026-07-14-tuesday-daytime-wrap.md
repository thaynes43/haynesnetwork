# 2026-07-14 — Tuesday daytime wrap (the correction-and-visibility day)

Continuation of the session-6 overnight run (`2026-07-14-session-6-wrap.md`). Owner engaged all
morning (rulings, rejections, live acceptance); afternoon ran autonomous. FIVE releases
(v0.50.1 → v0.54.0), one live pipeline rescue, one policy-gate saga, one UX system.

## Releases (all deployed + verified)

- **v0.50.1** — the owner REJECTED PLAN-045's Wanted-strip/chip-stack UX ("you trashed the
  book/audiobook/comics library… doesn't follow our common theme"). Fix #261: strip deleted,
  wanted items inline as Movies-anatomy poster cards, per-format detail → tooltips.
  **Root-caused honestly:** my brief never pinned the reference anatomy AND I deployed UX
  without visually diffing against the reference. Standing rule since (memory
  `ux-reference-anatomy-gate`): reference-pinned briefs + agent side-by-side proof +
  coordinator visual diff BEFORE any UX deploy.
- **v0.51.0** — wanted DETAIL-page parity (#264, owner-requested): `/library/books/wanted/
  [requestId]` on the Movies detail idiom; per-format Force-Search (LL / Kapowarr); requester
  attribution lives HERE now; "Have it" cards → the real library detail.
- **v0.52.0** — **PLAN-047 shared card system (ADR-058)**: `BaseCard` family in
  `apps/web/components/cards/` (typed slots, ONE badge row, no children escape), ESLint
  anatomy guard, dev-only card-gallery + CI drift spec, all 10 walls refit pixel-neutral
  (incl. Helpdesk + Trash). "The code guarantees the UX doesn't drift" — owner's mandate,
  delivered.
- **v0.53.0** — **PLAN-048 slice 1 (ADR-059, migration 0048)**: the Activity contract,
  Library → Activity tab (Helpdesk-chip filters), wall in-flight badge capability, the
  LL+SAB books adapter (stage machine incl. `stranded_import`), role-gated failure actions
  (Admin acts / others read-only; `role_activity_action_grants`), failure ledger + same-tx
  outbox events (the future SMTP digest's feed).
- **v0.54.0** — PLAN-048 COMPLETE: the *arr adapter (#273 — queues, progress,
  `import_blocked` w/ reasons, retry-import via new confined `processMonitoredDownloads` +
  force-search reuse) and the Kapowarr adapter (#275 — honest coverage map; comics have NO
  retry-import concept, re-search only; **Q-03 flag: comics activity rides the `books`
  section gate** — one-field flip if the owner wants it independent).

## The import-pipeline rescue (live, owner-reported "why did we not find these books")

Root cause: LL sent SAB jobs with NO category → completed downloads landed on the
haynestower-mount completed ROOT while LL watched the cephfs `lazylibrarian/` dir (two
genuinely different mounts). **42 stranded downloads; 39 imported after the fix** (27 ebooks +
12 audio; 3 real mismatches re-searching). `sab_cat=lazylibrarian` set; stranded folders
rescued cross-NFS; Kavita/ABS rescanned. **My `und`-substring theory was WRONG** — LL matches
reject-words on word boundaries (verified in source); the German list stands. 80 of the 94
"failed grabs" were stale pre-fix 404 artifacts. As-built: OPS-013 §11 + F-10 RUN 4 (#267).
This incident is PLAN-048's motivating case and its `stranded_import` failure class.

## The kyverno day (owner: "why is Kyverno paging me?")

TWO distinct denial classes hit: (a) v0.50.1 — the real GHCR signature-propagation race;
(b) v0.52.0 — **a no-op release**: my close/reopen dance collided with an in-flight
release-please run and STRIPPED the `autorelease: pending` label → merge tagged nothing →
kyverno correctly refused a nonexistent image (recovered by re-labeling the merged PR +
rerunning the run). Hardening shipped: **deploy gate = the artifact PAIR (manifest + digest
`.sig` both 200)**; dance guardrails (no dance mid-run; verify label + checks-started);
`upgrade.remediation.retries: 10` (haynes-ops `4789da14`). Runbook 1b/1c rewritten (#263).
v0.53.0 + v0.54.0 both deployed with ZERO kyverno noise under the new procedure. Owner asked
which alert paged him — answer pending; tune to sustained-denial when known.

## Model watch

**Two `model: opus` override probe flips** (first probe answered "Fable 5"; immediate retry
resolved Opus 4.8 both times) — a NEW transient flavor, recorded in
`fable-safeguard-model-switch`. Countermeasure now standard: probe → dispatch →
**transcript ground-truth** (`grep '"model":"..."'` on the output file). All four Opus builds
today verified genuine `claude-opus-4-8`. First flip coincided with the owner's "Claude app
auth acting wonky" report (unproven relation).

## Plan states

- **PLAN-044/045/046:** built + live (v0.49.0–v0.51.0 arc) — ACTIVE pending owner
  ratification (live Goodreads sync proven on his real account: all-shelves wave 27 items,
  41% coverage, comics routed to Kapowarr, both stray LL wants scrubbed).
- **PLAN-047/048:** BUILT + LIVE (v0.52.0–v0.54.0) — pending owner look; then completed/.
- **PLAN-043 saga:** MVP + framework phases live; next phases per the phase map.

## Open (owner)

Ratify the Activity tab + card-system refit + Goodreads/wanted arc (screenshots in-chat all
day); **Q-03 comics-section gate ruling**; Orwell essays queue-or-drop (GB `PqGMFPCiBEsC`);
**MAM gate self-reopens ~Tue eve** — verify the 7 usenet-poisoned titles grab MAM-English
(watch them in the new Activity tab!); qB 5.2.1 Approved-Clients check; which alert paged
(for tuning); SMTP (F-04) still the 1P blocker; F-11 post-import spot-check candidate;
ticket-worthy: the advisory e2e suite is red ON MAIN (member persona sees only My Fixes in
the hermetic stack — evidence files in the 047 scratchpad).
