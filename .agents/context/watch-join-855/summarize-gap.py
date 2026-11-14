"""Read private household inputs; publish aggregate gaps and at most ten named leads."""
import argparse
import collections
import json
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--history', type=Path, required=True)
parser.add_argument('--live', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
history = json.loads(args.history.read_text())
live = json.loads(args.live.read_text())
assert live['replica'] is True
assert all(r['finished'] for r in history['instances'])

def usable(row):
    ids = {}
    for key in ['tmdb', 'tvdb']:
        value = row.get(key + '_id')
        if isinstance(value, int) and 0 < value <= 9007199254740991:
            ids[key + 'Id'] = value
    value = row.get('imdb_id')
    if isinstance(value, str):
        value = value.strip()
        if value.startswith('tt') and value[2:].isascii() and value[2:].isdigit() and int(value[2:]) > 0:
            ids['imdbId'] = value
    return ids

joined = collections.defaultdict(list)
for group in history['titles']:
    joined[group['arrKind']].append(group)

def has_play(row):
    ids = usable(row)
    return any(any(g['guids'].get(k) == v for k, v in ids.items()) for g in joined[row['arr_kind']])

def group_id(g):
    return (g['slug'], g['arrKind'], g['ratingKey'])

unresolved = history['unattributable']
assert len({group_id(g) for g in unresolved}) == len(unresolved)
stats = []
for inst in history['instances']:
    for kind in ['radarr', 'sonarr']:
        groups = [g for g in unresolved if g['slug'] == inst['slug'] and g['arrKind'] == kind]
        oldest = [g['oldest'] for g in groups if g['oldest']]
        newest = [g['lastViewedAt'] for g in groups if g['lastViewedAt']]
        stats.append(dict(instance=inst['slug'], kind=kind, groups=len(groups),
                          plays=sum(g['playCount'] for g in groups),
                          oldest=min(oldest, default=None), newest=max(newest, default=None)))
assert sum(r['groups'] for r in stats) == sum(r['unjoined'] for r in history['instances'])
leads = []
matched_groups = set()
for row in live['titles']:
    if not usable(row) or has_play(row):
        continue
    groups = [g for g in unresolved if g['arrKind'] == row['arr_kind']
              and isinstance(g['title'], str) and g['title'].strip().casefold() == row['title'].strip().casefold()
              and g['year'] is not None and g['year'] == row['year']]
    if groups:
        matched_groups.update(group_id(g) for g in groups)
        leads.append(dict(title=row['title'], year=row['year'], kind=row['arr_kind'],
                          groups=len(groups), plays=sum(g['playCount'] for g in groups)))
report = dict(history_measured_at=history['measured_at'], live_measured_at=live['measured_at'],
              groups_by_instance_kind=stats, reasons=dict(collections.Counter(g['reason'] for g in unresolved)),
              total_groups=len(unresolved), total_plays=sum(g['playCount'] for g in unresolved),
              lead_movies=sum(r['kind'] == 'radarr' for r in leads),
              lead_shows=sum(r['kind'] == 'sonarr' for r in leads),
              lead_groups=len(matched_groups),
              lead_plays=sum(g['playCount'] for g in unresolved if group_id(g) in matched_groups),
              largest_leads=sorted(leads, key=lambda r: (-r['plays'], r['kind'], r['title'], r['year']))[:10])
args.output.write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
