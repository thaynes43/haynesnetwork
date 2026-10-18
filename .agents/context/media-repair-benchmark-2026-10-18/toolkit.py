"""Minimal identity-consistency tool over supplied observations, never truth labels."""
import bench


def inspect_internal_identity(evidence):
    expected=evidence['expected'];observed=evidence['observed']
    internal=observed.get('content_titles',[])
    if evidence['kind']=='tv':
        accepted=expected.get('segment_titles',[])
    else:
        accepted=[expected['title'],*expected.get('aliases',[])]
    verdict=bench.detect(evidence,'v1')
    return {'tool':'inspect_internal_identity','normalized_expected':[bench.norm(x) for x in accepted],
            'normalized_observed':[bench.norm(x) for x in internal],
            'exact_identity_consistent':None if verdict=='abstain' else verdict=='match',
            'policy':'One record expects its exact work or declared alias; containing it within a different collection is not the same work. For TV compare the complete reference segment set.',
            'evidence_scope':'Supplied documentary observations only; no media decoding.'}
