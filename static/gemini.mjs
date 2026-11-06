// Fixed Google origin. Credentials never appear in URLs, exported configuration or errors.
export const DEFAULT_MODELS = Object.freeze({
  llm_model: "gemini-3.8-flash",
  tts_model: "gemini-3.1-flash-tts-preview",
  lyria_model: "lyria-3-clip-preview",
});
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
export function speechBody(
  text,
  {
    host = "Kore",
    guest = "Puck",
    language = "en",
    direction = "",
    single = false,
  } = {},
) {
  const voice = (name) => ({ prebuiltVoiceConfig: { voiceName: name } });
  return {
    contents: [
      {
        parts: [
          {
            text: `Read naturally and clearly in ${language === "ja" ? "Japanese" : "English"}. ${direction.slice(0, 600)}\n${text}`,
          },
        ],
      },
    ],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: single
        ? { voiceConfig: voice(host) }
        : {
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
export async function speech(
  snapshot,
  text,
  options = {},
  request = googleRequest,
) {
  return audioParts(
    await request(
      snapshot,
      `models/${modelId(snapshot.models.tts_model)}:generateContent`,
      speechBody(text, options),
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
