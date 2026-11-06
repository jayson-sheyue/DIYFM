import os
import tempfile
import threading
import unittest
from unittest.mock import patch, Mock
import io
import wave
import math
from array import array
import zipfile
from datetime import datetime, timedelta
from io import BytesIO
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import preview_cache
import store


class ReuseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.prev = os.environ.get('DIYFM_DATA')
        os.environ['DIYFM_DATA'] = self.tmp.name
        preview_cache._boxes.clear()
        preview_cache._nonce.clear()

    def tearDown(self):
        preview_cache._boxes.clear()
        preview_cache._nonce.clear()
        if self.prev is None:
            os.environ.pop('DIYFM_DATA', None)
        else:
            os.environ['DIYFM_DATA'] = self.prev
        self.tmp.cleanup()

    def test_same_preview_joins_one_generation(self):
        key = preview_cache.cache_key(voice='Kore', role='host', model='gemini-tts', language='cmn-CN')
        started = threading.Event()
        release = threading.Event()
        calls = []

        def produce():
            calls.append(1)
            started.set()
            self.assertTrue(release.wait(2))
            return b'a' * 80

        outcomes = []

        def run():
            outcomes.append(preview_cache.get_or_make(key, force=False, produce=produce))

        first = threading.Thread(target=run)
        first.start()
        self.assertTrue(started.wait(2))
        second = threading.Thread(target=run)
        second.start()
        release.set()
        first.join(2)
        second.join(2)
        self.assertEqual(calls, [1])
        sources = [item[2] for item in outcomes]
        self.assertEqual(sources.count('miss'), 1)
        self.assertTrue(all(source in {'hit', 'joined', 'miss'} for source in sources))
        self.assertEqual(outcomes[0][0], outcomes[1][0])

    def test_failed_regenerate_keeps_previous_audio(self):
        key = preview_cache.cache_key(voice='Puck', role='guest', model='gemini-tts', language='cmn-CN')
        preview_cache.get_or_make(key, force=False, produce=lambda: b'b' * 80)
        with self.assertRaises(RuntimeError):
            preview_cache.get_or_make(key, force=True, produce=self._boom)
        cached = preview_cache.read_fresh(key)
        self.assertIsNotNone(cached)
        self.assertEqual(cached[0], b'b' * 80)

    def test_expired_preview_is_not_a_hit_and_clear_keeps_episodes(self):
        key = preview_cache.cache_key(voice='Kore', role='host', model='old', language='cmn-CN')
        old = datetime.now() - timedelta(days=8)
        preview_cache._nonce[key] = 1
        preview_cache.commit(key, 1, b'c' * 80, now=old)
        self.assertIsNone(preview_cache.read_fresh(key))
        show = store.create_show('保留')
        episode = store._audio_dir() / 'ep_keep.wav'
        episode.write_bytes(b'RIFFdemo')
        preview_cache.clear()
        self.assertTrue(episode.exists())
        self.assertTrue(store.get_show(show['id']))

    def test_stale_revision_does_not_overwrite(self):
        show = store.create_show('原标题')
        saved = store.update_show(show['id'], {'title': '新标题'}, expected_revision=0)
        self.assertEqual(saved['revision'], 1)
        with self.assertRaises(store.Conflict):
            store.update_show(show['id'], {'title': '过期标题'}, expected_revision=0)
        self.assertEqual(store.get_show(show['id'])['title'], '新标题')

    def test_backup_contains_shows_and_audio_not_preview_cache(self):
        store.create_show('备份节目')
        audio = store._audio_dir() / 'ep_demo.wav'
        audio.parent.mkdir(parents=True, exist_ok=True)
        audio.write_bytes(b'RIFFdemo')
        key = preview_cache.cache_key(voice='Kore', role='host', model='m', language='zh')
        preview_cache._nonce[key] = 3
        preview_cache.commit(key, 3, b'd' * 80)
        archive = zipfile.ZipFile(BytesIO(store.export_zip()))
        names = set(archive.namelist())
        self.assertIn('shows.json', names)
        self.assertIn('audio/ep_demo.wav', names)
        self.assertFalse(any(name.startswith('previews/') for name in names))

    def test_real_mp3_export_reuses_result_and_failed_reexport_keeps_old_file(self):
        show = store.create_show('导出')
        buffer = io.BytesIO()
        with wave.open(buffer, 'wb') as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(24000)
            wav.writeframes(array('h', (int(3000 * math.sin(i * math.pi / 30)) for i in range(48000))).tobytes())
        store.save_episode(show['id'], {'id': 'ep_export', 'status': 'ready'}, buffer.getvalue())
        mp3 = store.ensure_mp3('ep_export')
        self.assertGreater(mp3.stat().st_size, 1000)
        original = mp3.read_bytes()
        with patch('store.subprocess.run') as run:
            self.assertEqual(store.ensure_mp3('ep_export'), mp3)
            run.assert_not_called()
        newer = mp3.stat().st_mtime + 1
        os.utime(store.audio_path('ep_export'), (newer, newer))

        def fail(*args, **kwargs):
            mp3.with_suffix('.mp3.tmp').write_bytes(b'partial')
            return Mock(returncode=1, stderr='conversion failed')

        with patch('store.subprocess.run', side_effect=fail):
            with self.assertRaises(RuntimeError):
                store.ensure_mp3('ep_export')
        self.assertEqual(mp3.read_bytes(), original)
        self.assertFalse(mp3.with_suffix('.mp3.tmp').exists())

    @staticmethod
    def _boom():
        raise RuntimeError('生成失败')


if __name__ == '__main__':
    unittest.main()
