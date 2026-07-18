# Kometa config edit-in-place (owner ruling 2026-07-18 evening)

Branch `feat/kometa-config-edit`. Supersedes the read-only treatment #414 shipped.

## Owner ruling

> "the point of the collections config UI was to edit Kometa configs by add / update / editing
> collections."

Plus a copy critique: the chip "managed in the estate's Kometa config" was far too verbose.

## What shipped

- **Read ALL Kometa config files**, not just the app include. New pure module
  `packages/domain/src/kometa-hand-config.ts` parses every `movies-*.yml` / `shows-*.yml` under
  `kubernetes/main/apps/media/kometa/app/config/` into its collections (name, builder, editability,
  find-missing). `packages/haynesops` read client gained `listDirectory`.
- **One source-badged list** for Movies/TV (dropped the two-group split): app recipes = "Added here",
  hand-file + Defaults rows = "Kometa config". Books tabs keep their groups; chip shortened to
  "made in Kavita" / "made in Audiobookshelf".
- **Edit-in-place** for hand-file collections: a SURGICAL, byte-faithful text splice of only that
  collection's builder ref (or its `<arr>_add_missing`/`_search` keys, or a whole-block removal), opening a
  haynes-ops PR against THAT file. Hand-file PRs are ALWAYS human-merged (D-10 unchanged — managed-file-only
  already forbids auto-merge on a sibling). Adds still flow to the managed include and can auto-merge.
- **Editability honesty (D-04):** editable only when a block reduces to one allowlisted builder + a valid
  ref. Multi-builder / query-search-regex / template-var / bad-ref → Edit disabled with tooltip
  "Too custom to edit here. Edit the config directly." Name + builder locked on a hand edit; only the ref
  (and find-missing) is editable.
- Cap applies to non-admin edits (unprovable-size ref → over-cap ticket path). Delete of a hand collection
  is admin-only. Single-writer + audit-in-same-tx.

## The real-config counts (parsed from haynes-ops main this session)

153 hand-authored collections across the 7 live config files; **43 editable** (movies 26, TV 17), 110 not.
The remaining ~312 of the mirror's 465 `created_by='kometa'` collections are Kometa **Defaults** output
(config.yml universe/seasonal/franchise/awards) — listed but non-editable (no file to splice).

## Known seam (documented, not fixed)

A non-admin's over-cap hand EDIT files a `collection_override` ticket whose admin approval currently
materializes into the app-owned managed include (a title-merge twin), not the hand file. Admins (the owner,
the primary editor) bypass the cap, so this edge rarely bites. A hand-file materialize path is a follow-up.

## Files

- `packages/domain/src/kometa-hand-config.ts` (new parser + splices)
- `packages/domain/src/kometa-collections.ts` (overview merge + `editKometaHandCollection` /
  `setKometaHandFindMissing` / `deleteKometaHandCollection`)
- `packages/haynesops/src/read.ts` (`listDirectory`)
- `packages/api/src/routers/collections.ts` (`editHandCollection`, `remove`/`setFindMissing` handFile)
- `apps/web/app/(app)/collections/collections-client.tsx` (one list, source badges, disabled Edit, hand
  edit composer)
- Tests: `packages/domain/__tests__/kometa-hand-config.test.ts` (fidelity + editability matrix),
  `packages/api/__tests__/collections.test.ts` (hand-edit API paths)
- Docs: DESIGN-042 D-01 / D-02 / D-04 / D-10 revisions
