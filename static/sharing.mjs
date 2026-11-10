import { zipSync, unzipSync, strToU8, strFromU8 } from "./vendor/fflate.mjs";
import { readWav } from "./audio.mjs?v=2.1.2";

export const SHARE_LIMIT = 100 * 1024 * 1024;
export const CATALOG_URL = "https://jayson-sheyue.github.io/DIYFM/catalog/index.json";
const fail = (key) => { throw new Error(key); };
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const id = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,90}$/.test(value);
const hash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const text = (value, max, required = false) => {
  if (typeof value !== "string" || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) fail("分享包的资料格式无效。");
  if (required && !value.trim()) fail("请填写创作者署名和使用条款。");
  return value.trim();
};
export function sourceURL(value = "") {
  if (!value) return "";
  text(value, 2048);
  let url;
  try { url = new URL(value); } catch { fail("来源链接必须是有效的 HTTPS 地址。"); }
  if (url.protocol !== "https:" || url.username || url.password) fail("来源链接必须是有效的 HTTPS 地址。");
  return url.href;
}
export function attribution(value) {
  if (!object(value)) fail("分享包的资料格式无效。");
  return { author: text(value.author, 120, true), source_url: sourceURL(value.source_url || ""), license: text(value.license, 600, true) };
}
export function provenance(value) {
  if (!object(value) || !id(value.channel_id) || !hash(value.content_id)) fail("分享包的来源信息无效。");
  return { ...attribution(value), channel_id: value.channel_id, content_id: value.content_id };
}
export async function sha256(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(n => n.toString(16).padStart(2, "0")).join("");
}
function publicEpisode(ep, audio) {
  if (!object(ep) || !id(ep.id)) fail("分享包的资料格式无效。");
  const duration = Number(ep.duration_seconds);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 14400) fail("分享包的音频信息无效。");
  const sources = (ep.sources || []);
  if (!Array.isArray(sources) || sources.length > 30 || !Array.isArray(ep.expressions || []) || (ep.expressions || []).length > 20) fail("分享包的资料格式无效。");
  return {
    id: ep.id, title: text(ep.title, 80, true), summary: text(ep.summary || "", 600),
    script: text(ep.script || "", 100000),
    expressions: (ep.expressions || []).map(v => text(v, 160)),
    sources: sources.map(s => {
      if (!object(s)) fail("分享包的资料格式无效。");
      return { title: text(s.title, 240), url: sourceURL(s.url) };
    }),
    duration_seconds: duration, created_at: text(ep.created_at || "", 40),
    music_source: text(ep.music_source || "", 30),
    ...(ep.origin ? { origin: provenance(ep.origin) } : {}), audio,
  };
}
function channel(value) {
  if (!object(value) || !id(value.id) || !["en", "ja"].includes(value.language) || !["beginner", "basic", "advanced"].includes(value.difficulty)) fail("分享包的频道信息无效。");
  return { id: value.id, title: text(value.title, 80, true), language: value.language, difficulty: value.difficulty,
    description: text(value.description || "", 1200), ...(value.origin ? { origin: provenance(value.origin) } : {}) };
}
function normalize(manifest) {
  if (!object(manifest) || manifest.format !== "diyfm-channel" || manifest.version !== 1) fail("不支持这个分享包版本，请更新 DIYFM。");
  if (!Array.isArray(manifest.episodes) || !manifest.episodes.length || manifest.episodes.length > 50) fail("请选择 1 至 50 集完整成片。");
  const ids = new Set();
  return { format: "diyfm-channel", version: 1, channel: channel(manifest.channel), attribution: attribution(manifest.attribution),
    episodes: manifest.episodes.map(ep => {
      if (!object(ep) || !object(ep.audio) || !id(ep.id) || ids.has(ep.id)) fail("分享包含重复或无效的节目。");
      ids.add(ep.id);
      const a = ep.audio;
      if (a.path !== `audio/${ep.id}.wav` || !hash(a.sha256) || !Number.isSafeInteger(a.bytes) || a.bytes < 44 || a.bytes > SHARE_LIMIT) fail("分享包的音频信息无效。");
      return publicEpisode(ep, { path: a.path, bytes: a.bytes, sha256: a.sha256 });
    }) };
}
function archive(buffer, onlyManifest = false) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength > (onlyManifest ? 500 * 1024 * 1024 : SHARE_LIMIT)) fail("分享包过大，请将选定成片控制在 100MB 内。");
  let size = 0, count = 0;
  const names = new Set();
  try {
    return unzipSync(new Uint8Array(buffer), { filter(entry) {
      if (++count > 5000) fail("分享包的资料格式无效。");
      if (onlyManifest && entry.name !== "channel.json") return false;
      if (names.has(entry.name) || (!onlyManifest && !/^(?:channel\.json|audio\/[A-Za-z0-9_-]{1,90}\.wav)$/.test(entry.name))) fail("分享包含重复文件或不支持的路径。");
      names.add(entry.name); size += entry.originalSize;
      if (entry.originalSize < 0 || size > (onlyManifest ? 1024 * 1024 : SHARE_LIMIT) || (entry.name === "channel.json" && entry.originalSize > 1024 * 1024)) fail("分享包过大，请将选定成片控制在 100MB 内。");
      return true;
    } });
  } catch (e) { throw new Error(e.message?.includes("分享包") ? e.message : "无法读取分享包，已有节目仍保留。"); }
}
export function isChannelPackage(buffer) { return !!archive(buffer, true)["channel.json"]; }

export async function encodeChannel(show, { author, source_url = "", license, description = "", episodeIds }, readAudio) {
  const selected = new Set(episodeIds || []);
  if (!selected.size || selected.size > 50) fail("请选择 1 至 50 集完整成片。");
  const episodes = (show.episodes || []).filter(ep => selected.has(ep.id) && ep.status === "ready");
  if (episodes.length !== selected.size) fail("所选成片已发生变化，请重新选择。");
  const files = {}, records = [];
  let size = 0;
  for (const ep of episodes) {
    const blob = await readAudio(ep.id);
    if (!(blob instanceof Blob)) fail("成片音频缺失，无法分享。原频道仍保留。");
    size += blob.size;
    if (size > SHARE_LIMIT) fail("分享包过大，请将选定成片控制在 100MB 内。");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const decoded = readWav(bytes.buffer);
    if (!decoded || !decoded.pcm.length) fail("分享包的音频信息无效。");
    const path = `audio/${ep.id}.wav`;
    files[path] = bytes;
    // Publish only finished mixed audio and explicitly public metadata, never inputs or settings.
    records.push(publicEpisode({ ...ep, origin: ep.provenance, duration_seconds: decoded.pcm.length / decoded.rate }, { path, bytes: bytes.length, sha256: await sha256(bytes) }));
  }
  const manifest = normalize({ format: "diyfm-channel", version: 1,
    channel: { id: show.id, title: show.title, language: show.language, difficulty: show.difficulty, description, origin: show.provenance },
    attribution: { author, source_url, license }, episodes: records });
  files["channel.json"] = strToU8(JSON.stringify(manifest, null, 2));
  const bytes = zipSync(files, { level: 0 });
  if (bytes.length > SHARE_LIMIT) fail("分享包过大，请将选定成片控制在 100MB 内。");
  return new Blob([bytes], { type: "application/zip" });
}

export async function decodeChannel(buffer) {
  const files = archive(buffer);
  if (!files["channel.json"]) fail("无法读取分享包，已有节目仍保留。");
  let raw;
  try { raw = JSON.parse(strFromU8(files["channel.json"])); } catch { fail("分享包的资料格式无效。"); }
  const manifest = normalize(raw), referenced = new Set(["channel.json"]);
  let total = 0;
  for (const ep of manifest.episodes) {
    const bytes = files[ep.audio.path];
    if (!bytes || bytes.length !== ep.audio.bytes || await sha256(bytes) !== ep.audio.sha256) fail("分享包音频校验失败，未导入任何节目。");
    // The v1 format is PCM WAV, matching every existing native player and offline library.
    const wav = readWav(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    if (!wav || !wav.pcm.length || wav.rate < 8000 || wav.rate > 192000) fail("分享包的音频信息无效。");
    const duration = wav.pcm.length / wav.rate;
    if (Math.abs(duration - ep.duration_seconds) > Math.max(1, duration * .01)) fail("分享包的音频信息无效。");
    total += bytes.length; referenced.add(ep.audio.path);
  }
  if (Object.keys(files).some(name => !referenced.has(name)) || total > SHARE_LIMIT) fail("分享包含重复文件或不支持的路径。");
  const contentId = await sha256(strToU8(JSON.stringify(manifest)));
  return { manifest, files, contentId, bytes: buffer.byteLength };
}

// The curated catalog is a data-only file on one fixed, audited static origin.
export function parseCatalog(value, catalogURL = CATALOG_URL) {
  if (!object(value) || value.format !== "diyfm-catalog" || value.version !== 1 || !Array.isArray(value.channels) || value.channels.length > 500) fail("资源目录格式无效，请稍后刷新。");
  const base = new URL(catalogURL), seen = new Set();
  return value.channels.map(entry => {
    const c = channel(entry), a = attribution(entry.attribution);
    if (seen.has(c.id) || !hash(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 44 || entry.bytes > SHARE_LIMIT || !Number.isSafeInteger(entry.episodes) || entry.episodes < 1 || entry.episodes > 50) fail("资源目录格式无效，请稍后刷新。");
    seen.add(c.id);
    const url = new URL(entry.package, base);
    const prefix = new URL("./packages/", base).pathname;
    if (url.origin !== base.origin || !url.pathname.startsWith(prefix) || !/^[A-Za-z0-9_.-]+\.zip$/.test(url.pathname.slice(prefix.length)) || url.search || url.hash || url.username || url.password) fail("资源目录的下载地址无效。");
    return { ...c, attribution: a, url: url.href, sha256: entry.sha256, bytes: entry.bytes, episodes: entry.episodes };
  });
}
export async function readBounded(response, limit, signal) {
  if (!response.ok || response.type === "opaque") fail("资源下载失败，请检查网络后重试。");
  const length = Number(response.headers.get("Content-Length"));
  if (length > limit) fail("资源文件超过大小限制。");
  const reader = response.body?.getReader();
  if (!reader) fail("资源下载失败，请检查网络后重试。");
  const chunks = []; let size = 0;
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) fail("资源文件超过大小限制。");
      chunks.push(value);
    }
  } catch (e) { await reader.cancel().catch(() => {}); throw e; }
  finally { reader.releaseLock(); }
  const out = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out.buffer;
}
