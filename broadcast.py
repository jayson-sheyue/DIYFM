"""把一个节目的投料收成一集双人 FM。"""
from __future__ import annotations

import threading
import uuid
from datetime import datetime

import fm_synth
import harness
import re
import copy
import io
import wave
import settings as diy_settings
import store

_jobs: set[str] = set()
_guard = threading.Lock()


def _phase(show_id: str, episode_id: str, phase: str) -> None:
    try:
        store.patch_episode(show_id, episode_id, {'status': 'generating', 'phase': phase})
    except Exception:
        pass


def _now() -> str:
    return datetime.now().isoformat(timespec='seconds')


INTERRUPTED_MESSAGE = '服务重启后这次制作没有继续。收听愿望和已完成的台本仍保留，可以重新制作。关掉页面不会停止后台任务。'


def config_snapshot(models: dict | None = None) -> dict:
    """任务开始时记下模型配置。之后改设置，不影响这一次。"""
    cfg = models if isinstance(models, dict) else diy_settings.models()
    return {
        'project_id': str(cfg.get('project_id') or ''),
        'llm_model': str(cfg.get('llm_model') or ''),
        'llm_location': str(cfg.get('llm_location') or ''),
        'tts_model': str(cfg.get('tts_model') or ''),
        'lyria_model': str(cfg.get('lyria_model') or ''),
        'lyria_location': str(cfg.get('lyria_location') or ''),
    }


def orphan_update(episode: dict, *, show_busy: bool) -> dict | None:
    if show_busy or (episode or {}).get('status') != 'generating':
        return None
    return {
        'status': 'failed',
        'phase': 'interrupted',
        'title': '合成已中断',
        'error': INTERRUPTED_MESSAGE,
    }


def reconcile_orphans() -> int:
    """进程重启后，内存里的合成线程已经没了，不能再显示成进行中。"""
    with _guard:
        live = set(_jobs)
    changed = 0
    for show in store.list_shows():
        busy = show.get('id') in live
        for episode in show.get('episodes') or []:
            patch = orphan_update(episode, show_busy=busy)
            if not patch:
                continue
            store.patch_episode(show['id'], episode['id'], patch)
            changed += 1
    return changed


def produce(show_id: str, *, episode_wish='', request_id='', revision=None, retry_episode_id='') -> dict:
    if not isinstance(episode_wish, str) or len(episode_wish) > 600:
        raise ValueError('本期愿望请控制在 600 字以内')
    if not isinstance(request_id, str) or (request_id and not re.fullmatch(r'[A-Za-z0-9_-]{8,80}', request_id)):
        raise ValueError('请求编号无效')
    if not isinstance(retry_episode_id, str):
        raise ValueError('重试节目编号无效')
    with _guard:
        show = store.get_show(show_id)
        if not show:
            raise fm_synth.NotebookLMError('频道不存在', status_code=404, code='missing_show')
        if request_id:
            existing = next((ep for ep in show.get('episodes', []) if ep.get('request_id') == request_id), None)
            if existing:
                return existing
        if revision is not None and int(revision) != int(show.get('revision') or 0):
            raise store.Conflict(show)
        if show_id in _jobs:
            raise fm_synth.NotebookLMError('这个频道已有一集正在制作，可在消息中查看。', status_code=409, code='busy')
        if len(_jobs) >= 2:
            raise fm_synth.NotebookLMError('已有两集在制作，请等其中一集完成后再开始。', status_code=429, code='capacity')
        resume = None
        if retry_episode_id:
            resume = next((ep for ep in show.get('episodes', []) if ep['id'] == retry_episode_id and ep.get('status') == 'failed'), None)
            if not resume:
                raise ValueError('只能重试本频道里未完成的节目。')
            original = resume.get('input') or {}
            for key in ('language', 'difficulty', 'wish', 'length', 'host_voice', 'guest_voice', 'music_style'):
                if original.get(key) is not None:
                    show[key] = original[key]
            episode_wish = original.get('episode_wish', '')
        if show.get('host_voice') == show.get('guest_voice'):
            raise ValueError('两位主持需要使用不同声线，请到声音设置调整。')
        snapshot = config_snapshot()
        if not snapshot['project_id']:
            raise ValueError('请先到设置填写 Google Cloud 项目 ID，收听愿望会保留。')
        episode_id = 'ep_' + uuid.uuid4().hex[:12]
        inputs = {k: show.get(k) for k in ('title', 'language', 'difficulty', 'wish', 'length', 'host_voice', 'guest_voice', 'music_style', 'revision')}
        inputs['episode_wish'] = episode_wish.strip()
        pending = {'id': episode_id, 'request_id': request_id, 'title': '正在策划本期来信…',
                   'status': 'generating', 'phase': 'plan', 'created_at': _now(), 'error': '',
                   'config': snapshot, 'input': inputs, 'harness_version': harness.VERSION,
                   'retry_of': retry_episode_id,
                   'content_config': (resume.get('content_config') or resume.get('config')) if resume and resume.get('script') else snapshot,
                   'research_config': (resume.get('research_config') or resume.get('config')) if resume and resume.get('research') else snapshot}
        store.mark_episode(show_id, pending)
        _jobs.add(show_id)
        try:
            thread = threading.Thread(target=_run, args=(show_id, episode_id, snapshot, copy.deepcopy(show), inputs, copy.deepcopy(resume)), daemon=True)
            thread.start()
        except Exception:
            _jobs.discard(show_id)
            store.patch_episode(show_id, episode_id, {'status': 'failed', 'error': '制作任务未能启动，请重试。'})
            raise
    return pending


def _run(show_id: str, episode_id: str, snapshot: dict, show: dict, inputs: dict, resume: dict | None = None) -> None:
    def checkpoint(patch):
        store.patch_episode(show_id, episode_id, patch)

    try:
        if resume and resume.get('script') and resume.get('review', {}).get('passed') is True:
            content = {k: resume[k] for k in ('title', 'summary', 'script', 'turns', 'plan', 'expressions',
                        'expression_forms', 'interpretation', 'research', 'sources', 'review', 'harness_version', 'model_version') if k in resume}
        else:
            content = harness.generate(show, snapshot, inputs['episode_wish'],
                                       lambda phase: _phase(show_id, episode_id, phase), checkpoint,
                                       resume=resume if resume and resume.get('plan') else None)
        checkpoint(content)
        _phase(show_id, episode_id, 'voice')
        voice_direction = content['plan'].get('voice_direction', '')
        dialogue = fm_synth._synthesize_fm_dialogue_pcm(
            content['script'], host_voice=show.get('host_voice') or 'Kore',
            guest_voice=show.get('guest_voice') or 'Puck', language_code=show['language'],
            model_name=snapshot['tts_model'], strict=True, narration_prompt=voice_direction)
        music_note = ''
        _phase(show_id, episode_id, 'music')
        preset = fm_synth.FM_MUSIC_PRESET_INDEX.get(show.get('music_style') or '') or fm_synth.FM_MUSIC_PRESET_INDEX['focus_lofi']
        try:
            music_pcm, _preset, meta = fm_synth.resolve_fm_bgm_pcm(
                preset['id'], project_id=snapshot['project_id'], model_id=snapshot['lyria_model'], location=snapshot['lyria_location'])
            _phase(show_id, episode_id, 'mix')
            wav = fm_synth._pcm_to_wav(fm_synth._mix_fm_pcm(dialogue, music_pcm,
                                         speech_volume=fm_synth.FM_DEFAULT_SPEECH_VOLUME, music_volume=12))
            music_source = meta.get('source') or 'library'
        except Exception as exc:
            wav = fm_synth._dialogue_only_fm_wav(dialogue, speech_volume=fm_synth.FM_DEFAULT_SPEECH_VOLUME)
            music_source, music_note = 'skipped', str(exc)[:180]
        found = store.find_episode(episode_id)
        with wave.open(io.BytesIO(wav), 'rb') as completed_audio:
            duration = completed_audio.getnframes() / completed_audio.getframerate()
        ready = {**(found[1] if found else {}), **content,
                 'status': 'ready', 'phase': 'ready', 'error': '', 'language': show['language'],
                 'difficulty': show['difficulty'], 'music_source': music_source, 'music_note': music_note,
                 'music_label': preset['label'], 'scene_label': '虚构来信电台',
                 'duration_seconds': round(duration, 1)}
        store.save_episode(show_id, ready, wav)
    except Exception as exc:
        try:
            checkpoint({'status': 'failed', 'title': '本期制作未完成', 'error': str(exc)[:600]})
        except KeyError:
            pass
    finally:
        with _guard:
            _jobs.discard(show_id)
