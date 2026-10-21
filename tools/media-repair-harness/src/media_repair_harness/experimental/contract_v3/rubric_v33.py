"""Rubric v3.3 (W25, OpenProject #156): a DISCLOSED POST-LABEL AMENDMENT of rubric v3.1 / v3.2 that resolves the three disagreements v3.2 recorded.

Plainly: written after the public dev labels had been read (they were read for the contract-v3 tension list, and the dev-c6 and dev-c7 reports that name
case outcomes had been published).  It answers recorded reviewer findings (docs/contract-v3.md section 16, D32-1 to D32-3); none names, targets or was
tuned on a case, and none changes a label.  The frozen v3.0 block, `RUBRIC`, `RUBRIC_V31` and `RUBRIC_V32` are byte-identical and keep their digests;
`prereq.py` still applies rubric v3.1 for every earlier configuration and record.  The new checker `prereq_v33.py` applies this rubric.
docs/contract-v3.md section 17; JSON in docs/contract-v3-prerequisites-v3.3.json.
"""
import hashlib
import json

from . import rubric_v32 as RB32

RUBRIC_V33_VERSION = 'contract-v3-rubric-3.3'

AMENDMENTS_V33 = (
    {'id': 'A33-1', 'resolves': 'D32-1', 'changes': 'M6, D-NAME-1 (A31-13, C32-2) for multi-part audiobooks',
     'text': 'Each part of a multi-part audiobook is a naming-surface source (A31-13), so a complete result (state ran, status ok) of ffprobe or '
             'audiobook_inspect whose part tag map (files[i].tags) is explicitly empty ({}, or an explicitly empty list []) is an explicitly empty naming '
             'surface, cited as <id>:files[<i>]:tags_empty, exactly as a container-level map is (C32-2). No child field is synthesized. An absent, null, '
             'false or zero part map, and any part map of an incomplete result, shows nothing. Inside a populated part map the A31-13 rules are unchanged.',
     'why': 'A31-13 makes every part a naming surface and checks every part tag for explicit emptiness; the v3.1 checker flagged an empty string or list '
            'inside a part map but not a part map that is itself {}, unlike a container-level {} (D32-1).'},
    {'id': 'A33-2', 'resolves': 'D32-2', 'changes': 'statement kind of a prior record (v3.0 section 1, A31-3; supersedes C32-3 for the v3.3 checker)',
     'text': 'A prior record\'s kind derives only from its stated evidence_method. A negated, failed or missing method, and one that matches no '
             'vocabulary class, is report_unknown (A31-3, C32-3) and reports nothing the checker compares. A method that names content words together '
             'with declaration or hash words (for example "metadata read", "MD5 of the audio"; hash plus content falls under the same rule as declaration '
             'plus content) is ambiguous about whether content was observed and is report_unknown: it establishes no content. Its reported values are '
             'still compared at declaration strength (statement kind report_ambiguous): a disagreement contests identity and makes M5 present, and an '
             'agreement is declared_agree, exactly as the same report does under v3.1 (where it is report_declaration or report_hash); it never verifies '
             'or contradicts identity. Every other method keeps the frozen order: hash words give report_hash (also beside declaration words), declaration '
             'words report_declaration, content words alone report_content. The frozen vocabulary is unchanged and counts the bare word "read" as a '
             'content word. The checker shows, for every prior record, the method as stated, every vocabulary class it matched, whether it is negated, '
             'whether it is ambiguous, the kind derived and the statement kind compared.',
     'why': 'AUDIT-ASTRA-26 item 4 says negated, missing or ambiguous methods remain unknown; the frozen v3.0 rule typed a declaration-plus-content method '
            'as report_declaration (D32-2).'},
    {'id': 'A33-3', 'resolves': 'D32-3', 'changes': 'identity statements (section 8; C32-4)',
     'text': 'The legacy spine heads (spine_heads: the first six words of ALL character data of a spine document, its head title, styles and navigation '
             'included; statement kind legacy_mixed) are not content and establish no identity attribute in any configuration the v3.3 checker reads: it '
             'does not read them. Every other content statement is unchanged.',
     'why': 'The v3.1 checker typed spine_heads as content, so a head title naming the catalog title could make identity content_verified while the body '
            'names another work; only format v3.1-format\'s audit withheld them (D32-3).'},
)

SUPERSEDED_V33 = {'C32-3': 'A33-2 (a method naming content words beside declaration or hash words is report_unknown, compared at declaration strength; '
                            'v3.2 kept report_declaration or report_hash)'}

RUBRIC_V33 = dict(RB32.RUBRIC_V32, version=RUBRIC_V33_VERSION, amends=RB32.RUBRIC_V32_VERSION,
                  kind='amendment (made after labels had been read): A33-1 to A33-3 resolve D32-1 to D32-3',
                  amendments_v33=AMENDMENTS_V33, superseded=SUPERSEDED_V33, open_disagreements=(),
                  resolved_disagreements=tuple(a['resolves'] for a in AMENDMENTS_V33))


def canonical_json_v33():
    return json.dumps(RUBRIC_V33, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def sha256_v33():
    return hashlib.sha256(canonical_json_v33().encode()).hexdigest()
