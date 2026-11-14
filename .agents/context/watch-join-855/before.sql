SELECT json_build_object('measured_at',current_timestamp,'replica',pg_is_in_recovery(),
 'live', (SELECT json_agg(x) FROM (
 SELECT i.id, i.arr_kind, i.arr_item_id, i.tmdb_id, i.tvdb_id, i.imdb_id,
 CASE WHEN i.arr_kind <> 'lidarr' THEN i.title END AS title,
 i.on_disk_file_count, i.arr_tags ? 'dnd' AS dnd, i.arr_tags ? 'mediarequests' AS requested,
 m.play_count, m.last_viewed_at, m.last_watched_at, m.last_watched_server,
 m.extra->'tautulli' AS tautulli
 FROM media_items i LEFT JOIN media_metadata m ON m.media_item_id=i.id
 WHERE i.deleted_from_arr_at IS NULL) x));
