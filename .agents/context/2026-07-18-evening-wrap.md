# 2026-07-18 evening wrap — owner-driven iteration day (v0.81.0 → v0.84.0)

Continues the overnight wrap (same file dir, `2026-07-18-overnight-wrap.md`). The owner verified
live all day and ruled; the fleet shipped each ruling same-day. Four more releases, all
data/digest-verified.

## Shipped today (after the overnight run)
- **v0.81.0** trash autonomous promotion (ADR-073) + collections full-width + Dune media-type
  authority + GB sibling-reuse. Trash ground truth: the owner's save window was the only delay;
  admin-review greenlight was the sole ruling violation, now removed. First fully autonomous cycle
  follows the 07-25 ~16:39Z sweep.
- **v0.81.1** GB addBook dedup (#409) — root cause of the quota drain was OUR hourly re-adds
  (~23 titles × 12-24/day amplified through LL). Proof point: the 07-19 07:32 UTC pairing run.
- **v0.81.2** Collections nav → user-menu "Collection settings" (four-tab row restored, no-scroll
  at 320 re-asserted) + wall-drill "Edit collection" deep links (#412) + two-population list (#414).
- **v0.82.0** EDIT the estate's Kometa config collections in place (#415, owner ruling): surgical
  hand-file splice via human-merged haynes-ops PRs; 43/153 hand collections editable under the
  allowlist; short "Added here"/"Kometa config" badges; Defaults rows honestly uneditable.
- **v0.83.0** "Run now" retired → registry-standard **Force Search** on collection rows (#418,
  owner nomenclature ruling; label lint-retired). + Libretto search client (#417), DESIGN-044 (#419).
- **v0.84.0** the **full-page collection builder** (#421, DESIGN-044): /collections/new +
  /collections/<id>/edit, builder cards with plain-language copy, search-first ref (Libretto
  search live: Hardcover series + NYT; Radarr/Sonarr lookup for movies/TV incl. the franchise
  `collection` field), live in-library/missing tile preview + cap meter, Modal composer REMOVED.
- **Libretto** shipped + deployed `GET /api/search` + `POST /api/preview` (its PR #10).
- **Kometa write path ARMED end to end**: owner minted the fine-grained PAT (haynes-ops,
  contents+PR write) + 1Password field `HAYNESOPS_WRITE_TOKEN` on the `haynesnetwork` item;
  haynes-ops #2114 merged; ES synced; Kometa `/config/config.yml` regenerated with the managed
  includes; app pod carries the token.

## Standing state
- Prod: **v0.84.0**, journal 69 (no new migrations all day), health ok.
- Watch armed: 07-19 07:40 UTC verifier — GB events at :32 should collapse to ~0 addBook-driven;
  pairing backlog (210, incl. 27 ISBN-bearing) should finally resolve through the fresh window.
- Owner does his full pass this evening (was AFK for the v0.82-0.84 stretch).
- Residuals: builder-page hardening (unsaved-nav guard deferred), imdb_search badge casing nit,
  the perpetually-cancelled advisory e2e workflow (zero signal — cleanup candidate), over-cap
  hand-file materialize seam (#415 note), `agent-db-fixheal` stale job awaiting the owner's look.
- New owner rules captured as memories: cross-repo PR hygiene (short bodies, full URLs, no bare
  doc IDs); backlog/saga notes always merged to main (codified in CLAUDE.md § Workflow).
