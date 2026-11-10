import { i18n } from "./i18n.mjs?v=2.3.1";
import { Library } from "./library.mjs";
import { PRESETS } from "./presets.mjs";
import {
  DEFAULT_MODELS,
  newVault,
  modelId,
  googleRequest,
  speech,
  music,
} from "./gemini.mjs";
import { generate, speechBatches } from "./harness.mjs?v=2.1.0";
import {
  RATE,
  partsBlob,
  blobPCM,
  joinPCM,
  mixPCM,
  wavBlob,
  base64Bytes,
  encodeMP3,
} from "./audio.mjs?v=2.1.2";
import { zipSync, unzipSync, strToU8, strFromU8 } from "./vendor/fflate.mjs";
import { encodeChannel, decodeChannel, isChannelPackage, provenance, parseCatalog, readBounded, sha256, SHARE_LIMIT, CATALOG_URL } from "./sharing.mjs?v=2.3.1";
const uuid = () => crypto.randomUUID(),
  now = () => new Date().toISOString();
const error = (message, status = 400) =>
  Object.assign(new Error(message), { status });
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
const safeId = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,90}$/.test(value);
const showFields = [
  "title",
  "language",
  "difficulty",
  "wish",
  "length",
  "host_voice",
  "guest_voice",
  "music_style",
];
const snapshotShow = (show) =>
  Object.fromEntries(showFields.map((k) => [k, show[k]]));
export function cleanPreferences(input, current = {}) {
  const next = { ...current };
  const enums = {
    language: ["en", "ja"],
    difficulty: PRESETS.difficulties.map((x) => x.id),
    length: PRESETS.lengths.map((x) => x.id),
    host_voice: PRESETS.voices.map((x) => x.id),
    guest_voice: PRESETS.voices.map((x) => x.id),
    music_style: PRESETS.music.map((x) => x.id),
  };
  for (const k of showFields)
    if (Object.hasOwn(input, k)) {
      if (typeof input[k] !== "string") throw error("频道输入格式不正确。");
      if (enums[k] && !enums[k].includes(input[k]))
        throw error("未知的频道选项。");
      if (k === "wish" && input[k].length > 1200)
        throw error("收听愿望请控制在 1200 字以内。");
      next[k] =
        k === "title"
          ? input[k].trim().slice(0, 80) || current.title || "未命名频道"
          : input[k].trim();
    }
  if (next.host_voice === next.guest_voice)
    throw error("两位主持请选择不同声线。");
  return next;
}
export function createBrowserAPI({
  library = new Library(),
  fetcher = globalThis.fetch.bind(globalThis),
  request = googleRequest,
  editor = generate,
  synthesize = speech,
  makeMusic = music,
  mp3 = encodeMP3,
  locks = globalThis.navigator?.locks,
  legacy = false,
  catalogURL = CATALOG_URL,
} = {}) {
  const vault = newVault(),
    jobs = new Map(),
    musicJobs = new Map(),
    musicFlights = new Map(),
    previewFlights = new Map(),
    downloads = new Map(),
    urls = new Map();
  let account = "";
  const stagedImports = new Map();
  let catalogEntries = [];
  let importRevision = 0;
  const pageController = new AbortController();
  const cloud = (snap, path, body, options) =>
    request(snap, path, body, {
      ...options,
      fetcher,
      signal: pageController.signal,
    });
  const models = async () => ({
    ...DEFAULT_MODELS,
    ...(await library.get("models")),
  });
  const capture = async () => ({ ...vault.snapshot(await models()), account });
  async function setKey(value) {
    // Validate without changing the previous working credential.
    const trial = newVault();
    trial.set(value);
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(value.trim()),
    );
    const fingerprint = Array.from(new Uint8Array(digest))
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");
    vault.set(value);
    account = fingerprint;
    return settings();
  }
  async function settings() {
    return {
      settings: await models(),
      auth: "api_key",
      has_key: vault.has(),
      effective_project_id: account,
      auth_note: vault.has()
        ? "本页已启用你的 API Key。Key 仅在内存中，刷新或关闭页面后需要重新填写。"
        : "请填写自己的 Google AI Studio API Key。Key 只发往 Google，不进入本地存储、备份或公共仓库。",
      priority:
        "模型设置保存在当前浏览器；Key 不保存。不同访问者各自使用自己的 Key、额度和节目库。",
      effect: "下一次制作使用新设置；进行中的任务沿用开始时的配置。",
    };
  }
  async function list() {
    return ((await library.get("shows")) || []).sort((a, b) =>
      (b.updated_at || "").localeCompare(a.updated_at || ""),
    );
  }
  async function mutateShow(id, change) {
    return library.mutate("shows", (raw) => {
      const shows = raw || [],
        show = shows.find((s) => s.id === id);
      if (!show) throw error("频道不存在。", 404);
      const changed = change(show, shows) || {};
      return {
        result: changed.result ?? show,
        puts: [["shows", shows], ...(changed.puts || [])],
        deletes: changed.deletes || [],
      };
    });
  }
  async function patchEpisode(showId, id, patch) {
    return mutateShow(showId, (show) => {
      const ep = show.episodes.find((e) => e.id === id);
      if (!ep) throw error("节目不存在。", 404);
      Object.assign(ep, patch);
      show.updated_at = now();
    });
  }
  async function publicShow(show) {
    const episodes = [];
    for (const e of show.episodes || []) {
      const { script, turns, draft, research, ...ep } = e;
      ep.has_script = !!script;
      if (e.status === "ready") {
        if (!urls.has(e.id)) {
          const blob = await library.get("audio:" + e.id);
          if (blob) urls.set(e.id, URL.createObjectURL(blob));
        }
        ep.url = urls.get(e.id) || "";
      }
      episodes.push(ep);
    }
    return { ...show, episodes, materials: [] };
  }
  async function findEpisode(id) {
    for (const show of await list()) {
      const ep = show.episodes.find((e) => e.id === id);
      if (ep) return { show, ep };
    }
    throw error("节目不存在。", 404);
  }
  const withLock = (name, fn) =>
    locks?.request ? locks.request("diyfm:" + name, fn) : fn();
  async function reconcile() {
    const state = locks?.query ? await locks.query() : null;
    const active = new Set(
      [...(state?.held || []), ...(state?.pending || [])].map((x) => x.name),
    );
    const shows = await list();
    for (const show of shows)
      for (const ep of show.episodes || []) {
        if (ep.status !== "generating" || jobs.get(show.id) === ep.id) continue;
        const elapsed = Date.now() - Date.parse(ep.started_at || ep.created_at);
        if (
          (state && !active.has("diyfm:job:" + show.id) && elapsed > 5000) ||
          (!state && elapsed > 900000)
        )
          await patchEpisode(show.id, ep.id, {
            status: "failed",
            phase: "interrupted",
            title: "制作已中断",
            error:
              "页面已关闭或刷新，制作没有继续。台本与已完成阶段已保留，可填写 Key 后重试。",
          });
      }
  }
  async function getMusic(style, snap, force = false) {
    const preset = PRESETS.music.find((x) => x.id === style);
    if (!preset || style === "none") return null;
    const key = `music:${snap.models.lyria_model}:${style}`;
    if (!force) {
      const cached = await library.get(key);
      if (cached) return cached;
    }
    if (musicFlights.has(key)) return musicFlights.get(key);
    const job = (async () => {
      const part = await makeMusic(snap, preset.prompt, cloud),
        blob = new Blob([base64Bytes(part.data)], { type: part.mime });
      await blobPCM(blob);
      await library.write([[key, blob]]);
      return blob;
    })();
    musicFlights.set(key, job);
    try {
      return await job;
    } finally {
      musicFlights.delete(key);
    }
  }
  async function work(showId, id, show, snap, resume) {
    const phase = async (p) => patchEpisode(showId, id, { phase: p }),
      checkpoint = async (patch) => patchEpisode(showId, id, patch);
    try {
      let content =
        resume?.script && resume.review?.passed
          ? Object.fromEntries(
              [
                "title",
                "summary",
                "script",
                "turns",
                "plan",
                "expressions",
                "expression_forms",
                "interpretation",
                "research",
                "sources",
                "review",
                "harness_version",
              ].map((k) => [k, resume[k]]),
            )
          : await editor(
              show,
              snap,
              show.episode_wish,
              phase,
              checkpoint,
              resume || {},
              (s, p, o) =>
                import("./gemini.mjs").then((m) =>
                  m.textResult(s, p, { ...o, request: cloud }),
                ),
            );
      await checkpoint({
        ...content,
        config: { ...snap.models },
        language: show.language,
        difficulty: show.difficulty,
      });
      await phase("voice");
      const batches = speechBatches(content.turns),
        voice = [];
      const same =
        resume &&
        resume.config?.tts_model === snap.models.tts_model &&
        resume.input?.host_voice === show.host_voice &&
        resume.input?.guest_voice === show.guest_voice &&
        resume.script === content.script;
      for (let i = 0; i < batches.length; i++) {
        let blob = same ? await library.get(`voice:${resume.id}:${i}`) : null;
        if (!blob) {
          blob = await partsBlob(
            await synthesize(
              snap,
              batches[i],
              {
                host: show.host_voice,
                guest: show.guest_voice,
                language: show.language,
                direction: content.plan?.voice_direction || "",
              },
              cloud,
            ),
          );
          if ((await blobPCM(blob)).length < RATE * 0.2)
            throw error("有一段台词未能完整配音，已保留台本与已完成音频。");
        }
        await library.write([[`voice:${id}:${i}`, blob]]);
        voice.push(await blobPCM(blob));
      }
      const pcm = joinPCM(voice, Math.round(RATE * 0.08));
      let musicPCM = null,
        musicNote = "",
        musicSource = "none";
      if (show.music_style !== "none") {
        await phase("music");
        try {
          musicPCM = await blobPCM(await getMusic(show.music_style, snap));
          musicSource = "library";
        } catch {
          musicNote = "底乐未能生成，本期保留纯人声。可在声音设置重试底乐。";
          musicSource = "skipped";
        }
      }
      await phase("mix");
      const wav = wavBlob(mixPCM(pcm, musicPCM));
      await mutateShow(showId, (s) => {
        const ep = s.episodes.find((e) => e.id === id);
        if (!ep) throw error("节目已不存在。");
        Object.assign(ep, {
          status: "ready",
          phase: "ready",
          duration_seconds: pcm.length / RATE,
          bytes: wav.size,
          music_source: musicSource,
          music_note: musicNote,
          error: "",
          title: content.title,
        });
        s.updated_at = now();
        return { puts: [["audio:" + id, wav]] };
      });
    } catch (e) {
      await mutateShow(showId, (s) => {
        const ep = s.episodes.find((e) => e.id === id);
        if (!ep) return;
        ep.status = "failed";
        ep.error = e.message || "本期未完成，可重试。";
        if (ep.title === "本期正在制作") ep.title = "本期制作未完成";
      }).catch(() => {});
    } finally {
      jobs.delete(showId);
    }
  }
  async function startEpisode(showId, input) {
    const snap = await capture();
    let old, showSnapshot;
    const ep = await mutateShow(showId, (show) => {
      if (input.request_id && !/^[A-Za-z0-9_-]{8,90}$/.test(input.request_id))
        throw error("请求编号无效。");
      const existing =
        input.request_id &&
        show.episodes.find((e) => e.request_id === input.request_id);
      if (existing) return { result: { existing } };
      if (show.episodes.some((e) => e.status === "generating"))
        throw error("这个频道已有节目正在制作。", 409);
      if (jobs.size >= 2)
        throw error("本页最多同时制作两集，请稍后再试。", 409);
      if (
        input.revision !== undefined &&
        Number(input.revision) !== show.revision
      )
        throw error("频道偏好已在另一页更新，请重新载入后再制作。", 409);
      if (
        input.episode_wish !== undefined &&
        (typeof input.episode_wish !== "string" ||
          input.episode_wish.length > 600)
      )
        throw error("本期愿望请控制在 600 字以内。");
      if (input.retry_episode_id) {
        old = show.episodes.find(
          (e) => e.id === input.retry_episode_id && e.status === "failed",
        );
        if (!old) throw error("重试记录不存在。", 404);
      }
      const preferences = old?.input || snapshotShow(show);
      showSnapshot = {
        ...preferences,
        metadata_language: old?.input?.metadata_language || i18n.locale(),
        episode_wish: old?.input?.episode_wish || input.episode_wish || "",
        episodes: structuredClone(show.episodes),
      };
      const result = {
        id: "ep_" + uuid().replaceAll("-", ""),
        title: "本期正在制作",
        status: "generating",
        phase: "plan",
        created_at: now(),
        started_at: now(),
        request_id: input.request_id || uuid(),
        input: {
          ...snapshotShow(showSnapshot),
          metadata_language: showSnapshot.metadata_language,
          episode_wish: showSnapshot.episode_wish,
        },
        config: { ...snap.models },
        language: preferences.language,
        difficulty: preferences.difficulty,
        retry_of: old?.id || null,
      };
      show.episodes.unshift(result);
      show.updated_at = now();
      return { result };
    });
    if (ep.existing) return ep.existing;
    jobs.set(showId, ep.id);
    withLock("job:" + showId, () =>
      work(showId, ep.id, showSnapshot, snap, old),
    ).catch(async () => {
      jobs.delete(showId);
      await patchEpisode(showId, ep.id, {
        status: "failed",
        phase: "interrupted",
        error: "制作未完成，已有阶段保留。",
      }).catch(() => {});
    });
    return ep;
  }
  async function remove(showId, episodeId) {
    const all = await library.entries(),
      removed = [];
    await mutateShow(showId, (show, shows) => {
      if (show.episodes.some((e) => e.status === "generating"))
        throw error("这个频道还有节目正在制作，完成后可以删除。", 409);
      const episodes = episodeId
        ? show.episodes.filter((e) => e.id === episodeId)
        : show.episodes;
      if (episodeId && !episodes.length) throw error("这集节目不存在。", 404);
      if (episodes.some((e) => downloads.has(e.id)))
        throw error("音频正在准备下载，请等准备完成后再删除。", 409);
      removed.push(...episodes.map((e) => e.id));
      if (episodeId) {
        show.episodes = show.episodes.filter((e) => e.id !== episodeId);
        show.revision++;
        show.updated_at = now();
      } else shows.splice(shows.indexOf(show), 1);
      return {
        deletes: all
          .filter(([k]) =>
            removed.some(
              (id) =>
                k === `audio:${id}` ||
                k === `mp3:${id}` ||
                k === `mp3-meta:${id}` ||
                k.startsWith(`voice:${id}:`),
            ),
          )
          .map(([k]) => k),
      };
    });
    for (const id of removed) {
      if (urls.has(id)) URL.revokeObjectURL(urls.get(id));
      urls.delete(id);
    }
  }
  async function preview(input) {
    const snap = await capture();
    if (
      !PRESETS.voices.some((v) => v.id === input.voice) ||
      !["en", "ja"].includes(input.language)
    )
      throw error("声线或语言无效。");
    const key = `preview:${snap.account}:${snap.models.tts_model}:${input.language}:${input.voice}`;
    const old = await library.get(key);
    if (
      old &&
      !input.force &&
      Date.now() - Date.parse(old.created) < 7 * 86400000
    )
      return new Response(old.blob, {
        headers: { "X-DIYFM-Cache": "hit", "X-DIYFM-Cached-At": old.created },
      });
    if (!previewFlights.has(key))
      previewFlights.set(
        key,
        (async () => {
          const line =
            input.language === "ja"
              ? "こんにちは。今日は小さな出来事から、ゆっくり新しい言葉に出会いましょう。"
              : "Hello. Let us enjoy a little story, a small surprise, and a new way to see the day.";
          const blob = await partsBlob(
              await synthesize(
                snap,
                line,
                { single: true, host: input.voice, language: input.language },
                cloud,
              ),
            ),
            result = { blob, created: now() };
          await library.write([[key, result]]);
          return result;
        })(),
      );
    try {
      const result = await previewFlights.get(key);
      return new Response(result.blob, {
        headers: {
          "X-DIYFM-Cache": "generated",
          "X-DIYFM-Cached-At": result.created,
        },
      });
    } finally {
      previewFlights.delete(key);
    }
  }
  async function download(id) {
    let job = downloads.get(id);
    if (!job) {
      job = (async () => {
        await findEpisode(id);
        const wav = await library.get("audio:" + id);
        if (!wav) throw error("成片音频不存在。", 404);
        // MP3s are derivatives of the finished master, which already includes its BGM.
        // Never trust an imported/legacy cache or a cache from a different master.
        const digest = await crypto.subtle.digest(
          "SHA-256",
          await wav.arrayBuffer(),
        );
        const sourceHash = Array.from(new Uint8Array(digest), (b) =>
          b.toString(16).padStart(2, "0"),
        ).join("");
        const encoder = "lamejs-1.2.1-mono-24000-128-v1";
        const cached = await library.get("mp3-meta:" + id);
        let blob = await library.get("mp3:" + id);
        if (
          !blob ||
          cached?.source_hash !== sourceHash ||
          cached?.encoder !== encoder
        ) {
          blob = await mp3(await blobPCM(wav));
          await library.write([
            ["mp3:" + id, blob],
            ["mp3-meta:" + id, { source_hash: sourceHash, encoder }],
          ]);
        }
        return blob;
      })();
      downloads.set(id, job);
    }
    try {
      // Each caller owns its Response body, while concurrent requests share the encoding work.
      return new Response(await job, {
        headers: { "Content-Type": "audio/mpeg" },
      });
    } finally {
      if (downloads.get(id) === job) downloads.delete(id);
    }
  }
  async function backup() {
    const shows = await list(),
      files = {
        "shows.json": strToU8(JSON.stringify({ shows }, null, 2)),
        "settings.json": strToU8(JSON.stringify(await models())),
      };
    let total = 0;
    for (const [key, value] of await library.entries()) {
      if (!(value instanceof Blob)) continue;
      let name;
      if (key.startsWith("audio:")) name = "audio/" + key.slice(6) + ".wav";
      else if (key.startsWith("mp3:")) name = "audio/" + key.slice(4) + ".mp3";
      else if (key.startsWith("music:"))
        name = "bgm/" + key.slice(6).replaceAll(":", "_") + ".audio";
      else if (key.startsWith("voice:"))
        name = "progress/" + key.slice(6).replaceAll(":", "_") + ".wav";
      else continue;
      total += value.size;
      if (total > 500 * 1024 * 1024)
        throw error("备份超过 500MB，请分批下载成片或移除不再需要的节目。");
      files[name] = new Uint8Array(await value.arrayBuffer());
    }
    return new Response(zipSync(files, { level: 0 }), {
      headers: { "Content-Type": "application/zip" },
    });
  }
  async function decodeBackup(buffer) {
    if (buffer.byteLength > 500 * 1024 * 1024)
      throw error("备份不能超过 500MB。");
    let total = 0;
    const files = unzipSync(new Uint8Array(buffer), {
      filter: (entry) => {
        total += entry.originalSize;
        if (total > 500 * 1024 * 1024) throw error("解压后的备份过大。");
        return /^(?:shows\.json|settings\.json|audio\/[A-Za-z0-9_-]+\.(?:wav|mp3)|progress\/[A-Za-z0-9_-]+\.wav|bgm\/[A-Za-z0-9_.-]+\.audio)$/.test(
          entry.name,
        );
      },
    });
    if (!files["shows.json"]) throw error("备份中缺少节目清单。");
    let data;
    try { data = JSON.parse(strFromU8(files["shows.json"])); }
    catch { throw error("备份无法读取，已有频道仍保留。"); }
    if (!Array.isArray(data.shows) || data.shows.length > 1000)
      throw error("节目清单格式无效。");
    const imports = [],
      puts = [];
    let count = 0;
    for (const s of data.shows) {
      const show = cleanPreferences(s, {
        title: "导入的频道",
        language: "en",
        difficulty: "basic",
        wish: "",
        length: "SHORT",
        host_voice: "Kore",
        guest_voice: "Puck",
        music_style: "none",
      });
      show.id = "show_" + uuid().replaceAll("-", "");
      show.revision = 0;
      show.created_at = show.updated_at = now();
      show.episodes = [];
      show.materials = [];
      if (s.provenance) show.provenance = provenance(s.provenance);
      if (typeof s.description === "string") show.description = s.description.slice(0, 1200);
      for (const old of (s.episodes || []).slice(0, 1000)) {
        if (!safeId(old.id)) throw error("备份含无效的节目编号。");
        const id = "ep_" + uuid().replaceAll("-", ""),
          ep = cleanImportedEpisode(old, id, show);
        const wav = files[`audio/${old.id}.wav`];
        if (old.status === "ready" && !wav)
          throw error("备份缺少成片音频，未导入任何频道。");
        if (wav) {
          await blobPCM(new Blob([wav], { type: "audio/wav" }));
          puts.push(["audio:" + id, new Blob([wav], { type: "audio/wav" })]);
        }
        const mp3data = files[`audio/${old.id}.mp3`];
        if (mp3data)
          puts.push(["mp3:" + id, new Blob([mp3data], { type: "audio/mpeg" })]);
        show.episodes.push(ep);
        count++;
      }
      imports.push(show);
    }
    return { imports, puts, count };
  }
  async function importBackup(buffer) {
    const { imports, puts, count } = await decodeBackup(buffer);
    await library.mutate("shows", (old) => ({
      puts: [["shows", [...imports, ...(old || [])]], ...puts],
    }));
    return { channels: imports.length, episodes: count };
  }
  async function prepareImport(buffer) {
    const token = uuid(), revision = ++importRevision;
    stagedImports.clear();
    await ready;
    let stage, preview;
    if (isChannelPackage(buffer)) {
      const decoded = await decodeChannel(buffer), { manifest, contentId } = decoded;
      const origin = { ...manifest.attribution, channel_id: manifest.channel.id, content_id: contentId };
      const show = {
        id: "show_" + uuid().replaceAll("-", ""), title: manifest.channel.title,
        language: manifest.channel.language, difficulty: manifest.channel.difficulty,
        wish: "", length: "SHORT", host_voice: "Kore", guest_voice: "Puck", music_style: "none",
        revision: 0, created_at: now(), updated_at: now(), materials: [], provenance: origin,
        description: manifest.channel.description, episodes: [],
      };
      const puts = [];
      for (const item of manifest.episodes) {
        const id = "ep_" + uuid().replaceAll("-", ""), ep = cleanImportedEpisode({ ...item, status: "ready" }, id, show);
        ep.provenance = item.origin || manifest.channel.origin || origin;
        show.episodes.push(ep);
        puts.push(["audio:" + id, new Blob([decoded.files[item.audio.path]], { type: "audio/wav" })]);
      }
      const existing = (await list()).find(s => s.provenance?.content_id === contentId);
      const prior = (await list()).some(s => s.provenance?.channel_id === manifest.channel.id);
      stage = { imports: [show], puts, count: show.episodes.length, contentId };
      preview = { kind: "channel", token, bytes: buffer.byteLength, channels: [{ id: manifest.channel.id, title: show.title, language: show.language, difficulty: show.difficulty, description: show.description, attribution: manifest.attribution, origin: manifest.channel.origin, episodes: manifest.episodes.map(e => ({ title: e.title, duration_seconds: e.duration_seconds, summary: e.summary, script: e.script, origin: e.origin })) }], duplicate: !!existing, separateVersion: prior && !existing };
    } else {
      stage = await decodeBackup(buffer);
      preview = { kind: "backup", token, bytes: buffer.byteLength, duplicate: false, channels: stage.imports.map(s => ({ title: s.title, language: s.language, difficulty: s.difficulty, attribution: s.provenance, episodes: s.episodes.map(e => ({ title: e.title, duration_seconds: e.duration_seconds, script: e.script, status: e.status })) })) };
    }
    if (revision !== importRevision) throw new DOMException("Cancelled", "AbortError");
    stagedImports.set(token, stage);
    return preview;
  }
  async function commitImport(token) {
    const stage = stagedImports.get(token);
    if (!stage) throw error("导入预览已关闭，请重新选择文件。");
    if (!stage.commit) stage.commit = library.mutate("shows", raw => {
      if (stagedImports.get(token) !== stage) throw error("导入预览已关闭，请重新选择文件。");
      const old = raw || [], existing = stage.contentId && old.find(s => s.provenance?.content_id === stage.contentId);
      if (existing) return { result: { channels: 0, episodes: 0, duplicate: true, showId: existing.id } };
      return { puts: [["shows", [...stage.imports, ...old]], ...stage.puts], result: { channels: stage.imports.length, episodes: stage.count, showId: stage.imports[0]?.id, duplicate: false } };
    }).catch(e => { stage.commit = null; throw e; });
    return stage.commit;
  }
  async function exportChannel(id, options) {
    await ready;
    const show = (await list()).find(s => s.id === id);
    if (!show) throw error("频道不存在。", 404);
    return encodeChannel(show, options, id => library.get("audio:" + id));
  }
  async function catalog() {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetcher(catalogURL, { signal: controller.signal, credentials: "omit", referrerPolicy: "no-referrer", redirect: "error", cache: "no-store" });
      const bytes = await readBounded(response, 1024 * 1024, controller.signal);
      const entries = parseCatalog(JSON.parse(new TextDecoder().decode(bytes)), catalogURL);
      catalogEntries = entries;
      return entries;
    } catch (e) {
      throw error(e.name === "AbortError" ? "目录连接超时，请稍后刷新。" : "无法刷新资源目录。已保存的节目仍可离线收听。");
    } finally { clearTimeout(timer); }
  }
  async function prepareCatalog(id, signal) {
    const entry = catalogEntries.find(e => e.id === id);
    if (!entry) throw error("请先刷新资源目录。");
    const response = await fetcher(entry.url, { signal, credentials: "omit", referrerPolicy: "no-referrer", redirect: "error", cache: "no-store" });
    const bytes = await readBounded(response, SHARE_LIMIT, signal);
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    if (bytes.byteLength !== entry.bytes || await sha256(bytes) !== entry.sha256) throw error("目录文件校验失败，未导入任何节目。");
    const preview = await prepareImport(bytes), c = preview.channels[0];
    if (preview.kind !== "channel" || c.id !== entry.id || c.title !== entry.title || c.language !== entry.language || c.difficulty !== entry.difficulty || c.description !== entry.description || c.episodes.length !== entry.episodes || JSON.stringify(c.attribution) !== JSON.stringify(entry.attribution)) {
      stagedImports.delete(preview.token); throw error("目录资料与分享包不一致，未导入任何节目。");
    }
    if (signal?.aborted) { stagedImports.delete(preview.token); throw new DOMException("Cancelled", "AbortError"); }
    return preview;
  }
  async function migrateLocal() {
    if (!legacy || (await library.get("legacy-copied"))) return;
    const r = await fetcher("/api/shows", { cache: "no-store" });
    if (!r.ok) return;
    const data = await r.json();
    if (!Array.isArray(data.shows)) return;
    const existing = new Set((await list()).map((s) => s.id)),
      imports = [],
      puts = [];
    for (const source of data.shows) {
      if (existing.has(source.id) || !safeId(source.id)) continue;
      const show = {
        ...cleanPreferences(source, {
          title: "历史频道",
          language: "en",
          difficulty: "basic",
          length: "SHORT",
          host_voice: "Kore",
          guest_voice: "Puck",
          music_style: "none",
          wish: "",
        }),
        id: source.id,
        revision: source.revision || 0,
        created_at: source.created_at || now(),
        updated_at: source.updated_at || now(),
        episodes: [],
        materials: [],
      };
      for (const old of source.episodes || []) {
        if (!safeId(old.id)) continue;
        const ep = cleanImportedEpisode(old, old.id, show);
        if (old.has_script) {
          const result = await fetcher(`/api/episodes/${old.id}/transcript`);
          if (result.ok) {
            const transcript = await result.json();
            ep.script =
              typeof transcript.script === "string" ? transcript.script : "";
            ep.sources = transcript.sources || [];
          }
        }
        if (old.status === "ready") {
          const audio = await fetcher(`/api/episodes/${old.id}/audio`);
          if (!audio.ok)
            throw error(
              "旧版本机音频读取失败，原节目仍在 data 中，可稍后重试迁移。",
            );
          puts.push(["audio:" + old.id, await audio.blob()]);
        }
        show.episodes.push(ep);
      }
      imports.push(show);
    }
    await library.mutate("shows", (old) => ({
      puts: [
        ["shows", [...imports, ...(old || [])]],
        ["legacy-copied", true],
        ...puts,
      ],
    }));
  }
  function cleanImportedEpisode(old, id, show) {
    const text = (v, n = 2000) => (typeof v === "string" ? v.slice(0, n) : "");
    const script = text(old.script, 100000),
      turns = script
        .split("\n")
        .map((line) => line.match(/^(Host|Guest):\s*(.+)$/))
        .filter(Boolean)
        .map((m) => ({ speaker: m[1], text: m[2] }));
    return {
      id,
      title: text(old.title, 80) || "导入的来信",
      summary: text(old.summary, 600),
      interpretation: text(old.interpretation, 1200),
      created_at: text(old.created_at, 40) || now(),
      status: old.status === "ready" ? "ready" : "failed",
      phase: old.status === "ready" ? "ready" : "interrupted",
      script,
      turns,
      expressions: Array.isArray(old.expressions)
        ? old.expressions.slice(0, 8).map((e) => text(e, 160))
        : [],
      sources: Array.isArray(old.sources)
        ? old.sources
            .filter(
              (s) =>
                s && typeof s.url === "string" && s.url.startsWith("https://"),
            )
            .map((s) => ({
              title: text(s.title, 240),
              url: s.url.slice(0, 4000),
            }))
        : [],
      input: {
        ...snapshotShow(show),
        ...(["en", "ja", "zh-CN"].includes(old.input?.metadata_language)
          ? { metadata_language: old.input.metadata_language }
          : {}),
      },
      language: show.language,
      difficulty: show.difficulty,
      duration_seconds: Number(old.duration_seconds) || 0,
      error:
        old.status === "ready"
          ? ""
          : "导入了未完成记录。原台本如有保留，可重新制作。",
      music_source: text(old.music_source, 30),
      ...(old.provenance ? { provenance: provenance(old.provenance) } : {}),
    };
  }
  const ready = (async () => {
    await library.ready;
    await migrateLocal();
    await reconcile();
  })();
  async function dispatch(path, config = {}) {
    await ready;
    const method = config.method || "GET",
      input = config.body ? JSON.parse(config.body) : {};
    if (path === "/api/presets") return json(PRESETS);
    if (path === "/api/settings") {
      if (method === "PUT") {
        const current = await models();
        for (const key of Object.keys(DEFAULT_MODELS))
          if (Object.hasOwn(input, key)) current[key] = modelId(input[key]);
        await library.write([["models", current]]);
      }
      return json(await settings());
    }
    if (path === "/api/settings/restore") {
      await library.write([["models", { ...DEFAULT_MODELS }]]);
      return json(await settings());
    }
    if (path === "/api/backup") return backup();
    if (path === "/api/voices/preview") return preview(input);
    if (path === "/api/voices/cache/clear") {
      const keys = (await library.entries())
        .filter(([k]) => k.startsWith("preview:"))
        .map(([k]) => k);
      await library.write([], keys);
      return json({ message: "已清理本浏览器的声线试听缓存，成片仍保留。" });
    }
    if (path === "/api/bgm/jobs")
      return json({ jobs: Object.fromEntries(musicJobs) });
    let match;
    if ((match = path.match(/^\/api\/bgm\/([A-Za-z0-9_-]+)\/regenerate$/))) {
      const snap = await capture(),
        style = match[1];
      if (!PRESETS.music.some((p) => p.id === style) || style === "none")
        throw error("请先选择一种底乐风格。");
      musicJobs.set(style, { status: "running" });
      getMusic(style, snap, true).then(
        () => musicJobs.set(style, { status: "ready" }),
        (e) => musicJobs.set(style, { status: "failed", error: e.message }),
      );
      return json({ ok: true });
    }
    if ((match = path.match(/^\/media\/bgm\/([A-Za-z0-9_-]+)\.wav$/))) {
      const blob = await library.get(
        `music:${(await models()).lyria_model}:${match[1]}`,
      );
      if (!blob) throw error("这个浏览器还没有这条底乐，请先生成。", 404);
      return new Response(blob);
    }
    if ((match = path.match(/^\/api\/episodes\/([A-Za-z0-9_-]+)\/download$/)))
      return download(match[1]);
    if (
      (match = path.match(/^\/api\/episodes\/([A-Za-z0-9_-]+)\/transcript$/))
    ) {
      const { ep } = await findEpisode(match[1]);
      return json(ep);
    }
    if (path === "/api/shows") {
      if (method === "POST") {
        const id = "show_" + uuid().replaceAll("-", "");
        const show = cleanPreferences(input, {
          title: i18n.t(
            input.language === "ja" ? "日语来信电台" : "英语来信电台",
          ),
          language: "en",
          difficulty: "basic",
          wish: "",
          length: "SHORT",
          host_voice: "Kore",
          guest_voice: "Puck",
          music_style: "morning_acoustic",
        });
        Object.assign(show, {
          id,
          revision: 0,
          created_at: now(),
          updated_at: now(),
          episodes: [],
          materials: [],
        });
        await library.mutate("shows", (old) => ({
          puts: [["shows", [show, ...(old || [])]]],
        }));
        return json({ show: await publicShow(show) });
      }
      await reconcile();
      return json({ shows: await Promise.all((await list()).map(publicShow)) });
    }
    if (
      (match = path.match(
        /^\/api\/shows\/([A-Za-z0-9_-]+)\/episodes(?:\/([A-Za-z0-9_-]+))?$/,
      ))
    ) {
      const id = match[1];
      if (method === "DELETE") await remove(id, match[2]);
      else if (method === "POST") await startEpisode(id, input);
      else throw error("不支持的操作。");
      const show = (await list()).find((s) => s.id === id);
      return json({
        show: await publicShow(show),
        episode:
          show.episodes.find((e) => e.request_id === input.request_id) ||
          show.episodes[0],
      });
    }
    if ((match = path.match(/^\/api\/shows\/([A-Za-z0-9_-]+)$/))) {
      const id = match[1];
      if (method === "DELETE") {
        await remove(id);
        return json({ ok: true });
      }
      if (method === "PATCH") {
        let conflict;
        const show = await mutateShow(id, (s) => {
          if (
            input.revision !== undefined &&
            Number(input.revision) !== s.revision
          ) {
            conflict = structuredClone(s);
            return;
          }
          Object.assign(s, cleanPreferences(input, s));
          s.revision++;
          s.updated_at = now();
        });
        if (conflict)
          return json(
            {
              message: "这个频道刚刚在另一页保存过，当前输入仍保留。",
              show: await publicShow(conflict),
            },
            409,
          );
        return json({ show: await publicShow(show) });
      }
    }
    throw error("当前版本不支持这个操作。", 404);
  }
  return Object.freeze({
    fetch: async (path, config) => {
      try {
        return await dispatch(path, config);
      } catch (e) {
        return json(
          { message: e.message || "操作未完成，请重试。" },
          e.status || 400,
        );
      }
    },
    setKey,
    clearKey: () => {
      vault.clear();
      account = "";
      return settings();
    },
    hasKey: () => vault.has(),
    testKey: async () => {
      const snap = await capture();
      await cloud(snap, `models/${modelId(snap.models.llm_model)}`, null, {
        method: "GET",
        timeout: 15000,
      });
      return "Key 可以访问所选文本模型；未运行生成请求，语音和底乐能力需分别使用时确认。";
    },
    importBackup,
    prepareImport,
    commitImport,
    discardImport: token => {
      if (token) stagedImports.delete(token);
      else { importRevision++; stagedImports.clear(); }
    },
    exportChannel,
    catalog,
    prepareCatalog,
    isBusy: () =>
      jobs.size > 0 ||
      [...musicJobs.values()].some((j) => j.status === "running"),
    ready,
    dispose: () => {
      pageController.abort();
      vault.clear();
      account = "";
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
      stagedImports.clear();
      importRevision++;
    },
  });
}
