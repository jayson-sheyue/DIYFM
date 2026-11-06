import os
import tempfile
import unittest
from pathlib import Path


class SettingsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.environ['DIYFM_DATA'] = self.tmp.name
        os.environ.pop('DIYFM_PROJECT_ID', None)
        os.environ.pop('GCP_PROJECT_ID', None)
        import settings
        self.settings = settings

    def tearDown(self):
        os.environ.pop('DIYFM_DATA', None)
        self.tmp.cleanup()

    def test_rejects_bad_model_and_keeps_defaults(self):
        with self.assertRaises(ValueError):
            self.settings.save({'llm_model': 'gemini 2.5'})
        self.assertFalse(Path(self.tmp.name, 'settings.json').exists())
        saved = self.settings.save({
            'project_id': 'example-project',
            'llm_model': 'gemini-2.5-pro',
            'tts_model': 'gemini-3.1-flash-tts-preview',
            'lyria_model': 'lyria-002',
            'lyria_location': 'global',
        })
        self.assertEqual(saved['llm_model'], 'gemini-2.5-pro')
        self.assertEqual(saved['project_id'], 'example-project')
        self.assertIn('ADC', self.settings.public()['auth_note'])


if __name__ == '__main__':
    unittest.main()
