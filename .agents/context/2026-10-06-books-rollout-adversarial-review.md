# 2026-10-06 — Adversarial review: the books re-request rollout (v0.105.2 to v0.107.7)

Review of issue #731, written for the owner. Everything here was read, not changed: git history and PR threads, the
designs (DESIGN-024/028/036/038/039/046), the code in `packages/domain`, `packages/sync`, `packages/goodreads`,
`packages/lazylibrarian`, the LazyLibrarian overlays in haynes-ops, HANDOFF and the context notes, the app database on the
CNPG primary (`default_transaction_read_only=on`), LazyLibrarian's SQLite (`mode=ro`), Loki and Prometheus. One short
script ran once to probe a pure function; no test suite, no load, no write anywhere. Times are UTC.

## Executive summary

1. The rollout was not one bad deploy. It was a pipeline that had trusted three outside systems (LazyLibrarian, Google Books, the library tags) on eight assumptions that were all wrong, with nothing measuring the gap, and then a bulk action (hand ~790 wants back to LazyLibrarian at once) taken before anyone had checked what those wants pointed at.
2. The ~900 hung requests behind it had been silently wrong since July: LazyLibrarian deleted the app's books at every restart, and the app read "id absent" as "nothing to do". No metric, census or test could see it; it was found by accident during a repair.
3. Every one of the eight LazyLibrarian facts (addBook writes no author link, searchBook ignores its type, addBook on a held book resets both formats, no held-file guard on queueBook, no series data, failed SABnzbd jobs are imported, language is only a warning on API adds, getAllBooks absence means deleted) was readable in the pinned source inside the pod, and each was learned in production.
4. The fixes are mostly right in direction, and most needed a same-hour follow-up because verification was "pods Ready, no error lines, the first run's counters", not "the right books were asked for". The pre-merge gate that caught real defects (a CRITICAL in #676, HIGHs in #669, #707, #726) was the advisory review, not the tests.
5. The one e2e spec covering the changed push path was red for 24 hours across five releases; e2e is advisory and finished after the merge on 18 of 19 PRs (merges landed 4 to 26 minutes after opening).
6. Still wrong today: 53 of 59 `grabbed` formats are failed grabs the app still calls "downloading" (some since July); LazyLibrarian is still searching 22 books no request owns; 211 LazyLibrarian books survive only because an overlay spares them; the English-edition pass has not run one lookup; format-pairing burns about 95 percent of its Google Books budget on the same unresolvable wants every hour.
7. Agents wrote directly to the app database in three sessions and to LazyLibrarian's database in at least eight scripts; one code change (#701) exists only to accommodate a hand-made state. None of the sync-derived writes leaves an audit row.
8. Two policy rulings (English-only parks, the English-edition lookup) were made by the coordinator on issues that said "needs a design decision"; both are defensible, neither was the owner's, and the second has not been exercised live.
9. The CPU incident was a work order with no bounds: the subagent's method ("40 CPU burners") was in the PR body, the PR merged ten minutes later, no alert fired, and the only rule written since lives in one agent's private memory file. The pod still has no CPU limit.
10. Thirteen issues are open for the concrete defects (#734 to #744, haynes-ops #3402 and #3403). Eleven owed post-deploy checks are pending; six fall due at today's 04:54Z LazyLibrarian backlog run.

## 1. What happened, in order

| When | What | Record |
| --- | --- | --- |
| July to 2026-10-03 | LazyLibrarian deletes app-added books at every restart (`check_db` removes "bookless" authors; `addBook` never wrote `bookauthors`). About 900 open wants point at ids that no longer exist. The app's reconcile skips an absent id as "the honest gap". | `.agents/context/2026-10-04-ll-gone-wants.md` |
| 2026-07-13 | The owner orders a library-wide English-only audit (F10). It is not executed. | `.agents/context/2026-07-13-f10-english-audit.md:3` |
| 10-03 22:26Z to 23:37Z | v0.105.2: omnibus guard (#658), parked pairing wants stay parked (#660). The bundle audit parks 20 wants and sets 21 LazyLibrarian formats Skipped by a one-off script writing the app database directly. | `2026-10-03-bundle-audit.md:18` |
| 10-04 01:10Z to 01:42Z | v0.105.3 (#664): a Kavita anchor is the book it holds, not its series. First run shows the re-vanish was resetting 312 wants a run. Hand repair of 12 wants by direct write. Issue #665 found "on the way". | `2026-10-04-pairing-held-book-repair.md:56` |
| 10-04 03:14Z to 05:09Z | haynes-ops #3351 (LazyLibrarian overlays `gb.py`, `dbupgrade.py`), v0.105.4 (#669 gone rule), v0.105.5 (#670 format from anchor). 817 hung wants settle `missing`. | HANDOFF v0.105.4 block |
| 10-04 ~15:00Z | Owner ruling on #668: "Add them all back now". The issue named indexer load as the only risk. | issue #668 |
| 10-04 16:06Z to 17:14Z | v0.106.0 (#675 re-request), v0.106.1 (#676, 45 minutes later: quota-wall refusals were counted as failures; the review had flagged a CRITICAL stall). e2e goes red on `main` and stays red until 10-05 17:04Z. | PR #676 review; issue #702 |
| 10-05 04:54Z | LazyLibrarian's backlog search runs over 352 items and makes 113 grabs. One is the wrong book (#686). The day ends with 137 grabs (44 processed, 26 failed), against 6 to 19 a day the week before. | LL `wanted` table |
| 10-05 12:39Z to 14:43Z | haynes-ops #3367, #3368, #3369: LazyLibrarian post-processor and matcher overlays (#688, #694). A replay finds 153 + 44 historical cross-volume grabs; 19 records repaired, LazyLibrarian database written directly. | HANDOFF 2026-10-05 |
| 10-05 15:29Z to 16:10Z | v0.107.1 (#698 Volume Check), v0.107.2 (#701: conform the wants a repair parked by hand). 103 requests repaired by script. | DESIGN-028 amendment #693 |
| 10-05 17:26Z to 17:50Z | v0.107.3 (#707 English-only pairing), v0.107.4 (#708, 20 minutes later: the first release parked only unpushed wants). | HANDOFF v0.107.3 block |
| 10-05 19:33Z to 23:38Z | Language audit by hand (18 Kavita series, 2 Audiobookshelf items). v0.107.5 (#714 Kavita re-read), v0.107.6 (#720 landed truthfulness), v0.107.7 (#726 English edition, no deploy record). F10 sweeps hold ~6,500 files (22 GB). | HANDOFF F10 entries |
| 10-05 23:00Z to 00:11Z | A flake-fix subagent runs 40 to 60 CPU burners plus parallel vitest in the dev-env pod; talosm02 starves; EMQX, traefik, authentik, cloudnative-pg restart in loops. | haynes-ops #3381, #3382 |

44 pull requests merged in 50 hours (10-03 22:31Z to 10-06 00:30Z), twelve app releases, thirteen haynes-ops deploys and
overlays. Merges came 4 to 26 minutes after the PR opened.

## 2. Findings ranked by severity

| ID | Severity | Finding | Tracked |
| --- | --- | --- | --- |
| W-01 | High | No identity contract: a Google Books id was "the book" and a LazyLibrarian id's status was "our status", with no check that either named the work and volume the person asked for. Four mechanisms put wants on the wrong book; the matcher that grabs files is a fuzzy ratio with no series data. | #693 (fixed in part), #739 |
| W-02 | High | ~900 wants silently hung for ten weeks because an absent id was "an honest gap", and nothing measured absent ids, hung wants, orphan LazyLibrarian wants or foreign items. | #735, #744 |
| W-03 | High | Eight wrong assumptions about LazyLibrarian, each learned in production, each readable in the pinned source in the pod. | section 3 |
| W-04 | High | The bulk re-request ran before the identity check existed, with the known identity risk left out of the question to the owner; the gate was "pods Ready, no error lines, first-run counters". | section 3 |
| L-01 | High | A failed grab stays `grabbed` forever: 53 of 59 live `grabbed` formats are LazyLibrarian `Wanted` after a `Failed` grab, the oldest from 2026-07-17. The #715 fix covered `landed` only. | #734 |
| P-01 | High | The CPU incident: an unbounded work order, a PR body that stated the method, a ten-minute merge, no alert, a rule written only to a private memory file, and still no CPU limit. | haynes-ops #3403, #3381, #3382 |
| W-05 | Medium | The F10 English-only rule was never enforced: the 2026-07-13 audit was not executed; pairing minted foreign wants for twelve weeks; the library tags were wrong in both directions. | #744 |
| W-06 | Medium | e2e red on `main` for 24 hours across five releases; the failing spec was the push path being changed; e2e finished after merge on 18 of 19 PRs. | #742 |
| W-07 | Medium | Direct writes to the app database (three sessions) and to LazyLibrarian's database (at least eight scripts) bypassed the single writers; #701 is code written to match a hand-made state; nothing sync-derived is audited. | #741 |
| L-02 | Medium | LazyLibrarian is never told when the app abandons or parks a want; 22 wanted books have no owner and are searched daily. | #735 |
| L-03 | Medium | 211 LazyLibrarian books still lack a `bookauthors` row; only the `dbupgrade.py` overlay keeps them alive across restarts. | #736 |
| L-04 | Medium | The LazyLibrarian volume penalty does not fire when a release carries only a volume number. | #738 |
| L-05 | Medium | The lenient Volume Check accepts any book sharing one distinctive word; same-series volumes pass (probed). | #739 |
| L-06 | Medium | format-pairing spends about 95 percent of its daily Google Books slice re-trying the same unmintable wants, starving LazyLibrarian's adds and the English-edition pass. | #740 |
| L-07 | Medium | The English-edition pass has made no lookup; v0.107.7 has no deploy record and no owed check. | #737 |
| L-08 | Medium | Seven patched LazyLibrarian upstream files with no test harness in git. | haynes-ops #3402 |
| W-08 | Medium | Eleven owed post-deploy checks pending with no tracker; six due at 04:54Z today. | #743 |
| W-09 | Low | Two policy rulings made by the coordinator on "needs a design decision" issues; design amendments written after the code, no plan for any change in the window. | section 4, 7 |

## 3. What was actually wrong with the initial deployment

### W-01 There was no identity contract

A want's `ll_book_id` came from one of: a Google Books title search's top hit (`resolveVolume`, `packages/goodreads/src/google-books.ts`),
a reuse of another want's id by normalized title (`normTitle` cut at the first colon, so "Mistborn: Secret History" reused
*The Final Empire*), or Libretto's broker. The status then came from whatever LazyLibrarian said about that id. Nothing
compared the title LazyLibrarian held against the title the person asked for until #698 on 2026-10-05, and nothing in
LazyLibrarian compared a release to the book beyond `token_set_ratio` over the title words, with `series` and `member`
tables empty for all 1,227 books (LL DB, read-only). Four mechanisms are listed in DESIGN-028's #693 amendment; the F10
sweep found a fifth (foreign editions) and the Discworld record a sixth (a vague title took 32 novels).

Evidence: `packages/domain/src/book-requests.ts:376` (`normTitle`), DESIGN-028 "Amendment 2026-10-05 (issue #693)", the
LL `wanted` replay (153 + 44 cross-volume rows, HANDOFF 2026-10-05 13:10Z and 14:44Z).

### W-02 Nothing measured the gap, so a ten-week defect looked like a quiet pipeline

The 2026-07-15 rule read an absent id as "LL doesn't know this book, leave it" (DESIGN-028, quoted in the #665 amendment).
From the 2026-07-30 run on, 216 pairing wants were never found again; by 2026-10-04 it was 901 of 1,237 open wants. No
report field counted them, no alert watched them, no e2e or unit test could, because the stubs model LazyLibrarian as a
store that keeps what it is given. The defect was found while auditing bundles (#661 note, "Found on the way, filed").
The same blindness holds today for orphan LazyLibrarian wants (22), foreign items (0 measured), failed grabs the app
calls `grabbed` (53), and books without an author link (211): every one of these came out of ad hoc read-only queries
during this review, not from a report.

### W-03 Eight assumptions about LazyLibrarian, all wrong, all readable in the pod

| Assumed | True | Learned |
| --- | --- | --- |
| `addBook` creates a book LazyLibrarian keeps | `add_bookid_to_db` writes no `bookauthors` row; `check_db` deletes the author and cascades the books at the next start | 2026-10-04 (#665) |
| `searchBook&type=` searches one format | `type` is log text; every `Wanted` format is searched | 2026-10-02 (#644) |
| `addBook` on a held book is idempotent | it is an upsert that resets both formats to `Skipped` | 2026-10-04 (#665 rule 6) |
| `queueBook` will not re-queue a held file | unconditional `UPDATE books SET Status='Wanted'` | 2026-09-22 |
| LazyLibrarian knows series and volume | `series` and `member` are empty | 2026-10-05 (#688) |
| only a successful download is imported | a SABnzbd `Duplicate NZB` (progress -1) was imported by the fuzzy pass | 2026-10-05 (#688) |
| `imp_preflang` keeps foreign books out | it filters author imports only; an API add logs a warning | 2026-10-05 (F10 leftovers) |
| an id absent from `getAllBooks` is a transient gap | it is a deleted row | 2026-10-04 (#665) |

Every row was established by reading the running image's Python, which has been mounted in the pod the whole time
(`.agents/context/2026-09-22-ll-push-guard-evidence.md` §1 shows the method). None was established before the feature
that depended on it shipped.

### W-04 The bulk action ran before the identity check, and the question to the owner left the risk out

Order of events: the bundle audit (10-03) and #661 (10-04 01:00Z) had already shown identity errors at scale in pairing
wants (20 parked, 8 series-name anchors, 6 wants on audiobooks their anchor did not hold). Issue #668 was written at
03:11Z and named indexer load as the only risk. The ruling came, the re-request shipped at 16:18Z, and 790 wants were
handed back with their July identities. The identity check (#698) shipped 23 hours later and cleared 76 wants and
re-titled 22 (DESIGN-036 "Measured before merge"). In between, LazyLibrarian's 04:54Z search grabbed 113 items.

The verification gate for every release in the window was the same: 3/3 pods Ready, `/api/health` 200, "no error
lines in Loki", and the first scheduled run's counters (HANDOFF blocks for v0.105.4 to v0.107.6). Those gates cannot see
a wrong book. Two releases did measure against the live mirror before merge (#664, #698); both measured the matcher's
pairs, not the outcome.

What was checked but checked wrong:

- #707 verified "parked 7" and missed the 20 in-flight wants on foreign anchors (#708, 20 minutes later).
- #675 verified the eligible count (789) and the first runs; the first runs then counted quota-wall refusals as
  failures and would have stalled the whole pass (#676, review CRITICAL).
- #669 stated expected first-run numbers rather than observed ones; the format guess from `landed` picked the held format
  (#670).
- #730's body stated "40 CPU burners" as the method; the merge followed in ten minutes.
- Every HANDOFF block says "no error lines in Loki"; Loki holds 8 error lines over the three days, all upstream 503s and one
  LazyLibrarian network failure. Error lines were never the signal; the wrong-book signal does not exist as a log line.

### W-05 F10 was law for twelve weeks and enforced nowhere

`.agents/context/2026-07-13-f10-english-audit.md` records the owner's order and "Status: NOT EXECUTED". No code, census or
alert carried it forward. On 2026-10-05 the sweeps held about 6,500 files (22 GB): German, Swedish, French, Hebrew,
Danish, Italian, Dutch and Indonesian editions, plus twelve pairing wants pushed for foreign books in July. The library
tags were wrong both ways (18 Kavita series tagged `nl` for English books; an Audiobookshelf item tagged `English` over
German audio), so any rule reading tags alone would have both blocked and leaked. The rule that landed (#707) reads tags
plus LazyLibrarian's `BookLang`, which is the right shape; it arrived three months late and still has no census (#744).

### W-06 The advisory e2e was red through five releases

PR #675 changed the goodreads push to skip `addBook` for a held book and broke `apps/web/e2e/integrations.spec.ts:109`,
the spec that exercises exactly that push. It stayed red on the heads of #675, #676, #681, #698 and #701, through six
releases, until #706 (issue #702) on 2026-10-05 17:04Z. KICKOFF says e2e "is advisory (not a merge gate), so it never
blocks a merge" (`.agents/KICKOFF.md:106`), and the PR bodies' verification sections name local unit suites only. Across
the 19 fix PRs the e2e job finished 2 to 16 minutes after the merge on 18 (PR evidence collected for this review).

### W-07 Hand writes to both databases, and nothing audited

- App database, direct SQL by one-off scripts: the bundle audit (`2026-10-03-bundle-audit.md:18`, 22 wants), the
  held-book repair parts 1 and 2 (`2026-10-04-pairing-held-book-repair.md:56` and the following table, 12 wants), and
  the Chroniken settle ("all six rows were settled in one app-DB transaction", HANDOFF 2026-10-05 14:45Z). #701 was
  then written so the code would "conform the wants a repair parked by hand". The #693 repair did it right
  (`wrong-volume-requests-repair.ts` through `repairWrongVolumeRequests`, dry run then apply).
- LazyLibrarian database, direct SQLite writes with backups: `ambiguous_ebooks.py`, `audio_split.py`, `f10_foreign_ll.py`,
  `f10_followup.py`, `f10_lang_wants.py`, `f10_sweep_fix.py`, `f10_sweep_kavita.py`, `rekey_and_sidecars.py`, plus the
  `BookFile` blanking of 2026-10-05 (#686). These bypass LazyLibrarian's API (the surface the app is confined to) and its
  invariants; the root defect of the week was itself a missing row in a side table.
- Every sync-derived write is unaudited by design (`book-requests.ts:5`): 819 `ll_book_gone`, 412 `ll_rerequest`, 79
  re-identifications, 25 re-titles and 8 landed reverts in three days exist only in Loki and in HANDOFF prose (#741).

### W-08 Verification debt

HANDOFF carries owed checks (a) to (p) plus two unlettered ones. Eleven are pending; six fall due at the 04:54Z backlog
run and the 09:10Z library scan today (listed in #743). v0.107.7 (#726) has none. There is no due field, no owner and
nothing that fires if one is missed.

### W-09 Process shape

No `.agents/plans/` entry exists for any change in the window (the re-request carried two migrations). Design
amendments were written in the same PR as the code, after the behaviour was decided, so they record rather than
decide. Two rulings on policy are the coordinator's: DESIGN-036:435 "Owner-side rulings (the coordinator's,
2026-10-05)" and DESIGN-028:708 "Ruling (coordinator, 2026-10-05 ...)", on issues #700 and #719 whose bodies say the
language and edition questions need a decision. CLAUDE.md's "Ask rather than invent" and the memory rule to push owner
decisions one at a time were not followed for either.

## 4. Were the fixes the right fixes

| Fix | Verdict | Challenge |
| --- | --- | --- |
| #658 omnibus guard | Right, narrow | A string guard on a top hit. It cannot see an omnibus whose subtitle lists nothing. Libretto carries a copy, so every change is two repos (three Libretto bumps in three days). |
| #660 parked stays parked | Right | A plain bug. |
| #664 the anchor is the book held | Right, overdue | The conceptual fix (a Kavita row is a series). The first live run showed the re-vanish resetting 312 wants, which the unit tests had not modelled. |
| #669/#670 gone rule | Right mechanism | 24 h grace and a title-plus-author re-key are sound (and now skip foreign rows). Settling 790 wants `missing` and then needing a second ruling to re-acquire them was a two-step the owner could have been asked once. |
| #675/#676 re-request | Right mechanism, wrong order | Riding LazyLibrarian's daily search instead of `searchBook` was the right indexer call. Pushing 790 July identities before the identity check (#698) existed is what made 2026-10-05 a repair day. "All at once" is in practice quota-gated: 158 of ~670 pairing wants handed back in 36 hours, 416 deferred. |
| #681 quota instrumentation | Right | Cheap, and it disproved the shared-key premise within a day. |
| #698/#701 Volume Check | Right direction, too lenient | The strict check for a changed identity is good. The lenient check passes any same-series title (#739). Clearing an id never tells LazyLibrarian (#735). #701 exists because of a hand write. |
| haynes-ops #3367 post-processor | Right, narrow | A failed SABnzbd job is no longer imported. |
| haynes-ops #3368/#3369 matcher | Acceptable stopgap, not a fix of the class | Regex over release names is the same fragility as the matcher it patches; a bare-number release is not penalised (#738); the replay was checked "by hand" with no fixture in git (#3402). Not evaluated: giving LazyLibrarian series data (its own series sources) or an app-side check of the grabbed release against the want before import. |
| #707/#708 English-only parks | Right rule | The tag-plus-`BookLang` shape is right and blank/`XXX` passing is necessary (192 blank Audiobookshelf items). The park leaves LazyLibrarian searching the book, which the F10 cleanup then undid by hand (#735). |
| #714 Kavita rolling re-read | Right | Kavita has no change signal (probed); 150 cheap GETs an hour is fine. |
| #720 landed truthfulness | Right rule, half the state machine | `landed` now follows what holds it; `grabbed` still never regresses (#734, 53 live rows). |
| #726 English edition | Plausible, unproven, wrong authority | Switching to an English volume of the same work is what the person meant. It was ruled by the coordinator on an issue that asked for a decision, deployed during the CPU incident with no record, and has made no lookup because the goodreads budget slice is spent every day before it (#737). |
| Direct database writes | Careful, wrong tool | Backups, md5 manifests and preconditions were taken. They still produced states the code had never seen (#701), bypassed LazyLibrarian's invariants, and left no audit. The #693 repair script is the pattern to keep. |
| Unaudited status writes | Over-stretched | A July design choice for a cache became the mechanism for policy changes to thousands of rows (#741). |

## 5. Still latent

- **L-01 `grabbed` never regresses (#734).** `advanceStatus` (`book-requests.ts:186`) keeps `grabbed` over `wanted`; `applyRequestReconcile` (line 658) is the only path. Live join: 59 `grabbed` formats, 53 on LazyLibrarian `Wanted` with a `Failed` last grab (2026-07-17 to 2026-10-03), 4 `Snatched`, 2 `Skipped`. The wall calls them downloading; `isRequestSearchable` allows a search but nothing tells the user it failed. LazyLibrarian also never times out a snatch (three `Snatched` since 2026-09-25 to 09-30).
- **L-02 Orphan LazyLibrarian wants (#735).** `reidentifyPairingWant` (`format-pairing.ts:854`) and `parkPairingWant` (line 1163) never unqueue. 22 wanted books have no request; the confined write surface has no `unqueueBook`.
- **L-03 `bookauthors` backfill (#736).** 211 books; the overlay is the only thing between them and the #665 mechanism.
- **L-04 Bare-number releases (#738).** `names_other_volume` returns `None` when nothing follows the volume (`resultlist.py:159`).
- **L-05 The lenient check (#739).** Probed: "Mistborn: Secret History" matches "Mistborn: The Final Empire"; "Prisoner of Azkaban (Harry Potter, #3)" matches "Philosopher's Stone"; "Wild Cards 2: Aces High" matches "Wild Cards". It is the backstop for the landed check, the goodreads push and reconcile, and `acceptEnglishEdition`.
- **L-06 Budget burn (#740).** 2026-10-05 runs: attempted 100 / unmintable 95, 97, 94; per-minute quota trips at 10:33Z and 11:32Z; the slice gone by 12:32Z. ~1,500 candidates retried hourly with no backoff, on the key LazyLibrarian's adds share.
- **L-07 English edition unexercised (#737).** Three runs log `GB daily call budget spent ... used 198, due 12`; `english_edition_tried_at` is null everywhere; no deploy record.
- **L-08 Overlays without tests (haynes-ops #3402).** Seven patched files, re-applied by hand at every image bump.
- **Same class, lower risk, not filed.** The library matcher (`normTitle`, cut at `:` and `(`) could land both formats of a request on a same-title different-subtitle item, and `revertLandedFormats` refuses to touch a library match; the ten live matched pairs whose titles differ beyond a parenthetical are all the same book, so no live instance. `pickBestVolume` (comics, Kapowarr) is token overlap with no volume check; two comic requests exist. Libretto's resolve broker duplicates the Google Books guards (three bumps in three days) and has no language rule. The Lidarr release-block terms and the Seerr `settings/main` whole-object PUT are text-heuristic and stale-read writes respectively; both carry mitigations (whole-name, artist-named terms; read-back) and neither misfired in the window.

## 6. The process failure

- **P-01 The work order had no bounds.** The coordinator dispatched "fix the flaky test" to a subagent in a pod with no CPU limit (requests 1 CPU, limits memory only; haynes-ops #3381 is a held draft). The subagent reproduced the race under 40, then 60 busy loops and 6x40 parallel vitest; dev-env's 5-minute CPU average peaked at 18.5 cores; node load samples reached 121 with scrapes missing at the peaks. EMQX (two cores, about 10 restarts), traefik (about 16), authentik (about 6) and the cloudnative-pg operator (about 14) went into liveness-kill loops. No alert fired for any of them during the window (haynes-ops #3383 added one afterwards). A different subagent, investigating a lights outage, found and killed the processes.
- **P-02 The PR said what it did.** #730's body: "reproduced by looping the file under 40 CPU burners ... 0 of 320 under the same 40-burner load". It merged ten minutes after opening. #732 then removed a second test that "flaked under load" and that #730's body had said shared no race.
- **P-03 The rule did not survive the session.** The only record is `no-cpu-burners-in-dev-env.md` in one agent's memory directory. Neither the dev-env CLAUDE.md nor KICKOFF mentions CPU, load or parallel test runs; KICKOFF tells the coordinator to delegate "running the test suite" without bounds (haynes-ops #3403).
- **P-04 The coordinator pattern amplified it.** The coordinator is told to keep its own context small and hand everything to subagents; a subagent is told nothing about what the pod is. The two halves of the knowledge (the pod has no limit; the task needs load) met in nobody.

## 7. What should change

1. **Census before action (R-01).** Any unattended change that writes to an outside system in bulk (re-request, backfill, enrolment) ships as the janitor did: an observe-only pass that lists what it would do, a sample verified by hand against the real titles, then enforcement by cohort with a kill switch. The re-request's census would have been "790 wants and the LazyLibrarian title each points at".
2. **Measure the invariants (R-02).** Report fields and alerts for: wants whose id LazyLibrarian lacks, LazyLibrarian wanted formats no request owns, `grabbed` with no `Snatched` behind it, foreign items and foreign LazyLibrarian wants, books without `bookauthors`. Each is one query; each would have found a finding in this report weeks earlier (#735, #744, #734, #736).
3. **A LazyLibrarian contract (R-03).** One document of verified facts about the pinned image (the eight above and the ones in the 2026-09-22 note), each quoting the source line, read before any design that depends on LazyLibrarian; the stubs encode those facts, and a bump of the image re-verifies them. The same for Google Books (top hit, language, omnibus) and the library tags (unreliable both ways).
4. **Verification that can see a wrong book (R-04).** A deploy of the books pipeline is verified by a short list of named requests and the LazyLibrarian title each points at, not by pod readiness and counters. The HANDOFF owed-checks become a dated table with a due time and an owner, and the recurring LazyLibrarian ones become a read-only Job (#743).
5. **Red e2e stops the train (R-05).** Required for pipeline packages or on the release-please PR (#742). A PR waits for the advisory review and reads it; this review was the one gate that caught real defects, and it needs the minutes it takes.
6. **No hand writes (R-06).** Repairs go through domain single writers in a script with `--dry-run` and `--apply` (the #693 pattern), LazyLibrarian is changed through its API or through a written overlay, and every sync-derived write lands an event row (#741).
7. **Owner questions stay the owner's (R-07).** A policy that changes what gets downloaded (language, edition, bulk re-acquisition) is a `Q-NN` pushed through AskUserQuestion, with the known risks stated; the coordinator rules only on reversible, in-app behaviour. #668's question should have carried the identity risk the bundle audit had already shown.
8. **Bounded work orders (R-08).** Every subagent work order states where it runs and what it may consume; no load reproduction in the pod; the pod gets its CPU limit (#3381) and the rule goes into the shared CLAUDE.md (#3403). A PR body that describes a method the rules forbid is a review finding, not a verification section.
9. **Pace (R-09).** Twelve releases in two days each needed the next one. One release per cycle with its owed check discharged before the next feature, and fixes batched when the first run shows a sibling defect.
10. **Fix the class, not the row (R-10).** The matcher overlays, the Volume Check and the re-request each fixed the instance seen. The class is "a fuzzy text match decides a download": give LazyLibrarian series data or verify the grabbed release against the want before import; make the lenient check a coverage rule; stop re-trying what cannot resolve (#738, #739, #740).

## 8. Owed checks due now

From HANDOFF, all pending at the time of writing (2026-10-06 02:00Z); the LazyLibrarian ones fall due after the
04:54Z backlog run and the 09:10Z library scan: (k) `dGy0EAAAQBAJ` gets a book 1 release; (l) none of the 19 cross-volume
records grabs, `YVfJMgEACAAJ` and `ik6xzgEACAAJ` stay Skipped, every file link resolves; (n) no new `wanted` row for
`ik6xzgEACAAJ` and no request points at it; (o) no new row for `YVfJMgEACAAJ`, `pairing_resolve_rejected` rare; (p) the Dead
or Alive, Israel Potter and Murtagh grabs are English, no foreign grab, rowids 9552 to 9558 not grabbed again; (j) repeat (f)
until no `missing` pairing or collection want waits. Later: (b), (d), (e), (i), the v0.107.5 six-mint check, and (m) on
or after 2026-10-12. New: the first 07:41Z goodreads-sync run must show `englishEditions.looked` above zero and a logged
outcome for Azazel `415e4d34` (#737).

## 9. Issues opened by this review

haynesnetwork: #734 (grabbed never regresses), #735 (orphan LazyLibrarian wants), #736 (bookauthors backfill), #737
(English-edition pass starved, no deploy record), #738 (bare-number releases), #739 (lenient Volume Check), #740 (pairing
budget burn), #741 (audit trail for derived writes), #742 (e2e as a gate), #743 (owed-check tracker), #744 (F10 census).
haynes-ops: #3402 (overlay tests), #3403 (CPU rule and limit).

## Appendix: the evidence queries

- App database (CNPG primary `postgres16-1`, `PGOPTIONS='-c default_transaction_read_only=on'`): status matrix by origin;
  `grabbed` formats with `ll_book_id`; `unroutable_reason` counts (47 parked: 15 `wrong_volume`, 16 `foreign_language`,
  10 `multi_book` pairing, 6 `wrong_volume` collection); `english_edition_tried_at` (0 set); `permission_audit` since
  2026-10-03 (67 `request_book_search`, nothing else); matched goodreads requests whose title differs from the item.
- LazyLibrarian (`/config/lazylibrarian.db`, `mode=ro`): 1,227 books, 255 authors, 211 without `bookauthors`; `BookLang` en
  1,197 and 30 foreign, 0 foreign `Wanted`; 367 books wanted or snatched, 22 with no request; `wanted` 8,736 rows (Failed
  4,423, Processed 3,514, Seeding 793, Snatched 6); grabs per day 2026-09-29 to 10-05; the join of the app's 59 `grabbed`
  formats to LazyLibrarian status and last grab.
- Loki (`{namespace="frontend"}`, 3 days): `ll_book_gone` 819, `ll_rerequest` 412, `pairing_want_reidentified` 79,
  `pairing_want_retitled` 25, `request_landed_reverted` 8, `foreign_language park lifted` 14, `gb_quota_trip` 3; error
  lines 8; format-pairing run lines 2026-10-05 07:33Z to 12:32Z and 2026-10-06 00:32Z, 01:32Z; goodreads-sync
  `english_edition` lines 23:41Z, 00:41Z, 01:41Z.
- Prometheus: `node_load1` for talosm02 and dev-env container CPU, 2026-10-05 22:00Z to 2026-10-06 01:00Z; restart
  increases by pod; `kube_pod_container_resource_limits` for dev-env; `ALERTS` in the window.
- GitHub: PR bodies, reviews and check timings for #658, #660, #664, #669, #670, #675, #676, #681, #698, #701, #706, #707,
  #708, #714, #720, #726, #728, #730, #732; haynes-ops #3322, #3328, #3351, #3367 to #3369, #3381, #3382; issues #665,
  #668, #674, #719.
- Code probe: `llBookMismatch` and `llBookNamesTitle` from `packages/domain/src/ll-book-check.ts` over seven title pairs
  (table in #739), run once with the workspace `tsx`.
