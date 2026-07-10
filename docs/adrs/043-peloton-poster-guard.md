# ADR-043: Peloton poster guard — durable override art + drift-restore sync mode

- **Status:** Accepted
- **Date:** 2026-07-10
- **Deciders:** Tom Haynes (owner authority delegated to Fable 5 for the asset-home call)

## Context and problem statement

The k8plex **HOps Peloton** ytdl-sub library (ADR-038, surfaced read-only under Library by PLAN-022)
loses its posters whenever `peloton-config-manager` re-downloads or Plex re-scans: the class-type **shows**
revert to a generic thumb and the duration **seasons** (Season 5/10/…/120) lose the "N MINUTES" art. The
owner has authored a durable set of override posters (13 series + 10 duration PNGs, ~51 MB) and wants a
guard that keeps them applied without manual re-uploads. This was captured as the PLAN-022 deferred
question Q-01 (→ PRD Q-06) and ADR-038 C-09 (durable-poster store deferred).

Two decisions are entangled: **(1) where the durable asset bytes + their mapping live**, and **(2) how the
guard applies them without clobbering, looping, or leaving no audit trail.** Plex writes are otherwise
forbidden in this app except the ADR-017 sharing surface, so a poster upload is a **new** confined write.

## Decision drivers

- **51 MB rules out a ConfigMap** (1 MiB limit) and is awkward for etcd generally.
- **Durability + backup** — the art must survive a re-scan, a pod restart, and a cluster rebuild.
- **Edit ergonomics** — owner/agent drops a new PNG → the guard picks it up, ideally reviewably.
- **CronJob access** — the k8plex-facing guard job must reach the bytes with no bespoke infra.
- **Respect the standing posture** — ADR-019 / ADR-038 (option 9) / ADR-041 (option 5/6) all **reject
  storing poster bytes in Postgres `bytea` or a PVC**; the app proxies art, it does not warehouse it.
- **Non-destructive + auditable** — never delete gallery art; record every re-apply; re-apply only on drift.
- **Import confinement** — a Plex write must live behind `@hnet/plex`'s write subpath (ADR-017 C-10).

## Considered options

**Asset-home (where the 51 MB of PNGs + the mapping live):**
- **(a) App-repo, baked into the image.** `packages/sync/assets/peloton-posters/*.png` + a checked-in TS
  mapping. Versioned, PR-reviewed, byte-diffable; already present in the CronJob's own image (no mount).
  Cost: +51 MB image layer; changing art needs a release.
- **(b) Postgres `assets` table (`bytea`).** The owner's initial lean. Backed up with the DB, editable via
  an admin upload path. Cost: introduces the **exact bytea-poster pattern three accepted ADRs reject**, and
  needs a new admin upload UI + a migration carrying binary blobs; not diff-reviewable.
- **(c) NFS share on gasha01.** Drop-in, no release to change art. Cost: couples the guard to an NFS mount,
  no version history/review, availability tied to the NAS.

**Guard state/audit:** a mutable per-target upsert vs an **append-only ledger** (latest row per target =
current baseline); a `sync_runs`-bracketed run vs the smart-alerts precedent (no `sync_runs` row).

## Decision outcome

Chosen option: **(a) app-repo bytes + a checked-in mapping, with the DB holding an append-only apply
ledger** — because it is the only option that satisfies *durable + reviewable + zero-new-infra* without
adopting the bytea-poster pattern this codebase has thrice rejected. The bytes are versioned in git
(backed up, diffable, PR-gated) and ride the CronJob's own image, so the guard reads them from local disk
with no PVC, NFS mount, ConfigMap, or DB blob. The **DB is used for what the DB idiom is actually for**
here — the single-writer, auditable **drift baseline + audit trail** — not for warehousing pixels.

> **Divergence from the owner's stated lean (option b, DB import):** the owner leaned DB-bytea but
> explicitly delegated the final call to this ADR. Option (b) collides head-on with ADR-019/038/041 (no
> poster bytes in `bytea`/PVC) and would require a bespoke admin upload surface; the premise that "the app
> DB already stores cached poster bytes per PLAN-004" does not hold — PLAN-004 stores poster **references**
> (`poster_source`/`poster_ref` strings), never bytes. Git-in-image gives the same durability/backup with
> better review ergonomics and no anti-pattern. **Flagged for owner review** (see PLAN-024 owner notes);
> the mapping/asset dir is trivially portable to a DB or NFS home later if the owner prefers — only
> `createFilePosterAssetSource` + one ADR would change, the guard logic is source-agnostic.

The **guard** is a new `poster-guard` `@hnet/sync` mode → `@hnet/domain runPelotonPosterGuard`. It resolves
the Peloton section by title, walks shows + seasons, maps each to its override by **live title / season
index** (never a pinned ratingKey), and **re-applies only drifted targets** via a new confined
`PlexWriteClient.uploadPoster`. Each re-apply appends one `poster_guard_applications` row (drift baseline +
audit) in the same transaction. Mirrors the smart-alerts mode: no `sync_runs` row, a self-generated
correlation `run_id`, degrade-safe. Scheduled hourly (a haynes-ops CronJob mirroring `sync-smart-alerts`).

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: the durable override PNGs live in `packages/sync/assets/peloton-posters/` (git-versioned, baked into `ghcr.io/thaynes43/haynesnetwork`); the guard reads them from the image with no PVC/NFS/ConfigMap/DB-blob. Respects ADR-019/038/041 (no poster bytes in the DB). |
| C-02 | Good: the mapping (`PELOTON_POSTER_MAPPING`) resolves by **live show TITLE + season INDEX**, so new shows/seasons auto-map and a Plex re-index that changes ratingKeys never breaks it. Filenames are normalized in the durable copy (`60-minuites-02.png`→`60-minutes.png`, `90-minuites.png`→`90-minutes.png`). |
| C-03 | Good: unmapped targets (unknown show, or season index `0`/`75` with no asset) are **reported, never guessed**; a mapped filename missing from the image is reported (`missingAssets`) and skipped, not fatal. |
| C-04 | Good: re-apply is **non-destructive + reversible** — `POST /library/metadata/{id}/posters` selects the new poster but Plex keeps the prior art in the item's gallery. The one sanctioned drift-test resets a target to a prior gallery image (reversible). |
| C-05 | Good: the append-only `poster_guard_applications` ledger is both the **drift baseline** (newest row per ratingKey = the thumb we recorded post-upload + the asset sha256) and the **audit trail** (`reason` ∈ initial/drift/asset-updated, `previous_thumb`). Written only by the `@hnet/domain` single-writer, same-tx; guard-listed. No `sync_runs` row (smart-alerts precedent); `run_id` is a per-run correlation uuid. |
| C-06 | Good: bounded + drift-gated — steady state is ~1 listSections + 1 listSectionContents + one children read per show (~14 reads) and writes **only** on drift (normally zero). Safe hourly. (The very first run has no baseline ⇒ it re-applies all mapped targets once — idempotent, same bytes.) |
| C-07 | Good/constraint: the poster upload is a **new confined write** — `PlexWriteClient.uploadPoster` behind `@hnet/plex`'s write subpath, called only by `packages/domain` (ADR-017 C-10 guard extended; the raw-body path added to `PlexHttp`). |
| C-08 | Bad/accepted: changing the canonical art requires a **release** (image re-bake) rather than a live drop-in; +51 MB image layer. Accepted as the cost of versioned/reviewed art; the source-agnostic asset seam makes a later move to DB/NFS a one-file change. |

## More information

- Supersedes the deferral in **ADR-038 C-09** (durable-poster store) and answers **PRD Q-06 / PLAN-022 Q-01**.
- Builds on **ADR-041 C-07** (the poster proxy's single-resolve seam) only indirectly: the guard restores
  art **on the Plex server**, so the existing ADR-041 proxy self-invalidates (its ETag is keyed on the
  thumb path, which changes on every apply) — no proxy/cache change is needed.
- Reuses the **ADR-040 / DESIGN-020** smart-alerts mode shape (early-return sync mode, single-writer,
  guard-listed table, haynes-ops CronJob mirroring `sync-smart-alerts`).
- Satisfies **PRD R-137..R-140**; realized by **DESIGN-021**; operated per **OPS-010**; delivered by
  **PLAN-024** (migration 0034, glossary T-124..T-125).
