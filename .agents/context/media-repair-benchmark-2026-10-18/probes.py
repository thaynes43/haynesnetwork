"""Independent small diagnostic probes; never added to the frozen benchmark."""
import json
from pathlib import Path
import bench


def evidence(kind, title, titles, **expected):
    return {'kind':kind,'expected':dict(title=title,**expected),'observed':{'content_titles':titles}}


def run():
    probes = [
        ('unfamiliar-match', evidence('ebook','North Harbor',['North Harbor']), 'match'),
        ('unrelated-title', evidence('ebook','North Harbor',['South Orchard']), 'mismatch'),
        ('declared-alias', evidence('movie','North Harbor',['Northern Port'],aliases=['Northern Port']), 'match'),
        ('missing-evidence', evidence('audiobook','North Harbor',[]), 'abstain'),
        ('tv-reordered-segments', evidence('tv','Unseen Series',['Blue Door','Red Road'],segment_titles=['Red Road','Blue Door']), 'match'),
        ('tv-extra-segment', evidence('tv','Unseen Series',['Blue Door','Red Road','Other'],segment_titles=['Red Road','Blue Door']), 'mismatch'),
    ]
    rows = [{'probe':name,'input':item,'expected':expected,'actual':bench.detect(item,'v1')} for name,item,expected in probes]
    assert all(r['expected']==r['actual'] for r in rows)
    # Structural audit over every model request; no diagnostic provenance field.
    for case in bench.load_cases():
        payload=bench.detector_payload(case)
        assert 'evidence_method' not in payload['evidence']['observed']
        assert not {'label','source','split','family','expected_candidate','candidates'} & set(payload)
    return rows


if __name__ == '__main__':
    print(json.dumps(run(),indent=2))
