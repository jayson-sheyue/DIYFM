import types
import unittest
from unittest.mock import patch
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

    def test_synthesize_dialogue_isolates_each_turn_into_single_speaker_call(self):
        calls = []
        state = {'rate_limited_once': False}
        fake_pcm = (b'\x10\x08\xf0\xf7' * (fm_synth.FM_SAMPLE_RATE // 4))

        class FakeClient:
            def __init__(self):
                self.transport = types.SimpleNamespace(close=lambda: None)

            def synthesize_speech(self, *, input, voice, audio_config, timeout):
                calls.append({'text': input.text, 'prompt': input.prompt, 'voice': voice})
                if len(calls) == 2 and not state['rate_limited_once']:
                    state['rate_limited_once'] = True
                    raise RuntimeError('429 Resource Exhausted')
                return types.SimpleNamespace(audio_content=fake_pcm)

        fake_tts = types.SimpleNamespace(
            TextToSpeechClient=FakeClient,
            AudioConfig=lambda **kw: kw,
            AudioEncoding=types.SimpleNamespace(LINEAR16='LINEAR16'),
            SynthesisInput=lambda **kw: types.SimpleNamespace(**kw),
            VoiceSelectionParams=lambda **kw: types.SimpleNamespace(**kw),
        )
        script = (
            'Host: Welcome to tonight\'s letter.\n'
            'Guest: Happy to read it together.\n'
            'Host: The writer said "I brought my bath towel into the hot spring."\n'
            'Guest: Every traveler remembers that moment!\n'
            'Host: Then an older guest gently showed how to pour warm water first.\n'
            'Guest: That keeps the bath clean and warms the body safely.\n'
            'Host: By the end, the traveler felt completely relaxed.\n'
            'Guest: Goodnight, and stay warm everyone.'
        )
        with patch.dict(sys.modules, {'google.cloud.texttospeech': fake_tts, 'google.cloud': types.SimpleNamespace(texttospeech=fake_tts)}), \
             patch('fm_synth.time.sleep') as mocked_sleep:
            pcm = fm_synth._synthesize_fm_dialogue_pcm(
                script,
                host_voice='Zephyr',
                guest_voice='Charon',
                language_code='en',
                model_name='gemini-3.1-flash-tts-preview',
            )
        self.assertEqual(mocked_sleep.call_count, 1)
        # 8 turns + 1 retried 429 on turn 2 = 9 single-speaker requests
        self.assertEqual(
            [c['voice'].name for c in calls],
            ['Zephyr', 'Charon', 'Charon', 'Zephyr', 'Charon', 'Zephyr', 'Charon', 'Zephyr', 'Charon'],
        )
        for c in calls:
            self.assertFalse(hasattr(c['voice'], 'multi_speaker_voice_config'))
            self.assertNotRegex(c['text'], r'^(?:Host|Guest)\s*:')
        self.assertGreater(len(pcm), fm_synth.FM_SAMPLE_RATE * 2)


if __name__ == '__main__':
    unittest.main()
