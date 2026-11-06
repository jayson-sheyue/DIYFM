"""DIYFM：投入资料，生成可每天收听的双人广播。"""
from __future__ import annotations

import io
import os
import threading
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, Response, jsonify, request, send_file, redirect

import broadcast
import fm_synth
import preview_cache
import ingest
import settings as diy_settings
import store
import harness

load_dotenv()

app = Flask(__name__, static_folder='static', template_folder='templates')
app.config['MAX_CONTENT_LENGTH'] = 20 * 1024 * 1024
app.config['SEND_FILE_MAX_AGE_DEFAULT'] = 0

_bgm_jobs: dict[str, dict] = {}
_bgm_guard = threading.Lock()


@app.before_request
def json_object_only():
    if request.path.startswith('/api/') and request.is_json and not isinstance(request.get_json(silent=True), dict):
        return jsonify({'message': '请求内容需要是 JSON 对象'}), 400


def _scene_payload() -> list[dict]:
    return [
        {'id': item['id'], 'label': item['label'], 'prompt': item['prompt']}
        for item in fm_synth.FM_PROGRAM_PRESETS
    ]


def _clean_show_patch(body: dict) -> tuple[dict, str]:
    patch: dict = {}
    for key, allowed, label in (
        ('language', {'en', 'ja'}, '语言'),
        ('difficulty', {'beginner', 'basic', 'advanced'}, '难度'),
    ):
        if key in body:
            if not isinstance(body[key], str) or body[key] not in allowed:
                return {}, f'未知的{label}选项'
            patch[key] = body[key]
    if 'wish' in body:
        if not isinstance(body['wish'], str) or len(body['wish']) > 1200:
            return {}, '收听愿望请控制在 1200 字以内'
        patch['wish'] = body['wish'].strip()
    if 'title' in body:
        patch['title'] = str(body.get('title') or '')
    if 'scene_id' in body:
        scene_id = str(body.get('scene_id') or '')
        if scene_id not in fm_synth.FM_PROGRAM_PRESET_INDEX:
            return {}, '未知的场景预设'
        patch['scene_id'] = scene_id
    if 'scene_prompt' in body:
        patch['scene_prompt'] = str(body.get('scene_prompt') or '')[:4000]
    if 'host_voice' in body:
        voice = str(body.get('host_voice') or '')
        if voice not in fm_synth.FM_VOICE_IDS:
            return {}, '未知的主持人声'
        patch['host_voice'] = voice
    if 'guest_voice' in body:
        voice = str(body.get('guest_voice') or '')
        if voice not in fm_synth.FM_VOICE_IDS:
            return {}, '未知的嘉宾人声'
        patch['guest_voice'] = voice
    if 'music_style' in body:
        style = str(body.get('music_style') or '')
        if style not in fm_synth.FM_MUSIC_PRESET_INDEX:
            return {}, '未知的底乐预设'
        patch['music_style'] = style
    if 'length' in body:
        length = str(body.get('length') or '').upper()
        if length not in fm_synth.FM_LENGTH_PROFILES:
            return {}, '未知的时长'
        patch['length'] = length
    return patch, ''


@app.get('/')
def index():
    return redirect('/static/index.html')


@app.get('/api/presets')
def presets():
    return jsonify({
        'scenes': _scene_payload(),
        'voices': fm_synth.FM_VOICE_PRESETS,
        'music': fm_synth.list_fm_bgm_library(),
        'lengths': fm_synth.fm_length_options(),
        'languages': harness.LANGUAGES,
        'difficulties': harness.LEVELS,
    })


@app.get('/api/settings')
def get_settings():
    return jsonify(diy_settings.public())


@app.post('/api/settings/restore')
def restore_settings():
    saved = diy_settings.restore_model_defaults()
    payload = diy_settings.public()
    payload['settings'] = saved
    return jsonify(payload)


@app.put('/api/settings')
def put_settings():
    try:
        saved = diy_settings.save(request.json or {})
    except ValueError as exc:
        return jsonify({'message': str(exc)}), 400
    payload = diy_settings.public()
    payload['settings'] = saved
    return jsonify(payload)


@app.get('/api/shows')
def shows():
    return jsonify({'shows': [store.public_show(s) for s in store.list_shows()]})


@app.post('/api/shows')
def create_show():
    body = request.json or {}
    patch, err = _clean_show_patch(body)
    if err:
        return jsonify({'message': err}), 400
    if patch.get('host_voice', 'Kore') == patch.get('guest_voice', 'Puck'):
        return jsonify({'message': '两位主持需要使用不同声线，请调整后开始。'}), 400
    default_title = ('日语' if patch.get('language') == 'ja' else '英语') + '来信电台'
    show = store.create_show(str(body.get('title') or default_title), patch)
    return jsonify({'show': store.public_show(show)})


@app.patch('/api/shows/<show_id>')
def patch_show(show_id):
    patch, err = _clean_show_patch(request.json or {})
    if err:
        return jsonify({'message': err}), 400
    raw_revision = (request.json or {}).get('revision', None)
    try:
        expected = None if raw_revision is None or raw_revision == '' else int(raw_revision)
        show = store.update_show(show_id, patch, expected_revision=expected)
    except store.Conflict as exc:
        return jsonify({
            'message': '这个节目刚刚在另一处保存过。当前页面的修改还在，可以选择覆盖，或重新载入已保存的版本。',
            'show': store.public_show(exc.show),
        }), 409
    except (TypeError, ValueError):
        return jsonify({'message': '节目版本号无效'}), 400
    if not show:
        return jsonify({'message': '节目不存在'}), 404
    return jsonify({'show': store.public_show(show)})


@app.delete('/api/shows/<show_id>')
def remove_show(show_id):
    with broadcast._guard:
        if show_id in broadcast._jobs:
            return jsonify({'message': '这个频道还有节目正在制作，完成后可以删除。'}), 409
        try:
            if not store.delete_show(show_id):
                return jsonify({'message': '节目不存在'}), 404
        except store.MediaBusy as exc:
            return jsonify({'message': str(exc)}), 409
        except OSError:
            app.logger.exception('Channel deletion failed')
            return jsonify({'message': '删除未完成，记录与音频已保留。请检查本机文件权限或磁盘后重试。'}), 500
    return jsonify({'ok': True})


@app.delete('/api/shows/<show_id>/episodes/<episode_id>')
def remove_episode(show_id, episode_id):
    with broadcast._guard:
        if show_id in broadcast._jobs:
            return jsonify({'message': '这个频道还有节目正在制作，完成后可以删除单集。'}), 409
        try:
            show = store.delete_episode(show_id, episode_id)
        except store.MediaBusy as exc:
            return jsonify({'message': str(exc)}), 409
        except OSError:
            app.logger.exception('Episode deletion failed')
            return jsonify({'message': '删除未完成，记录与音频已保留。请检查本机文件权限或磁盘后重试。'}), 500
        if show is None:
            return jsonify({'message': '这集节目不存在'}), 404
    return jsonify({'show': store.public_show(show)})


@app.post('/api/shows/<show_id>/materials')
def add_material(show_id):
    if not store.get_show(show_id):
        return jsonify({'message': '节目不存在'}), 404
    try:
        if request.files.get('file'):
            upload = request.files['file']
            title, text = ingest.text_from_upload(upload.filename or '资料', upload.read())
            kind, source = 'file', upload.filename or ''
        else:
            body = request.json or {}
            url = str(body.get('url') or '').strip()
            if not url:
                return jsonify({'message': '请上传文件或填写公开 URL'}), 400
            title, text = ingest.text_from_url(url)
            kind, source = 'url', url
    except Exception as exc:
        return jsonify({'message': str(exc)}), 400
    item = store.add_material(show_id, title=title, kind=kind, text=text, source=source)
    show = store.get_show(show_id)
    return jsonify({'material': {k: v for k, v in item.items() if k != 'text'}, 'show': store.public_show(show)})


@app.delete('/api/shows/<show_id>/materials/<material_id>')
def remove_material(show_id, material_id):
    if not store.delete_material(show_id, material_id):
        return jsonify({'message': '资料不存在'}), 404
    return jsonify({'show': store.public_show(store.get_show(show_id))})


@app.post('/api/shows/<show_id>/episodes')
def make_episode(show_id):
    try:
        body = request.get_json(silent=True) or {}
        episode = broadcast.produce(show_id, episode_wish=body.get('episode_wish', ''),
                                    request_id=body.get('request_id', ''), revision=body.get('revision'),
                                    retry_episode_id=body.get('retry_episode_id', ''))
    except fm_synth.NotebookLMError as exc:
        return jsonify({'message': str(exc)}), exc.status_code
    except store.Conflict as exc:
        return jsonify({'message': '频道刚刚在另一处修改过，请重新载入后生成。', 'show': store.public_show(exc.show)}), 409
    except (ValueError, TypeError) as exc:
        return jsonify({'message': str(exc)}), 400
    except Exception as exc:
        return jsonify({'message': str(exc)}), 500
    return jsonify({'episode': episode, 'show': store.public_show(store.get_show(show_id))})


@app.get('/api/episodes/<episode_id>/transcript')
def transcript(episode_id):
    found = store.find_episode(episode_id)
    if not found or not found[1].get('script'):
        return jsonify({'message': '这一集还没有保存的台本。旧版本成片不含台本。'}), 404
    ep = found[1]
    return jsonify({'title': ep.get('title'), 'script': ep['script'], 'expressions': ep.get('expressions', []),
                    'sources': ep.get('sources', []), 'research': ep.get('research', {}),
                    'input': ep.get('input', {}), 'harness_version': ep.get('harness_version', '')})


@app.get('/api/episodes/<episode_id>/audio')
def episode_audio(episode_id):
    path = store.audio_path(episode_id)
    if not path:
        return jsonify({'message': '音频不存在'}), 404
    return send_file(path, mimetype='audio/wav', conditional=True)


@app.get('/api/episodes/<episode_id>/download')
def episode_download(episode_id):
    found = store.find_episode(episode_id)
    if not found or not store.audio_path(episode_id):
        return jsonify({'message': '音频不存在'}), 404
    show, episode = found
    try:
        path = store.ensure_mp3(episode_id)
    except Exception as exc:
        return jsonify({'message': f'MP3 转码失败：{exc}'}), 500
    title = f"{show.get('title') or 'DIYFM'} {episode.get('title') or episode_id}".strip()
    filename = ''.join(ch for ch in title if ch not in '\\/:*?"<>|')[:80] or episode_id
    return send_file(path, mimetype='audio/mpeg', as_attachment=True, download_name=f'{filename}.mp3')


@app.get('/media/bgm/<style_id>.wav')
def bgm_preview(style_id):
    try:
        wav = fm_synth.load_fm_bgm_preview_wav(style_id)
    except fm_synth.NotebookLMError as exc:
        return jsonify({'message': str(exc)}), exc.status_code
    return Response(wav, mimetype='audio/wav')


@app.get('/api/bgm/jobs')
def bgm_jobs():
    with _bgm_guard:
        jobs = dict(_bgm_jobs)
    return jsonify({'jobs': jobs})


@app.post('/api/bgm/<style_id>/regenerate')
def regenerate_bgm(style_id):
    sid = ''.join(ch for ch in (style_id or '') if ch.isalnum() or ch in '_-')
    if sid not in fm_synth.FM_MUSIC_PRESET_INDEX:
        return jsonify({'message': '未知的底乐预设'}), 400
    with _bgm_guard:
        current = _bgm_jobs.get(sid) or {}
        if current.get('status') == 'running':
            return jsonify({'status': 'running', 'style_id': sid}), 202
        _bgm_jobs[sid] = {'status': 'running', 'error': ''}

    def work():
        try:
            cfg = diy_settings.models()
            fm_synth.resolve_fm_bgm_pcm(
                sid,
                force_new=True,
                project_id=cfg['project_id'],
                model_id=cfg['lyria_model'],
                location=cfg['lyria_location'],
            )
            with _bgm_guard:
                _bgm_jobs[sid] = {'status': 'ready', 'error': ''}
        except Exception as exc:
            with _bgm_guard:
                _bgm_jobs[sid] = {'status': 'failed', 'error': str(exc)[:400]}

    threading.Thread(target=work, daemon=True).start()
    return jsonify({'status': 'running', 'style_id': sid}), 202


@app.get('/api/backup')
def backup():
    payload = store.export_zip()
    return send_file(
        io.BytesIO(payload),
        mimetype='application/zip',
        as_attachment=True,
        download_name='diyfm-backup.zip',
    )


@app.post('/api/voices/cache/clear')
def clear_voice_cache():
    removed = preview_cache.clear()
    return jsonify({'removed': removed, 'message': '试听缓存已清理。成片和底乐还在。'})


@app.post('/api/voices/preview')
def voice_preview():
    body = request.json or {}
    try:
        role = 'guest' if str(body.get('role') or '') == 'guest' else 'host'
        cfg = diy_settings.models()
        voice = fm_synth._sanitize_fm_voice(str(body.get('voice') or 'Kore'), 'Kore')
        model = cfg['tts_model']
        mode = body.get('language', 'en')
        if not isinstance(mode, str) or mode not in {'en', 'ja'}:
            return jsonify({'message': '未知的试听语言'}), 400
        language = fm_synth._fm_language_code(mode)
        key = preview_cache.cache_key(voice=voice, role=role, model=model, language=language, project=cfg['project_id'])
        force = bool(body.get('force'))

        def produce() -> bytes:
            return fm_synth.synthesize_fm_voice_preview(
                voice,
                role=role,
                model_name=model,
                language_code=mode,
            )

        mp3, created_at, source = preview_cache.get_or_make(key, force=force, produce=produce)
    except fm_synth.NotebookLMError as exc:
        return jsonify({'message': str(exc)}), exc.status_code
    except Exception as exc:
        return jsonify({'message': str(exc)}), 500
    resp = Response(mp3, mimetype='audio/mpeg')
    resp.headers['X-DIYFM-Cache'] = source
    resp.headers['X-DIYFM-Cached-At'] = created_at
    return resp


if __name__ == '__main__':
    broadcast.reconcile_orphans()
    port = int(os.getenv('PORT') or 5055)
    app.run(host='127.0.0.1', port=port, debug=False, threaded=True)
