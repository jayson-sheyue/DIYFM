"""模型 ID 与区域。本地和 Cloud Run 都走 ADC，这里不保存密钥。"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

def _root() -> Path:
    return Path(os.environ.get('DIYFM_DATA') or (Path(__file__).resolve().parent / 'data'))


def _path() -> Path:
    return _root() / 'settings.json'

DEFAULTS = {
    'project_id': '',
    'llm_model': 'gemini-2.5-flash',
    'llm_location': 'us-central1',
    'tts_model': 'gemini-3.1-flash-tts-preview',
    'lyria_model': 'lyria-002',
    'lyria_location': 'global',
}

_MODEL = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.:-]{1,119}$')
_LOCATION = re.compile(r'^[a-z][a-z0-9-]{1,39}$')
_PROJECT = re.compile(r'^[a-z][a-z0-9-]{4,28}[a-z0-9]$')

_FIELDS = (
    ('project_id', 'GCP 项目 ID'),
    ('llm_model', 'LLM 模型 ID'),
    ('llm_location', 'LLM 区域'),
    ('tts_model', 'TTS 模型 ID'),
    ('lyria_model', 'Lyria 模型 ID'),
    ('lyria_location', 'Lyria 区域'),
)


def _env_seed() -> dict:
    data = dict(DEFAULTS)
    data['project_id'] = (os.getenv('DIYFM_PROJECT_ID') or os.getenv('GCP_PROJECT_ID') or '').strip()
    data['llm_model'] = (os.getenv('DIYFM_SCRIPT_MODEL') or data['llm_model']).strip()
    data['llm_location'] = (os.getenv('DIYFM_LOCATION') or data['llm_location']).strip()
    data['tts_model'] = (os.getenv('DIYFM_TTS_MODEL') or os.getenv('LEARN_FM_TTS_MODEL') or data['tts_model']).strip()
    data['lyria_model'] = (os.getenv('DIYFM_LYRIA_MODEL') or data['lyria_model']).strip()
    data['lyria_location'] = (os.getenv('DIYFM_LYRIA_LOCATION') or os.getenv('LEARN_FM_LYRIA_LOCATION') or data['lyria_location']).strip()
    return data


def load() -> dict:
    if not _path().exists():
        return _env_seed()
    try:
        raw = json.loads(_path().read_text(encoding='utf-8'))
    except Exception:
        return _env_seed()
    data = dict(DEFAULTS)
    if isinstance(raw, dict):
        for key in DEFAULTS:
            if key in raw and raw[key] is not None:
                data[key] = str(raw[key]).strip()
    return data


def validate(patch: dict) -> tuple[dict, list[str]]:
    current = load()
    errors: list[str] = []
    cleaned = dict(current)
    incoming = patch if isinstance(patch, dict) else {}
    for key, label in _FIELDS:
        if key not in incoming:
            continue
        value = str(incoming.get(key) or '').strip()
        if key == 'project_id':
            if value and not _PROJECT.fullmatch(value):
                errors.append(f'{label}格式不对，例如 example-project')
                continue
        elif key.endswith('_location'):
            value = value.lower()
            if not _LOCATION.fullmatch(value):
                errors.append(f'{label}需要像 us-central1 或 global')
                continue
        elif not _MODEL.fullmatch(value):
            errors.append(f'{label}只能包含字母、数字、点、下划线和短横线')
            continue
        cleaned[key] = value
    return cleaned, errors


def save(patch: dict) -> dict:
    cleaned, errors = validate(patch)
    if errors:
        raise ValueError('；'.join(errors))
    _root().mkdir(parents=True, exist_ok=True)
    tmp = _path().with_suffix('.json.tmp')
    tmp.write_text(json.dumps(cleaned, ensure_ascii=False, indent=2), encoding='utf-8')
    tmp.replace(_path())
    return load()


def models() -> dict:
    saved = load()
    project = (
        saved.get('project_id')
        or os.getenv('DIYFM_PROJECT_ID')
        or os.getenv('GOOGLE_CLOUD_PROJECT')
        or os.getenv('GCP_PROJECT_ID')
        or ''
    ).strip()
    return {**saved, 'project_id': project, 'auth': auth_mode()}


def auth_mode() -> str:
    if os.getenv('K_SERVICE'):
        return 'cloud_run'
    return 'adc'


def restore_model_defaults() -> dict:
    """恢复模型与区域默认值，保留已经填写的项目 ID。"""
    current = load()
    patch = {key: value for key, value in DEFAULTS.items() if key != 'project_id'}
    patch['project_id'] = current.get('project_id') or ''
    return save(patch)


def public() -> dict:
    saved = load()
    effective = models()
    if effective['auth'] == 'cloud_run':
        note = '当前在 Cloud Run 上，使用运行时服务账号。请给该账号 Vertex AI User（roles/aiplatform.user）。'
    else:
        note = '当前使用本机 ADC。部署到 Cloud Run 后会自动改用运行时服务账号，给该账号 roles/aiplatform.user 即可调用上面的模型，这里不用填密钥。'
    return {
        'settings': saved,
        'effective_project_id': effective['project_id'],
        'auth': effective['auth'],
        'auth_note': note,
        'priority': '已保存的设置优先。只有还没有设置文件时，才用环境变量填初始值。项目 ID 留空时，再看 DIYFM_PROJECT_ID、GOOGLE_CLOUD_PROJECT、GCP_PROJECT_ID。',
        'effect': '保存后，下一次试听、底乐和合成会用新模型。已经开始的合成仍用它开始时的配置。',
    }
