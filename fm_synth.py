# -*- coding: utf-8 -*-
"""DIYFM 双人广播引擎：台本、Gemini-TTS、Lyria 底乐与混音。

从 TSE Learn FM 抽出，不再依赖学习主线、Digest 或 NotebookLM。
"""
from __future__ import annotations

import base64
import io
import os
import re
import sys
import time
import wave
from array import array
from pathlib import Path
from typing import Any, Optional

from llm import call_llm

AUDIO_MAX_CHARS = 90000


def _sanitize_listen_script(text: str) -> str:
    """去掉注音/特殊括号等，并强制插入句号，避免 Chirp TTS「sentence too long」。"""
    s = (text or '').strip()
    s = re.sub(r'^```(?:\w+)?\s*', '', s)
    s = re.sub(r'\s*```$', '', s)
    # 模型偶发输出 ⟪词⧸拼音⟫ / 《词/py》 类注音
    s = re.sub(r'[⟪《〈]([^⟫》〉⧸/]{1,24})[⧸/][^⟫》〉]{0,48}[⟫》〉]', r'\1', s)
    s = re.sub(r'[⟪⟫《》〈〉⧸｜|]+', '', s)
    # 残留「词/拼音」夹注
    s = re.sub(r'(?<=[\u4e00-\u9fff])[ /][a-zA-Zāáǎàōóǒòēéěèīíǐìūúǔùüǖǘǚǜv]{1,16}(?=[\u4e00-\u9fff]|[，。！？；、]|$)', '', s)
    s = re.sub(r'[#>*`_~]+', '', s)
    s = re.sub(r'[ \t\r\f\v]+', ' ', s)
    s = re.sub(r'\n{3,}', '\n\n', s)
    s = s.replace('...', '。').replace('…', '。')
    s = re.sub(r'(?<=[\u4e00-\u9fff])\.(?=\s|[\u4e00-\u9fff]|$)', '。', s)

    max_sent = 120
    pieces: list[str] = []

    def _flush_long(sent: str) -> None:
        nonlocal pieces
        buf = sent.strip()
        if not buf:
            return
        # 先按逗号拆
        bits = [b.strip() for b in re.split(r'(?<=[，、,；;])', buf) if b and b.strip()]
        if not bits:
            bits = [buf]
        cur = ''
        for bit in bits:
            if not cur:
                cur = bit
            elif len(cur) + len(bit) <= max_sent:
                cur += bit
            else:
                if cur[-1] in '，、,；;':
                    cur = cur[:-1] + '。'
                elif cur[-1] not in '。！？；!?;':
                    cur += '。'
                pieces.append(cur)
                cur = bit
        if cur:
            while len(cur) > max_sent:
                cut = cur[:max_sent].rstrip('，、,；; ') + '。'
                pieces.append(cut)
                cur = cur[max_sent:].lstrip('，、,；; ')
            if cur:
                if cur[-1] not in '。！？；!?;':
                    cur += '。'
                pieces.append(cur)

    for para in re.split(r'\n+', s):
        para = para.strip()
        if not para:
            continue
        for sent in re.split(r'(?<=[。！？；!?;])', para):
            sent = sent.strip()
            if not sent:
                continue
            if len(sent) <= max_sent:
                if sent[-1] not in '。！？；!?;':
                    sent += '。'
                pieces.append(sent)
            else:
                _flush_long(sent)
    return ''.join(pieces).strip()


_JA_KANA_RE = re.compile(r'[\u3040-\u30ff]')


_JA_PARTICLE_RE = re.compile(r'[をへ]|[はが](?=[\u3040-\u9fff])')


def _clause_looks_japanese(s: str) -> bool:
    """有假名、或「」内的日语助词，即视为日语（避免纯汉字被中文 TTS 用汉语发音）。"""
    t = s or ''
    if _JA_KANA_RE.search(t):
        return True
    if _JA_PARTICLE_RE.search(t):
        return True
    return False


def _split_tts_chunks(text: str, max_chars: int = 360) -> list[str]:
    """按句切块；Chirp 对单句长度敏感，块也不宜过大。"""
    s = _sanitize_listen_script(text)
    if not s:
        return []
    sentences = [x.strip() for x in re.split(r'(?<=[。！？；!?;])', s) if x and x.strip()]
    if not sentences:
        sentences = [s]
    chunks: list[str] = []
    buf = ''
    for sent in sentences:
        parts = [sent]
        if len(sent) > 120:
            parts = []
            rest = sent
            while len(rest) > 120:
                parts.append(rest[:120].rstrip('，、,；; ') + '。')
                rest = rest[120:].lstrip('，、,；; ')
            if rest:
                if rest[-1] not in '。！？；!?;':
                    rest += '。'
                parts.append(rest)
        for part in parts:
            if not buf:
                buf = part
            elif len(buf) + len(part) <= max_chars:
                buf += part
            else:
                chunks.append(buf)
                buf = part
    if buf:
        chunks.append(buf)
    return chunks


_FM_DIALOGUE_LINE_RE = re.compile(
    r'^(?:\*\*|__|\*|_|`)?\s*'
    r'(Host|Guest|主持人|主持|嘉宾|客座|主播|讲解)'
    r'\s*(?:\*\*|__|\*|_|`)?\s*[:：\-–—]\s*(.+)$',
    re.IGNORECASE,
)


_FM_SPEAKER_ALIASES = {
    'host': 'Host',
    'guest': 'Guest',
    '主持人': 'Host',
    '主持': 'Host',
    '主播': 'Host',
    '嘉宾': 'Guest',
    '客座': 'Guest',
    '讲解': 'Guest',
}

BGM_DIR = Path(__file__).resolve().parent / 'data' / 'bgm'
BGM_DIR.mkdir(parents=True, exist_ok=True)

DEFAULT_PROJECT_ID = 'example-project'


DEFAULT_LOCATION = 'global'


DEFAULT_ENDPOINT_LOCATION = 'global'


MAX_TEXT_CHARS = 48000


class NotebookLMError(Exception):
    """可对用户展示的 NotebookLM 错误。"""

    def __init__(self, message: str, *, status_code: int = 400, code: str = 'notebooklm_error'):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.code = code


def _model_setting(key: str) -> str:
    try:
        import settings as diy_settings
        return str(diy_settings.models().get(key) or '').strip()
    except Exception:
        return ''


def _cfg() -> dict[str, str]:
    project_id = (
        _model_setting('project_id')
        or (os.getenv('DIYFM_PROJECT_ID') or '').strip()
        or (os.getenv('GOOGLE_CLOUD_PROJECT') or '').strip()
        or (os.getenv('GCP_PROJECT_ID') or '').strip()
        or (os.getenv('NOTEBOOKLM_PROJECT_ID') or '').strip()
        or DEFAULT_PROJECT_ID
    )
    project_number = (
        (os.getenv('NOTEBOOKLM_PROJECT_NUMBER') or '').strip()
        or (os.getenv('GCP_PROJECT_NUMBER') or '').strip()
    )
    location = (os.getenv('NOTEBOOKLM_LOCATION') or DEFAULT_LOCATION).strip() or DEFAULT_LOCATION
    endpoint = (
        (os.getenv('NOTEBOOKLM_ENDPOINT_LOCATION') or DEFAULT_ENDPOINT_LOCATION).strip()
        or DEFAULT_ENDPOINT_LOCATION
    )
    return {
        'project_id': project_id,
        'project_number': project_number,
        'location': location,
        'endpoint_location': endpoint,
    }


def _clip(text: str, lim: int = MAX_TEXT_CHARS) -> str:
    s = str(text or '').strip()
    if len(s) <= lim:
        return s
    return s[: lim - 20] + '\n\n…(已截断)'


AUDIO_MAX_DIGESTS = 24


FM_LENGTH_PROFILES = {
    'BRIEF': {
        'id': 'BRIEF',
        'label': '短约3分钟',
        'target_chars': 650,
        'hard_limit': 950,
        'min_chars': 420,
        'min_turns': 8,
        'minutes_hint': 3,
        'allow_expand': False,
    },
    'SHORT': {
        'id': 'SHORT',
        'label': '短约5分钟',
        'target_chars': 1100,
        'hard_limit': 1600,
        'min_chars': 750,
        'min_turns': 10,
        'minutes_hint': 5,
        'allow_expand': True,
    },
    'STANDARD': {
        'id': 'STANDARD',
        'label': '标准约10分钟',
        'target_chars': 2200,
        'hard_limit': 3200,
        'min_chars': 1400,
        'min_turns': 16,
        'minutes_hint': 10,
        'allow_expand': True,
    },
    'LONG': {
        'id': 'LONG',
        'label': '长约15分钟',
        'target_chars': 3400,
        'hard_limit': 4800,
        'min_chars': 2200,
        'min_turns': 22,
        'minutes_hint': 15,
        'allow_expand': True,
    },
}


FM_PROGRAM_PRESETS = [
    {
        'id': 'drive_explainer',
        'label': '通勤干货',
        'prompt': (
            '生成适合开车、通勤或做家务时收听的双人学习 FM。主持人用简短问题串联，嘉宾用口语化解释回应；'
            '突出可记住的要点、关键对比和小例子。节奏明快、信息密度高，不念稿、不寒暄、不重复材料原文。'
        ),
    },
    {
        'id': 'concept_clarifier',
        'label': '概念讲透',
        'prompt': (
            '把本期内容做成双人 FM 的概念拆解。主持人专门提出听众最容易混淆的问题，嘉宾先说结论，再解释原因；'
            '用生活化比喻和正反对比讲清边界，最后由主持人复述最该记住的三件事。避免术语堆砌。'
        ),
    },
    {
        'id': 'case_walkthrough',
        'label': '案例推演',
        'prompt': (
            '把材料组织为双人 FM 案例推演。主持人提出一个典型场景和决策难点，嘉宾按“发生什么、如何判断、怎么处理”'
            '带听众走一遍；每一步给出具体小例子与常见误区。结尾输出可直接照做的行动清单。'
        ),
    },
    {
        'id': 'review_recall',
        'label': '复习记忆',
        'prompt': (
            '生成一集用于复习巩固的双人 FM。主持人用快问快答、判断题和回忆提示带节奏，嘉宾补充正确答案与理由；'
            '反复连接关键概念之间的关系，但不要机械重复。结尾给出便于离线回想的记忆钩子。'
        ),
    },
    {
        'id': 'decision_practice',
        'label': '决策实战',
        'prompt': (
            '把学习内容转换成双人 FM 的实战决策训练。主持人扮演需要做选择的人，嘉宾引导识别目标、约束、风险与取舍；'
            '用一到两个小情境演示如何落地，并明确哪些信号出现时应改变策略。表达务实直接。'
        ),
    },
    {
        'id': 'morning_brief',
        'label': '晨间开机',
        'prompt': (
            '生成一集适合洗漱、早餐或出门前收听的双人 FM。主持人先用一句话交代今天最值得带走的主题，'
            '嘉宾用清醒、轻快的方式讲清两个核心要点；穿插一个“今天就能试”的微行动。不要制造焦虑，结尾留一句简洁提醒。'
        ),
    },
    {
        'id': 'walk_and_think',
        'label': '散步慢想',
        'prompt': (
            '生成适合散步、整理房间或放空时收听的双人 FM。节奏从容但不空泛，主持人偶尔停下来追问“这和我们有什么关系”，'
            '嘉宾用一个连贯故事、比喻和反直觉点带出知识。保留思考余白，不要做密集清单。'
        ),
    },
    {
        'id': 'late_night_decode',
        'label': '深夜拆解',
        'prompt': (
            '生成一集安静但有洞见的深夜 FM。主持人从一个看似普通却令人困惑的现象切入，'
            '嘉宾层层拆解机制、证据与例外，语气克制、清晰、带一点陪伴感。不要煽情，不要高亢，最后给出一个值得睡前回想的问题。'
        ),
    },
    {
        'id': 'mission_control',
        'label': '任务指挥室',
        'prompt': (
            '把内容做成一场有轻微科幻感的“任务指挥室”双人 FM，但知识必须严谨。主持人像任务官提出目标、限制和突发情况，'
            '嘉宾像专家顾问给出判断依据与方案。可以有少量紧张感和任务感，不能加入虚构事实或音效旁白。'
        ),
    },
    {
        'id': 'myth_buster',
        'label': '谣言粉碎机',
        'prompt': (
            '生成一集有趣而严谨的双人辟谣 FM。主持人先抛出常见误解或直觉判断，嘉宾用证据、条件与反例逐步校正；'
            '每个结论都说明“什么时候成立、什么时候不成立”。语气机智，不嘲笑听众，不夸大结论。'
        ),
    },
    {
        'id': 'seminar_serious',
        'label': '严肃研讨',
        'prompt': (
            '生成一集面向认真学习者的严肃双人研讨 FM。主持人负责界定问题与追问证据，嘉宾区分事实、推断和不确定性；'
            '保留必要术语，但首次出现要用白话解释。不要戏剧化，不要鸡汤，结尾总结关键结论与待验证问题。'
        ),
    },
]


FM_PROGRAM_PRESET_INDEX = {item['id']: item for item in FM_PROGRAM_PRESETS}


DEFAULT_AUDIO_FOCUS = FM_PROGRAM_PRESET_INDEX['drive_explainer']['prompt']


FM_SAMPLE_RATE = 24000


FM_TTS_MODEL = (os.getenv('LEARN_FM_TTS_MODEL') or 'gemini-3.1-flash-tts-preview').strip()


FM_LYRIA_MODEL = 'lyria-002'


FM_LYRIA_LOCATION = (os.getenv('LEARN_FM_LYRIA_LOCATION') or 'global').strip() or 'global'


FM_DEFAULT_SPEECH_VOLUME = 100


FM_DEFAULT_MUSIC_VOLUME = 32


FM_VOICE_PRESETS = [
    {'id': 'Zephyr', 'label': 'Zephyr · 明亮女声'},
    {'id': 'Puck', 'label': 'Puck · 活泼男声'},
    {'id': 'Charon', 'label': 'Charon · 知性男声'},
    {'id': 'Kore', 'label': 'Kore · 坚定女声'},
    {'id': 'Fenrir', 'label': 'Fenrir · 兴奋男声'},
    {'id': 'Leda', 'label': 'Leda · 年轻女声'},
    {'id': 'Orus', 'label': 'Orus · 坚定男声'},
    {'id': 'Aoede', 'label': 'Aoede · 轻快女声'},
    {'id': 'Callirrhoe', 'label': 'Callirrhoe · 随和女声'},
    {'id': 'Autonoe', 'label': 'Autonoe · 明亮女声'},
    {'id': 'Enceladus', 'label': 'Enceladus · 气声男声'},
    {'id': 'Iapetus', 'label': 'Iapetus · 清晰男声'},
    {'id': 'Umbriel', 'label': 'Umbriel · 随和男声'},
    {'id': 'Algieba', 'label': 'Algieba · 顺滑男声'},
    {'id': 'Despina', 'label': 'Despina · 顺滑女声'},
    {'id': 'Erinome', 'label': 'Erinome · 清晰女声'},
    {'id': 'Algenib', 'label': 'Algenib · 沙哑男声'},
    {'id': 'Rasalgethi', 'label': 'Rasalgethi · 知性男声'},
    {'id': 'Laomedeia', 'label': 'Laomedeia · 活泼女声'},
    {'id': 'Achernar', 'label': 'Achernar · 柔软女声'},
    {'id': 'Alnilam', 'label': 'Alnilam · 坚定男声'},
    {'id': 'Schedar', 'label': 'Schedar · 平稳男声'},
    {'id': 'Gacrux', 'label': 'Gacrux · 成熟女声'},
    {'id': 'Pulcherrima', 'label': 'Pulcherrima · 直率女声'},
    {'id': 'Achird', 'label': 'Achird · 亲切男声'},
    {'id': 'Zubenelgenubi', 'label': 'Zubenelgenubi · 随意男声'},
    {'id': 'Vindemiatrix', 'label': 'Vindemiatrix · 温柔女声'},
    {'id': 'Sadachbia', 'label': 'Sadachbia · 生动男声'},
    {'id': 'Sadaltager', 'label': 'Sadaltager · 博学男声'},
    {'id': 'Sulafat', 'label': 'Sulafat · 温暖女声'},
]


FM_VOICE_IDS = {item['id'] for item in FM_VOICE_PRESETS}


FM_SPEECH_PROMPT = (
    'Read this educational dialogue clearly and naturally. '
    'Keep the two speakers distinct, at a steady speaking volume. '
    'Do not whisper or drop the volume on any line. Short pauses between turns.'
)


FM_SPEECH_PROMPT_PLAIN = 'Read the dialogue clearly and calmly.'


FM_PERFORMANCE_TAGS = (
    '[excited]', '[whispers]', '[laughs]', '[sighs]', '[very slow]',
)


FM_PERFORMANCE_TAG_SET = {tag.lower() for tag in FM_PERFORMANCE_TAGS}


_FM_LEADING_TAG_RE = re.compile(r'^\s*(\[[^\]\r\n]{2,24}\])\s*')


FM_MUSIC_PRESETS = [
    # Lyria 2：提示须为英文；保持短、中性、纯器乐，降低拒词率。
    # 避免：vocals/radio/FM/announcer/sci-fi/hip hop samples/lyrics 等敏感或易拒词。
    {
        'id': 'focus_lofi',
        'label': '专注 Lo-fi',
        'prompt': (
            'Soft lo-fi instrumental, muted drums, gentle electric piano, slow tempo, calm. Instrumental.'
        ),
        'fallback_prompt': (
            'Calm lo-fi instrumental with soft piano and light drums, slow tempo. Instrumental.'
        ),
    },
    {
        'id': 'calm_ambient',
        'label': '安静氛围',
        'prompt': (
            'Soft ambient instrumental, warm pads, gentle piano, slow tempo, peaceful. Instrumental.'
        ),
        'fallback_prompt': (
            'Calm ambient instrumental with soft pads, slow tempo. Instrumental.'
        ),
    },
    {
        'id': 'light_jazz',
        'label': '轻爵士',
        'prompt': (
            'Light jazz instrumental, soft piano, upright bass, brushed drums, relaxed tempo. Instrumental.'
        ),
        'fallback_prompt': (
            'Relaxed jazz piano instrumental with soft bass, medium-slow tempo. Instrumental.'
        ),
    },
    {
        'id': 'night_drive',
        'label': '夜间驾车',
        'prompt': (
            'Calm downtempo instrumental, soft synth pads, gentle pulse, medium-slow tempo. Instrumental.'
        ),
        'fallback_prompt': (
            'Soft downtempo instrumental with warm pads, medium-slow tempo. Instrumental.'
        ),
    },
    {
        'id': 'morning_acoustic',
        'label': '晨光原声',
        'prompt': (
            'Gentle acoustic guitar instrumental, light percussion, warm melody, medium tempo. Instrumental.'
        ),
        'fallback_prompt': (
            'Soft acoustic guitar instrumental, bright and calm, medium tempo. Instrumental.'
        ),
    },
    {
        'id': 'rainy_window',
        'label': '雨窗阅读',
        'prompt': (
            'Quiet piano ambient instrumental, soft pads, slow tempo, gentle and soft. Instrumental.'
        ),
        'fallback_prompt': (
            'Soft piano ambient instrumental, slow tempo, quiet. Instrumental.'
        ),
    },
    {
        'id': 'cosmic_library',
        'label': '星际图书馆',
        'prompt': (
            'Spacious ambient instrumental, soft synthesizer pads, gentle arpeggios, slow tempo. Instrumental.'
        ),
        'fallback_prompt': (
            'Calm ambient instrumental with soft synth pads, slow tempo. Instrumental.'
        ),
    },
    {
        'id': 'playful_lab',
        'label': '趣味实验室',
        'prompt': (
            'Light electronic instrumental, soft plucked synth, light percussion, medium tempo. Instrumental.'
        ),
        'fallback_prompt': (
            'Clean light electronic instrumental with soft synth, medium tempo. Instrumental.'
        ),
    },
    {
        'id': 'documentary',
        'label': '纪实沉稳',
        # 避免 strings/sparse/rhythm 等易触发 Lyria「换提示词」拒答的词；用已验证过的 piano+pad 写法。
        'prompt': (
            'Warm calm piano instrumental with soft pads, slow steady tempo, quiet. Instrumental.'
        ),
        'fallback_prompt': (
            'Gentle piano ambient instrumental, soft pads, slow tempo, peaceful. Instrumental.'
        ),
    },
]


FM_MUSIC_PRESET_INDEX = {item['id']: item for item in FM_MUSIC_PRESETS}


FM_LYRIA_NEGATIVE_PROMPT = (
    'vocals, singing, lyrics, spoken words, speech, rap, choir, voice'
)


FM_LYRIA_SAFE_FALLBACK_PROMPT = (
    'Calm ambient instrumental with soft pads and gentle piano, slow tempo. Instrumental.'
)


FM_LYRIA_EXTRA_SAFE_PROMPTS = (
    'Soft ambient instrumental pads, slow tempo, quiet and gentle. Instrumental.',
    'Simple calm piano instrumental, slow tempo, soft and peaceful. Instrumental.',
    'Quiet lo-fi instrumental, soft electric piano, light drums, slow tempo. Instrumental.',
)


FM_LYRIA_HTTP_TIMEOUT_SEC = 90


FM_LYRIA_TIMEOUT_RETRIES = 1


FM_LYRIA_PROMPT_REJECT_RETRIES = 1


FM_LYRIA_MAX_PROMPTS = 5


FM_BGM_LIBRARY_PREFIX = 'tse_media/_shared/fm_bgm'


def default_audio_focus() -> str:
    return DEFAULT_AUDIO_FOCUS


def _fm_length_profile(length: str) -> dict:
    key = (length or 'STANDARD').strip().upper()
    return FM_LENGTH_PROFILES.get(key) or FM_LENGTH_PROFILES['STANDARD']


def fm_length_options() -> list[dict]:
    return [
        {
            'id': p['id'],
            'label': p['label'],
            'minutes_hint': p['minutes_hint'],
        }
        for p in FM_LENGTH_PROFILES.values()
    ]


def build_podcast_contexts_from_export(exported: dict) -> list[dict]:
    """把主线 Digest / 投料压成 Podcast API contexts（纯文本）。"""
    ml = exported.get('mainline') or {}
    digests = [
        d for d in (exported.get('digests') or [])
        if isinstance(d, dict) and d.get('id')
    ]
    digests_sorted = sorted(
        digests,
        key=lambda d: str(d.get('updated_at') or d.get('created_at') or ''),
        reverse=True,
    )[:AUDIO_MAX_DIGESTS]

    parts: list[str] = [
        f"学习主线：{ml.get('title') or ''}",
        f"简述：{ml.get('topic_brief') or ml.get('note') or '（无）'}",
    ]
    for i, dg in enumerate(digests_sorted, 1):
        title = (dg.get('summary') or dg.get('id') or f'Digest {i}').strip()
        body = (dg.get('body') or '').strip()
        oq = dg.get('open_questions') or []
        ns = dg.get('next_steps') or []
        chunk = [f"## {i}. {title}", body or '（无正文）']
        if oq:
            chunk.append('开放问题：' + '；'.join(str(x) for x in oq[:6]))
        if ns:
            chunk.append('下一步：' + '；'.join(str(x) for x in ns[:6]))
        parts.append('\n'.join(chunk))

    if not digests_sorted:
        # 无 Digest 时用较长投料兜底
        inbox = [
            it for it in (exported.get('inbox') or [])
            if isinstance(it, dict) and (it.get('raw_text') or '').strip()
        ]
        inbox_sorted = sorted(
            inbox,
            key=lambda it: str(it.get('updated_at') or it.get('created_at') or ''),
            reverse=True,
        )[:12]
        for i, it in enumerate(inbox_sorted, 1):
            raw = (it.get('raw_text') or '').strip()
            title = (it.get('preview') or f'投料 {i}').strip()
            parts.append(f"## 投料 {i}. {title}\n{_clip(raw, 8000)}")

    text = _clip('\n\n'.join(parts), AUDIO_MAX_CHARS)
    if len(text.strip()) < 80:
        raise NotebookLMError(
            '主线内容太少，请先投入并消化至少一条 Digest，再生成听学音频。',
            status_code=400,
            code='audio_empty',
        )
    return [{'text': text}]


_JA_TITLE_HINT = re.compile(
    r'(日语|日本語|五十音|假名|jlpt|n[1-5]|ひらがな|カタカナ|汉字读音|听力|会话)',
    re.I,
)


_EN_TITLE_HINT = re.compile(
    r'(english|英文|英语|gcp|aws|azure|python|javascript|kubernetes|\bapi\b|cloud|terraform)',
    re.I,
)


_AUDIO_LANG_ALIASES = {
    'zh': 'zh', 'zh_cn': 'zh', 'zh_hans': 'zh', 'cmn': 'zh', 'cmn_cn': 'zh', 'chinese': 'zh', '中文': 'zh',
    'ja': 'ja', 'ja_jp': 'ja', 'jp': 'ja', 'japanese': 'ja', '日语': 'ja', '日本語': 'ja',
    'en': 'en', 'en_us': 'en', 'en_gb': 'en', 'english': 'en', '英文': 'en',
    'zh_ja': 'zh_ja', 'zhja': 'zh_ja', 'mixed': 'zh_ja', 'mix': 'zh_ja',
    'cn_jp': 'zh_ja', '中日': 'zh_ja', '中日混合': 'zh_ja',
    'zh_en': 'zh_en', 'zhen': 'zh_en', 'cn_en': 'zh_en', '中英': 'zh_en', '中英混合': 'zh_en',
    'auto': 'auto',
}


def _script_stats(text: str) -> tuple[int, int, int]:
    """假名数、汉字数、英文词数。"""
    t = text or ''
    kana = len(re.findall(r'[\u3040-\u30ff]', t))
    han = len(re.findall(r'[\u4e00-\u9fff]', t))
    en_words = len(re.findall(r'\b[A-Za-z]{3,}\b', t))
    return kana, han, en_words


def _detect_listen_mode(sample_text: str, *, title: str = '') -> str:
    """按主线标题+正文判断听学音色模式。优先中文讲解+外语音色，避免单语硬读。"""
    blob = f'{title or ""}\n{sample_text or ""}'
    kana, han, en_words = _script_stats(blob)
    ja_hint = bool(_JA_TITLE_HINT.search(blob))
    en_hint = bool(_EN_TITLE_HINT.search(blob))
    has_zh = han >= 20

    ja_signal = kana + (36 if ja_hint else 0)
    en_signal = en_words + (22 if en_hint else 0)

    if ja_signal >= 10 and ja_signal >= en_signal * 0.7:
        if has_zh or ja_hint:
            return 'zh_ja'
        return 'ja' if kana >= 24 else 'zh_ja'

    if en_signal >= 16:
        if has_zh or en_hint:
            return 'zh_en'
        if en_words >= 40 and en_words > han:
            return 'en'
        return 'zh_en'

    if ja_hint:
        return 'zh_ja'
    if en_hint and has_zh:
        return 'zh_en'
    return 'zh'


def _normalize_audio_lang(code: str, *, sample_text: str = '', title: str = '') -> str:
    """zh | ja | en | zh_ja | zh_en。auto 时按主线内容检测混合模式。"""
    raw = (code or 'auto').strip().lower().replace('-', '_')
    lang = _AUDIO_LANG_ALIASES.get(raw, _AUDIO_LANG_ALIASES.get(raw.replace(' ', ''), 'auto'))
    if lang != 'auto':
        return lang
    return _detect_listen_mode(sample_text, title=title)


def _fm_speaker_from_label(raw: str) -> str:
    key = str(raw or '').strip().lower()
    # 中文别名保留原大小写键
    if str(raw or '').strip() in _FM_SPEAKER_ALIASES:
        return _FM_SPEAKER_ALIASES[str(raw).strip()]
    return _FM_SPEAKER_ALIASES.get(key, 'Host' if key == 'host' else 'Guest')


def _fm_language_code(mode: str) -> str:
    """Gemini-TTS 使用完整 locale；双语主线仍以中文 FM 主持串联。"""
    mode = (mode or 'zh').strip().lower()
    if mode == 'ja':
        return 'ja-JP'
    if mode == 'en':
        return 'en-US'
    return 'cmn-CN'


def _normalize_fm_performance_tag(text: str) -> str:
    """仅保留 Gemini-TTS 已约定的行首表演标签，杜绝把编导说明念出来。"""
    value = (text or '').strip()
    match = _FM_LEADING_TAG_RE.match(value)
    if not match:
        return value
    tag = match.group(1).lower()
    spoken = value[match.end():].strip()
    if tag in FM_PERFORMANCE_TAG_SET:
        return f'{tag} {spoken}'.strip()
    # LLM 偶尔会自行发明 [微笑] / [pause] 等标签；去掉而非送进 TTS。
    return spoken


def _sanitize_fm_voice(raw: str, default: str) -> str:
    """FM 可用完整 Gemini-TTS 预置声线，不沿用旧系统设置的精简白名单。"""
    name = str(raw or '').strip()
    marker = 'chirp3-hd-'
    pos = name.lower().rfind(marker)
    if pos >= 0:
        name = name[pos + len(marker):]
    name = name.split('/')[-1].strip()
    return name if name in FM_VOICE_IDS else default


def _parse_fm_dialogue_turns(raw: str) -> list[tuple[str, str]]:
    """从模型原文解析 Host/Guest 对白回合（兼容中文角色名、Markdown、续行）。"""
    text = (raw or '').strip()
    text = re.sub(r'^```(?:\w+)?\s*', '', text)
    text = re.sub(r'\s*```$', '', text).strip()
    # 去掉整段围栏残留
    text = re.sub(r'```(?:\w+)?', '', text)
    turns: list[tuple[str, str]] = []
    current_speaker: Optional[str] = None
    for line in text.splitlines():
        line = (line or '').strip()
        if not line:
            continue
        line = re.sub(r'^[-*•·\d]+[.)、]\s*', '', line).strip()
        if not line:
            continue
        match = _FM_DIALOGUE_LINE_RE.match(line)
        if match:
            speaker = _fm_speaker_from_label(match.group(1))
            spoken = _normalize_fm_performance_tag(_sanitize_listen_script(match.group(2)))
            if spoken:
                turns.append((speaker, spoken))
                current_speaker = speaker
            continue
        # 无前缀续行：并入上一说话人
        if current_speaker and not re.match(r'^(标题|旁白|音效|scene|narrator)\b', line, re.I):
            spoken = _normalize_fm_performance_tag(_sanitize_listen_script(line))
            if spoken:
                if turns and turns[-1][0] == current_speaker:
                    turns[-1] = (current_speaker, turns[-1][1] + spoken)
                else:
                    turns.append((current_speaker, spoken))
    return turns


def _fm_spoken_chars(turns: list[tuple[str, str]]) -> int:
    return sum(len(text) for _speaker, text in turns)


def _fm_script_ok(turns: list[tuple[str, str]], *, min_total: int = 8) -> bool:
    if len(turns) < min_total:
        return False
    speakers = {speaker for speaker, _text in turns}
    if speakers != {'Host', 'Guest'}:
        return False
    host_n = sum(1 for s, _t in turns if s == 'Host')
    guest_n = sum(1 for s, _t in turns if s == 'Guest')
    return host_n >= 4 and guest_n >= 4


def _bound_fm_turns(turns: list[tuple[str, str]], hard_limit: int) -> list[tuple[str, str]]:
    """按 hard_limit 逐行截断；尽量保留完整回合。"""
    limit = max(200, int(hard_limit or 0))
    bounded: list[tuple[str, str]] = []
    used = 0
    for speaker, text in turns:
        line_size = len(speaker) + len(text) + 3
        if bounded and used + line_size > limit and len(bounded) >= 8:
            break
        bounded.append((speaker, text))
        used += line_size
    if not _fm_script_ok(bounded, min_total=8):
        return list(turns)
    return bounded


def _fm_focus_is_custom(focus: str) -> bool:
    """是否为用户自定义 / 非内置节目预设文案。"""
    f = str(focus or '').strip()
    if not f:
        return False
    if f == DEFAULT_AUDIO_FOCUS:
        return False
    for item in FM_PROGRAM_PRESETS:
        if f == str(item.get('prompt') or '').strip():
            return False
    return True


def _fm_language_hint(mode: str) -> str:
    """语言仅作软提示；节目焦点可完全覆盖。"""
    if mode == 'ja':
        return '默认倾向自然日语。'
    if mode == 'en':
        return 'Default toward natural spoken English.'
    if mode == 'zh_ja':
        return '默认倾向中文串联并可夹日语短句；若焦点要求日语课文/对照翻译等，以焦点为准。'
    if mode == 'zh_en':
        return '默认倾向中文串联并可夹英语短句；若焦点另有语言版式，以焦点为准。'
    return '默认倾向简体中文。'


def _fm_program_block(focus: str) -> str:
    focus_s = (focus or '').strip() or DEFAULT_AUDIO_FOCUS
    return (
        '【节目焦点 · 版式与内容由你主导】\n'
        '请按下面预设组织整期节目（角色分工、语言、节奏、是否翻译/念稿/问答等均以它为准）。'
        '后文「系统硬格式」只保证双人 TTS 能读；「软默认」仅在焦点没写明时参考，'
        '不得用软默认覆盖或稀释焦点。\n'
        f'{_clip(focus_s, 4000)}\n'
    )


def _fm_script_system_prompt(
    *,
    focus: str,
    mode: str,
    minutes_hint: int,
    target_chars: int,
    min_chars: int,
    min_turns: int,
) -> str:
    """台本 system：节目焦点主导，系统只留 TTS 必需硬格式 + 轻量软默认。"""
    focus_text = (focus or '').strip() or DEFAULT_AUDIO_FOCUS
    soft_roles = (
        '角色：焦点若写了老师/念稿/翻译等分工，按其映射到 Host 与 Guest；'
        '焦点未写时，再默认 Host 提问串联、Guest 讲解举例。'
        if _fm_focus_is_custom(focus_text) else
        '角色默认：Host 提问串联，Guest 讲解举例（焦点另有规定时以焦点为准）。'
    )
    return (
        '你是学习 FM 编导：把学习材料做成两位说话人的电台对白。\n\n'
        f'{_fm_program_block(focus_text)}\n'
        '【系统硬约束 · 与节目版式无关，必须满足】\n'
        '- 输出格式：每一行必须以英文 Host: 或 Guest: 开头（可用中文冒号）；'
        '两人交替；Host 与 Guest 各至少 4 句；不要标题/Markdown/旁白/项目符号；'
        '不要使用 Host/Guest 以外的角色名\n'
        f'- 时长档位：目标成品约 {minutes_hint} 分钟；台词正文（不含 Host:/Guest: 前缀）'
        f'约 {target_chars} 字，至少 {min_chars} 字、至少 {min_turns} 个对白回合。'
        '未达到字数/回合下限前不要收尾；用更多符合节目焦点的内容拉长，'
        '不要用寒暄凑字。格式与焦点优先，但篇幅下限仍须尽量写满\n\n'
        '【软默认 · 焦点未写明时才用；不可覆盖焦点或时长档位】\n'
        f'- {soft_roles}\n'
        f'- 语言：{_fm_language_hint(mode)}\n'
        '- 材料是素材库：按焦点取材与改写；焦点未要求「照念原文」时，避免大段逐字朗读原材料\n'
        '- 台词里不要写方括号表演标签（如 [excited]）；直接写可朗读的句子\n'
    )


def _repair_fm_dialogue_turns(
    *,
    draft_raw: str,
    focus: str,
    source_text: str,
    language_rule: str,
    cfg: dict,
) -> list[tuple[str, str]]:
    """格式失败时强制重写成 Host:/Guest: 台本。"""
    prompt = (
        '把下面内容改写成双人学习 FM 台本。\n'
        f'{_fm_program_block(focus)}\n'
        '只保留这些硬格式：\n'
        '- 每一行 Host: 或 Guest: 开头\n'
        '- 两人交替，各至少 4 句\n'
        '- 不要 Markdown / 标题 / 旁白\n'
        f'- 语言参考（可被焦点覆盖）：{language_rule}\n'
        '只输出台词行。\n\n'
        f'材料：\n{_clip(source_text, 12000)}\n\n'
        f'待修复草稿：\n{_clip(draft_raw, 8000)}\n'
    )
    raw = (call_llm(cfg, prompt) or '').strip()
    return _parse_fm_dialogue_turns(raw)


def _write_fm_dialogue_script(
    exported: dict,
    *,
    focus: str,
    length: str,
    language_code: str = 'auto',
    model_config: Optional[dict] = None,
) -> tuple[str, str]:
    """把 Learn 材料改写为严格的 Host / Guest 双人 FM 台本。"""
    ml = exported.get('mainline') or {}
    contexts = build_podcast_contexts_from_export(exported)
    source_text = (contexts[0].get('text') if contexts else '') or ''
    mode = _normalize_audio_lang(
        language_code,
        sample_text=source_text[:8000],
        title=str(ml.get('title') or ''),
    )
    length_u = (length or 'STANDARD').strip().upper()
    if length_u not in FM_LENGTH_PROFILES:
        length_u = 'STANDARD'
    profile = _fm_length_profile(length_u)
    target_chars = int(profile['target_chars'])
    min_chars = int(profile.get('min_chars') or max(300, int(target_chars * 0.75)))
    min_turns = int(profile.get('min_turns') or 8)
    minutes_hint = int(profile.get('minutes_hint') or 10)
    allow_expand = bool(profile.get('allow_expand', True))
    # 输出预算按档位封顶，避免模型拖很久仍在「写满」
    out_tokens = 8192 if minutes_hint <= 5 else (12288 if minutes_hint <= 10 else 16384)
    focus_text = (focus or '').strip() or DEFAULT_AUDIO_FOCUS
    language_rule = _fm_language_hint(mode)

    system = _fm_script_system_prompt(
        focus=focus_text,
        mode=mode,
        minutes_hint=minutes_hint,
        target_chars=target_chars,
        min_chars=min_chars,
        min_turns=min_turns,
    )
    user = (
        f"学习主线：{ml.get('title') or ''}\n"
        f'材料：\n{_clip(source_text, 28000)}\n\n'
        f'请按节目焦点写出可直接用于双人 TTS 的 FM 台本；'
        f'时长档位必须达到约 {minutes_hint} 分钟（≥{min_chars} 字、≥{min_turns} 回合）。'
    )
    models = model_config if isinstance(model_config, dict) else {}
    cfg = {
        'apiProvider': 'vertex',
        'projectId': str(models.get('projectId') or _cfg()['project_id']).strip(),
        'location': str(models.get('location') or 'us-central1').strip(),
        'modelId': str(models.get('modelId') or 'gemini-2.5-flash').strip(),
        'useWebSearch': False,
        'maxOutputTokens': out_tokens,
    }
    raw = (call_llm(cfg, system + '\n\n' + user) or '').strip()
    turns = _parse_fm_dialogue_turns(raw)

    if not _fm_script_ok(turns):
        turns = _repair_fm_dialogue_turns(
            draft_raw=raw or '(空)',
            focus=focus_text,
            source_text=source_text,
            language_rule=language_rule,
            cfg=cfg,
        )

    spoken = _fm_spoken_chars(turns)

    # 仅当明显过短才扩写一次；短档默认不扩写，避免「选 3 分钟也等很久」
    severely_short = spoken < int(min_chars * 0.7) or len(turns) < max(8, int(min_turns * 0.7))
    if allow_expand and _fm_script_ok(turns) and severely_short:
        draft = '\n'.join(f'{speaker}: {text}' for speaker, text in turns)
        expand = (
            f'{system}\n\n'
            f'下面草稿未达到所选时长档位（当前约 {spoken} 字 / {len(turns)} 回合；'
            f'要求约 {target_chars} 字、至少 {min_chars} 字与 {min_turns} 回合 ≈ {minutes_hint} 分钟）。\n'
            '请继续服从节目焦点，输出完整终稿（不要只输出增量），并补足到时长下限。\n'
            '终稿每一行仍必须以 Host: 或 Guest: 开头。\n\n'
            f'材料：\n{_clip(source_text, 20000)}\n\n'
            f'过短草稿：\n{draft}\n'
        )
        raw2 = (call_llm(cfg, expand) or '').strip()
        turns2 = _parse_fm_dialogue_turns(raw2)
        if not _fm_script_ok(turns2):
            turns2 = _repair_fm_dialogue_turns(
                draft_raw=raw2 or draft,
                focus=focus_text,
                source_text=source_text,
                language_rule=language_rule,
                cfg=cfg,
            )
        if _fm_script_ok(turns2) and (
            _fm_spoken_chars(turns2) > spoken or len(turns2) > len(turns)
        ):
            turns = turns2
            spoken = _fm_spoken_chars(turns)

    if not _fm_script_ok(turns):
        raise NotebookLMError(
            'FM 台本格式不完整，请重试。系统需要 Host: 与 Guest: 两人各至少 4 句。',
            status_code=502,
            code='fm_script_invalid',
        )

    bounded = _bound_fm_turns(turns, int(profile['hard_limit']))
    script = '\n'.join(f'{speaker}: {text}' for speaker, text in bounded)
    if len(script) < 120:
        raise NotebookLMError('FM 台本过短，请补充更多 Digest 后重试。', status_code=502, code='fm_script_empty')
    return _clip(script, 16000), mode


def _parse_fm_turns(script: str) -> list[tuple[str, str]]:
    turns = _parse_fm_dialogue_turns(script)
    if not _fm_script_ok(turns, min_total=2):
        raise NotebookLMError('FM 台本缺少双人对白。', status_code=502, code='fm_script_invalid')
    return turns


def _split_fm_turn_batches(turns: list[tuple[str, str]], max_bytes: int = 3200) -> list[list[tuple[str, str]]]:
    """Cloud Gemini-TTS 单次对白与提示词合计有字节上限，按完整回合分批。"""
    batches: list[list[tuple[str, str]]] = []
    current: list[tuple[str, str]] = []
    current_bytes = 0
    for speaker, text in turns:
        pieces = _split_tts_chunks(text, max_chars=280) or [text]
        for piece in pieces:
            size = len(f'{speaker}: {piece}\n'.encode('utf-8'))
            if size > max_bytes:
                raise NotebookLMError('FM 单句过长，请缩短学习材料后重试。', status_code=502, code='fm_turn_too_long')
            if current and current_bytes + size > max_bytes:
                batches.append(current)
                current = []
                current_bytes = 0
            current.append((speaker, piece))
            current_bytes += size
    if current:
        batches.append(current)
    return batches


def _fm_tts_policy_blocked(exc: BaseException) -> bool:
    low = str(exc or '').lower()
    return (
        'usage guidelines' in low
        or 'could not generate audio' in low
        or '54702341' in low
    )


def _fm_tts_safe_line(text: str) -> str:
    """去掉方括号标签、链接和标记符号，降低 Gemini-TTS 误拦。"""
    s = str(text or '')
    s = re.sub(r'\[[^\]\r\n]{1,48}\]', ' ', s)
    s = re.sub(r'https?://\S+', ' ', s)
    s = re.sub(r'[`*_#|>]', ' ', s)
    s = re.sub(r'\s+', ' ', s).strip()
    return s


def _lift_quiet_fm_pcm(pcm: bytes) -> bytes:
    """把明显偏轻的人声段拉回本集正常音量。

    Gemini 双人合成按批返回，单句或整批有时会突然变轻，下一批又恢复。
    只提升仍像说话的窗口，停顿和近静音不放大。
    """
    if not pcm or len(pcm) < FM_SAMPLE_RATE:
        return pcm
    samples = _pcm16_to_samples(pcm)
    n = len(samples)
    hop = int(FM_SAMPLE_RATE * 0.10)
    half = int(FM_SAMPLE_RATE * 0.15)
    silence_rms = 280.0
    max_gain = 4.5
    spans: list[tuple[int, int, float]] = []
    start = 0
    while start < n:
        end = min(n, start + hop)
        left = max(0, start - half)
        right = min(n, end + half)
        count = right - left
        energy = 0.0
        for index in range(left, right):
            value = float(samples[index])
            energy += value * value
        rms = (energy / count) ** 0.5 if count else 0.0
        spans.append((start, end, rms))
        start = end
    speech = sorted(rms for _a, _b, rms in spans if rms >= silence_rms)
    if len(speech) < 4:
        return pcm
    target = speech[min(len(speech) - 1, int(len(speech) * 0.65))]
    if target < 900:
        return pcm
    floor = target * 0.62
    gains = array('d', [1.0]) * n
    for start, end, rms in spans:
        gain = 1.0
        if silence_rms <= rms < floor:
            gain = min(max_gain, target / rms)
        for index in range(start, end):
            gains[index] = gain
    smooth = max(1, int(FM_SAMPLE_RATE * 0.04))
    if smooth > 1 and n > smooth:
        running = 0.0
        window: list[float] = []
        smoothed = array('d', [1.0]) * n
        for index, gain in enumerate(gains):
            running += gain
            window.append(gain)
            if len(window) > smooth:
                running -= window.pop(0)
            smoothed[index] = running / len(window)
        gains = smoothed
    out = array('h')
    for index, sample in enumerate(samples):
        out.append(max(-32768, min(32767, int(sample * gains[index]))))
    return _samples_to_pcm16(out)


def _fm_tts_fallback_line(text: str) -> str:
    sample = str(text or '')
    if re.search(r'[\u3040-\u30ff]', sample):
        return 'では、次に進みます。'
    if re.search(r'[A-Za-z]{4,}', sample) and not re.search(r'[\u4e00-\u9fff]', sample):
        return 'Let us continue.'
    return '我们继续。'


def _trim_fm_turn_pcm(pcm: bytes, threshold: int = 196, pad_sec: float = 0.03) -> bytes:
    """裁掉单句首尾多余静音并加极短淡入淡出，让逐句拼接停顿自然且无咔哒声。"""
    if not pcm or len(pcm) < 4:
        return pcm
    samples = _pcm16_to_samples(pcm)
    n = len(samples)
    start = 0
    end = n - 1
    while start <= end and abs(samples[start]) < threshold:
        start += 1
    while end >= start and abs(samples[end]) < threshold:
        end -= 1
    if start > end:
        return pcm
    pad = int(FM_SAMPLE_RATE * pad_sec)
    lo = max(0, start - pad)
    hi = min(n, end + 1 + pad)
    if lo == 0 and hi == n:
        return pcm
    trimmed = array('h', samples[lo:hi])
    fade = min(int(FM_SAMPLE_RATE * 0.01), len(trimmed) // 4)
    for idx in range(fade):
        w = (idx + 1) / fade
        trimmed[idx] = int(trimmed[idx] * w)
        trimmed[-1 - idx] = int(trimmed[-1 - idx] * w)
    return _samples_to_pcm16(trimmed)


def _fm_voice_anchor(voice_id: str, speaker: str = 'Host') -> str:
    label = next((item.get('label', '') for item in FM_VOICE_PRESETS if item.get('id') == voice_id), '')
    role = 'responsive radio co-host' if speaker == 'Guest' else 'steady lead radio host'
    if '男声' in label:
        return (
            f'Speak in a natural, grounded male {role} voice in your normal chest register '
            '(do not raise pitch into falsetto or imitate another speaker).'
        )
    if '女声' in label:
        return f'Speak in a natural, clear female {role} voice in a steady normal register.'
    return f'Speak in one consistent {role} voice in your natural register.'


def _fm_tts_retriable(exc: BaseException) -> bool:
    low = str(exc or '').lower()
    return any(
        token in low
        for token in ('429', '503', 'resource exhausted', 'resource_exhausted', 'rate limit', 'unavailable', 'deadline')
    )


def _synthesize_fm_dialogue_pcm(script: str, *, host_voice: str, guest_voice: str, language_code: str, model_name: str = '', strict: bool = False, narration_prompt: str = '') -> bytes:
    """逐回合调用 Cloud Gemini-TTS 单声线接口合成 24kHz PCM 对话。

    每回合仅挂载当前角色对应的单一声线（Host -> host_voice，Guest -> guest_voice），
    从物理上杜绝双人模式（MultiSpeakerMarkup）在长段落/引用书信后锁定单一声线串台的问题。
    """
    try:
        from google.cloud import texttospeech
    except ImportError as e:
        raise NotebookLMError(
            '服务端未安装支持 Gemini-TTS 的 google-cloud-texttospeech。',
            status_code=500,
            code='fm_tts_dep_missing',
        ) from e
    host = _sanitize_fm_voice(host_voice, 'Kore')
    guest = _sanitize_fm_voice(guest_voice, 'Puck')
    if host == guest:
        raise NotebookLMError('FM 的主持人与嘉宾需要选择不同声线。', status_code=400, code='fm_same_voice')
    turns = _parse_fm_turns(script)
    primary_lang = _fm_language_code(language_code)
    model = (model_name or _model_setting('tts_model') or FM_TTS_MODEL).strip()
    client = texttospeech.TextToSpeechClient()
    skipped = 0
    direction = re.sub(r'\s+', ' ', (narration_prompt or '').strip())[:240]
    def _turn_prompts(voice_id: str, speaker: str) -> tuple[str, str]:
        anchor = _fm_voice_anchor(voice_id, speaker)
        rich = (
            f'{anchor} Read this single radio dialogue turn naturally and clearly '
            'at a steady speaking volume. Do not whisper or drop volume.'
            + (f' {direction}' if direction else '')
        )
        plain = f'{anchor} Read this line clearly and calmly.'
        return rich, plain

    config = texttospeech.AudioConfig(
        audio_encoding=texttospeech.AudioEncoding.LINEAR16,
        sample_rate_hertz=FM_SAMPLE_RATE,
    )

    def _call_single(voice_id: str, text: str, prompt: str, lang: str) -> bytes:
        for attempt in range(4):
            try:
                response = client.synthesize_speech(
                    input=texttospeech.SynthesisInput(text=text, prompt=prompt),
                    voice=texttospeech.VoiceSelectionParams(
                        language_code=lang,
                        model_name=model,
                        name=voice_id,
                    ),
                    audio_config=config,
                    timeout=180,
                )
                return response.audio_content or b''
            except Exception as exc:
                if attempt < 3 and _fm_tts_retriable(exc):
                    time.sleep(2.5 * (2 ** attempt))
                    continue
                raise
        return b''

    def _langs_for(text: str) -> list[str]:
        langs = [primary_lang]
        if strict:
            return langs
        if re.search(r'[\u3040-\u30ff]', text) and primary_lang != 'ja-JP':
            langs.append('ja-JP')
        if re.search(r'[\u4e00-\u9fff]', text) and primary_lang not in ('cmn-CN', 'zh-CN'):
            langs.append('cmn-CN')
        return langs

    def _synth_piece(speaker: str, raw_text: str) -> bytes:
        nonlocal skipped
        voice_id = guest if speaker == 'Guest' else host
        clean = re.sub(r'^\s*(?:Host|Guest)\s*[:：]\s*', '', str(raw_text or ''), flags=re.IGNORECASE)
        safe = _fm_tts_safe_line(clean) or _fm_tts_fallback_line(clean)
        rich_prompt, plain_prompt = _turn_prompts(voice_id, speaker)
        last_err: Optional[BaseException] = None
        for prompt in (rich_prompt, plain_prompt):
            for lang in _langs_for(safe):
                try:
                    audio = _call_single(voice_id, safe, prompt, lang)
                    if audio:
                        return audio
                except Exception as exc:
                    last_err = exc
                    if not _fm_tts_policy_blocked(exc):
                        raise
        sub_pieces = _split_tts_chunks(safe, max_chars=220)
        if len(sub_pieces) > 1:
            return b''.join(_synth_piece(speaker, p) for p in sub_pieces)
        if strict:
            raise NotebookLMError('有一句台词未能完整配音，本期已停止。台本已保留，可以重试。', status_code=502, code='fm_tts_incomplete') from last_err
        skipped += 1
        try:
            return _call_single(voice_id, _fm_tts_fallback_line(safe), plain_prompt, primary_lang)
        except Exception:
            return b''

    pause_pcm = b'\x00\x00' * int(FM_SAMPLE_RATE * 0.22)
    try:
        pcm_parts: list[bytes] = []
        for speaker, text in turns:
            pieces = _split_tts_chunks(text, max_chars=900) or [text]
            turn_chunks: list[bytes] = []
            for piece in pieces:
                audio = _synth_piece(speaker, piece)
                if audio:
                    turn_chunks.append(_trim_fm_turn_pcm(audio))
            if turn_chunks:
                intra_pause = b'\x00\x00' * int(FM_SAMPLE_RATE * 0.08)
                turn_pcm = _lift_quiet_fm_pcm(intra_pause.join(turn_chunks))
                pcm_parts.append(turn_pcm)
    except NotebookLMError:
        raise
    except Exception as e:
        if _fm_tts_policy_blocked(e):
            raise NotebookLMError(
                'FM 对话被语音安全策略拦截。请缩短焦点里的敏感表述，或换一段材料后重试。',
                status_code=502,
                code='fm_tts_failed',
            ) from e
        raise NotebookLMError(
            f'双人 FM 对话合成失败：{e}', status_code=502, code='fm_tts_failed'
        ) from e
    finally:
        try:
            client.transport.close()
        except Exception:
            pass
    pcm = _lift_quiet_fm_pcm(pause_pcm.join(pcm_parts))
    if len(pcm) < FM_SAMPLE_RATE * 2:
        raise NotebookLMError(
            '双人 FM 对话被语音安全策略拦截，未能合成可播放音频。请调整节目焦点或材料后重试。'
            if skipped else '双人 FM 对话音频异常过短。',
            status_code=502,
            code='fm_tts_failed' if skipped else 'fm_tts_empty',
        )
    return pcm


def _generate_fm_music_wav(style_id: str, *, project_id: str = '', model_id: str = '', location: str = '') -> tuple[bytes, dict]:
    """调用 Lyria 2 得到约 30 秒器乐 WAV；FM 混音阶段会循环铺底。

    快速失败策略：最多试少数提示词、短超时；全部失败由上层降级为无人声底乐，
    避免配乐重试拖垮整单（曾出现 7×180s 串行导致用户空等 20 分钟）。
    """
    preset = FM_MUSIC_PRESET_INDEX.get((style_id or '').strip()) or FM_MUSIC_PRESET_INDEX['focus_lofi']
    try:
        import google.auth
        from google.auth.transport.requests import AuthorizedSession

        credentials, discovered_project = google.auth.default(
            scopes=['https://www.googleapis.com/auth/cloud-platform']
        )
        project_id = (project_id or _cfg()['project_id'] or discovered_project).strip()
        if not project_id:
            raise RuntimeError('缺少 GCP 项目 ID')
        loc = (location or _model_setting('lyria_location') or FM_LYRIA_LOCATION).strip().lower().replace('_', '-') or 'global'
        # 官方 Lyria 2 仅 global；误填语言码时回退
        if loc in ('en-us', 'en', 'ja-jp', 'ja', 'zh-cn', 'zh', 'cmn-cn'):
            loc = 'global'
        host = 'aiplatform.googleapis.com' if loc == 'global' else f'{loc}-aiplatform.googleapis.com'
        model = (model_id or _model_setting('lyria_model') or FM_LYRIA_MODEL).strip() or FM_LYRIA_MODEL
        url = (
            f'https://{host}/v1/projects/{project_id}'
            f'/locations/{loc}/publishers/google/models/{model}:predict'
        )
        http = AuthorizedSession(credentials)
        prompts = []
        for candidate in (
            preset.get('prompt'),
            preset.get('fallback_prompt'),
            FM_LYRIA_SAFE_FALLBACK_PROMPT,
            *FM_LYRIA_EXTRA_SAFE_PROMPTS,
        ):
            text = str(candidate or '').strip()
            if text and text not in prompts:
                prompts.append(text)
        prompts = prompts[: max(1, int(FM_LYRIA_MAX_PROMPTS))]
        last_err = ''
        for idx, prompt in enumerate(prompts):
            payload = {
                'instances': [{
                    'prompt': prompt,
                    'negative_prompt': FM_LYRIA_NEGATIVE_PROMPT,
                }],
                'parameters': {'sample_count': 1},
            }
            response = None
            # 超时 / 偶发拒词：同一提示再试一次；仍失败再换提示词
            net_attempts = 1 + max(0, int(FM_LYRIA_TIMEOUT_RETRIES))
            reject_budget = 1 + max(0, int(FM_LYRIA_PROMPT_REJECT_RETRIES))
            attempt = 0
            while attempt < max(net_attempts, reject_budget):
                try:
                    response = http.post(url, json=payload, timeout=FM_LYRIA_HTTP_TIMEOUT_SEC)
                except Exception as req_err:
                    last_err = f'Lyria 请求超时/网络错误: {req_err}'
                    attempt += 1
                    if attempt < net_attempts:
                        continue
                    response = None
                    break
                body = (response.text or '')[:400]
                if response.status_code < 400:
                    break
                last_err = f'HTTP {response.status_code}: {body}'
                low = body.lower()
                prompt_rejected = (
                    'different prompt' in low or 'could not generate audio' in low
                )
                retriable_http = response.status_code in (429, 500, 503, 504) or prompt_rejected
                attempt += 1
                if prompt_rejected and attempt < reject_budget:
                    continue
                if retriable_http and attempt < net_attempts:
                    continue
                break
            if response is None:
                if idx + 1 < len(prompts):
                    continue
                raise RuntimeError(last_err or 'Lyria 请求失败')
            body = (response.text or '')[:400]
            if response.status_code >= 400:
                last_err = f'HTTP {response.status_code}: {body}'
                low = body.lower()
                retriable = (
                    'different prompt' in low
                    or 'could not generate audio' in low
                    or 'unavailable' in low
                    or response.status_code in (400, 429, 500, 503, 504)
                )
                if idx + 1 < len(prompts) and retriable:
                    continue
                raise RuntimeError(last_err)
            predictions = (response.json() or {}).get('predictions') or []
            first = predictions[0] if predictions else {}
            encoded = first.get('audioContent') or first.get('bytesBase64Encoded')
            raw = base64.b64decode(encoded) if encoded else b''
            if len(raw) < 4096:
                last_err = 'Lyria 未返回有效 WAV 音频'
                if idx + 1 < len(prompts):
                    continue
                raise RuntimeError(last_err)
            used = dict(preset)
            used['prompt_used'] = prompt
            used['prompt_attempt'] = idx + 1
            return raw, used
        raise RuntimeError(last_err or 'Lyria 配乐生成失败')
    except NotebookLMError:
        raise
    except Exception as e:
        msg = str(e)
        low = msg.lower()
        if 'different prompt' in low or 'could not generate audio' in low:
            raise NotebookLMError(
                f'背景音乐提示词被 Lyria 拒绝，请换一个配乐风格后重试（{msg}）。',
                status_code=502,
                code='fm_music_prompt_rejected',
            ) from e
        if '403' in msg or 'permission' in low or 'unauth' in low:
            raise NotebookLMError(
                '背景音乐生成失败。请确认 Cloud Run 服务账号已获 Vertex AI 调用权限，'
                f'并且项目可使用 Lyria 2（{msg}）。',
                status_code=502,
                code='fm_music_failed',
            ) from e
        raise NotebookLMError(
            f'背景音乐生成失败（{msg}）。',
            status_code=502,
            code='fm_music_failed',
        ) from e


def _dialogue_only_fm_wav(
    dialogue_pcm: bytes,
    *,
    speech_volume: int = FM_DEFAULT_SPEECH_VOLUME,
) -> bytes:
    """配乐不可用时：仅输出人声对白 WAV，避免整单失败。"""
    if not dialogue_pcm:
        raise NotebookLMError('FM 对人声轨为空。', status_code=502, code='fm_mix_empty')
    dialogue = _pcm16_to_samples(dialogue_pcm)
    speech_gain = _normalize_fm_volume(speech_volume, default=FM_DEFAULT_SPEECH_VOLUME) / 100
    pad_frames = int(FM_SAMPLE_RATE * 0.6)
    speech = array('h', [0]) * pad_frames + dialogue + array('h', [0]) * pad_frames
    out = array('h')
    for sample in speech:
        out.append(max(-32768, min(32767, int(sample * speech_gain))))
    return _pcm_to_wav(_samples_to_pcm16(out))


def _pcm16_to_samples(pcm: bytes) -> array:
    if not pcm or len(pcm) % 2:
        raise NotebookLMError('PCM 音频数据不完整。', status_code=502, code='fm_pcm_invalid')
    samples = array('h')
    samples.frombytes(pcm)
    if sys.byteorder != 'little':
        samples.byteswap()
    return samples


def _samples_to_pcm16(samples: array) -> bytes:
    out = array('h', samples)
    if sys.byteorder != 'little':
        out.byteswap()
    return out.tobytes()


def _resample_fm_samples(samples: array, source_rate: int) -> array:
    """线性重采样；Lyria 通常为 48kHz，常用路径会直接隔样抽取。"""
    if source_rate == FM_SAMPLE_RATE:
        return samples
    if source_rate > FM_SAMPLE_RATE and source_rate % FM_SAMPLE_RATE == 0:
        return samples[::source_rate // FM_SAMPLE_RATE]
    target_size = max(1, (len(samples) * FM_SAMPLE_RATE) // source_rate)
    out = array('h')
    for index in range(target_size):
        source_pos = index * source_rate
        left_index = source_pos // FM_SAMPLE_RATE
        fraction = source_pos % FM_SAMPLE_RATE
        right_index = min(left_index + 1, len(samples) - 1)
        left = samples[left_index]
        right = samples[right_index]
        out.append(int(left + ((right - left) * fraction / FM_SAMPLE_RATE)))
    return out


def _lyria_wav_to_fm_pcm(raw: bytes) -> bytes:
    """把 Lyria WAV 下混/重采样为 24kHz 单声道 PCM，供无外部转码器的 Cloud Run 混音。"""
    try:
        with wave.open(io.BytesIO(raw), 'rb') as source:
            channels = source.getnchannels()
            width = source.getsampwidth()
            rate = source.getframerate()
            compression = source.getcomptype()
            frames = source.readframes(source.getnframes())
    except Exception as e:
        raise NotebookLMError('Lyria 返回的背景音乐不是可读取的 WAV。', status_code=502, code='fm_music_format') from e
    if compression != 'NONE' or width != 2 or channels not in (1, 2) or rate <= 0:
        raise NotebookLMError('Lyria 背景音乐格式不受支持。', status_code=502, code='fm_music_format')
    source_samples = _pcm16_to_samples(frames)
    if channels == 2:
        mono = array('h')
        for index in range(0, len(source_samples), 2):
            mono.append((int(source_samples[index]) + int(source_samples[index + 1])) // 2)
        source_samples = mono
    pcm = _samples_to_pcm16(_resample_fm_samples(source_samples, rate))
    if len(pcm) < FM_SAMPLE_RATE * 2:
        raise NotebookLMError('背景音乐异常过短。', status_code=502, code='fm_music_empty')
    return pcm


def _normalize_fm_volume(value: Any, *, default: int) -> int:
    """把前端百分比限制为可预测的成品混音范围。"""
    try:
        return max(0, min(100, int(round(float(value)))))
    except (TypeError, ValueError):
        return default


def _loop_music_to_length(music: array, target_len: int, *, crossfade: int) -> array:
    """把短 BGM 循环铺满 target_len；接点用交叉淡化，避免硬切爆音。"""
    if target_len <= 0:
        return array('h')
    n = len(music)
    if n <= 0:
        return array('h', [0]) * target_len
    if n >= target_len:
        return array('h', music[:target_len])
    cf = max(0, min(int(crossfade), n // 4))
    out = array('h', music)
    while len(out) < target_len:
        if cf <= 0:
            out.extend(music)
            continue
        start = len(out) - cf
        for i in range(cf):
            a = (i + 1) / (cf + 1)
            out[start + i] = int(out[start + i] * (1.0 - a) + music[i] * a)
        out.extend(music[cf:])
    return array('h', out[:target_len])


def _mix_fm_pcm(
    dialogue_pcm: bytes,
    music_pcm: bytes,
    *,
    speech_volume: int = FM_DEFAULT_SPEECH_VOLUME,
    music_volume: int = FM_DEFAULT_MUSIC_VOLUME,
) -> bytes:
    """为双人对话叠加可调音量的循环底乐（短 BGM 铺满长 FM），并留出自然的片头/片尾。"""
    if not dialogue_pcm or not music_pcm:
        raise NotebookLMError('FM 混音缺少音轨。', status_code=502, code='fm_mix_empty')
    dialogue = _pcm16_to_samples(dialogue_pcm)
    music = _pcm16_to_samples(music_pcm)
    speech_gain = _normalize_fm_volume(speech_volume, default=FM_DEFAULT_SPEECH_VOLUME) / 100
    music_gain = _normalize_fm_volume(music_volume, default=FM_DEFAULT_MUSIC_VOLUME) / 100
    pad_frames = int(FM_SAMPLE_RATE * 1.2)
    speech = array('h', [0]) * pad_frames + dialogue + array('h', [0]) * pad_frames
    total = len(speech)
    # ~350ms 接点交叉淡化；片头淡入 / 片尾淡出，避免循环感突兀
    music_bed = _loop_music_to_length(
        music,
        total,
        crossfade=int(FM_SAMPLE_RATE * 0.35),
    )
    intro_fade = min(int(FM_SAMPLE_RATE * 1.5), max(1, total // 8))
    outro_fade = min(int(FM_SAMPLE_RATE * 2.0), max(1, total // 6))
    mixed = array('h')
    for index, speech_sample in enumerate(speech):
        mg = music_gain
        if index < intro_fade:
            mg *= index / intro_fade
        elif index >= total - outro_fade:
            mg *= max(0.0, (total - 1 - index) / outro_fade)
        value = int(speech_sample * speech_gain) + int(music_bed[index] * mg)
        mixed.append(max(-32768, min(32767, value)))
    return _samples_to_pcm16(mixed)


def _pcm_to_wav(pcm: bytes) -> bytes:
    out = io.BytesIO()
    with wave.open(out, 'wb') as target:
        target.setnchannels(1)
        target.setsampwidth(2)
        target.setframerate(FM_SAMPLE_RATE)
        target.writeframes(pcm)
    return out.getvalue()


def _detect_snippet_lang(text: str, *, hint: str = '') -> str:
    """短选区语言：有假名走日语；纯汉字看 Digest 语境，避免日语词被中文声读错。"""
    t = (text or '').strip()
    if not t:
        return 'zh'
    kana, han, en_words = _script_stats(t)
    latin = len(re.findall(r'[A-Za-z]', t))
    looks_ja = _clause_looks_japanese(t)
    hint_mode = _detect_listen_mode(hint) if (hint or '').strip() else ''

    if looks_ja and latin >= 8:
        return 'zh_en' if han >= 8 and kana == 0 else 'zh_ja'
    if looks_ja:
        return 'ja'
    if latin >= 2 and han == 0 and kana == 0:
        return 'en'
    if latin >= 4 and han >= 2:
        return 'zh_en'
    if han >= 1 and hint_mode in ('ja', 'zh_ja'):
        return 'ja'
    if han >= 1 and hint_mode in ('en', 'zh_en') and latin >= 2:
        return 'zh_en'
    if han >= 1:
        return 'zh'
    if en_words:
        return 'en'
    return 'zh'


def synthesize_fm_voice_preview(
    voice_id: str,
    *,
    role: str = 'host',
    partner_voice: str = '',
    model_name: str = '',
    language_code: str = 'zh',
) -> bytes:
    """只合成被点中的那一条声线，不把主持和嘉宾一起读出来。"""
    try:
        from google.cloud import texttospeech
    except ImportError as e:
        raise NotebookLMError(
            '服务端未安装 google-cloud-texttospeech。',
            status_code=500,
            code='tts_dep_missing',
        ) from e

    preview = _sanitize_fm_voice(voice_id, 'Kore')
    is_guest = str(role or 'host').strip().lower() == 'guest'
    line = '你好，我是这一集的嘉宾。我会把重点讲成能记住的一句。' if is_guest else '你好，我是这一集的主持。我会把今天的重点问清楚。'
    if language_code == 'en':
        line = "Hello, welcome to our letter radio. There is always another way to see a little everyday surprise."
    elif language_code == 'ja':
        line = 'こんにちは、おたよりラジオへようこそ。今日も、小さな日常の出来事を一緒に楽しみましょう。'
    model = (model_name or _model_setting('tts_model') or FM_TTS_MODEL).strip()
    lang = _fm_language_code(language_code)
    client = texttospeech.TextToSpeechClient()
    config = texttospeech.AudioConfig(
        audio_encoding=texttospeech.AudioEncoding.MP3,
        speaking_rate=1.0,
    )
    try:
        try:
            response = client.synthesize_speech(
                input=texttospeech.SynthesisInput(text=line, prompt='Read this line naturally and warmly, with one consistent voice.'),
                voice=texttospeech.VoiceSelectionParams(language_code=lang, model_name=model, name=preview),
                audio_config=config,
                timeout=90,
            )
        except Exception:
            speaker = 'Guest' if is_guest else 'Host'
            other = 'Host' if speaker == 'Guest' else 'Guest'
            other_id = _sanitize_fm_voice(partner_voice, '') or ('Puck' if preview != 'Puck' else 'Kore')
            if other_id == preview:
                other_id = 'Puck' if preview != 'Puck' else 'Kore'
            response = client.synthesize_speech(
                input=texttospeech.SynthesisInput(
                    multi_speaker_markup=texttospeech.MultiSpeakerMarkup(turns=[
                        texttospeech.MultiSpeakerMarkup.Turn(speaker=speaker, text=line),
                    ]),
                    prompt='Read only this one speaker, clearly and calmly.',
                ),
                voice=texttospeech.VoiceSelectionParams(
                    language_code=lang,
                    model_name=model,
                    multi_speaker_voice_config=texttospeech.MultiSpeakerVoiceConfig(
                        speaker_voice_configs=[
                            texttospeech.MultispeakerPrebuiltVoice(speaker_alias=speaker, speaker_id=preview),
                            texttospeech.MultispeakerPrebuiltVoice(speaker_alias=other, speaker_id=other_id),
                        ]
                    ),
                ),
                audio_config=config,
                timeout=90,
            )
        mp3 = response.audio_content or b''
    except NotebookLMError:
        raise
    except Exception as e:
        raise NotebookLMError(
            f'FM 声线试听失败：{e}', status_code=502, code='fm_voice_preview_failed'
        ) from e
    finally:
        try:
            client.transport.close()
        except Exception:
            pass
    if len(mp3) < 64:
        raise NotebookLMError('FM 声线试听结果异常过短。', status_code=502, code='fm_voice_preview_empty')
    return mp3


def load_fm_bgm_preview_wav(style_id: str) -> bytes:
    """共享库 BGM 试听（WAV 字节）。"""
    sid = re.sub(r'[^a-zA-Z0-9_-]', '', (style_id or '').strip())
    if not sid or sid not in FM_MUSIC_PRESET_INDEX:
        raise NotebookLMError('未知的配乐风格。', status_code=400, code='fm_bgm_unknown')
    raw = _load_shared_fm_bgm_wav(sid)
    if not raw:
        raise NotebookLMError('该风格配乐尚未入库，请先刷新或预热。', status_code=404, code='fm_bgm_missing')
    return raw


def _bgm_file(style_id: str) -> Path:
    sid = re.sub(r'[^a-zA-Z0-9_-]', '', (style_id or '').strip()) or 'focus_lofi'
    return BGM_DIR / f'{sid}.wav'


def list_fm_bgm_library() -> list[dict]:
    out = []
    for preset in FM_MUSIC_PRESETS:
        sid = preset['id']
        path = _bgm_file(sid)
        ready = path.exists() and path.stat().st_size >= 4096
        out.append({
            'id': sid,
            'label': preset.get('label') or sid,
            'ready': ready,
            'url': f'/media/bgm/{sid}.wav' if ready else '',
            'size': path.stat().st_size if ready else 0,
        })
    return out


def _load_shared_fm_bgm_wav(style_id: str) -> bytes:
    path = _bgm_file(style_id)
    if not path.exists():
        return b''
    raw = path.read_bytes()
    return raw if len(raw) >= 4096 else b''


def _save_shared_fm_bgm_wav(style_id: str, wav_bytes: bytes) -> str:
    if not wav_bytes or len(wav_bytes) < 4096:
        raise NotebookLMError('无法写入空的共享 BGM。', status_code=502, code='fm_bgm_empty')
    path = _bgm_file(style_id)
    path.write_bytes(wav_bytes)
    return f'/media/bgm/{path.stem}.wav'


def resolve_fm_bgm_pcm(
    style_id: str,
    *,
    force_new: bool = False,
    project_id: str = '',
    model_id: str = '',
    location: str = '',
) -> tuple[bytes, dict, dict]:
    preset = FM_MUSIC_PRESET_INDEX.get((style_id or '').strip()) or FM_MUSIC_PRESET_INDEX['focus_lofi']
    sid = preset['id']
    if not force_new:
        cached = _load_shared_fm_bgm_wav(sid)
        if cached:
            try:
                return _lyria_wav_to_fm_pcm(cached), preset, {
                    'source': 'library',
                    'url': f'/media/bgm/{sid}.wav',
                    'style_id': sid,
                }
            except NotebookLMError:
                pass
    wav, used_preset = _generate_fm_music_wav(
        sid, project_id=project_id, model_id=model_id, location=location,
    )
    pcm = _lyria_wav_to_fm_pcm(wav)
    url = _save_shared_fm_bgm_wav(sid, _pcm_to_wav(pcm))
    return pcm, used_preset, {
        'source': 'generated',
        'url': url,
        'style_id': sid,
        'prompt_used': used_preset.get('prompt_used') or '',
    }
