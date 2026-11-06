"""本地频道与成片库。旧节目保留，缺少的新字段在读取时补默认值。"""
from __future__ import annotations

import io
import logging
import json
import os
import subprocess
import threading
import uuid
import zipfile
from contextlib import ExitStack
from datetime import datetime
from pathlib import Path

_lock = threading.Lock()
_mp3_locks: dict[str, threading.Lock] = {}


class MediaBusy(Exception):
    """An export currently owns this result's files."""


class Conflict(Exception):
    """另一处已经写过这个节目。调用方应保留用户还没提交的内容。"""

    def __init__(self, show: dict):
        super().__init__('这个节目刚刚在另一处保存过')
        self.show = show


def data_root() -> Path:
    raw = (os.environ.get('DIYFM_DATA') or '').strip()
    return Path(raw) if raw else Path(__file__).resolve().parent / 'data'


def _shows_path() -> Path:
    return data_root() / 'shows.json'


def _audio_dir() -> Path:
    return data_root() / 'audio'


def _now() -> str:
    return datetime.now().isoformat(timespec='seconds')


def _blank() -> dict:
    return {'shows': []}


def _read() -> dict:
    if not _shows_path().exists():
        return _blank()
    try:
        data = json.loads(_shows_path().read_text(encoding='utf-8'))
    except Exception as exc:
        raise RuntimeError('节目库读取失败，请先检查或恢复 data/shows.json，避免覆盖原数据。') from exc
    if not isinstance(data, dict) or not isinstance(data.get('shows'), list):
        raise RuntimeError('节目库格式无效，请检查或恢复 data/shows.json。')
    for show in data['shows']:
        show.setdefault('language', 'en')
        show.setdefault('difficulty', 'basic')
        show.setdefault('wish', '')
        show.setdefault('schema_version', 2)
    return data


def _write(data: dict) -> None:
    data_root().mkdir(parents=True, exist_ok=True)
    _audio_dir().mkdir(parents=True, exist_ok=True)
    tmp = _shows_path().with_suffix('.json.tmp')
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    tmp.replace(_shows_path())


def list_shows() -> list[dict]:
    with _lock:
        shows = _read()['shows']
    return sorted(shows, key=lambda s: s.get('updated_at') or '', reverse=True)


def get_show(show_id: str) -> dict | None:
    with _lock:
        for show in _read()['shows']:
            if show.get('id') == show_id:
                return show
    return None


def create_show(title: str, preferences: dict | None = None) -> dict:
    show = {
        'id': 'show_' + uuid.uuid4().hex[:8],
        'title': (title or '未命名节目').strip()[:80] or '未命名节目',
        'scene_id': 'morning_brief',
        'host_voice': 'Kore',
        'guest_voice': 'Puck',
        'music_style': 'morning_acoustic',
        'length': 'SHORT',
        'materials': [],
        'episodes': [],
        'created_at': _now(),
        'updated_at': _now(),
        'revision': 0,
        'language': 'en',
        'difficulty': 'basic',
        'wish': '',
        'schema_version': 2,
    }
    for key in ('language', 'difficulty', 'wish', 'length', 'host_voice', 'guest_voice', 'music_style'):
        if preferences and key in preferences:
            show[key] = preferences[key]
    with _lock:
        data = _read()
        data['shows'].insert(0, show)
        _write(data)
    return show


def update_show(show_id: str, patch: dict, expected_revision: int | None = None) -> dict | None:
    allowed = {'title', 'scene_id', 'scene_prompt', 'host_voice', 'guest_voice', 'music_style', 'length', 'language', 'difficulty', 'wish'}
    with _lock:
        data = _read()
        for show in data['shows']:
            if show.get('id') != show_id:
                continue
            current = int(show.get('revision') or 0)
            if expected_revision is not None and int(expected_revision) != current:
                raise Conflict(dict(show))
            for key, value in patch.items():
                if key not in allowed or value is None:
                    continue
                if key == 'scene_prompt':
                    show[key] = str(value)[:4000]
                elif key == 'title':
                    show[key] = str(value).strip()[:80] or show.get('title') or '未命名节目'
                else:
                    show[key] = value
            show['updated_at'] = _now()
            show['revision'] = current + 1
            _write(data)
            return show
    return None


def delete_show(show_id: str) -> bool:
    return _delete_content(show_id) is not None


def delete_episode(show_id: str, episode_id: str) -> dict | None:
    """Delete one saved result and its audio, retaining the channel preferences."""
    return _delete_content(show_id, episode_id)


def _delete_content(show_id: str, episode_id: str | None = None) -> dict | None:
    # Never remove a source while FFmpeg is writing its cache, or hold the
    # production lock through a long export just to delete a result.
    with _lock:
        show = next((s for s in _read()['shows'] if s.get('id') == show_id), None)
        if show is None:
            return None
        ids = sorted({ep['id'] for ep in show.get('episodes', [])
                      if _safe_episode_id(ep.get('id', '')) and
                      (episode_id is None or ep.get('id') == episode_id)})
        guards = [_mp3_locks.setdefault(eid, threading.Lock()) for eid in ids]
    with ExitStack() as stack:
        for guard in guards:
            if not guard.acquire(blocking=False):
                raise MediaBusy('音频正在准备下载，请等下载准备完成后再删除。')
            stack.callback(guard.release)
        with _lock:
            data = _read()
            show = next((s for s in data['shows'] if s.get('id') == show_id), None)
            if show is None or (episode_id is not None and not any(
                    ep.get('id') == episode_id for ep in show.get('episodes', []))):
                return None
            staged = []
            try:
                for eid in ids:
                    for ext in ('.wav', '.mp3'):
                        path = _audio_dir() / f'{eid}{ext}'
                        if path.exists():
                            pending = path.with_name(f'.{path.name}.deleting-{uuid.uuid4().hex}')
                            path.replace(pending)
                            staged.append((path, pending))
                if episode_id is None:
                    data['shows'] = [s for s in data['shows'] if s.get('id') != show_id]
                else:
                    show['episodes'] = [ep for ep in show.get('episodes', []) if ep.get('id') != episode_id]
                    show['updated_at'] = _now()
                    show['revision'] = int(show.get('revision') or 0) + 1
                _write(data)
            except Exception:
                for original, pending in reversed(staged):
                    pending.replace(original)
                raise
            for _, pending in staged:
                try:
                    pending.unlink()
                except OSError:
                    # No public audio path remains. A cleanup failure must not
                    # report the already committed library change as a failure.
                    logging.exception('Could not remove staged audio %s', pending.name)
            return show


def add_material(show_id: str, *, title: str, kind: str, text: str, source: str = '') -> dict | None:
    item = {
        'id': 'mat_' + uuid.uuid4().hex[:8],
        'title': (title or '未命名资料').strip()[:120] or '未命名资料',
        'kind': kind,
        'source': (source or '')[:500],
        'text': text,
        'chars': len(text),
        'created_at': _now(),
    }
    with _lock:
        data = _read()
        for show in data['shows']:
            if show.get('id') != show_id:
                continue
            show.setdefault('materials', []).insert(0, item)
            show['updated_at'] = _now()
            _write(data)
            return item
    return None


def delete_material(show_id: str, material_id: str) -> bool:
    with _lock:
        data = _read()
        for show in data['shows']:
            if show.get('id') != show_id:
                continue
            before = len(show.get('materials') or [])
            show['materials'] = [m for m in (show.get('materials') or []) if m.get('id') != material_id]
            if len(show['materials']) == before:
                return False
            show['updated_at'] = _now()
            _write(data)
            return True
    return False


def public_show(show: dict) -> dict:
    """列表里不回传整篇投料正文。"""
    materials = []
    for mat in show.get('materials') or []:
        materials.append({
            'id': mat.get('id'),
            'title': mat.get('title'),
            'kind': mat.get('kind'),
            'source': mat.get('source'),
            'chars': mat.get('chars') or len(mat.get('text') or ''),
            'created_at': mat.get('created_at'),
        })
    episodes = []
    for ep in show.get('episodes') or []:
        episodes.append({**{k: v for k, v in ep.items() if k not in {'script', 'turns', 'draft', 'research'}},
                         'has_script': bool(ep.get('script'))})
    return {**show, 'materials': materials, 'episodes': episodes}


def save_episode(show_id: str, episode: dict, wav: bytes) -> dict:
    _audio_dir().mkdir(parents=True, exist_ok=True)
    path = _audio_dir() / f"{episode['id']}.wav"
    tmp = path.with_suffix('.wav.tmp')
    tmp.write_bytes(wav)
    tmp.replace(path)
    episode['url'] = f"/api/episodes/{episode['id']}/audio"
    episode['bytes'] = len(wav)
    with _lock:
        data = _read()
        for show in data['shows']:
            if show.get('id') != show_id:
                continue
            episodes = [ep for ep in (show.get('episodes') or []) if ep.get('id') != episode['id']]
            episodes.insert(0, episode)
            show['episodes'] = episodes
            show['updated_at'] = _now()
            _write(data)
            return episode
    raise KeyError(show_id)


def patch_episode(show_id: str, episode_id: str, patch: dict) -> None:
    with _lock:
        data = _read()
        for show in data['shows']:
            if show.get('id') != show_id:
                continue
            for episode in show.get('episodes') or []:
                if episode.get('id') != episode_id:
                    continue
                episode.update(patch)
                show['updated_at'] = _now()
                _write(data)
                return
    raise KeyError(episode_id)


def mark_episode(show_id: str, episode: dict) -> None:
    with _lock:
        data = _read()
        for show in data['shows']:
            if show.get('id') != show_id:
                continue
            episodes = [ep for ep in (show.get('episodes') or []) if ep.get('id') != episode['id']]
            episodes.insert(0, episode)
            show['episodes'] = episodes
            show['updated_at'] = _now()
            _write(data)
            return
    raise KeyError(show_id)


def _safe_episode_id(episode_id: str) -> str:
    safe = ''.join(ch for ch in (episode_id or '') if ch.isalnum() or ch in '_-')
    if not safe or safe != episode_id:
        return ''
    return safe


def find_episode(episode_id: str) -> tuple[dict, dict] | None:
    safe = _safe_episode_id(episode_id)
    if not safe:
        return None
    for show in list_shows():
        for episode in show.get('episodes') or []:
            if episode.get('id') == safe:
                return show, episode
    return None


def audio_path(episode_id: str) -> Path | None:
    safe = _safe_episode_id(episode_id)
    if not safe:
        return None
    path = _audio_dir() / f'{safe}.wav'
    return path if path.exists() else None


def ensure_mp3(episode_id: str) -> Path:
    with _lock:
        guard = _mp3_locks.setdefault(episode_id, threading.Lock())
    with guard:
        return _ensure_mp3_locked(episode_id)


def _ensure_mp3_locked(episode_id: str) -> Path:
    wav = audio_path(episode_id)
    if not wav:
        raise FileNotFoundError(episode_id)
    mp3 = wav.with_suffix('.mp3')
    if mp3.exists() and mp3.stat().st_mtime >= wav.stat().st_mtime and mp3.stat().st_size > 1000:
        return mp3
    import imageio_ffmpeg
    exe = imageio_ffmpeg.get_ffmpeg_exe()
    tmp = mp3.with_suffix('.mp3.tmp')
    try:
        proc = subprocess.run(
            [exe, '-y', '-i', str(wav), '-vn', '-codec:a', 'libmp3lame', '-q:a', '4', '-f', 'mp3', str(tmp)],
            capture_output=True, text=True, timeout=180,
        )
        if proc.returncode != 0 or not tmp.exists() or tmp.stat().st_size < 1000:
            tail = (proc.stderr or 'mp3 转码失败').strip().splitlines()
            raise RuntimeError(tail[-1][:240] if tail else 'mp3 转码失败')
        tmp.replace(mp3)
    finally:
        if tmp.exists():
            tmp.unlink()
    return mp3


def export_zip() -> bytes:
    """打包节目清单、设置和成片。试听缓存不放进去，清缓存也不会靠这个恢复成片。"""
    root = data_root()
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for name in ('shows.json', 'settings.json'):
            path = root / name
            if path.is_file():
                archive.write(path, name)
        for folder in ('audio', 'bgm'):
            directory = root / folder
            if not directory.is_dir():
                continue
            for file in sorted(directory.glob('*')):
                if file.is_file() and file.suffix in {'.wav', '.mp3'}:
                    archive.write(file, f'{folder}/{file.name}')
    return buf.getvalue()
