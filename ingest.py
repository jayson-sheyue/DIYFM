"""把上传文件或公开网页收成可写进台本的纯文本。"""
from __future__ import annotations

import io
import re
from html.parser import HTMLParser

import requests

MAX_CHARS = 28000
MAX_DOWNLOAD = 8 * 1024 * 1024


class _TextExtractor(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts: list[str] = []
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style', 'noscript', 'svg'):
            self._skip += 1

    def handle_endtag(self, tag):
        if tag in ('script', 'style', 'noscript', 'svg') and self._skip:
            self._skip -= 1
        if tag in ('p', 'div', 'br', 'li', 'h1', 'h2', 'h3', 'tr', 'section', 'article'):
            self.parts.append('\n')

    def handle_data(self, data):
        if not self._skip and data.strip():
            self.parts.append(data.strip() + ' ')


def _clean(text: str) -> str:
    text = text.replace('\x00', '')
    text = re.sub(r'[ \t]+\n', '\n', text)
    text = re.sub(r'\n{3,}', '\n\n', text)
    text = re.sub(r'[ \t]{2,}', ' ', text).strip()
    if len(text) > MAX_CHARS:
        text = text[:MAX_CHARS].rstrip() + '\n…'
    return text


def text_from_upload(filename: str, raw: bytes) -> tuple[str, str]:
    name = (filename or '资料').rsplit('/', 1)[-1]
    ext = name.rsplit('.', 1)[-1].lower() if '.' in name else ''
    if ext in ('txt', 'md', 'markdown', 'csv', 'json'):
        body = raw.decode('utf-8', errors='replace')
    elif ext == 'pdf':
        from pypdf import PdfReader
        reader = PdfReader(io.BytesIO(raw))
        body = '\n'.join((page.extract_text() or '') for page in reader.pages[:40])
    elif ext == 'docx':
        from docx import Document
        doc = Document(io.BytesIO(raw))
        body = '\n'.join(p.text for p in doc.paragraphs if p.text.strip())
    else:
        raise ValueError('仅支持 txt、md、pdf、docx，或直接粘贴公开 URL')
    text = _clean(body)
    if len(text) < 40:
        raise ValueError('这份资料几乎没有可朗读的文字')
    return name, text


def text_from_url(url: str) -> tuple[str, str]:
    target = (url or '').strip()
    if not target.startswith(('http://', 'https://')):
        raise ValueError('请提供 http 或 https 开头的公开链接')
    resp = requests.get(
        target,
        timeout=20,
        headers={'User-Agent': 'DIYFM/1.0'},
        stream=True,
    )
    resp.raise_for_status()
    chunks = []
    size = 0
    for chunk in resp.iter_content(65536):
        if not chunk:
            continue
        size += len(chunk)
        if size > MAX_DOWNLOAD:
            break
        chunks.append(chunk)
    raw = b''.join(chunks)
    ctype = (resp.headers.get('content-type') or '').lower()
    if 'pdf' in ctype or target.lower().split('?', 1)[0].endswith('.pdf'):
        title, text = text_from_upload('source.pdf', raw)
        return target, text
    html = raw.decode(resp.encoding or 'utf-8', errors='replace')
    parser = _TextExtractor()
    parser.feed(html)
    title_match = re.search(r'<title[^>]*>(.*?)</title>', html, flags=re.I | re.S)
    title = re.sub(r'\s+', ' ', title_match.group(1)).strip() if title_match else target
    text = _clean(''.join(parser.parts))
    if len(text) < 40:
        raise ValueError('这个页面没有抽出足够的正文')
    return (title or target)[:120], text
