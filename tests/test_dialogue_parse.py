import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import fm_synth


class DialogueParseTests(unittest.TestCase):
    def test_host_guest_lines(self):
        turns = fm_synth._parse_fm_dialogue_turns(
            'Host: 今天听什么？\nGuest: 先讲一个能记住的结论。\nHost: 那边界呢？\nGuest: 只在材料里出现过的条件下成立。'
        )
        self.assertEqual([speaker for speaker, _text in turns], ['Host', 'Guest', 'Host', 'Guest'])
        self.assertEqual({speaker for speaker, _text in turns}, {'Host', 'Guest'})

    def test_scene_and_voice_catalogs(self):
        self.assertIn('morning_brief', fm_synth.FM_PROGRAM_PRESET_INDEX)
        self.assertTrue(fm_synth.FM_PROGRAM_PRESET_INDEX['morning_brief']['prompt'])
        self.assertIn('Kore', fm_synth.FM_VOICE_IDS)
        self.assertIn('focus_lofi', fm_synth.FM_MUSIC_PRESET_INDEX)


if __name__ == '__main__':
    unittest.main()
