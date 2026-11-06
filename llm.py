"""Vertex generateContent REST adapter. Each request owns its ADC session/configuration."""
from __future__ import annotations

import re
from urllib.parse import urlparse


def call_llm_result(req_data: dict, prompt_text: str) -> dict:
    import google.auth
    from google.auth.transport.requests import AuthorizedSession
    from google.auth.exceptions import GoogleAuthError, TransportError
    import requests
    import settings

    configured = settings.models()
    project = str(req_data.get('projectId') or configured.get('project_id') or '').strip()
    location = str(req_data.get('location') or configured['llm_location']).strip()
    model = str(req_data.get('modelId') or configured['llm_model']).strip()
    if not re.fullmatch(r'[a-z][a-z0-9-]{4,28}[a-z0-9]', project):
        raise ValueError('请先到设置填写有效的 Google Cloud 项目 ID。')
    if not re.fullmatch(r'[a-z][a-z0-9-]{1,39}', location) or not re.fullmatch(r'[A-Za-z0-9_.:-]{2,120}', model):
        raise ValueError('模型 ID 或区域无效，请检查设置。')
    host = 'aiplatform.googleapis.com' if location == 'global' else f'{location}-aiplatform.googleapis.com'
    url = f'https://{host}/v1/projects/{project}/locations/{location}/publishers/google/models/{model}:generateContent'
    generation = {'maxOutputTokens': int(req_data.get('maxOutputTokens') or 8192)}
    if req_data.get('json'):
        generation['responseMimeType'] = 'application/json'
    body = {'contents': [{'role': 'user', 'parts': [{'text': prompt_text}]}], 'generationConfig': generation}
    if req_data.get('useWebSearch'):
        body['tools'] = [{'googleSearch': {}}]
    try:
        credentials, _ = google.auth.default(scopes=['https://www.googleapis.com/auth/cloud-platform'])
        with AuthorizedSession(credentials, refresh_timeout=30) as session:
            response = session.post(url, json=body, timeout=(15, 240))
    except TransportError as exc:
        raise RuntimeError('无法连接 Google 鉴权服务，请检查网络后重试。') from exc
    except GoogleAuthError as exc:
        raise RuntimeError('ADC 鉴权失败。请运行 gcloud auth application-default login 后重试。') from exc
    except requests.Timeout as exc:
        raise RuntimeError('模型请求超时，本期未完成。输入和已有节目已保留，可重试。') from exc
    except requests.RequestException as exc:
        raise RuntimeError('无法连接 Google Cloud，请检查网络后重试。') from exc
    if not response.ok:
        hints = {400: '模型可能不支持此请求或 Google Search，请检查模型能力。',
                 401: 'ADC 已失效，请重新登录。', 403: '请检查项目权限、API 和计费是否启用。',
                 404: '模型或区域不存在，请到设置检查。', 429: '配额或速率受限，请稍后重试。'}
        raise RuntimeError(f'模型请求失败（HTTP {response.status_code}）。' + hints.get(response.status_code, '服务暂时不可用，请稍后重试。'))
    payload = response.json()
    candidates = payload.get('candidates') or []
    candidate = candidates[0] if candidates else {}
    if candidate.get('finishReason') not in (None, 'STOP'):
        raise RuntimeError(f"模型输出未完成（{candidate.get('finishReason')}），本期没有进入配音，可重试。")
    text = ''.join(p.get('text', '') for p in candidate.get('content', {}).get('parts', []) if not p.get('thought'))
    if not text.strip():
        raise RuntimeError('模型没有返回可用内容，本期没有进入配音，可重试。')
    grounding = candidate.get('groundingMetadata') or {}
    sources = []
    for chunk in grounding.get('groundingChunks') or []:
        web = chunk.get('web') or {}
        uri = str(web.get('uri') or '')
        if urlparse(uri).scheme == 'https' and urlparse(uri).netloc:
            sources.append({'title': str(web.get('title') or '参考来源')[:240], 'url': uri})
    return {'text': text, 'sources': sources, 'grounding': grounding,
            'model_version': payload.get('modelVersion', model),
            'search_suggestions': grounding.get('searchEntryPoint', {}).get('renderedContent', '')}


def call_llm(req_data: dict, prompt_text: str) -> str:
    return call_llm_result(req_data, prompt_text)['text']
