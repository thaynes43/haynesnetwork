# Collections manager — list BOTH populations per tab (fix/collections-list-all)

Date: 2026-07-18
Branch: `fix/collections-list-all`

## The gap (owner-reported)

`/collections` Movies + TV tabs showed "No movies collections yet" even though the estate mirror
carries ~465 Kometa-produced collections. The client rendered only `data.recipes` (app-authored
managed-file recipes — zero) and ignored the mirror rows the server already returned. Same blind spot
on Books/Audiobooks: hand-made Kavita/ABS collections (no Libretto recipe) were invisible.

## Prod evidence (read-only psql Job, frontend ns, deleted after)

`plex_collections` by `created_by` × library media_type:

| media_type | created_by | count |
|---|---|---|
| movie | kometa | 441 |
| movie | plex  | 4 |
| show  | kometa | 24 |
| show  | plex  | 1 |

Total `plex_collections` = 470. The `created_by='kometa'` constant in `readProducedCollections` MATCHES
reality — no constant change needed. The tiny `plex` hand-made minority (4 movie + 1 show) is out of
scope for the Kometa-config read-only group.

`books_collections` by source × created_by:

| source | created_by | total | with recipe |
|---|---|---|---|
| audiobookshelf | libretto | 4 | 4 |
| kavita | libretto | 15 | 15 |
| kavita | kavita | 7 | 0 |

So Books gets 7 hand-made Kavita read-only rows; Audiobooks gets 0 (all 4 ABS are Libretto-managed).

## What shipped

- **API** (`packages/api/src/routers/collections.ts`) — both `overview` branches now return a
  `readOnly[]` array beside `recipes[]`.
  - Kometa: mirror collections whose normalized title does NOT join a managed recipe →
    `{ name, itemCount, managedBy: 'kometa_config', source: null }`.
  - Libretto: `books_collections` rows with `libretto_recipe_id IS NULL` for the tab's media type
    (audiobookshelf ⇒ audiobooks, kavita ⇒ books) → `{ ..., managedBy: 'hand_made', source }`.
- **Client** (`collections-client.tsx`) — MediaSection renders two groups: "Managed here" (recipes,
  full controls) and "From the estate's config" / "Made in your library apps" (read-only rows, one
  muted chip, no controls). One `library-search` input above both groups filters client-side. Empty
  state only when BOTH groups are empty; a no-match search shows a quiet note. Post-#412 deep-link
  idiom untouched.
- **Tests** — two new API cases (Kometa read-only + no-duplicate; Libretto hand-made per-tab). Mirror
  rows seeded ONLY through `syncPlexCollections` / `syncBooksCollections` (no-direct-state-writes guard).
- **Capture** (`capture-collections.ts`) — seeds a hand-made Kavita collection via `syncBooksCollections`
  so the Books tab shows the read-only group; waits on `collections-readonly-list`.
- **Docs** — DESIGN-042 D-02 amend + DESIGN-043 D-02 amend.

Green: typecheck, lint, lint:css, test (full), build.
