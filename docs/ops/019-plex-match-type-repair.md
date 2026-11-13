# OPS-019 — Plex match type repair: reading the dry run

- **Status:** Active (2026-11-13). Written with ADR-123 / DESIGN-025 D-10 (story 847).
- **Scope:** how to print the cross-type match rows the repair would delete, and where that delete actually runs. This page does not change a Trash rule, a pace, or a protection.
- **Normative basis:** ADR-123, DESIGN-025 D-10.
- **Repos:** this app. The hourly job is `haynesnetwork-sync-plex-match` in namespace `frontend` (`52 * * * *`).

---

## 1. What the dry run prints

`packages/sync/src/scripts/plex-match-type-repair.ts --dry-run` writes nothing. It prints one line per selected row, then one JSON summary:

```text
<title><TAB><year><TAB><kind><TAB><server>/<library>
{"dryRun":true,"selected":N,"removed":0,"groups":[...]}
```

The year is empty when the ledger has none. The groups are the same counts the census uses: server, library, library type, kind, and which id matched.

The script judges type from the registry (`plex_libraries.media_type`). It does not read Plex. Do not `--apply` while a live section type disagrees with that registry: the hourly sync leaves such a library out of the delete, and the script does not.

## 2. Where it is run

After the image that contains the script is deployed, in a pod of that image (namespace `frontend`, container `app`):

```sh
kubectl -n frontend exec "$POD" -c app -- tsx /sync/src/scripts/plex-match-type-repair.ts --dry-run
```

`--apply` deletes the selected rows and nothing else. Story 847 does not run `--apply` against production. The delete that follows the release is the hourly `haynesnetwork-sync-plex-match` run: it reads Plex, upserts, deletes cross-type rows, then reconciles. A stale wrong row in a library that run read in full is logged as `crossTypeRemoved`. When that count is not zero the same line's groups name the libraries. A library whose live section type disagrees with the registry is logged at error as `typeDisagreements` and left out of the delete.
