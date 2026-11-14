-- Read-only mirror of DESIGN-008 D-15. Caller substitutes household history JSON.
WITH history AS (
 SELECT r->>'slug' AS slug, r->>'arrKind' AS kind,
        (r->>'playCount')::integer AS plays,
        (r->>'lastViewedAt')::timestamptz AS last_viewed,
        (r->'guids'->>'tmdbId')::integer AS tmdb,
        (r->'guids'->>'tvdbId')::integer AS tvdb,
        r->'guids'->>'imdbId' AS imdb
 FROM jsonb_array_elements(__HISTORY__::jsonb->'titles') r
), live AS (
 SELECT i.*, btrim(i.imdb_id) ~ '^tt[0-9]+$' AND btrim(i.imdb_id) ~ '[1-9]' AS usable_imdb
 FROM media_items i WHERE deleted_from_arr_at IS NULL AND arr_kind IN ('radarr','sonarr')
), projected AS (
 SELECT i.id, i.arr_kind, i.arr_item_id, i.title, i.tmdb_id, i.tvdb_id, i.imdb_id,
        i.on_disk_file_count,
        m.play_count AS before_plays, m.last_viewed_at AS before_last,
        m.last_watched_server AS before_server,
        CASE WHEN i.tmdb_id>0 OR i.tvdb_id>0 OR i.usable_imdb THEN coalesce(w.plays,0) END AS after_plays,
        w.last_viewed AS after_last, w.server AS after_server,
        coalesce(m.last_viewed_at >= current_timestamp - interval '30 days',false) AS before_recent,
        coalesce(w.last_viewed >= current_timestamp - interval '30 days',false) AS after_recent,
        i.arr_tags ? 'dnd' AS dnd, i.arr_tags ? 'mediarequests' AS requested,
        EXISTS (SELECT 1 FROM trash_save_intents s WHERE s.media_item_id=i.id AND s.revoked_at IS NULL) AS saved,
        EXISTS (SELECT 1 FROM watchlist_registry_items r WHERE
          (i.arr_kind='radarr' AND r.kind='movie' AND r.tmdb_id=i.tmdb_id) OR
          (i.arr_kind='sonarr' AND r.kind='show' AND (r.tmdb_id=i.tmdb_id OR r.tvdb_id=i.tvdb_id))) AS watchlisted,
        (SELECT max(p.plex_added_at) FROM media_plex_matches p WHERE p.media_item_id=i.id) AS newest_plex_added,
        (SELECT count(*) FROM media_plex_matches p WHERE p.media_item_id=i.id) AS plex_matches,
        (SELECT count(*) FROM media_plex_matches p WHERE p.media_item_id=i.id AND p.plex_added_at IS NULL) AS undated_matches,
        (SELECT max(e.occurred_at) FROM ledger_events e WHERE e.media_item_id=i.id AND e.source=i.arr_kind AND e.event_type='imported' AND e.payload->>'rawEventType'='downloadFolderImported') AS newest_import,
        CASE WHEN i.arr_kind='sonarr' THEN 'unchecked'
          WHEN i.on_disk_file_count=0 THEN 'verified'
          WHEN (SELECT coalesce((btrim(coalesce(e.payload->>'sourceTitle',''))<>''
             AND position('://' in coalesce(e.payload->>'sourceTitle',''))=0
             AND lower(coalesce(e.payload->>'sourceTitle','')) !~ '\{(tmdb|tvdb|imdb)-') OR EXISTS (
               SELECT 1 FROM ledger_events g WHERE g.media_item_id=e.media_item_id AND g.event_type='grabbed'
               AND g.payload->>'downloadId'=e.payload->>'downloadId'
               AND btrim(coalesce(g.payload->>'sourceTitle',''))<>''
               AND position('://' in coalesce(g.payload->>'sourceTitle',''))=0
               AND lower(coalesce(g.payload->>'sourceTitle','')) !~ '\{(tmdb|tvdb|imdb)-'),false)
             FROM ledger_events e WHERE e.media_item_id=i.id AND e.event_type='imported'
             AND coalesce(e.payload->>'rawEventType','') NOT IN ('movieFolderImported','seriesFolderImported')
             ORDER BY e.occurred_at DESC,e.id DESC LIMIT 1)
          OR EXISTS (SELECT 1 FROM legacy_release_names l WHERE l.arr_kind='radarr' AND l.record_kind='file'
             AND l.external_id=i.tmdb_id AND l.size_bytes=i.size_on_disk AND i.size_on_disk>0
             AND lower(l.release_name) !~ '\{(tmdb|tvdb|imdb)-') THEN 'verified'
          ELSE 'unverified' END AS release_name,
        EXISTS (SELECT 1 FROM trash_candidates c WHERE
          (i.arr_kind='radarr' AND c.media_kind='movie' AND c.tmdb_id=i.tmdb_id) OR
          (i.arr_kind='sonarr' AND c.media_kind='tv' AND c.tvdb_id=i.tvdb_id)) AS in_pool,
        coalesce((SELECT json_agg(json_build_object('batch_id',b.id,'batch_state',b.state,'item_state',t.state,'keep_reason',t.keep_reason))
          FROM trash_batch_items t JOIN trash_batches b ON b.id=t.batch_id
          WHERE t.media_item_id=i.id AND b.state NOT IN ('deleted','cancelled','expired')), '[]'::json) AS open_batches
 FROM live i LEFT JOIN media_metadata m ON m.media_item_id=i.id
 LEFT JOIN LATERAL (
  SELECT sum(h.plays)::integer AS plays, max(h.last_viewed) AS last_viewed,
    (array_agg(h.slug ORDER BY h.last_viewed DESC NULLS LAST,
      CASE h.slug WHEN 'haynesops' THEN 0 WHEN 'hayneskube' THEN 1 ELSE 2 END)
      FILTER (WHERE h.last_viewed IS NOT NULL))[1] AS server
  FROM history h WHERE h.kind=i.arr_kind AND (
    (i.tmdb_id>0 AND h.tmdb=i.tmdb_id) OR (i.tvdb_id>0 AND h.tvdb=i.tvdb_id) OR
    (i.usable_imdb AND h.imdb=btrim(i.imdb_id)))
 ) w ON true
)
SELECT json_build_object('measured_at',current_timestamp,'replica',pg_is_in_recovery(),
 'age_fill_enabled',coalesce((SELECT value='true'::jsonb FROM app_settings WHERE key='age_guard_ignore_library_fill'),false),
 'registry_ok_at',(SELECT max(finished_at) FROM watchlist_registry_runs WHERE status='ok'),
 'projected',(SELECT json_agg(p) FROM projected p));
