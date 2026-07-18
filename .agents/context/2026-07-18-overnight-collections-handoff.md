# COLD-START HANDOFF — Collections saga, PR4+ (2026-07-18 ~04:40 UTC)

> Written for a FRESH session (coordinator now on Fable — the prior loop was stuck on Opus; a
> mid-session `/model` only saves a NEW-session default, so this cold start IS the fix). Priority:
> **finish the Collections saga — the headline is PR4, the collections MANAGEMENT TAB (edit/add/
> suggest collections).** Dispatch all build work to **Opus** subagents; the coordinator (you, Fable)
> orchestrates + owns UI/UX judgment + live-verify. Only wake the owner for a genuine product fork or
> the morning wrap.

## FIRST MOVES (in order)
1. **Reattach the fleet.** The prior session's background agents are ORPHANED by this cold start.
   Re-dispatch as needed (all state is on git branches + docs):
   - **Resume PR3** from branch `feat/collection-size-cap` @ `8af41f9` (worktree `/home/dev/work/hnet-collections`,
     CLEAN + pushed, compiles GREEN: typecheck/eslint/css-hex pass, cap-guard unit 7/7). Migration **0067**
     claimed. **DONE:** domain `exceedsCollectionSizeCap`/`assertWithinCollectionSizeCap` + `CollectionSizeCapError`
     wired to `UNPROCESSABLE_CONTENT`/`COLLECTION_SIZE_CAP_EXCEEDED`; `createCollectionOverrideTicket`
     single-writer (ADR-050 `createTicket`, category `collection_override`); API `collections.save` enforces
     cap for non-admins (admins bypass) + new `collections.requestOverride`; `overview` returns `sizeCap`+`capBypass`;
     web composer over-cap **Modal → "Request admin override"** (hard rule 8); movies collection-drill Wanted tiles
     render `@hnet/ui <MediaAction action="forceSearch">` → reused `ForceSearchDialog`; docs DESIGN-035 **D-17**.
     **REMAINING (do this first):** API cap-enforcement + `requestOverride` router tests
     (`packages/api/__tests__/collections.test.ts` — stub-Libretto `validateRecipe` `workCount>25` trips the cap)
     + `createCollectionOverrideTicket` domain test (`packages/domain/__tests__/tickets.test.ts`); full
     `pnpm test`+`build`; then release + live-verify. THEN:
   - **★ BOOKS + AUDIOBOOKS Wanted-tiles leg — OWNER-CRITICAL, DO NOT DROP** (NOT started). The owner
     flagged this 2026-07-18 as "super important": **a books OR audiobooks collection that is not full MUST
     render its MISSING members as Wanted/missing tiles** (held tiles + missing tiles side by side) so the
     household can see and FILL what's missing. Today these collections show held-only — that's the gap.
     (Movies already do this since v0.75.0; books/audiobooks were deferred ONLY until Libretto could expose
     the missing IDENTITIES, which is now LIVE.) Build: mint `book_requests` origin `'collection'` from
     Libretto `read.listMissingMembers(recipeId)` (client LIVE on main) → render held + Wanted tiles on the
     BOTH the books AND audiobooks collection drill/wall (the shipped DESIGN-029 idiom + the movies
     collection-drill wanted-tile pattern PR3 just added). The owner's Stormlight "3 held + 15 wanted" view.
     This is a first-class requirement, at least as important as PR4 — do NOT let PR4 crowd it out.
   - **Re-dispatch the overnight verifier** (it was sleeping until ~07:38 UTC; a cold start orphans it).
     After 07:05 UTC, capture: pairing-resolution proof (v0.76.0 fix — did the ~210 stuck pairing wants
     resolve; 27 flagged immediately-unblockable), Mia's Goodreads fills, FLIP grant state. Read-only.
2. **PR4 — THE COLLECTIONS TAB (the priority, multi-hour).** The management surface: composer to
   create/add collections, the **suggest → approve** member flow (`notification_outbox`/T-173),
   per-role grants `suggest`/`manage`/`acquire` with /admin controls, and the Kometa (movie/TV)
   contribution **human-merged config-PR** write path (DESIGN-042 Q-01 default). Design in
   `docs/designs/042-*`, `docs/designs/043-*`, `.agents/plans/052-*`. Members create/add size-capped
   (PR3's 25-cap), `manage` to trusted roles, `acquire` owner-held. **Route the visible tab UI/UX
   decisions through the OWNER** (his standing rule — don't silently pick tab design). Likely needs
   2-3 fresh Opus agents handed the branch as each hits context. Next free migration after 0067 = **0068**.
3. **Unification agent tail:** its PR-4 (wanted-detail/activity refactor onto shared components) is ON
   HOLD until the books-Wanted-tiles leg settles; then it refactors those surfaces, and PR-6 (the
   `action-anatomy` lint drift-guard) lands **DEAD LAST** (after every surface is clean, or it false-fails).

## WHAT SHIPPED THIS SESSION (build ON, do not redo) — v0.74.0 → v0.77.0
- **v0.74.0** books/audiobooks/comics category chips (dynamic, free-form `category`, migration 0064).
- **v0.75.0** admin force-search override (#375) + movies Wanted-tiles (#374, `plex_collection_members`
  has media_item_id/held, migration 0065; verified vs real Radarr — Fast&Furious 10+2, Toy Story 4+1…).
- **v0.76.0** unified media-action system ADR-071 (shared `@hnet/ui` MediaAction/MediaActionBar/
  ConsumeLink/ReservedActionSlot/MediaHero + `MEDIA_ACTIONS` registry; item-detail + ytdl-sub refactored)
  + Libretto client (#376) + pairing-ISBN GB-resolve fix (#373, PLAN-059 — the 210-want prize).
- **v0.77.0 = THE FLIP** (#383): books gain green Fix + Force Search through the shared components;
  `role_books_action_grants` admits `fix_book` + `force_search_book` (migration 0066); /admin → roles →
  **"Books actions"** grant grid. **OWNER ACTION PENDING: he grants Fix/Force-Search to roles in that
  grid whenever he wants — self-serve, no code.** Book Force Search = quick re-search, no durable row.
- **Libretto extended + LIVE** (its own repo, full-autonomy): member-missing endpoint
  `GET /api/collections/:id/missing` (client `read.listMissingMembers`) + ISBN-first resolve broker
  (M3 fix, armed). Auth 401 root-caused (app secret had no LIBRETTO_API_KEY) + fixed.
- **Also this session:** label-driven collection chips across all 5 walls (Kometa labels → derive; the
  companion-file dry-run proved same-name blank_collection is duplicate-skipped → app-side derive from
  Kometa's own section labels); dormant Plex catalog rows deleted (migration 0061); MAM governor raised
  to the real Elite VIP **200** (was stale 20); Mia's (`mia.xh`) 41 Goodreads wants force-searched.

## FLEET BOUNDARIES (keep, to avoid file collisions)
- **Media-action PRESENTATION + gating** (item-detail, books-detail, wanted-detail, the fix/force-search
  dialogs, `canFix`/`canForceSearch`) = the unification lane. Everything renders media actions through
  `@hnet/ui` `<MediaAction action="fix|forceSearch">` — NEVER hand-roll a Fix/Force-Search button (the
  PR-6 lint guard will fail CI). Pass the registry KEY, not a label/class.
- **Collection DATA + composer/suggest + wanted-tile DATA + collection views** = the collections lane.
- **ONE release driver at a time** (release-please contention otherwise); other agents merge to main and
  ride the driver's next release. Release train is MANUAL (docs/ops/004; stale names: ns `frontend`,
  deployment `haynesnetwork-main`). Live-verify at the data layer / a frontend-ns job (login wall blocks
  headless Playwright; the owner does the pixel check — his binding ruling).

## STANDING RULES (memories — read them)
- `unified-media-action-ux-doctrine` — identical action UX across all media types + views, enforced by
  shared components + a drift guard. `label-driven-collections-program`, `libretto-suite-repo-autonomy`
  (Libretto = full-autonomy headless suite repo; haynesnetwork owns 100% of collection UX),
  `coordinator-delegate-to-opus` (dispatch Opus for real work, Fable coordinator orchestrates),
  `coordinator-model-flip-watch` (the flip history + the /model-doesn't-switch-live-session datum),
  `owner-copy-tone-rules`, `kapowarr-ops-doctrine`, `authentik-forward-auth-doctrine`.
- Owner rulings + backlog: `.agents/context/2026-07-18-owner-rulings-and-backlog.md`. Collection design:
  `.agents/context/2026-07-17-label-driven-collections-spike.md` + `-classification.md`.

## OPEN OWNER DECISIONS / BACKLOG (don't lose)
- SSO estate-apps plan + Home Assistant OIDC research; unified Tautulli (one for all Plex servers);
  Kid/Teen roles + library curation (needs kid/YA books); SMTP for Kavita+apps. Libretto M3 direction-a
  (hnet-side resolve broker) — partly delivered via the Libretto broker; the cross-repo full version is
  still an owner call. The `integrations` section grant (point members at Goodreads). PR4 tab UI/UX —
  route design choices through the owner.
