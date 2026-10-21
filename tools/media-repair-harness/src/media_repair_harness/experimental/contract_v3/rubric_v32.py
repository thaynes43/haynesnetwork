"""Rubric v3.2 (dev-c7, WO-W22 with the AUDIT-ASTRA-26 amendments): a DISCLOSED POST-LABEL CLARIFICATION of rubric v3.1.

Plainly: written after the public dev labels had been read (they were read for the contract-v3 tension list, and AUDIT-ASTRA-25, which
names case outcomes, was required reading for this story).  It changes NO check, NO prerequisite and NO checker: `prereq.py` still applies
rubric v3.1 (`rubric.RUBRIC_V31`), and the frozen v3.0 block, `RUBRIC` and `RUBRIC_V31` are byte-identical.  Each clarification states, in
words, a rule the unchanged checker or the unchanged typed layer already applies, so a prompt can state it; none names, targets or was tuned on
a case, and none changes a label.  A disagreement between the contract text and the checker found while writing it is recorded under
`open_disagreements` and NOT resolved (the evaluator decides).  docs/contract-v3.md section 16; JSON in docs/contract-v3-prerequisites-v3.2.json.
"""
import hashlib
import json

from . import rubric as RB

RUBRIC_V32_VERSION = 'contract-v3-rubric-3.2'
EOF_TOLERANCE_S = 1.0       # the existing constant of evidence_v2 (EOF_TOLERANCE_S); restated here, not a new value (a test pins the two equal)

CLARIFICATIONS_V32 = (
    {'id': 'C32-1', 'clarifies': 'M3, M4 (completion of a full decode)',
     'text': 'A full decode is complete only on affirmative evidence: a decode that ran to completion (status ok) with exit 0, a decoded span greater than zero and a known container '
             'duration, whose span reaches that duration within the existing tolerance of 1.0 s (container rounding and unequal stream lengths). A shortfall '
             'of exactly 1.0 s is within the tolerance; a shortfall above it is the typed conflict decoded_span_shorter_than_duration (M3). With the duration '
             'or the span unknown, completion is unknown, not a conflict and not complete. A failed, timed-out or partial execution (a partial result\'s fields '
             'may still show to_end_of_file true; it is incomplete and supports nothing, A31-4), a stated completed_to_eof false, a quota stop, or a '
             'bounded window answering a whole-file request (request_not_honored) is not a completed full decode. '
             'The tolerance decides completion only: the checked interval stays the decoded span (the remainder up to the container duration stays not '
             'checked), and completion never certifies the whole file (H1 to H5 are unchanged). Every other material conflict is unchanged.',
     'source': 'evidence_v2.EOF_TOLERANCE_S and _derive_decode / _live_decode (unchanged)'},
    {'id': 'C32-2', 'clarifies': 'M6, D-NAME-1 (an explicitly empty audiobook tag map)',
     'text': 'For an audiobook, a complete result (state ran, status ok) of ffprobe or audiobook_inspect whose container-level tag map (format.tags or tags) '
             'is explicitly empty ({}; an explicitly empty list [] is read the same way) is an explicitly empty naming surface (M6, D-NAME-1), cited as '
             '<id>:tags_empty. No child field is synthesized: title, album and artist stay absent and are not each reported empty. A tag map that is absent, '
             'null, false or zero, and any tag map of an incomplete result, shows nothing. A populated map is read field by field: an absent child is not '
             'evidence; an empty string, an empty list or an empty element is empty (M6); a null, false or zero child is not empty. For movies and TV the '
             'naming surface is the file name only, so an empty tag map there is no naming defect.',
     'source': 'prereq.check_named naming_surface_defect (unchanged)'},
    {'id': 'C32-3', 'clarifies': 'statement kind of a prior record (v3.0 section 1, A31-3)',
     'text': 'A prior record\'s kind derives only from its stated evidence_method, by the frozen vocabulary: hash words give report_hash; declaration words '
             '(OPF, metadata, tags, file names, title field) give report_declaration, also beside content words; content words alone give report_content; '
             'a negated, failed or missing method, and a method that names no vocabulary word, give report_unknown. Its original values and method are kept as '
             'stated. A tag reading or a hash stays a declaration or a report; a report, whatever its kind, is never an observation of this run.',
     'source': 'facts.report_kind and rubric.REPORT_METHOD_VOCABULARY / NEGATED_METHOD_RX (unchanged)'},
    {'id': 'C32-4', 'clarifies': 'statement kinds of EPUB body text (tools behaviour v3)',
     'text': 'EPUB body excerpts and observed body headings read by tools behaviour v3 (rule xhtml-body-text-3) are content with the provenance of the '
             'read; OPF metadata, the declared table of contents and every navigation region inside a spine document are declarations, never body text or '
             'observed headings. An observed heading is an observation, never by itself a verdict on identity. The legacy spine heads (the first six words of '
             'all character data of a spine document, head title, styles and navigation included) are labelled legacy_mixed and establish no content '
             'identity under format v3.1-format: its audit withholds them from the checker. The v3.1 checker does not read excerpts or headings (free-text '
             'identity is judged, section 13).',
     'source': 'epub_text.py, evidence_v31.py; prereq.py unchanged'},
)

OPEN_DISAGREEMENTS_V32 = (
    {'id': 'D32-1', 'between': 'A31-13 (each part of a multi-part audiobook is a naming-surface source; every part tag is checked for explicit emptiness) '
                               'and prereq.check_named naming_surface_defect',
     'finding': 'a complete live multi-part audiobook whose part tag map is explicitly empty (files[i].tags == {}) is not a naming-surface defect for the '
                'checker (M6 unmet), while a container-level {} is (tags_empty); empty, null and absent part maps all read as nothing. An empty string or '
                'empty list INSIDE a part map is a defect, as A31-13 says.',
     'status': 'recorded, not resolved: no checker, prerequisite or prompt rule picks a side; C32-2 covers the container-level map only'},
    {'id': 'D32-2', 'between': 'AUDIT-ASTRA-26 item 4 ("negated, missing or ambiguous methods remain unknown") and the frozen v3.0 section 1 rule ("a method '
                               'naming both declaration and content words is the weaker report_declaration")',
     'finding': 'a method that matches both declaration and content words (for example a metadata reading described with the word read) is '
                'report_declaration under the frozen rule, not report_unknown. Neither kind is content, so neither lets a report establish D-ID-1.',
     'status': 'recorded, not resolved: the frozen rule is kept (rubrics unchanged); the v3.1 presentation shows every matched vocabulary class so the '
               'mixed method is visible; "ambiguous" is read as a method that matches no vocabulary word (report_unknown)'},
    {'id': 'D32-3', 'between': 'v3.0 section 1 / prereq.View.statements (EPUB spine text is content) and how spine_heads are made (tools.py, the vendored '
                               'inspector: the first six words of ALL character data of a spine document)',
     'finding': 'the unchanged checker types spine_heads as content, so a head title or navigation text alone can make identity content_verified (a head '
                'title naming the catalog title with a body heading naming another work reads content_verified)',
     'status': 'recorded, not resolved for the checker and every earlier configuration (unchanged); format v3.1-format labels the heads legacy_mixed and '
               'its audit withholds them from the checker, so there they establish nothing'},
)

RUBRIC_V32 = dict(RB.RUBRIC_V31, version=RUBRIC_V32_VERSION, amends=RB.RUBRIC_V31_VERSION, kind='clarification (no check changed)',
                  clarifications=CLARIFICATIONS_V32, open_disagreements=OPEN_DISAGREEMENTS_V32, eof_tolerance_s=EOF_TOLERANCE_S)


def canonical_json_v32():
    return json.dumps(RUBRIC_V32, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def sha256_v32():
    return hashlib.sha256(canonical_json_v32().encode()).hexdigest()
