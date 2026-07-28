# 2026-07-28 — Leaving Soon duplicate-collections incident (root cause, cleanup, ADR-078 fix)

Owner report: Plex Home (HaynesOps server) showed **four identical "Leaving Soon — Movies" rows**;
no "Leaving Soon" visible in the library Collections tab (buried among 448 collections).

## Evidence chain (all live-verified 2026-07-28)

- Plex (via the Maintainerr media-server proxy, `https://maintainerr.haynesops.com/api/media-server/...` —
  the dev-env pod cannot reach Plex directly; egress allows only the internal ingress): FOUR collection
  objects titled "Leaving Soon — Movies" in library 1 — ratingKeys **98724** (2026-07-07, the real one)
  / **98887** (07-11) / **99586** (07-18) / **100233** (07-25). All four resolved the SAME 48 children
  (Plex membership is a title tag), so each rendered a full identical Home row. TV library clean.
- Maintainerr `GET /api/collections`: only the two `hnet` rule collections (ids 1, 3) — **no**
  Leaving-Soon record, despite space-policy showing an OPEN movie batch `1680f30c…` in `leaving_soon`
  (promoted 07-25 15:17 EDT, "Adding collection to the database.. / Adding 50 media items").
- The vanish window: CollectionWorkerService counted "3 total (isActive), 1 skipped (Do Nothing)" at
  26/07 00:00 and "2 total" at 12:00; between them only `[RuleMaintenanceService] Starting maintenance`
  (04:20). v3.19.0 source: `removeCollectionsWithoutRule()` deletes every collection record with no
  rule group — raw repo delete, **no logging, no Plex-side cleanup**. The app's `POST /api/collections`
  create makes exactly such a record.
- The broken save: 26/07 16:41:30 `[CollectionsService] Collection with id 21 not found, skipping removal`
  — a member's save hit the purged record; `removeFromCollectionInternal` no-ops tolerantly, so the
  "rescued" item stayed on the Plex wall.
- The duplicate factory: with the record purged nightly, every weekly promote re-created it; the bare
  collection create path (`createCollectionWithChildren`, `empty=false`) mints a NEW Plex object
  unconditionally and promotes it to Home/Recommended. Four cycles (07-07/11/18/25) → four objects.

## Cleanup (operational, done 2026-07-28 ~04:30 UTC)

Deleted 98887, 99586, 100233 one at a time via `DELETE /api/media-server/collection/:id`, verifying
after each that 98724 still resolved its 48 children (it did; a recovery snapshot of the membership
was taken first). Plex now has exactly ONE "Leaving Soon — Movies" (98724). The `childCount`
attribute on it reads 0 while children resolve 48 — the same stale-metadata quirk the empty
duplicates showed; Home rows render from resolved children.

## Fix (ADR-078, this PR)

Rule-group SHELL transport + self-heal + membership reconcile + group-cascade teardown — see
`docs/adrs/078-leaving-soon-rule-group-shell.md` and DESIGN-011 D-03 (amended). The open batch
`1680f30c…` still points at purged record id 21; the deployed heal re-drives it on the next hourly
space-policy tick (`:17`) or first save — it will adopt 98724 by title, reconcile membership to the
current pending set (stripping the 07-26 failed-save item), and re-point the batch row with an
audited ledger event.

## Post-deploy validation contract

1. Next `sync-space-policy` run after deploy: reason string contains "Re-drove its missing
   Leaving-Soon collection"; `GET /api/collections` shows a "Leaving Soon — Movies" record and
   `GET /api/rules` shows its `useRules:false` shell.
2. After the NEXT RuleMaintenanceService run (04:20 America/New_York): the record is still there
   (pre-fix it died every night).
3. Plex library 1 still has exactly ONE "Leaving Soon — Movies" object (no new ratingKey).

## Residuals / follow-ups

- Consider an upstream Maintainerr issue: `removeCollectionsWithoutRule` deleting API-created
  collections nightly, unlogged, is hostile to the very API surface it ships.
- Unrelated noise seen in the logs, worth a look someday: hourly Seerr request-removal loop on rule
  collection 98837 with repeated `Failed to remove item 14312/4840 from collection 98837`.
