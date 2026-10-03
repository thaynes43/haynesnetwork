# ADR-096: The Trash walls show a save only after the server confirms it

- **Status:** Accepted (2026-10-03; an agent-authored correction of an owner-reported defect, Accept
  authority per `.agents/plans/README.md`)
- **Date:** 2026-10-03
- **Deciders:** Tom Haynes (owner report, 2026-10-03: a phone screenshot of the Leaving Soon wall showed a
  title as saved that was never saved) · drafted by Opus 5.5
- **Supersedes in part:** [ADR-033](033-fold-batches-into-per-kind-tabs.md), the word "Optimistic" in its
  "Fast tap-toggle everywhere" refinement. The rest of that refinement stands: one tap saves, inert states
  stay inert, the glyph language is unified, nothing reflows.

## Context and problem statement

At 00:02 EDT on 2026-10-03 the owner screenshotted the Movies Leaving Soon wall on his phone. The header read
`Deleting 48 · Rescued 2 · Kept 0 · frees 758 GB` and two tiles wore the green saved shield: *101 Dalmatians*
(1996) and *How Stella Got Her Groove Back* (1998). Only the first save existed. Stella was still `pending`
twenty minutes later, with no `trash_batch_saves` row, no `trash_excluded` ledger event and no Maintainerr
exclusion, and its batch deletes it at the first sweep after 2026-10-04 23:17 EDT.

The evidence (Traefik access log, Maintainerr log, the database):

| Time (EDT) | Event |
|---|---|
| 00:00:01 | Maintainerr starts its scheduled rule run (it runs at 00:00, 08:00 and 16:00, about five minutes each). |
| 00:02:12.6 | Tap 1: `POST trash.batches.setItemSaved` for 101 Dalmatians. |
| 00:02:17.8 | Maintainerr finishes the movie rule, then logs "Added global exclusion for media with id 53". |
| 00:02:18.3 | The save row is written; the POST answers 200 after 5.7 s. |
| 00:02:24.3 | Tap 2: `POST trash.batches.setItemSaved` for Stella. Maintainerr is now running the TV rule (until 00:04:58). |
| 00:02:54.3 | The app's 30 s Maintainerr timeout fires; the POST answers **502** (`MAINTAINERR_UNAVAILABLE`). Nothing was written. |

The wall flipped a tile to the saved shield the moment it was tapped and reconciled when the answer came back
(ADR-033's "optimistic, reconciled with the server"). For the 30 s the request was out, the tile was green, the
header counted it under Rescued, and nothing on the tile said a request was still pending (`aria-busy` was set but
had no visual style). The screenshot falls in that window. When the 502 landed the tile reverted and the error went
to the wall's error line, which sits above the grid and was off screen for a tile further down the wall.

Reading the wall code for this found a second way to the same picture. Each wall shares one mutation hook across
all its tiles and settled a tap through callbacks passed to `mutate()`. TanStack Query keeps only the latest
`mutate()` call's callbacks, so tapping a second tile while the first tile's request was still out orphaned the
first answer: a failed first save stayed green for good with no error, and a successful one was never reconciled.
It did not happen in this incident (the first request had answered before the second tap), but it is the same
symptom.

A protective action that reads as done when it is not is the worst failure this surface can have: the owner moves
on, and the title is deleted at the sweep.

## Decision drivers

- A tile and the header must never claim a save, un-save or un-protect the server has not confirmed.
- A failed tap must be visible where the viewer tapped, not only in a line that may have scrolled away.
- Hard rule 9 / ADR-015: an interaction may recolor, never reflow.
- Saving stays one tap (ADR-014 keeps the two-step for releases only).
- Writes can be slow: Maintainerr holds exclusion writes while its rules run, so an answer can take up to the
  30 s timeout.

## Considered options

1. **Keep the optimistic flip, add a visible busy style.** The tile would still show the saved shield and the header
   would still count it while the request is out. Rejected: the screenshot problem stays.
2. **Show the confirmed state only, with a busy style while the request is out and a failure mark on the tile.**
3. **Disable the whole wall while any request is out.** Rejected: one slow write would block every other tap.

## Decision outcome

Chosen option: **2**, on both Trash walls (the batch wall and the pending walls, which share the tap-toggle).

- **Confirmed only.** A tap starts the request and marks the tile busy. The tile keeps drawing its last confirmed
  glyph, and the running header keeps counting it there. Only the server's answer (the returned state, which on an
  inert `changed:false` tap may differ from what was asked) changes the glyph and the counts.
- **Busy.** While the request is out the poster gets a dashed ring in the progress tone and the corner puck a pulsing
  halo (color and shadow only); the tile's accessible name and tooltip read "Saving <title>…" (or "Un-saving",
  "Un-protecting"); further taps on it are ignored. Reduced motion stills the pulse; the dashed ring remains.
- **Failed.** A failed tap leaves the glyph alone, gives the poster the danger ring and swaps the tile's meta text for
  a short note ("Not saved", "Still saved", "Still protected") in the danger tone, in the same fixed-height line. The
  wall's existing error line names the title and gives the reason ("How Stella Got Her Groove Back (1998) was not
  saved. Maintainerr didn't respond. Nothing changed — try again in a bit."). The next tap on the tile clears its
  mark.
- **The error line holds its height.** Its slot is now a fixed height that clamps the text (one line on wide screens,
  two below 760 px) instead of a minimum height that grew: at 390 px the named message wrapped to two lines and moved
  every tile 13 px. The full text rides the `title` attribute and the `role="alert"` announcement.
- **Each tap settles its own tile.** A tap is settled through its own request's promise (`mutateAsync`), never
  through callbacks passed to a shared `mutate()`, so overlapping taps each land.
- The rules live in one pure module, `apps/web/lib/wall-taps.ts`, used by `PosterWall` (`kind-tab.tsx`) and
  `usePendingSaves` (`components/pending-wall.tsx`), and unit-tested with a replay of the incident.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: the wall can no longer show Saved or count Rescued for a save that did not happen. A screenshot of the wall is a true record. |
| C-02 | Good: a failed tap is visible on the tile itself, in the danger tone, plus the named error line; nothing reflows. |
| C-03 | Bad: a save no longer looks instant. A normal save shows the busy ring for well under a second; during a Maintainerr rule run it can show it for up to 30 s and then fail. The ring makes the wait honest instead of hiding it. |
| C-04 | Neutral: the server, the wire contracts and the data are unchanged. This is a client-side display rule. |
| C-05 | Follow-up, not decided here: saves made while Maintainerr runs its rules (three windows of about five minutes a day) fail after 30 s. Whether to wait longer, retry, or record the intent first is a separate decision, tracked in [issue #642](https://github.com/thaynes43/haynesnetwork/issues/642). |

## More information

- DESIGN-011 D-07 (batch wall) and DESIGN-010 D-09 (pending walls) carry the 2026-10-03 amendments.
- ADR-014 (two-step for releases only), ADR-015 (no reflow on interaction), ADR-033 (the shared tap-toggle).
- Regression tests: `apps/web/lib/__tests__/wall-taps.test.ts` (unit) and two e2e tests in
  `apps/web/e2e/trash.spec.ts` ("a save the server has not confirmed never shows as saved; a failed save says so on
  the tile" on the batch wall at 390 px, and "pending wall: overlapping saves that fail never read as saved, and both
  tiles say so"). Both tap two tiles while the first is out and make the stub Maintainerr hold and then fail (or
  slowly succeed) the exclusion write (`/_stub/exclusion-fault`). Both fail on the code before this change.
