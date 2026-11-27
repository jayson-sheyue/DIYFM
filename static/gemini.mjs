// Fixed Google origin. Credentials never appear in URLs, exported configuration or errors.
export const DEFAULT_MODELS = Object.freeze({
  llm_model: "gemini-3.8-flash",
  tts_model: "gemini-3.8-flash-tts",
  lyria_model: "lyria-3-clip-preview",
});
// Catalog suggestions, not an account-level availability guarantee (checked 2026-11-27).
export const MODEL_PRESETS = Object.freeze({
  llm_model: Object.freeze(["gemini-3.8-flash", "gemini-3.5-flash-lite"]),
  tts_model: Object.freeze([
    "gemini-3.8-flash-tts",
    "gemini-3.8-flash-lite-tts",
    "gemini-3.1-flash-tts-preview",
  ]),
  lyria_model: Object.freeze(["lyria-3-clip-preview", "lyria-3.5"]),
});
// Separate old generated clips from requests using the corrected transcript contract.
export const SPEECH_VERSION = "structured-tts-1";
const ORIGIN = "https://generativelanguage.googleapis.com/v1beta/";
export function modelId(value) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9._-]{1,119}$/.test(value))
    throw new Error("模型 ID 格式无效，请使用 AI Studio 支持的模型名称。");
  return value;
}
export function newVault() {
  let key = "",
    revision = 0;
  return Object.freeze({
    set(value) {
      if (
        typeof value !== "string" ||
        !/^[A-Za-z0-9._-]{20,4096}$/.test(value.trim())
      )
        throw new Error("Key 格式无效，请复制完整 Key，勿包含空格、换行或网址。");
      key = value.trim();
      revision++;
    },
    clear() {
      key = "";
      revision++;
    },
    has() {
      return !!key;
    },
    // A job captures this value in memory only; clearing/replacing does not change an in-flight job.
    snapshot(models) {
      if (!key)
        throw new Error("请先到设置填写自己的 Google AI Studio API Key。");
      return { key, revision, models: { ...models } };
    },
    revision() {
      return revision;
    },
  });
}
export async function googleRequest(
  snapshot,
  path,
  body,
  { fetcher = fetch, timeout = 240000, method = "POST", signal } = {},
) {
  if (
    !/^(?:models(?:\/[A-Za-z0-9._-]+(?::generateContent)?)?|interactions)$/.test(
      path,
    )
  )
    throw new Error("不允许的 Google API 地址。");
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeout);
  try {
    const r = await fetcher(ORIGIN + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": snapshot.key,
      },
      ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
    if (!r.ok) {
      const hints = {
        400: "模型不支持此请求，或输入格式不合要求。请检查模型能力。",
        401: "API Key 无效，请重新填写。",
        403: "请检查 Key 权限、地区、API 限制和计费设置。",
        404: "模型不存在或当前账户不可用，请检查设置。",
        429: "配额或速率受限，请稍后重试。",
      };
      throw new Error(
        `Google 请求失败（HTTP ${r.status}）。${hints[r.status] || "服务暂时不可用，请稍后重试。"}`,
      );
    }
    if (Number(r.headers?.get("Content-Length")) > 80 * 1024 * 1024)
      throw new Error("模型结果过大，请缩短节目时长。");
    return await r.json();
  } catch (e) {
    if (e.name === "AbortError")
      throw new Error(
        "Google 请求已超时或停止。已有台本和成片仍保留，可在消息中重试。",
      );
    if (e instanceof TypeError || e instanceof SyntaxError)
      throw new Error(
        "无法读取 Google 响应，请检查网络、浏览器限制或代理后重试。",
      );
    // Do not forward provider error bodies, request headers, or fetch exception messages.
    if (
      e.message?.startsWith("Google 请求失败") ||
      e.message?.startsWith("模型结果过大")
    )
      throw e;
    throw new Error("Google 请求未完成，请检查网络后重试。");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
export async function textResult(
  snapshot,
  prompt,
  { search = false, tokens = 8192, request = googleRequest } = {},
) {
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: tokens },
  };
  if (search) body.tools = [{ googleSearch: {} }];
  else body.generationConfig.responseMimeType = "application/json";
  const payload = await request(
    snapshot,
    `models/${modelId(snapshot.models.llm_model)}:generateContent`,
    body,
  );
  const c = payload.candidates?.[0];
  if (!c || (c.finishReason && c.finishReason !== "STOP"))
    throw new Error("模型没有返回完整内容，本期未进入配音。");
  const text = (c.content?.parts || [])
    .filter((p) => !p.thought)
    .map((p) => p.text || "")
    .join("");
  if (!text.trim()) throw new Error("模型没有返回可用内容，本期未进入配音。");
  const grounding = c.groundingMetadata || {};
  const sources = (grounding.groundingChunks || []).flatMap((chunk) => {
    try {
      const u = new URL(chunk.web?.uri);
      return u.protocol === "https:"
        ? [
            {
              title: String(chunk.web.title || "参考来源").slice(0, 240),
              url: u.href,
            },
          ]
        : [];
    } catch {
      return [];
    }
  });
  return {
    text,
    sources,
    grounding,
    model_version: payload.modelVersion || snapshot.models.llm_model,
    search_suggestions: grounding.searchEntryPoint?.renderedContent || "",
  };
}
export function audioParts(payload) {
  if (payload.status && payload.status !== "completed")
    throw new Error("模型没有返回可播放的音频，已保留台本。");
  const modern = (payload.steps || [])
    .filter((s) => s.type === "model_output")
    .flatMap((s) => s.content || [])
    .filter((p) => p.type === "audio" && p.data)
    .map((p) => ({
      data: p.data,
      mime: p.mime_type || "audio/L16;rate=24000",
    }));
  if (modern.length) return modern;
  const parts = (payload.candidates || [])
    .flatMap((c) => c.content?.parts || [])
    .filter((p) => p.inlineData?.data)
    .map((p) => ({
      data: p.inlineData.data,
      mime: p.inlineData.mimeType || "audio/L16;rate=24000",
    }));
  if (!parts.length) throw new Error("模型没有返回可播放的音频，已保留台本。");
  return parts;
}
const MALE_VOICES = new Set([
  "Puck",
  "Charon",
  "Fenrir",
  "Orus",
  "Enceladus",
  "Iapetus",
  "Umbriel",
  "Algieba",
  "Algenib",
  "Rasalgethi",
  "Alnilam",
  "Schedar",
  "Achird",
  "Zubenelgenubi",
  "Sadachbia",
  "Sadaltager",
]);
const FEMALE_VOICES = new Set([
  "Zephyr",
  "Kore",
  "Leda",
  "Aoede",
  "Callirrhoe",
  "Autonoe",
  "Despina",
  "Erinome",
  "Laomedeia",
  "Achernar",
  "Gacrux",
  "Pulcherrima",
  "Vindemiatrix",
  "Sulafat",
]);
function voiceRegisterAnchor(voiceName, speaker = "Host") {
  const role =
    speaker === "Guest" ? "responsive radio co-host" : "steady lead radio host";
  if (MALE_VOICES.has(voiceName))
    return `natural grounded male ${role} voice in normal chest register, do not raise pitch into falsetto`;
  if (FEMALE_VOICES.has(voiceName))
    return `natural clear female ${role} voice in steady normal register`;
  return `consistent ${role} voice in natural register`;
}
function legacySpeechBody(
  text,
  {
    host = "Kore",
    guest = "Puck",
    voice: selectedVoice = "",
    speaker = "Host",
    language = "en",
    direction = "",
    single = false,
  } = {},
) {
  const voice = (name) => ({ prebuiltVoiceConfig: { voiceName: name } }),
    chosen = selectedVoice || host,
    langName = language === "ja" ? "Japanese" : "English",
    langCode = language === "ja" ? "ja-JP" : "en-US",
    style = String(direction || "")
      .replace(/[:\r\n]+/g, ", ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 240),
    anchor = voiceRegisterAnchor(chosen, speaker),
    clean = String(text || "")
      .replace(/^\s*(?:Host|Guest)\s*[:：]\s*/i, "")
      .trim();
  return {
    contents: [
      {
        parts: [
          {
            text: single
              ? `Say the following in ${langName}, naturally and clearly at a steady conversational radio volume (${anchor}${style ? `; ${style}` : ""}): ${clean}`
              : `TTS the following conversation between Host and Guest in ${langName}, keeping the two voices clearly distinct on every turn${style ? ` (${style})` : ""}:\n${text}`,
          },
        ],
      },
    ],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: single
        ? { languageCode: langCode, voiceConfig: voice(chosen) }
        : {
            languageCode: langCode,
            multiSpeakerVoiceConfig: {
              speakerVoiceConfigs: [
                { speaker: "Host", voiceConfig: voice(host) },
                { speaker: "Guest", voiceConfig: voice(guest) },
              ],
            },
          },
    },
  };
}
const legacySpeechModel = (model) => /^gemini-(?:2\.5|3\.1)-.*tts/.test(model);
export function speechBody(text, options = {}) {
  const {
    model = DEFAULT_MODELS.tts_model,
    host = "Kore",
    guest = "Puck",
    voice = "",
    single = false,
    direction = "",
  } = options;
  if (legacySpeechModel(model)) return legacySpeechBody(text, options);
  const style = String(direction || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  const turn = (line, speaker) => ({
    type: "text",
    text: line,
    annotations: [{
      type: "speech_metadata",
      ...(speaker ? { speaker } : {}),
      ...(style ? { style } : {}),
    }],
  });
  let content;
  if (single) {
    const clean = String(text || "")
      .replace(/^\s*(?:Host|Guest)\s*[:：]\s*/i, "")
      .trim();
    if (!clean) throw new Error("台本缺少可配音的对白，已保留草稿。");
    content = [turn(clean)];
  } else {
    const turns = String(text || "").trim().split(/\n(?=\s*(?:Host|Guest)\s*[:：])/i);
    content = turns.map((line) => {
      const match = line.match(/^\s*(Host|Guest)\s*[:：]\s*([\s\S]+)$/i);
      if (!match || !match[2].trim()) throw new Error("台本缺少可配音的对白，已保留草稿。");
      return turn(match[2].trim(), /^host$/i.test(match[1]) ? "Host" : "Guest");
    });
  }
  return {
    model: modelId(model),
    input: [{ type: "user_input", content }],
    store: false,
    // Request PCM explicitly: unary 3.8 defaults to a WAV container.
    response_format: { type: "audio", mime_type: "audio/l16", sample_rate: 24000 },
    generation_config: {
      speech_config: single
        ? [{ voice: voice || host }]
        : { speakers: [{ speaker: "Host", voice: host }, { speaker: "Guest", voice: guest }] },
    },
  };
}
export async function speech(
  snapshot,
  text,
  options = {},
  request = googleRequest,
) {
  const model = modelId(snapshot.models.tts_model);
  return audioParts(
    await request(
      snapshot,
      legacySpeechModel(model) ? `models/${model}:generateContent` : "interactions",
      speechBody(text, { ...options, model }),
    ),
  );
}
export async function music(snapshot, prompt, request = googleRequest) {
  const payload = await request(snapshot, "interactions", {
    model: modelId(snapshot.models.lyria_model),
    input:
      prompt +
      " Instrumental only, no vocals, singing, speech or lyrics. Suitable as a quiet loop under spoken radio.",
    store: false,
  });
  const blocks = (payload.steps || [])
    .filter((s) => s.type === "model_output")
    .flatMap((s) => s.content || []);
  const block = blocks.filter((b) => b.type === "audio" && b.data).at(-1);
  if (!block) throw new Error("音乐模型没有返回音频，旧底乐仍保留。");
  return { data: block.data, mime: block.mime_type || "audio/mpeg" };
}
