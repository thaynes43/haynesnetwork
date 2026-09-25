-- ADR-092 / DESIGN-051 D-07 (PLAN-071 — the owner's Plex watchlist through the watch tools). Journal idx 79.
-- ADDITIVE: watch_marks.action admits the two Watchlist Change actions (T-260), `watchlist_add` and
-- `watchlist_remove` — a `set_watchlist` call recorded as a Watch Mark so it is attributed (consumer, actor),
-- audited by its row and undone by `undo_last_change`. No new table or column: such a row carries `scope` = the
-- kind (`movie` | `show`), the resolved identity with `plex_guid = plex://<kind>/<discover id>`, `flipped = []`
-- and `plex_result` `pending` → `written` | `failed`, all within the existing CHECKs. The list is built from
-- WATCH_MARK_ACTIONS (enums.ts). A down-migration restores the 0077 CHECK after deleting the watchlist rows.
ALTER TABLE "watch_marks" DROP CONSTRAINT "watch_marks_action_enum";--> statement-breakpoint
ALTER TABLE "watch_marks" ADD CONSTRAINT "watch_marks_action_enum" CHECK ("watch_marks"."action" = ANY (ARRAY['watched','not_interested','not_mine','watchlist_add','watchlist_remove']));
