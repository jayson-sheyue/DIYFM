"""声线试听缓存。成片在 data/audio，不在这个目录里。"""
from __future__ import annotations

import hashlib
import json
import threading
from datetime import datetime, timedelta
from pathlib import Path

import store

TTL = timedelta(days=7)
MAX_FILES = 24
MAX_BYTES = 40 * 1024 * 1024

_lock = threading.Lock()
_boxes: dict[str, dict] = {}
_nonce: dict[str, int] = {}
_seq = 0


def cache_key(*, voice: str, role: str, model: str, language: str, project: str = '') -> str:
    raw = '\n'.join([voice.strip(), role.strip(), model.strip(), language.strip(), project.strip(), 'letters-preview-1'])
    return hashlib.sha256(raw.encode('utf-8')).hexdigest()[:32]


def _dir() -> Path:
    return store.data_root() / 'previews'


def _ok_key(key: str) -> bool:
    return len(key) == 32 and all(ch in '0123456789abcdef' for ch in key)


def _paths(key: str) -> tuple[Path, Path]:
    folder = _dir()
    return folder / f'{key}.mp3', folder / f'{key}.json'


def _parse_time(value: str) -> datetime | None:
    try:
        return datetime.fromisoformat(value)
    except Exception:
        return None


def read_fresh(key: str, now: datetime | None = None) -> tuple[bytes, str] | None:
    if not _ok_key(key):
        return None
    audio, meta_path = _paths(key)
    if not audio.is_file() or not meta_path.is_file() or audio.stat().st_size < 64:
        return None
    try:
        meta = json.loads(meta_path.read_text(encoding='utf-8'))
    except Exception:
        return None
    created = _parse_time(str(meta.get('created_at') or ''))
    if not created:
        return None
    moment = now or datetime.now()
    if moment - created > TTL:
        return None
    return audio.read_bytes(), created.isoformat(timespec='seconds')


def commit(key: str, nonce: int, audio: bytes, now: datetime | None = None) -> str:
    """只有仍是这一次生成的结果才覆盖文件。失败或过期的旧文件留到新的成功为止。"""
    if not _ok_key(key) or len(audio) < 64:
        return ''
    with _lock:
        if _nonce.get(key) != nonce:
            return ''
        folder = _dir()
        folder.mkdir(parents=True, exist_ok=True)
        created = (now or datetime.now()).isoformat(timespec='seconds')
        audio_path, meta_path = _paths(key)
        tmp = audio_path.with_suffix('.mp3.tmp')
        tmp.write_bytes(audio)
        meta_path.write_text(json.dumps({'created_at': created}, ensure_ascii=False), encoding='utf-8')
        tmp.replace(audio_path)
        _evict()
        return created


def _evict() -> None:
    folder = _dir()
    if not folder.is_dir():
        return
    files = [path for path in folder.glob('*.mp3') if path.is_file()]
    files.sort(key=lambda path: path.stat().st_mtime)
    total = sum(path.stat().st_size for path in files)
    while files and (len(files) > MAX_FILES or total > MAX_BYTES):
        victim = files.pop(0)
        total -= victim.stat().st_size
        meta = victim.with_suffix('.json')
        victim.unlink(missing_ok=True)
        if meta.exists():
            meta.unlink()


def clear() -> int:
    folder = _dir()
    if not folder.is_dir():
        return 0
    removed = 0
    for path in folder.glob('*'):
        if path.is_file() and path.suffix in {'.mp3', '.json', '.tmp'}:
            path.unlink()
            removed += 1
    return removed


def get_or_make(key: str, *, force: bool, produce):
    """相同试听复用同一次生成。重新生成用新的序号，晚到的旧结果不能覆盖它。"""
    with _lock:
        global _seq
        if not force:
            cached = read_fresh(key)
            if cached:
                return cached[0], cached[1], 'hit'
        current = _boxes.get(key)
        if current and not force:
            box = current
            owner = False
        else:
            _seq += 1
            box = {'event': threading.Event(), 'nonce': _seq, 'data': None, 'error': None}
            _boxes[key] = box
            _nonce[key] = box['nonce']
            owner = True
    if not owner:
        if not box['event'].wait(180):
            raise TimeoutError('同一次试听还在生成，没有再次提交。')
        if box['error']:
            raise box['error']
        if not box['data']:
            raise RuntimeError('试听没有返回音频。')
        audio, created = box['data']
        return audio, created, 'joined'
    try:
        audio = produce()
        created = commit(key, box['nonce'], audio)
        if not created:
            box['data'] = (audio, '')
            return audio, '', 'stale'
        box['data'] = (audio, created)
        return audio, created, 'miss'
    except Exception as exc:
        box['error'] = exc
        raise
    finally:
        box['event'].set()
        with _lock:
            if _boxes.get(key) is box:
                _boxes.pop(key, None)
