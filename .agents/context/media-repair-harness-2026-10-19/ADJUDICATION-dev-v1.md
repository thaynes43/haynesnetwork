# Coordinator adjudication of the dev-v1 frontier misses (2026-10-19, claude-opus-5-5)

Input: `baseline/REPORT.md` §6 (PR #1007). These rulings are for the DEV split only. The held-out set (sealed) is
not touched. Each ruling is based on the evidence handed to the model, never on a model's opinion. It produces
`dev-v1.1`. `dev-v1` stays frozen as-is, and its runs are re-scored under v1.1 labels as a separate column.

| # | Case | Ruling | v1.1 change |
|---|---|---|---|
| 1 | tv-insuff-002 | Label sound. A real miss by all six models: an unverified half is not "no defect". | none. **Primary regression for the harness rule "unverified segments never mean healthy"** |
| 2 | epub-insuff-002 | Over-strict. A French edition where English is expected is a wrong-language release. | class identity_mismatch, supported [blocklist_and_search, escalate], truth.ref notes the language rule |
| 3 | epub-identity-005 | Under-evidenced. Nothing tells the model what chapters the expected book has. | add authoritative expected-TOC evidence (from the construction recipe) to context.arr; label unchanged; re-run |
| 4 | epub-identity-004 | Label sound, hard. | supported adds escalate (abstaining for a human on one subtle string is acceptable, a false healthy is not) |
| 5 | epub-identity-001 | An omnibus can legitimately contain the novel. | supported [blocklist_and_search, escalate] |
| 6 | epub-identity-002 | Label sound. The case lacks the arr context needed for a write action. | add context.arr app/ids (synthetic, read-only stub); re-run |
| 7 | movie-identity-001 | Release name only. | supported [blocklist_and_search, escalate] |
| 8 | tv-identity-001 | Evidence fits both a wrong release and a misfiled other episode. | supported [blocklist_and_search, escalate]. remap is NOT supported (nothing shows the other slot is missing) |
| 9 | tv-identity-002 | Label sound (a contrived swap). Over-caution, plus a pinned row that cannot be sampled live. | add replay for the pinned row's OCR so the failed follow-up is not an artifact; re-run |
| 10 | audiobook-naming-001 | Soft. The prompt never defined the taxonomy. | label unchanged; fixed by the harness prompt v2 taxonomy (blank required tags = metadata_naming) |
| 11 | audiobook-order-001 | Under-specified: no wanted edition is stated. | accepted_classes [order_edition_ambiguity, healthy], supported [escalate, none] |
| 12 | audiobook-insuff-001 | Action right, class overlaps. | accepted_classes [insufficient_evidence, metadata_naming] |
| 13 | movie-insuff-001 | Action right, class overlaps. | accepted_classes [insufficient_evidence, order_edition_ambiguity] |

## Cross-cutting rulings

- **CONTRACT v1.1:** an optional `accepted_classes` list (default `[truth.class]`). The scorer counts class as
  correct when the decision's class is in it. Write actions on any case whose accepted classes include
  `healthy` or `insufficient_evidence` are still unsupported (G1), unless the case's supported_actions lists them.
- **remap vs rename (8 of 23 G1 counts):** the prompt v2 defines `rename` (change only file, tag or metadata names;
  content is right and in the right slot) and `remap` (re-link a file the *arr has in the wrong slot onto its right
  episode or entry, no download). Each naming case's supported set must list every write that would actually fix
  it, decided from the case's construction. A model picking the other one counts as G1 only if that write would
  not fix it.
- **Filename bias:** give defective cases the same mix of odd, scene-style and edition-tagged names that the
  healthy controls have. Change `context.filename` only, never the fixture bytes.
- **G8 rule:** a decision fails G8 only if it cites a failed tool's evidence id as support, OR reaches a non-abstain
  class that only the failed tool could have shown. Merely mentioning the failure passes.
- **Leak-guard false positive (fixed in 244913c0):** keep a regression test for it.
- The original v1 records and scores are never deleted.
