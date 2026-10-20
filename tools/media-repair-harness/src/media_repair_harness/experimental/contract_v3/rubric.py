"""THE FROZEN BLINDED RUBRIC of contract v3 (docs/contract-v3.md, sections 4 to 8), as machine-readable data.

Frozen before any label was inspected: written from the public interface (the model-visible request shape of the dev-c5 runs, aggregated
without case ids or decisions), the frozen prompt v5, the evidence-format-v2 document and the audits.  It names no case, title, file
name or expected answer.  `RUBRIC_SHA256` (tests/test_contract_v3_prereq.py) pins the canonical JSON of `RUBRIC`; a change to it is a
new rubric version, never an edit of this one.

Vocabulary.
  statement kind   what a fact is: catalog (what the case and its managing app say the item should be), declaration (what the file says
                   about itself), content (what was observed in the media: on-screen text, body text, subtitle text, a picture), integrity
                   (whether the bytes and structure decode or parse), integrity_signal (signal statistics), client (the stated client),
                   report (a prior process's claim: reported_content, reported_declaration, reported_hash, report_unknown), complaint.
  provenance       observed (this harness's tool ran on the media now), recorded (case evidence or replayed recording of an earlier
                   observation), reported (a prior record's own claim, evidence_method stated), stated (the case context).
  presence         absent (no key), null, empty ('' / [] / {}), false, zero, populated -- six states that never collapse; plus, for a
                   source, not_checked (nothing that would carry the field ran) and unknown (it ran; the field cannot be read).
"""

RUBRIC_VERSION = 'contract-v3-rubric-1'

STATEMENT_KINDS = ('catalog', 'declaration', 'content', 'content_picture', 'integrity', 'integrity_signal', 'client', 'report_content',
                   'report_declaration', 'report_hash', 'report_unknown', 'complaint')
PROVENANCE = ('observed', 'recorded', 'reported', 'stated')
PRESENCE = ('absent', 'null', 'empty', 'false', 'zero', 'populated')
SOURCE_PRESENCE = ('not_checked', 'unknown')

# evidence_method vocabulary of a prior record (checked in this order; a text with both declaration and content words is the WEAKER kind)
REPORT_METHOD_VOCABULARY = (
    ('report_hash', r'\b(?:md5|sha-?1|sha-?256|hash(?:es)?|checksum)\b'),
    ('report_declaration', r'\b(?:opf|metadata|tags?|id3|file ?names?|title field|dc:\w+|package document)\b'),
    ('report_content', r'\b(?:subtitles?|ocr|on-screen|opening cards?|title cards?|frames?|audio|speech|listen(?:ed|ing)?|transcripts?|body text|spine text|chapter text|read)\b'),
)

# naming surface per media type: the declarations a managing app and a player name the item by.  Other declarations are not naming
# defects (an MKV without a title tag is ordinary); they still count for identity.
NAMING_SURFACE = {
    'movie': ('file_name',),
    'tv': ('file_name',),
    'epub': ('file_name', 'dc_title', 'dc_creator'),
    'audiobook': ('file_name', 'tag_title', 'tag_album', 'tag_artist'),
}

# work-identifying attributes (a disagreement on one is an identity disagreement) and edition attributes (a disagreement is an
# edition / version disagreement).  Runtime and duration identify nothing (rule 4 of v5 is kept).
IDENTITY_ATTRIBUTES = ('title', 'series', 'episode_number', 'episode_title', 'author')
EDITION_ATTRIBUTES = ('language', 'year', 'narrator', 'edition')

# a container duration and a catalog runtime agree within the larger of these (both populated); otherwise a material disagreement
RUNTIME_TOLERANCE_S = 1.0
RUNTIME_TOLERANCE_FRACTION = 0.05

# conflicts that are material for healthy (request_not_honored only limits the completed scope; the completed part still counts)
MATERIAL_CONFLICTS = ('status_ok_with_defect', 'exit_zero_with_decoder_errors', 'decoded_span_shorter_than_duration', 'duration_mismatch')

# STATIC TOOL SEMANTICS: what each tool may inspect (scopes) and what kinds of statement its result carries.  A capability link uses
# this table, the advertised capabilities and the visible observations only.
TOOL_SEMANTICS = {
    'ffprobe': {'scopes': ('container', 'stream_list', 'declared_tags', 'declared_chapters', 'container_duration', 'client_fields'),
                'kinds': ('integrity', 'declaration')},
    'decode_sample': {'scopes': ('decode_interval', 'whole_file_decode'), 'kinds': ('integrity',)},
    'frame_sample': {'scopes': ('picture_at',), 'kinds': ('content_picture',)},
    'ocr': {'scopes': ('on_screen_text_at',), 'kinds': ('content',)},
    'audio_sample': {'scopes': ('audio_signal_at',), 'kinds': ('integrity_signal',)},
    'epub_inspect': {'scopes': ('package', 'epub_declarations', 'epub_body_heads'), 'kinds': ('integrity', 'declaration', 'content')},
    'audiobook_inspect': {'scopes': ('container', 'declared_tags', 'declared_chapters', 'container_duration', 'client_fields'),
                          'kinds': ('integrity', 'declaration')},
    'arr_lookup': {'scopes': ('catalog_record', 'slot_occupancy'), 'kinds': ('catalog',)},
}
# scopes no offered tool can inspect (a link to them has zero candidates; that is a fact, never a reason to invent a tool)
UNINSPECTABLE_SCOPES = ('stream_selection_of_window', 'epub_body_beyond_heads', 'speech', 'other')

# AXES of a generic triage (no specific complaint): the question is "is anything wrong that one of the actions addresses?"
AXES = ('integrity', 'identity', 'naming', 'ordering', 'client')

# MATERIAL UNCERTAINTY: an unresolved item is material when resolving it could change the class or the action.  With no specific complaint
# these are material, and nothing else is: an unchecked remainder is NOT material by itself (no full decode is a universal prerequisite),
# and it is never clean (it stays listed as not checked).
MATERIAL_UNCERTAINTY = (
    {'id': 'M1', 'axis': 'integrity', 'text': 'no positively clean integrity result exists at the item\'s container or package level (every one failed, timed out, was unavailable, was unknown or was not made)'},
    {'id': 'M2', 'axis': 'integrity', 'text': 'an unclassified diagnostic (a finding kind ending _unclassified, probe_messages, input_failure, exit_nonzero_unclassified) inside a checked scope; a decoder_warning alone is not material and is not clean'},
    {'id': 'M3', 'axis': 'integrity', 'text': 'a material conflict (MATERIAL_CONFLICTS) in any shown result'},
    {'id': 'M4', 'axis': 'integrity', 'text': 'a signal that points INTO the unchecked remainder: a container duration that disagrees with the catalog runtime beyond tolerance, a decoded span shorter than the container duration, or a complaint (context.question) that names a part that was not checked'},
    {'id': 'M5', 'axis': 'identity', 'text': 'an identity or edition attribute of any declaration, content or report that disagrees with the catalog (after the case-supplied aliases, alternate titles, editions and orderings are applied) and is not settled by a content observation'},
    {'id': 'M6', 'axis': 'naming', 'text': 'a naming-surface declaration of this media type that is explicitly empty, or that differs from the catalog value'},
    {'id': 'M7', 'axis': 'ordering', 'text': 'two legitimate candidates (orderings, numberings or editions listed by the case) that the observations fit, with no case-supplied choice that settles them'},
    {'id': 'M8', 'axis': 'client', 'text': 'a stated client with an unknown verdict, an unread clause, or an ambiguous or unrecorded stream selection for a field it states'},
    {'id': 'M9', 'axis': 'any', 'text': 'a complaint (context.question) whose subject no shown observation reaches'},
)

# SUFFICIENT EVIDENCE FOR healthy / none.  All must hold.  None of them is a full decode, and none treats unchecked as clean: healthy means
# "no material problem in the checks performed", with the unchecked scope stated, never "the whole file is certified".
HEALTHY = (
    {'id': 'H1', 'text': 'at least one integrity result ran with status ok and is positively clean inside its stated scope (a parsed container with streams, a package with every stage clean, a decoded window with frames and no messages)'},
    {'id': 'H2', 'text': 'no known_defect finding and no collector veto in any shown result, of any execution state'},
    {'id': 'H3', 'text': 'no material uncertainty M1 to M9'},
    {'id': 'H4', 'text': 'identity is uncontradicted (no M5); positive content confirmation of identity is NOT required for none, which changes nothing'},
)

# IDENTITY LEVELS (used by diagnosis and action prerequisites)
IDENTITY_LEVELS = {
    'contradicted_by_content': 'a content or report_content observation disagrees with the catalog on an identity or edition attribute',
    'contested': 'only declarations, report_declaration or report_hash disagree with the catalog; no content observation settles it',
    'content_verified': 'a content or report_content observation agrees with the catalog on an identity attribute and nothing contradicts it',
    'uncontradicted': 'nothing disagrees with the catalog, and no content observation confirms it',
}

# The kinds that can and cannot satisfy each named check.  A clean decode is integrity: it never establishes identity; a tag, a reported
# hash or a reported declaration never becomes observed content.
CHECKS = {
    'located_defect': {'kinds': ('integrity',), 'value': 'a finding with known_defect true and a location', 'execution': ('ran', 'failed', 'timed_out')},
    'support_grade_defect': {'kinds': ('integrity',), 'value': 'located_defect from a result that ran to completion (state ran, status ok), or an error result whose cause is not tool', 'execution': ('ran', 'failed')},
    'positively_clean': {'kinds': ('integrity',), 'value': 'H1', 'execution': ('ran',)},
    'identity_disagreement': {'kinds': ('content', 'report_content'), 'never': ('declaration', 'report_declaration', 'report_hash', 'integrity', 'integrity_signal', 'catalog'),
                              'value': 'a typed title / episode / author / language field, or an episode marker in text, that disagrees with every catalog value after aliases and orderings'},
    'identity_agreement': {'kinds': ('content', 'report_content'), 'never': ('declaration', 'report_declaration', 'report_hash', 'integrity', 'integrity_signal', 'catalog'),
                           'value': 'a content value that contains a catalog identity value (title, alias, episode title or marker)'},
    'declaration_disagreement': {'kinds': ('declaration', 'report_declaration', 'report_hash'), 'value': 'a declared identity / edition value that disagrees with the catalog'},
    'naming_surface_defect': {'kinds': ('declaration',), 'value': 'M6: an explicitly empty, or differing, naming-surface field (absent is NOT evidence: it is unknown)'},
    'unsupported_selected_stream': {'kinds': ('client', 'declaration'), 'value': 'client_comparison row unsupported, selection recorded or only_stream_of_type'},
    'stated_client': {'kinds': ('client',), 'value': 'context.client_profile or context.expected.client_profile populated'},
    'managed_app': {'kinds': ('catalog',), 'value': 'context.arr.app is a managing app (sonarr, radarr, lidarr, readarr, bookshelf, lazylibrarian)'},
    'source_bound': {'kinds': ('catalog',), 'value': 'the managing app\'s record of the linked file (relativePath / file id) equals the case\'s file name or file id; for an unmanaged item the case item itself'},
    'destination_evidenced': {'kinds': ('content', 'report_content'), 'value': 'content names the item the file really is, and the catalog lists that item'},
    'free_slot': {'kinds': ('catalog',), 'value': 'a catalog record of the destination item shows NO linked file (explicit null / empty / hasFile false); absent is not evidence'},
    'old_value': {'kinds': ('declaration', 'catalog'), 'value': 'the current naming-surface value, populated'},
    'new_value': {'kinds': ('catalog',), 'value': 'the catalog value the naming surface should carry, populated and different from the old value'},
    'two_candidates': {'kinds': ('catalog',), 'value': 'two or more legitimate candidates listed by the case (editions, episode orders, aliases with different numbering)'},
    'no_settling_choice': {'kinds': ('catalog',), 'value': 'no case-supplied choice (series_order, library_episode_order, wanted / monitored edition) that selects one candidate'},
}

# DIAGNOSIS PREREQUISITES (what establishes the class).  Separate from action prerequisites.
DIAGNOSIS = {
    'corrupt_file': ({'id': 'D-COR-1', 'check': 'located_defect'},),
    'decoder_incompatible': ({'id': 'D-DEC-1', 'check': 'stated_client'}, {'id': 'D-DEC-2', 'check': 'unsupported_selected_stream'}),
    'identity_mismatch': ({'id': 'D-ID-1', 'check': 'identity_disagreement'},),
    'metadata_naming': ({'id': 'D-NAME-1', 'check': 'naming_surface_defect'}, {'id': 'D-NAME-2', 'check': 'positively_clean'},
                        {'id': 'D-NAME-3', 'check': 'identity_level', 'value': 'uncontradicted or content_verified (contested or contradicted is not naming)'}),
    'order_edition_ambiguity': ({'id': 'D-ORD-1', 'check': 'two_candidates'}, {'id': 'D-ORD-2', 'check': 'no_settling_choice'}),
    'healthy': tuple({'id': 'D-OK-' + h['id'], 'check': h['id']} for h in HEALTHY),
    'insufficient_evidence': ({'id': 'D-INS-1', 'check': 'none_established', 'value': 'no other class established and healthy not established'},),
}

# ACTION PREREQUISITES.  `source` is the binding of the proposal to the item under triage (NOT proof of content identity or health);
# `target` is action specific.  `execution` lists what the executor (never the model) must check before a real write; they are not
# missing prerequisites of the proposal.
ACTIONS = {
    'none': {'classes': ('healthy',), 'source': None, 'target': None, 'prerequisites': (), 'execution': ()},
    'escalate': {'classes': 'any', 'source': None, 'target': None, 'prerequisites': (), 'execution': ()},
    'blocklist_and_search': {
        'classes': ('identity_mismatch', 'corrupt_file'), 'source': 'source_bound', 'target': {'kind': 'release_of_source', 'fields': ('source_ref',)},
        'prerequisites': (
            {'id': 'A-BLK-1', 'check': 'managed_app'},
            {'id': 'A-BLK-2', 'check': 'source_bound'},
            {'id': 'A-BLK-3', 'check': 'support_grade_defect', 'when_class': 'corrupt_file'},
            {'id': 'A-BLK-4', 'check': 'identity_disagreement', 'when_class': 'identity_mismatch', 'support_grade': True},
        ),
        'execution': ('the release record still links the bound source', 'the blocklist entry is recorded so it can be removed')},
    'remap': {
        'classes': ('identity_mismatch', 'metadata_naming'), 'source': 'source_bound', 'target': {'kind': 'destination_slot', 'fields': ('slot_ref', 'slot_free_ref')},
        'prerequisites': (
            {'id': 'A-MAP-1', 'check': 'managed_app'},
            {'id': 'A-MAP-2', 'check': 'source_bound'},
            {'id': 'A-MAP-3', 'check': 'destination_evidenced'},
            {'id': 'A-MAP-4', 'check': 'free_slot'},
        ),
        'execution': ('the destination slot is still free at execution time (collision check)', 'no file is overwritten or deleted')},
    'rename': {
        'classes': ('metadata_naming',), 'source': 'source_bound', 'target': {'kind': 'rename_of_source', 'fields': ('old_value', 'new_value')},
        'prerequisites': (
            {'id': 'A-REN-0', 'check': 'source_bound'},
            {'id': 'A-REN-1', 'check': 'identity_level', 'value': 'content_verified'},
            {'id': 'A-REN-2', 'check': 'old_value'},
            {'id': 'A-REN-3', 'check': 'new_value'},
        ),
        'execution': ('the new name does not collide with another file', 'the old value is recorded for the undo')},
    'convert': {
        'classes': ('decoder_incompatible',), 'source': 'source_bound', 'target': {'kind': 'isolated_copy', 'fields': (), 'allocated_by': 'executor'},
        'prerequisites': (
            {'id': 'A-CNV-0', 'check': 'source_bound'},
            {'id': 'A-CNV-1', 'check': 'stated_client'},
            {'id': 'A-CNV-2', 'check': 'unsupported_selected_stream'},
        ),
        'execution': ('the executor allocates and names the isolated copy', 'the copy does not overwrite an existing file (no-overwrite)', 'the copy is validated against the stated client'),
        'not_prerequisites': ('a destination name from the model', 'a clean full decode of the source')},
}

# CAPABILITY LINKS: rules (implemented by links.py)
LINK_RULES = {
    'inputs': ('visible observations', 'advertised capabilities', 'TOOL_SEMANTICS'),
    'never_inputs': ('an uncalled result', 'truth, labels, provenance labels, solvability', 'remaining budget (counted separately)'),
    'meaning': 'may inspect this scope; never will resolve it',
    'availability': ('available', 'unavailable', 'unknown', 'called', 'called_failed'),
    'offsets': 'every advertised offset whose window intersects the unresolved interval, in advertised order; "any" yields one template at the interval start; never an offset chosen by a recorded result',
    'cardinality': 'zero, one or many candidates',
}

# UNCALLED-CHECK COUNTING (an escalation's decision prefix): a candidate counts only when available, offered, its arguments valid for
# the advertisement, not a repeat of a call already made (or failed) and the remaining budget at the decision is at least one.
UNCALLED_RULES = ('availability available', 'tool offered', 'arguments valid for the advertisement', 'not a repeat of a call already made',
                  'not a repeat of a call that failed, timed out or was unavailable', 'remaining budget >= 1 at the decision')

# forbidden output fields of every v3 prototype (a renderer or checker states facts and prerequisite states, never a verdict)
FORBIDDEN_FIELDS = ('sufficient', 'solvable', 'recommended_action', 'recommended', 'expected_class', 'truth', 'label', 'will_resolve')


RUBRIC = {
    'version': RUBRIC_VERSION, 'statement_kinds': STATEMENT_KINDS, 'provenance': PROVENANCE, 'presence': PRESENCE, 'source_presence': SOURCE_PRESENCE,
    'report_method_vocabulary': REPORT_METHOD_VOCABULARY, 'naming_surface': NAMING_SURFACE, 'identity_attributes': IDENTITY_ATTRIBUTES,
    'edition_attributes': EDITION_ATTRIBUTES, 'runtime_tolerance': {'seconds': RUNTIME_TOLERANCE_S, 'fraction': RUNTIME_TOLERANCE_FRACTION},
    'material_conflicts': MATERIAL_CONFLICTS, 'tool_semantics': TOOL_SEMANTICS, 'uninspectable_scopes': UNINSPECTABLE_SCOPES, 'axes': AXES,
    'material_uncertainty': MATERIAL_UNCERTAINTY, 'healthy': HEALTHY, 'identity_levels': IDENTITY_LEVELS, 'checks': CHECKS,
    'diagnosis': DIAGNOSIS, 'actions': ACTIONS, 'link_rules': LINK_RULES, 'uncalled_rules': UNCALLED_RULES, 'forbidden_fields': FORBIDDEN_FIELDS,
}


def canonical_json():
    import json
    return json.dumps(RUBRIC, sort_keys=True, ensure_ascii=False, separators=(',', ':'))


def sha256():
    import hashlib
    return hashlib.sha256(canonical_json().encode()).hexdigest()
