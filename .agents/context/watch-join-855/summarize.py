"""Summarize the replica snapshots; household fields only. No network or writes to a database."""
import collections
import csv
import datetime as dt
import json
import gzip
from pathlib import Path

BASE = Path(__file__).parent
before = json.loads(gzip.decompress((BASE / 'before.json.gz').read_bytes()))
projection = json.loads(gzip.decompress((BASE / 'projection.json.gz').read_bytes()))
live = before['live']
rows = projection['projected']
by_id = {r['id']: r for r in rows}
now = dt.datetime.fromisoformat(projection['measured_at'])

def invalid(v):
    return v is None or str(v).strip() in ('', '0', 'tt0')

def instant(v):
    return dt.datetime.fromisoformat(v) if v else None

def watch_record(r):
    return (r['play_count'], r['last_viewed_at'], r['last_watched_at'], r['last_watched_server'])

summary = {'before_measured_at': before['measured_at'], 'projection_measured_at': projection['measured_at'],
           'replica': before['replica'] and projection['replica'], 'id_census': [], 'pairs': [],
           'age_fill_enabled': projection['age_fill_enabled'], 'registry_ok_at': projection['registry_ok_at']}
affected = set()
for namespace, col in [('TMDB', 'tmdb_id'), ('TVDB', 'tvdb_id'), ('IMDb', 'imdb_id')]:
    groups = collections.defaultdict(list)
    for r in live:
        if not invalid(r[col]):
            groups[r[col]].append(r)
    pairs = [(a, b) for g in groups.values() for a in g for b in g if a['arr_kind'] < b['arr_kind']]
    for a, b in pairs:
        affected.update([a['id'], b['id']])
    summary['pairs'].append({'namespace': namespace, 'pairs': len(pairs),
        'by_arr_pair': dict(collections.Counter(f"{a['arr_kind']}/{b['arr_kind']}" for a,b in pairs)),
        'with_play': sum((a['play_count'] or 0)>0 or (b['play_count'] or 0)>0 for a,b in pairs),
        'identical_positive_before': sum(watch_record(a)==watch_record(b) and (a['play_count'] or 0)>0 for a,b in pairs),
        'identical_positive_after': sum(by_id[a['id']]['after_plays']==by_id[b['id']]['after_plays']
            and by_id[a['id']]['after_last']==by_id[b['id']]['after_last']
            and (by_id[a['id']]['after_plays'] or 0)>0 for a,b in pairs)})
    for arr in ['radarr', 'sonarr', 'lidarr']:
        subset = [r for r in live if r['arr_kind']==arr]
        bad = [r for r in subset if invalid(r[col])]
        identical = collections.Counter(watch_record(r) for r in bad)
        after_records = collections.Counter(
            (by_id[r['id']]['after_plays'], by_id[r['id']]['after_last'],
             by_id[r['id']]['after_last'], by_id[r['id']]['after_server'])
            if r['id'] in by_id else watch_record(r) for r in bad)
        summary['id_census'].append({'namespace': namespace, 'arr': arr, 'live': len(subset),
            'zero': sum(r[col] is not None and str(r[col]).strip() in ('0','tt0') for r in subset),
            'empty': sum(r[col] is not None and str(r[col]).strip()=='' for r in subset),
            'missing': sum(r[col] is None for r in subset),
            'identical_groups': sum(n>1 for n in identical.values()),
            'titles_in_identical_groups': sum(n for n in identical.values() if n>1),
            'identical_groups_after': sum(n>1 for n in after_records.values()),
            'titles_in_identical_groups_after': sum(n for n in after_records.values() if n>1),
            'positive_identical_groups_before': sum(n>1 and (k[0] or 0)>0 for k,n in identical.items()),
            'positive_identical_groups_after': sum(n>1 and (k[0] or 0)>0 for k,n in after_records.items())})
        for r in bad:
            if r[col] is not None and str(r[col]).strip() in ('0','tt0'):
                affected.add(r['id'])

for r in rows:
    # Match the app's elapsed milliseconds, including across daylight-saving boundaries.
    for phase in ['before', 'after']:
        viewed = instant(r[phase + '_last'])
        exact_recent = viewed is not None and now-viewed <= dt.timedelta(days=30)
        assert exact_recent == r[phase + '_recent'], 'Reassess the census using the exact elapsed watch window'
    dates = [instant(v) for v in [r['newest_import'], r['newest_plex_added']] if v]
    recent = dates and now-max(dates)<dt.timedelta(days=180)
    r['age_guard'] = 'recent' if recent else 'unknown' if not r['plex_matches'] or r['undated_matches'] else 'clear'
    keeps = [label for field,label in [('saved','saved'),('dnd','tag'),('watchlisted','watchlisted'),('requested','media_request')] if r[field]]
    if r['age_guard']=='recent': keeps.append('recently_added')
    if r['age_guard']=='unknown': keeps.append('unevaluable_age')
    if r['release_name']=='unverified': keeps.append('release_unverified')
    r['other_keeps'] = ','.join(keeps)
    r['loses_watch_keep'] = r['before_recent'] and not r['after_recent']
    r['gains_watch_keep'] = not r['before_recent'] and r['after_recent']
    r['changed'] = r['before_plays']!=r['after_plays'] or instant(r['before_last'])!=instant(r['after_last']) or r['before_server']!=r['after_server']
    r['collision_or_sentinel'] = r['id'] in affected

summary['watch_totals'] = [dict(arr=arr,
    before_played=sum((r['play_count'] or 0)>0 for r in live if r['arr_kind']==arr),
    before_zero=sum(r['play_count']==0 for r in live if r['arr_kind']==arr),
    before_unknown=sum(r['play_count'] is None for r in live if r['arr_kind']==arr),
    after_played=sum((r['after_plays'] or 0)>0 for r in rows if r['arr_kind']==arr),
    after_zero=sum(r['after_plays']==0 for r in rows if r['arr_kind']==arr),
    after_unknown=sum(r['after_plays'] is None for r in rows if r['arr_kind']==arr))
    for arr in ['radarr','sonarr']]
summary['affected_titles'] = len(affected)
summary['changed_titles'] = sum(r['changed'] for r in rows)
summary['changed_affected_titles'] = sum(r['changed'] and r['collision_or_sentinel'] for r in rows)
summary['loses_watch_keep'] = [r['title'] for r in rows if r['loses_watch_keep']]
summary['gains_watch_keep'] = [r['title'] for r in rows if r['gains_watch_keep']]
summary['guardian_clears_after_loss'] = [r['title'] for r in rows if r['loses_watch_keep'] and not r['other_keeps']]
summary['newly_deletable_in_pool_or_batch'] = [r['title'] for r in rows if r['loses_watch_keep'] and not r['other_keeps'] and (r['in_pool'] or r['open_batches'])]
summary['id_zero_after'] = [dict(title=r['title'],plays=r['after_plays'],last=r['after_last']) for r in rows if r['tmdb_id']==0]
summary['unknown_video_titles'] = [r['title'] for r in rows if r['after_plays'] is None]
assert not projection['age_fill_enabled'], 'Fill-enabled projections need the full D-31 SQL'
assert before['replica'] and projection['replica']
summary['other_changes'] = [{k:r[k] for k in ['title','arr_kind','before_plays','after_plays','before_last','after_last','before_server','after_server']} for r in rows if r['changed'] and not r['collision_or_sentinel']]
assert all(not r['in_pool'] and not r['open_batches'] for r in rows if r['loses_watch_keep']), 'Reassess deletion exposure before publishing'

fields = list(rows[0])
for filename, selected in [('household-inventory.csv',rows), ('affected-titles.csv',[r for r in rows if r['collision_or_sentinel']])]:
    with (BASE / filename).open('w') as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        for r in sorted(selected,key=lambda r:(r['arr_kind'],r['title'])):
            writer.writerow({**r, 'open_batches':json.dumps(r['open_batches'],sort_keys=True)})
(BASE / 'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps({k:v for k,v in summary.items() if k not in ['id_zero_after','id_census']},indent=2))
