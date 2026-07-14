# ADR-056: Kapowarr comic acquisition — confined client + comic request routing

- **Status:** Accepted
- **Date:** 2026-07-14
- **Deciders:** Tom Haynes
- **Builds on:** ADR-055 (integration linking + app-side Goodreads shelf sync + the confined LazyLibrarian
  request surface). ADR-055 is Accepted and immutable; this ADR is a **follow-on**, not an edit — it adds the
  comic-acquisition leg ADR-055 named but deferred ("Comics are Kapowarr's domain, not LL's").

## Context and problem statement

ADR-055 / PLAN-044 shipped Goodreads → book/audiobook requests through LazyLibrarian (LL), and explicitly
**parked** any comic-classified shelf want: a comic must never blind-fire into LL (LL grabs prose, not the
GetComics DDL sources comics come from). The owner deliberately shelved two real comics
(*Scott Pilgrim's Precious Little Life* vol 1; *Zero Year: Part 1 — DC Comics: The Legend of Batman*) to
"rest comic acquisition on top of books." **Kapowarr** is the estate's comics *arr (deployed by PLAN-023 in
ns `downloads`, `kapowarr.haynesops.com`, API on :5656) — it resolves a ComicVine volume, monitors it, and
acquires from its **own** GetComics DDL sources. PLAN-023 left "wire a ComicVine API key" as an owner TODO;
that key **is now present** (verified live 2026-07-14 — ComicVine volume search returns real matches), so the
live leg is operable.

We need: (a) a confined Kapowarr client mirroring the `@hnet/arr` / `@hnet/lazylibrarian` read/write split;
(b) a routing path that turns a comic-classified `book_requests` row into a monitored Kapowarr volume and
reconciles its state back; (c) a force-search surface the Library "Force Search" button (PLAN-045) calls for
a comic — all without ever touching MAM / qBittorrent / Prowlarr / the PLAN-039 governor (Kapowarr's sources
are wholly separate), and without disturbing the ADR-046 mirror or the ADR-055 book path.

## Decision drivers

- **Kapowarr uses ITS OWN sources** (GetComics DDL). It must NOT be wired anywhere near
  MAM/qBittorrent/Prowlarr/the governor — the compliance machinery is prose-torrent-only.
- **No new external write surface leaks** — the Kapowarr acquisition surface (`@hnet/kapowarr/write`) is
  import-confined to `packages/domain`, exactly like `@hnet/arr/write` / `@hnet/lazylibrarian/write` (the
  arr-write-import-guard, extended).
- **ADR-046 + ADR-055 stand:** `books_items` is a pure mirror; request/Missing state lives in `book_requests`.
  The comic leg EXTENDS that ledger (a third per-format status), it does not fork a new table.
- **Graceful degradation:** if Kapowarr/ComicVine is unreachable/unconfigured, comics stay **parked**
  (`unroutable_reason='comic'`, `comic_status='requested'`) — the honest "we couldn't route it yet" state,
  never a fabricated add.
- **One force-search endpoint** for the whole Library book wall (PLAN-045): `integrations.search` dispatches
  a comic to Kapowarr and a book/audiobook to LazyLibrarian, both audited identically.

## Decision (C-01 … C-06)

- **C-01 — `@hnet/kapowarr`, read/write split.** A new confined client: the `.`/`./read` surface (ComicVine
  volume search, added-volume list/detail, root-folder list) is import-unrestricted; `./write` (add volume /
  set monitored / trigger the `auto_search` task) is import-confined to `packages/domain`. Kapowarr wraps
  every response in `{ error, result }`; the http layer unwraps it, retries transient 5xx/network/timeout with
  backoff, and **redacts the `api_key`** from every error. Env: `KAPOWARR_URL` (in-cluster default
  `http://kapowarr.downloads.svc.cluster.local:5656`) + `KAPOWARR_API_KEY` (required secret; 1Password
  `kapowarr` item, `HaynesKube` vault). The arr-write-import-guard test is extended for `@hnet/kapowarr/write`.

- **C-02 — comic_status: a third per-format status on `book_requests`.** Migration 0046 adds three nullable
  columns: `comic_status` (the five `BOOK_REQUEST_STATUSES` or NULL), `kapowarr_volume_id` (the local Kapowarr
  volume id — the `ll_book_id` analog: the reconcile + force-search key), and `comicvine_id` (audit/dedupe).
  **`comic_status IS NOT NULL` is the durable "this request is a comic" discriminator** (a comic uses
  `comic_status`; ebook/audio stay `missing` — N/A). A comic that could not be routed stays PARKED
  (`unroutable_reason='comic'`, `comic_status='requested'`); once routed, `unroutable_reason` clears and
  `comic_status='wanted'`. `BOOK_REQUEST_FORMATS` gains `'comic'`. No new table, no new audit action, no other
  CHECK relaxations.

- **C-03 — the goodreads-sync comic routing (single-writer + confined client).** When a Kapowarr bundle is
  present, a comic-classified want resolves to a ComicVine volume via **Kapowarr's own search** (the ComicVine
  id is not reliably derivable from the Goodreads/GB signals), gets added **monitored** (auto-search on), and
  its Kapowarr state reconciles back into `comic_status`. The resolver `pickBestVolume` ranks candidates by
  shared distinctive title tokens (absolute overlap, then ratio), preferring the **original edition**
  (`translated=false`) and a known year — so *Scott Pilgrim* resolves to the Oni Press original over a German
  reprint, and the Eaglemoss "Legend of Batman" partwork over an unrelated "Year Zero". The reconcile maps
  Kapowarr's monitored + downloaded issue counts to `wanted / grabbed / landed / missing`. A per-comic failure
  is logged and the request stays parked for the next run (the ADR-055 LL-push discipline — never fails the
  whole sync). The mint/route/reconcile writes are UNaudited (synced/derived, the ADR-055 exemption).

- **C-04 — `integrations` section (unchanged) + the dispatching force-search.** No new section id. The
  existing `integrations.search` procedure — the endpoint PLAN-045's Library "Force Search" button calls for a
  book-wall item — now **dispatches by format**: a comic fires Kapowarr's `auto_search` task
  (`runComicVolumeSearch`), a book/audiobook fires LL's `searchBook` (`runManualBookSearch`). BOTH co-write a
  `request_book_search` permission_audit row (the ADR-055 precedent), and both are gated by
  `integrationsProcedure` with ownership re-checked server-side.

- **C-05 — graceful degradation, not fabrication.** Absent `KAPOWARR_API_KEY` (or an unreachable Kapowarr / a
  ComicVine search with no match) leaves the comic PARKED, honestly surfaced; the layer is fully stub-backed
  (a `stub-kapowarr` in the hermetic e2e stack) and unit-tested (route → reconcile → force-search round trip,
  absent-Kapowarr degradation, no-ComicVine-match parking).

- **C-06 — Kapowarr is wholly separate from the compliance machinery.** The Kapowarr client never touches
  MAM/qBittorrent/Prowlarr/the governor. Comic acquisition rides Kapowarr's GetComics DDL — no tracker, no
  passkey, no seed economy, no unsatisfied-torrent cap. The MAM invariants (OPS-013 / ADR-054) are unaffected.

## Consequences

- **Positive:** comics acquire on the same request-ledger idiom as books, with the same audited force-search;
  the confined write surface keeps the "no unrecorded external acquisition write" invariant executable; the
  degraded path is honest; the compliance machinery is untouched.
- **Negative / residual:** the ComicVine match is a best-effort title resolve (documented — `pickBestVolume`
  can mis-pick an ambiguous partwork; the owner can re-monitor in Kapowarr). Kapowarr monitors at VOLUME
  (series) granularity — a shelf item naming a single volume/part still monitors the whole ComicVine volume.
  `comic_status` reconcile granularity is coarse (whole-volume monitored/downloaded counts), not per-issue.

## Live as-built (2026-07-14, owner-directed remediation)

- **ComicVine operability:** CONFIRMED present in Kapowarr (`comicvine_api_key` set; volume search live).
- **The stray wants (owner ruling "remove them"):** the first Goodreads sync mis-classified **both** shelf
  comics as books and pushed them to LazyLibrarian as Wanted (GB categories were truncated/sparse; the
  classifier fix rides `fix/integrations-link-ux`). Removed live: `unqueueBook` (→ Skipped) both formats of
  `2WBgVbzwZPMC` (*Scott Pilgrim*) and `SEby0QEACAAJ` (*Zero Year*) — verified `Status=Skipped` in the LL DB.
  Their `book_requests` rows were flipped to comic routing (`unroutable_reason='comic'`, ebook/audio
  `missing`, `ll_book_id` cleared). Nothing else in LL was touched.
- **The two shelf comics → Kapowarr (monitored WANTED):** added live — cv **25478** *Scott Pilgrim* (Oni
  Press, 6 issues) → Kapowarr volume **1**; cv **121720** *DC Comics: The Legend of Batman* (Eaglemoss, 31
  issues) → Kapowarr volume **2**. Both `monitored=true`, auto-search on. Once migration 0046 deploys and the
  goodreads-sync runs with the Kapowarr bundle (and the classifier fix), the parked rows reconcile to
  `comic_status='wanted'` against these already-added volumes (search `already_added` ⇒ no double-add).
