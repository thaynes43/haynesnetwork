"""No inference: verify matched text-only boundary and resource stop gates."""
import json
import unittest
import run_text


class TextBoundary(unittest.TestCase):
    def test_only_frame_removed_from_frozen_av_tool_packets(self):
        previous = run_text.read(run_text.ROOT.parent / 'media-repair-av-identity-2026-10-18/cases-tool.json')
        current = run_text.read(run_text.ROOT / 'text-cases.json')
        for packet in previous:
            del packet['observations']['frame']
        self.assertEqual(previous, current)
        self.assertTrue(all('images' not in p and 'label' not in p for p in current))

    def test_shared_budgets_and_no_frame_citation(self):
        protocol = run_text.read(run_text.ROOT / 'text-protocol.json')
        self.assertEqual(protocol['max_measured_calls'], protocol['case_count'] * len(protocol['models']))
        self.assertEqual(protocol['options']['num_thread'], 2)
        self.assertNotIn('frame', protocol['av_schema']['properties']['evidence']['items']['enum'])
        self.assertIn('only text observations', protocol['av_system'])

    def test_active_memory_and_oom_block_gate(self):
        snapshot = {'snapshot':{'exit_code':0,'stdout':run_text.runtime.GPU+', 1 MiB, 24124 MiB, 0 %\n'+str(46*2**30)+'\nMemAvailable: 100663296 kB\n','compute_processes':'','compute_query_exit':0},'extra_exit':0,'extra':'inactive_file '+str(44*2**30)+'\noom_kill 0\noom 0\n'}
        self.assertTrue(run_text.healthy(snapshot, idle=True))
        snapshot['extra'] = 'inactive_file 0\noom_kill 0\noom 0\n'
        self.assertFalse(run_text.healthy(snapshot, idle=True))
        snapshot['extra'] = 'inactive_file '+str(44*2**30)+'\noom_kill 1\noom 1\n'
        self.assertFalse(run_text.healthy(snapshot))
        snapshot['extra'] = 'inactive_file '+str(44*2**30)+'\n'
        self.assertFalse(run_text.healthy(snapshot))


if __name__ == '__main__':
    unittest.main()
