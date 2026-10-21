"""dev-c7 (WO-W22): dev-c6 stays byte-identical.  Every committed dev-c6 base-run record (prompt v6, evidence format v3, guards v3; the restored views share
their transcripts) is re-run OFFLINE through the dev-c7 runner with the recorded replies played back (no model call): every request sent equals the recorded raw
request (the system text, the user messages and the Ollama schema; the flattened transcript of the claude and codex CLIs), and the decision, guard outcome,
reference resolution, action audit, tool calls and the evidence-format record equal the record.  Only authorised records are read: the committed run
directories and the public dev suite v1.1.  A case whose fixture is not in this checkout (a pod-local cache) is counted as unavailable coverage and skipped
without resolving it when it names the forbidden harness cache.  Serial, offline, no binaries, no network."""
import json
import tempfile
import unittest

import th
import test_contract_v3_baseline as B
from media_repair_harness import adapters as A
from media_repair_harness import run as R
from media_repair_harness import tools as T

DEV_C6 = ('devc6-gpt-6-astra', 'devc6-haiku-5-5', 'devc6-qwen3.8-27b')
FORBIDDEN_CACHE = 'media-repair-harness-1019'


class DevC6ReRendered(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        B.need_v11()

    def test_requests_decisions_guards_audit_and_records_are_reproduced(self):
        n_req = n_rec = skipped = 0
        for run in DEV_C6:
            records = sorted((B.RUNS / 'dev-c6' / run).glob('*-*-*.json'))
            self.assertEqual(len(records), 73, run)
            for p in records:
                rec = json.loads(p.read_text())
                self.assertEqual((rec['prompt']['version'], rec['evidence_format']['version']), ('v6', 'v3'), p.name)
                case = B.load_case(rec['case_id'], rec['case_sha256'])
                locator = str((case.get('fixture') or {}).get('locator') or '')
                if FORBIDDEN_CACHE in locator or T.Fixture.from_case(case, B.SUITE_V11).verify_local() != rec['fixture']:
                    skipped += 1     # unavailable coverage here: a fixture outside git, whose advertisement legitimately differs in this checkout
                    continue
                n_rec += 1
                ad = B.Replay(rec['requested_model'], [t['text'] for t in rec['turns']])
                new = R.run_case(case, rec['case_sha256'], ad, B.SUITE_V11, tempfile.mkdtemp(prefix='mrh-w22-'), run_id=rec['run_id'], prompt_version='v6',
                                 evidence_format='v3', guards='v3', replay='auto', which=th.NO_BINARIES, tool_output_bytes=8192)
                self.assertEqual(len(ad.sent), len(rec['turns']), p.name)
                for sent, turn in zip(ad.sent, rec['turns']):
                    raw = turn['raw_request']
                    if 'messages' in raw:            # ollama: system + messages + the per-case schema
                        self.assertEqual([{'role': 'system', 'content': sent['system']}] + sent['messages'], raw['messages'], p.name)
                        self.assertEqual(sent['schema'], raw['format'], p.name)
                    elif 'system_prompt' in raw:     # the claude CLI: the system prompt and one flattened transcript
                        self.assertEqual(sent['system'], raw['system_prompt'], p.name)
                        self.assertEqual(A.render_transcript(sent['messages']), raw['prompt'], p.name)
                    else:                            # the codex CLI: the system text and the transcript in one prompt
                        self.assertEqual(sent['system'] + '\n\n---\n\n' + A.render_transcript(sent['messages']), raw['prompt'], p.name)
                    n_req += 1
                for key in ('decision', 'guard', 'bad_evidence_refs', 'refs_to_failed_tools', 'refs_to_non_ok_tools', 'decision_flags', 'unverified_parts', 'forced'):
                    self.assertEqual(new.get(key), rec.get(key), (p.name, key))
                self.assertEqual(new['action_audit'], rec['action_audit'], p.name)
                for key in ('capabilities', 'messages', 'final_summary', 'wire_bytes', 'audit_version', 'tools_behavior', 'rubric', 'version', 'contract'):
                    self.assertEqual(new['evidence_format'][key], rec['evidence_format'][key], (p.name, key))
                strip = lambda calls: [{k: v for k, v in c.items() if k != 'wall_s'} for c in calls]
                self.assertEqual(strip(new['tool_calls']), strip(rec['tool_calls']), p.name)
                self.assertEqual(new['prompt']['sha256'], rec['prompt']['sha256'], p.name)
        self.assertEqual(n_rec + skipped, 219)
        self.assertGreaterEqual(n_rec, 207, (n_rec, skipped))      # at most the 4 pod-local fixture cases per run are unavailable here
        self.assertGreater(n_req, n_rec)
        print('\ndev-c6 replay: %d records re-rendered, %d requests equal, %d unavailable here (pod-local fixtures)' % (n_rec, n_req, skipped))


if __name__ == '__main__':
    unittest.main()
