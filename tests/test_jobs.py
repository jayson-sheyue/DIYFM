import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import broadcast


class JobRuleTests(unittest.TestCase):
    def test_orphan_only_when_thread_is_gone(self):
        episode = {'status': 'generating', 'phase': 'voice'}
        self.assertIsNone(broadcast.orphan_update(episode, show_busy=True))
        patch = broadcast.orphan_update(episode, show_busy=False)
        self.assertEqual(patch['phase'], 'interrupted')
        self.assertIn('服务重启', patch['error'])
        self.assertIsNone(broadcast.orphan_update({'status': 'ready'}, show_busy=False))

    def test_snapshot_is_a_copy(self):
        source = {
            'project_id': 'example-project',
            'llm_model': 'gemini-2.5-flash',
            'llm_location': 'us-central1',
            'tts_model': 'gemini-3.1-flash-tts-preview',
            'lyria_model': 'lyria-002',
            'lyria_location': 'global',
        }
        snap = broadcast.config_snapshot(source)
        source['llm_model'] = 'changed-later'
        self.assertEqual(snap['llm_model'], 'gemini-2.5-flash')
        self.assertNotIn('auth', snap)


if __name__ == '__main__':
    unittest.main()
