import test from "node:test";
import assert from "node:assert/strict";
import { indexedDB } from "fake-indexeddb";
import { Library } from "../static/library.mjs";
import { createBrowserAPI } from "../static/browser-api.mjs";
import {
  newVault,
  googleRequest,
  textResult,
  speechBody,
  speech,
  audioParts,
  MODEL_PRESETS,
  SPEECH_VERSION,
  music,
  DEFAULT_MODELS,
} from "../static/gemini.mjs";
import {
  wavBlob,
  readWav,
  partsBlob,
  trimSilencePCM,
  normalizeTurnPCM,
  RATE,
} from "../static/audio.mjs?v=2.6.0";
import { generate, validateEpisode, speechTurns } from "../static/harness.mjs?v=2.6.0";
import {
  zipSync,
  strToU8,
  unzipSync,
  strFromU8,
} from "../static/vendor/fflate.mjs";
const KEY = "unit-test-only-key-" + "a".repeat(30);
const jsonRequest = (method, body) => ({ method, body: JSON.stringify(body) });
const makeLibrary = () =>
  new Library({ indexedDB, name: "test-" + crypto.randomUUID() });
async function call(api, path, method = "GET", body) {
  const r = await api.fetch(
    path,
    body ? jsonRequest(method, body) : { method },
  );
  return { status: r.status, data: await r.json() };
}
const audioPart = {
  mime: "audio/L16;rate=24000",
  data: Buffer.alloc(24000).toString("base64"),
};
const content = {
  title: "测试来信",
  summary: "一封独立来信",
  script: "Host: Hello.\nGuest: Welcome.",
  turns: [
    { speaker: "Host", text: "Hello." },
    { speaker: "Guest", text: "Welcome." },
  ],
  plan: { voice_direction: "Warm." },
  review: { passed: true, issues: [] },
  expressions: ["hello", "welcome"],
  research: { text: "Fiction.", sources: [] },
  sources: [],
};
async function fixture(overrides = {}) {
  const { show: showPrefs, ...apiOverrides } = overrides;
  const library = makeLibrary();
  const api = createBrowserAPI({
    library,
    editor: async () => structuredClone(content),
    synthesize: async () => [audioPart],
    makeMusic: async () => ({
      mime: "audio/wav",
      data: Buffer.from(
        await wavBlob(new Float32Array(2400)).arrayBuffer(),
      ).toString("base64"),
    }),
    ...apiOverrides,
  });
  await api.ready;
  await api.setKey(KEY);
  const show = (
    await call(api, "/api/shows", "POST", {
      title: "室友趣事电台",
      theme_id: "custom",
      description: "两位主持聊合租生活里的小意外",
      wish: "室友趣事，轻松好笑一点",
      music_style: "none",
      ...showPrefs,
    })
  ).data.show;
  return { library, api, show };
}
const episodeBody = (extra = {}) => ({
  request_id: "episode_" + Math.random().toString(36).slice(2, 10),
  episode_wish: "这一集讲合租里的一件小事",
  revision: 0,
  ...extra,
});
async function finished(api, id) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const shows = (await call(api, "/api/shows")).data.shows;
    const show = shows.find((s) => s.id === id),
      ep = show?.episodes[0];
    if (ep && ep.status !== "generating") return { show, ep };
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("Controlled job did not complete");
}
test("key vault validates before replacement and never exposes a public key getter", () => {
  const vault = newVault();
  vault.set(KEY);
  assert.throws(() => vault.set("invalid"));
  assert.equal(vault.snapshot(DEFAULT_MODELS).key, KEY);
  assert.equal(vault.key, undefined);
  vault.clear();
  assert.equal(vault.has(), false);
  assert.throws(() => vault.snapshot(DEFAULT_MODELS));
});
test("authorization keys with dots are accepted unchanged without inferring a Vertex endpoint", async () => {
  const key = "AQ." + "synthetic-not-a-real-key_".repeat(15);
  const vault = newVault();
  vault.set("  " + key + "  ");
  for (const invalid of [
    key + "\r\nInjected: header",
    "https://example.com/" + key,
    "x".repeat(4097),
  ]) {
    assert.throws(() => vault.set(invalid));
    assert.equal(vault.snapshot(DEFAULT_MODELS).key, key);
  }
  let seen;
  await googleRequest(
    vault.snapshot(DEFAULT_MODELS),
    "models/gemini-3.8-flash",
    undefined,
    {
      method: "GET",
      fetcher: async (url, config) => {
        seen = { url, config };
        return new Response("{}");
      },
    },
  );
  assert.equal(seen.config.headers["x-goog-api-key"], key);
  assert.equal(new URL(seen.url).hostname, "generativelanguage.googleapis.com");
  assert.ok(!seen.url.includes(key));
  vault.clear();
  assert.equal(vault.has(), false);
});
test("Google key is only in the header, fixed-origin URL and error text never disclose it", async () => {
  let seen;
  const snapshot = { key: KEY, models: DEFAULT_MODELS };
  await assert.rejects(
    () =>
      googleRequest(
        snapshot,
        "models/gemini-3.8-flash:generateContent",
        {},
        {
          fetcher: async (url, config) => {
            seen = { url, config };
            return new Response(JSON.stringify({ error: KEY }), {
              status: 429,
            });
          },
        },
      ),
    (e) => /429/.test(e.message) && !e.message.includes(KEY),
  );
  assert.equal(seen.config.headers["x-goog-api-key"], KEY);
  assert.equal(seen.config.credentials, "omit");
  assert.equal(seen.config.redirect, "error");
  assert.ok(!seen.url.includes(KEY));
  await assert.rejects(
    () =>
      googleRequest(
        snapshot,
        "https://evil.example/steal",
        {},
        {
          fetcher: () => {
            throw Error("must not call");
          },
        },
      ),
    /不允许/,
  );
  await assert.rejects(
    () =>
      googleRequest(
        snapshot,
        "models/gemini-3.8-flash:generateContent",
        {},
        {
          fetcher: async () => {
            throw new TypeError(KEY);
          },
        },
      ),
    (e) => !e.message.includes(KEY),
  );
});
test("search parses only actual grounding sources and speech uses exactly the selected two voices", async () => {
  const payload = {
    candidates: [
      {
        finishReason: "STOP",
        content: {
          parts: [{ text: "answer" }, { thought: true, text: "hidden" }],
        },
        groundingMetadata: {
          groundingChunks: [
            { web: { uri: "https://example.org", title: "Official" } },
            { web: { uri: "javascript:alert(1)" } },
          ],
        },
      },
    ],
  };
  const result = await textResult(
    { key: KEY, models: DEFAULT_MODELS },
    "prompt",
    {
      search: true,
      request: async (_s, _p, body) => {
        assert.deepEqual(body.tools, [{ googleSearch: {} }]);
        return payload;
      },
    },
  );
  assert.equal(result.text, "answer");
  assert.equal(result.sources.length, 1);
  const body = speechBody("Host: Hi\nGuest: Hello", {
    host: "Zephyr",
    guest: "Charon",
  });
  assert.deepEqual(
    body.generation_config.speech_config.speakers.map((v) => v.voice),
    ["Zephyr", "Charon"],
  );
});
test("music uses Developer API interactions with storage disabled and extracts only audio output", async () => {
  const part = await music(
    { key: KEY, models: DEFAULT_MODELS },
    "Soft piano",
    async (_s, path, body) => {
      assert.equal(path, "interactions");
      assert.equal(body.store, false);
      assert.equal(body.model, "lyria-3-clip-preview");
      return {
        steps: [
          {
            type: "model_output",
            content: [
              { type: "text", text: "Description" },
              { type: "audio", mime_type: "audio/mpeg", data: "abc" },
            ],
          },
        ],
      };
    },
  );
  assert.equal(part.data, "abc");
});
test("modern speech keeps English and Japanese transcripts verbatim and directions outside speech text", async () => {
  for (const model of ["gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts", "custom-future-tts"]) {
    for (const [language, text] of [["en", 'A letter says: "Take your time."'], ["ja", "雨の音を聞きながら、ゆっくり休みましょう。"]]) {
      const options = { single: true, voice: "Puck", speaker: "Guest", language, direction: "Quiet, sleepy and slow." };
      const result = await speech({ models: { tts_model: model } }, "Guest: " + text, options, async (_snap, path, body) => {
        assert.equal(path, "interactions");
        assert.equal(body.model, model, "custom model must not be silently substituted");
        assert.equal(body.store, false);
        assert.deepEqual(body.response_format, { type: "audio", mime_type: "audio/l16", sample_rate: 24000 });
        assert.deepEqual(body.generation_config.speech_config, [{ voice: "Puck" }]);
        assert.deepEqual(body.input[0].content, [{ type: "text", text, annotations: [{ type: "speech_metadata", style: options.direction }] }]);
        return { status: "completed", steps: [
          { type: "user_input", content: [{ type: "audio", data: "do-not-use" }] },
          { type: "model_output", content: [{ type: "text", text: "description" }, { type: "audio", mime_type: audioPart.mime, data: audioPart.data }] },
        ] };
      });
      assert.deepEqual(result, [audioPart]);
      const wav = readWav(await (await partsBlob(result)).arrayBuffer());
      assert.equal(wav.rate, RATE);
      assert.equal(wav.pcm.length, 12000);
    }
  }
  const dual = speechBody("Host: Hello.\nA second line.\nGuest: Goodnight.", { direction: "Soft." });
  assert.deepEqual(dual.input[0].content.map(p => [p.text, p.annotations[0].speaker]), [["Hello.\nA second line.", "Host"], ["Goodnight.", "Guest"]]);
  assert.equal(speechBody("Hello.", { single: true }).input[0].content[0].annotations[0].style, undefined);
  assert.throws(() => speechBody("Host:", {}), /台本/);
  assert.throws(() => audioParts({ status: "failed", steps: [{ type: "model_output", content: [{ type: "audio", data: "partial" }] }] }), /"status": "failed"/);
  assert.throws(() => audioParts({ status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: "unsupported" }] }] }), /unsupported/);
});
test("legacy preview models keep their original generateContent protocol", async () => {
  for (const model of ["gemini-3.1-flash-tts-preview", "gemini-2.5-flash-preview-tts"]) {
    const result = await speech({ models: { tts_model: model } }, "Guest: Goodnight.", { single: true, voice: "Puck", speaker: "Guest" }, async (_snap, path, body) => {
      assert.equal(path, `models/${model}:generateContent`);
      assert.match(body.contents[0].parts[0].text, /^Say the following/);
      assert.match(body.contents[0].parts[0].text, /natural grounded male/);
      assert.equal(body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, "Puck");
      return { candidates: [{ content: { parts: [{ inlineData: { mimeType: audioPart.mime, data: audioPart.data } }] } }] };
    });
    assert.deepEqual(result, [audioPart]);
  }
});
test("model presets accompany editable settings; custom values survive reload and restore is explicit", async () => {
  const library = makeLibrary();
  const api = createBrowserAPI({ library });
  await api.ready;
  assert.deepEqual((await call(api, "/api/settings")).data.model_presets, MODEL_PRESETS);
  const custom = { llm_model: "custom-writer", tts_model: "custom-speaker", lyria_model: "custom-music" };
  assert.equal((await call(api, "/api/settings", "PUT", custom)).status, 200);
  const reloaded = createBrowserAPI({ library });
  await reloaded.ready;
  assert.deepEqual((await call(reloaded, "/api/settings")).data.settings, custom);
  assert.equal((await call(reloaded, "/api/settings", "PUT", { tts_model: "bad model!" })).status, 400);
  assert.deepEqual((await call(reloaded, "/api/settings")).data.settings, custom);
  assert.deepEqual((await call(reloaded, "/api/settings/restore", "POST")).data.settings, DEFAULT_MODELS);
  assert.equal(DEFAULT_MODELS.tts_model, "gemini-3.8-flash-tts");
});
test("voice previews ignore old prompt-bearing cache and reuse corrected results", async () => {
  let requests = 0;
  const { api, library } = await fixture({ synthesize: async () => { requests++; return [audioPart]; } });
  const account = (await call(api, "/api/settings")).data.effective_project_id;
  const oldKey = `preview:${account}:${DEFAULT_MODELS.tts_model}:en:Puck`;
  await library.write([[oldKey, { blob: new Blob(["old prompt audio"]), created: new Date().toISOString() }]]);
  const input = jsonRequest("POST", { voice: "Puck", language: "en" });
  const first = await api.fetch("/api/voices/preview", input);
  assert.equal(first.headers.get("X-DIYFM-Cache"), "generated");
  const second = await api.fetch("/api/voices/preview", input);
  assert.equal(second.headers.get("X-DIYFM-Cache"), "hit");
  assert.equal(requests, 1);
  assert.ok(await library.get(`preview:${SPEECH_VERSION}:${account}:${DEFAULT_MODELS.tts_model}:en:Puck`));
});
test("keys never enter IndexedDB, ordinary settings, backups or the reload state", async () => {
  const { api, library } = await fixture();
  await call(api, "/api/settings", "PUT", {
    llm_model: "gemini-3.8-flash",
    api_key: KEY,
  });
  const settings = (await call(api, "/api/settings")).data;
  assert.equal(settings.has_key, true);
  assert.ok(!JSON.stringify(settings).includes(KEY));
  assert.ok(!JSON.stringify(await library.entries()).includes(KEY));
  const backup = await api.fetch("/api/backup"),
    files = unzipSync(new Uint8Array(await backup.arrayBuffer()));
  for (const bytes of Object.values(files))
    assert.ok(!strFromU8(bytes).includes(KEY));
  const reloaded = createBrowserAPI({ library });
  await reloaded.ready;
  assert.equal(reloaded.hasKey(), false);
  assert.equal(
    (await call(reloaded, "/api/settings")).data.settings.llm_model,
    "gemini-3.8-flash",
  );
});
test("browser generation snapshots preferences, skips duplicate submission and stores playable WAV", async () => {
  let unblock,
    editorCalls = 0,
    snapshot;
  const gate = new Promise((r) => (unblock = r));
  const { api, library, show } = await fixture({
    editor: async (s, c) => {
      editorCalls++;
      snapshot = { wish: s.wish, models: { ...c.models }, key: c.key };
      await gate;
      return structuredClone(content);
    },
  });
  const input = { request_id: "controlled_request", revision: 0, episode_wish: "这一集讲合租里的一件小事" };
  const first = await call(
    api,
    `/api/shows/${show.id}/episodes`,
    "POST",
    input,
  );
  await call(api, `/api/shows/${show.id}/episodes`, "POST", input);
  assert.equal(
    (await call(api, `/api/shows/${show.id}`, "PATCH", {
      wish: "后来修改",
      revision: 0,
    })).status,
    400,
  );
  await api.clearKey();
  unblock();
  const { ep } = await finished(api, show.id);
  assert.equal(ep.id, first.data.episode.id);
  assert.equal(ep.status, "ready");
  assert.equal(editorCalls, 1);
  assert.equal(snapshot.wish, "室友趣事，轻松好笑一点");
  assert.equal(snapshot.key, KEY);
  assert.equal(ep.has_script, true);
  assert.ok(
    readWav(await (await library.get("audio:" + ep.id)).arrayBuffer()).pcm
      .length > 0,
  );
  assert.ok(!JSON.stringify(await library.entries()).includes(KEY));
});
test("failed synthesis keeps reviewed script; retry uses original wish and does not rewrite content", async () => {
  let failed = true,
    edits = 0;
  const { api, show } = await fixture({
    editor: async () => {
      edits++;
      return structuredClone(content);
    },
    synthesize: async () => {
      if (failed) throw Error("controlled voice failure");
      return [audioPart];
    },
  });
  await call(api, `/api/shows/${show.id}/episodes`, "POST", {
    request_id: "first_attempt",
    episode_wish: "这一集讲合租里的一件小事",
  });
  const original = await finished(api, show.id);
  assert.equal(original.ep.status, "failed");
  assert.equal(
    (await call(api, `/api/shows/${show.id}`, "PATCH", {
      wish: "另一个愿望",
      revision: 0,
    })).status,
    400,
  );
  failed = false;
  await call(api, `/api/shows/${show.id}/episodes`, "POST", {
    request_id: "retry_attempt",
    retry_episode_id: original.ep.id,
    revision: 0,
  });
  const retry = await finished(api, show.id);
  assert.equal(retry.ep.status, "ready");
  assert.equal(edits, 1);
  assert.equal(retry.ep.input.wish, "室友趣事，轻松好笑一点");
  assert.equal(retry.ep.title, "测试来信");
});
test("single episode deletion removes its media and progress, channel preferences and others survive", async () => {
  const { api, library, show } = await fixture();
  await call(api, `/api/shows/${show.id}/episodes`, "POST", {
    request_id: "saved_audio",
    episode_wish: "这一集讲合租里的一件小事",
  });
  const { ep } = await finished(api, show.id);
  const other = (await call(api, "/api/shows", "POST", {
    title: "保留栏目",
    description: "用于删除测试的第二个栏目简介",
    wish: "保留主题口味，随便聊聊日常",
  })).data
    .show;
  const result = await call(
    api,
    `/api/shows/${show.id}/episodes/${ep.id}`,
    "DELETE",
  );
  assert.equal(result.status, 200);
  assert.equal(result.data.show.wish, "室友趣事，轻松好笑一点");
  assert.equal(await library.get("audio:" + ep.id), undefined);
  assert.ok(
    !(await library.entries()).some(([k]) =>
      k.startsWith("voice:" + ep.id + ":"),
    ),
  );
  await call(api, `/api/shows/${show.id}`, "DELETE");
  assert.equal((await call(api, "/api/shows")).data.shows[0].id, other.id);
});
test("IDB transaction failure retains the entire prior library", async () => {
  const library = makeLibrary();
  await library.write([["shows", [{ id: "original" }]]]);
  await assert.rejects(() =>
    library.mutate("shows", () => {
      throw Error("controlled failure");
    }),
  );
  assert.equal((await library.get("shows"))[0].id, "original");
});
test("backup imports merge with new IDs, keep settings and key separate, reject missing audio atomically", async () => {
  const { api, show, library } = await fixture();
  await call(api, `/api/shows/${show.id}/episodes`, "POST", {
    request_id: "backup_audio",
    episode_wish: "这一集讲合租里的一件小事",
  });
  await finished(api, show.id);
  const r = await api.fetch("/api/backup"),
    bytes = await r.arrayBuffer();
  const result = await api.importBackup(bytes);
  assert.equal(result.channels, 1);
  assert.equal((await call(api, "/api/shows")).data.shows.length, 2);
  assert.equal(api.hasKey(), true);
  const bad = zipSync({
    "shows.json": strToU8(
      JSON.stringify({
        shows: [
          {
            ...show,
            episodes: [{ id: "missing", status: "ready" }],
            api_key: KEY,
          },
        ],
      }),
    ),
  });
  await assert.rejects(() => api.importBackup(bad.buffer), /缺少成片音频/);
  assert.equal((await library.get("shows")).length, 2);
});
test("PCM TTS is wrapped in a valid WAV, preserving duration and samples", async () => {
  const blob = await partsBlob([audioPart]),
    wav = readWav(await blob.arrayBuffer());
  assert.equal(wav.rate, RATE);
  assert.equal(wav.pcm.length, 12000);
  assert.equal(blob.type, "audio/wav");
});
test("editorial checks reject wrong languages, fabricated recurrence and invalid roles", () => {
  const draft = {
    title: "测试",
    summary: "测试",
    turns: Array.from({ length: 8 }, (_, i) => ({
      speaker: i % 2 ? "Guest" : "Host",
      text: "I assumed that we could share this cake. It turns out we made a small mistake.",
    })),
  };
  assert.deepEqual(
    validateEpisode(draft, "en", [1, 2000], ["I assumed", "It turns out"]),
    [],
  );
  assert.ok(
    validateEpisode(draft, "ja", [1, 2000], []).some((e) => e.includes("日语")),
  );
  assert.ok(
    validateEpisode(draft, "en", [1, 2000], ["never spoken"]).some((e) =>
      e.includes("至少两次"),
    ),
  );
});
test("required research without real sources fails before speech or script generation", async () => {
  let calls = 0;
  const plan = {
    interpretation: "test",
    topic: "test",
    angle: "test",
    listening_support: "simple",
    expressions: ["one phrase", "other phrase"],
    needs_search: true,
    search_queries: ["official rules"],
  };
  await assert.rejects(
    () =>
      generate(
        { language: "en", difficulty: "basic", length: "BRIEF", episodes: [] },
        { models: DEFAULT_MODELS },
        "",
        async () => {},
        async () => {},
        {},
        async () =>
          ++calls === 1
            ? { text: JSON.stringify(plan) }
            : { text: "No sources", sources: [] },
      ),
    /可追溯来源/,
  );
  assert.equal(calls, 2);
});
test("episode metadata language is captured separately from the listening language", async () => {
  const { i18n } = await import("../static/i18n.mjs?v=2.6.0");
  i18n.setLocale("ja");
  let seen;
  const gate = new Promise((resolve) => {
    seen = resolve;
  });
  let input;
  try {
    const { api, show } = await fixture({
      editor: async (snapshot) => {
        input = snapshot;
        await gate;
        return structuredClone(content);
      },
    });
    await call(api, `/api/shows/${show.id}/episodes`, "POST", {
      request_id: "metadata-locale-01",
      episode_wish: "这一集讲合租里的一件小事",
    });
    i18n.setLocale("zh-CN");
    seen();
    const { ep } = await finished(api, show.id);
    assert.equal(ep.input.metadata_language, "ja");
    assert.equal(input.metadata_language, "ja");
    assert.equal(ep.language, "en");
    assert.equal(input.language, "en");
    const archive = await (await api.fetch("/api/backup")).arrayBuffer();
    const restored = createBrowserAPI({ library: makeLibrary() });
    await restored.ready;
    await restored.importBackup(archive);
    const restoredEpisode = (await call(restored, "/api/shows")).data.shows[0]
      .episodes[0];
    assert.equal(restoredEpisode.input.metadata_language, "ja");
  } finally {
    i18n.setLocale("en");
    seen?.();
  }
  let prompt;
  await assert.rejects(
    () =>
      generate(
        {
          language: "ja",
          difficulty: "beginner",
          length: "BRIEF",
          metadata_language: "en",
        },
        { models: DEFAULT_MODELS },
        "",
        async () => {},
        async () => {},
        {},
        async (s, p) => {
          prompt = p;
          throw Error("stop-after-planning");
        },
      ),
    /stop-after-planning/,
  );
  assert.match(prompt, /One sentence in English/);
  assert.match(prompt, /"language":"日语"/);
  assert.doesNotMatch(prompt, /中文搭桥/);
});
const tonePCM = (frequency, seconds, amplitude) =>
  Float32Array.from(
    { length: RATE * seconds },
    (_, i) => amplitude * Math.sin((2 * Math.PI * frequency * i) / RATE),
  );
const tonePart = async (pcm) => ({
  mime: "audio/wav",
  data: Buffer.from(await wavBlob(pcm).arrayBuffer()).toString("base64"),
});
const toneAmplitude = (pcm, frequency) => {
  let re = 0,
    im = 0;
  const start = RATE,
    end = Math.min(pcm.length, RATE * 2);
  for (let i = start; i < end; i++) {
    const phase = (2 * Math.PI * frequency * i) / RATE;
    re += pcm[i] * Math.cos(phase);
    im += pcm[i] * Math.sin(phase);
  }
  return (2 * Math.hypot(re, im)) / (end - start);
};
test("MP3 export encodes the mixed master, replaces unverified cache and follows audio changes", async () => {
  let encoded,
    calls = 0;
  const { api, library, show } = await fixture({
    show: { music_style: "focus_lofi" },
    synthesize: async () => [await tonePart(tonePCM(880, 3, 0.25))],
    makeMusic: async () => tonePart(tonePCM(220, 1, 0.25)),
    mp3: async (pcm) => {
      encoded = pcm.slice();
      calls++;
      return new Blob(["encoded-mixed-" + calls], { type: "audio/mpeg" });
    },
  });
  await call(api, `/api/shows/${show.id}/episodes`, "POST", {
    request_id: "mixed-mp3-regression",
    episode_wish: "这一集讲合租里的一件小事",
  });
  const { ep } = await finished(api, show.id);
  assert.equal(ep.music_source, "library");
  await library.write([
    ["mp3:" + ep.id, new Blob(["legacy-voice-only-cache"])],
  ]);
  await api.clearKey();
  const first = await api.fetch(`/api/episodes/${ep.id}/download`);
  assert.equal(await first.text(), "encoded-mixed-1");
  assert.ok(
    toneAmplitude(encoded, 220) > 0.01,
    "BGM must reach the MP3 encoder",
  );
  assert.ok(
    toneAmplitude(encoded, 880) > 0.2,
    "voice must reach the MP3 encoder",
  );
  const second = await api.fetch(`/api/episodes/${ep.id}/download`);
  assert.equal(await second.text(), "encoded-mixed-1");
  assert.equal(calls, 1, "unchanged audio must reuse its verified MP3");
  await library.write([["audio:" + ep.id, wavBlob(tonePCM(440, 3, 0.25))]]);
  const replaced = await api.fetch(`/api/episodes/${ep.id}/download`);
  assert.equal(await replaced.text(), "encoded-mixed-2");
  assert.ok(toneAmplitude(encoded, 440) > 0.2);
  assert.equal(calls, 2, "a changed master must invalidate the old MP3");
});
test("concurrent MP3 downloads share encoding but provide independently readable responses", async () => {
  let calls = 0,
    release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { api, library, show } = await fixture({
    mp3: async () => {
      calls++;
      await gate;
      return new Blob(["mixed-download"]);
    },
  });
  await call(api, `/api/shows/${show.id}/episodes`, "POST", {
    request_id: "parallel-export",
    episode_wish: "这一集讲合租里的一件小事",
  });
  const { ep } = await finished(api, show.id);
  const one = api.fetch(`/api/episodes/${ep.id}/download`),
    two = api.fetch(`/api/episodes/${ep.id}/download`);
  release();
  const [a, b] = await Promise.all([one, two]);
  assert.equal(await a.text(), "mixed-download");
  assert.equal(await b.text(), "mixed-download");
  assert.equal(calls, 1);
  assert.ok(await library.get("mp3-meta:" + ep.id));
  await call(api, `/api/shows/${show.id}/episodes/${ep.id}`, "DELETE");
  assert.equal(await library.get("mp3-meta:" + ep.id), undefined);
});
test("failed MP3 replacement preserves old files but never serves an invalidated cache as success", async () => {
  let fail = false;
  const { api, library, show } = await fixture({
    mp3: async () => {
      if (fail) throw Error("controlled encode failure");
      return new Blob(["good-export"]);
    },
  });
  await call(api, `/api/shows/${show.id}/episodes`, "POST", {
    request_id: "failed-export",
    episode_wish: "这一集讲合租里的一件小事",
  });
  const { ep } = await finished(api, show.id);
  assert.equal(
    await (await api.fetch(`/api/episodes/${ep.id}/download`)).text(),
    "good-export",
  );
  const old = await library.get("mp3:" + ep.id),
    meta = await library.get("mp3-meta:" + ep.id);
  await library.write([["audio:" + ep.id, wavBlob(tonePCM(440, 3, 0.25))]]);
  fail = true;
  const failure = await api.fetch(`/api/episodes/${ep.id}/download`);
  assert.equal(failure.ok, false);
  assert.equal(
    await (await library.get("mp3:" + ep.id)).text(),
    await old.text(),
  );
  assert.deepEqual(await library.get("mp3-meta:" + ep.id), meta);
  assert.ok((await library.get("audio:" + ep.id)).size > 44);
});
test("episode synthesis isolates Host and Guest into single-speaker requests on every turn", async () => {
  const multiTurn = {
    ...structuredClone(content),
    script: [
      "Host: Good evening, everyone.",
      "Guest: Glad to be here tonight.",
      'Host: A listener wrote: "I walked into the wrong bathhouse towel in hand."',
      "Guest: Oh no, that happens to every first-time traveler!",
      "Host: Exactly, and a kind local showed the right way.",
      "Guest: Rules make much more sense once you see the care behind them.",
    ].join("\n"),
    turns: [
      { speaker: "Host", text: "Good evening, everyone." },
      { speaker: "Guest", text: "Glad to be here tonight." },
      {
        speaker: "Host",
        text: 'A listener wrote: "I walked into the wrong bathhouse towel in hand."',
      },
      {
        speaker: "Guest",
        text: "Oh no, that happens to every first-time traveler!",
      },
      { speaker: "Host", text: "Exactly, and a kind local showed the right way." },
      {
        speaker: "Guest",
        text: "Rules make much more sense once you see the care behind them.",
      },
    ],
  };
  const ttsRequests = [];
  const hostPart = await tonePart(tonePCM(440, 1, 0.2));
  const guestPart = await tonePart(tonePCM(880, 1, 0.2));
  const library = makeLibrary(),
    api = createBrowserAPI({
      library,
      editor: async () => structuredClone(multiTurn),
      request: async (_snap, path, body) => {
        ttsRequests.push({ path, body });
        const voiceName = body.generation_config.speech_config[0].voice;
        const part = voiceName === "Charon" ? guestPart : hostPart;
        return {
          status: "completed",
          steps: [{ type: "model_output", content: [{ type: "audio", mime_type: part.mime, data: part.data }] }],
        };
      },
    });
  await api.ready;
  await api.setKey(KEY);
  const show = (
    await call(api, "/api/shows", "POST", {
      title: "温泉旅行电台",
      description: "两位主持聊温泉旅行里的误会",
      wish: "温泉旅行，轻松口语",
      host_voice: "Zephyr",
      guest_voice: "Charon",
      music_style: "none",
    })
  ).data.show;
  await call(api, `/api/shows/${show.id}/episodes`, "POST", {
    request_id: "strict-two-voices",
    episode_wish: "第一期讲拿错浴衣",
  });
  const { ep } = await finished(api, show.id);
  assert.equal(ep.status, "ready");
  assert.equal(ttsRequests.length, 6);
  assert.equal(ep.transcript_timing.durations.length, 6);
  assert.equal(ep.transcript_timing.gap, 0.22);
  const assembled = ep.transcript_timing.durations.reduce((sum, n) => sum + n, 0) + 5 * 0.22;
  assert.ok(Math.abs(assembled - ep.duration_seconds) < 1e-9);
  const expectedVoices = [
    "Zephyr",
    "Charon",
    "Zephyr",
    "Charon",
    "Zephyr",
    "Charon",
  ];
  ttsRequests.forEach(({ path, body }, idx) => {
    assert.equal(path, "interactions");
    assert.deepEqual(body.generation_config.speech_config, [{ voice: expectedVoices[idx] }]);
    assert.equal(body.input[0].content[0].text, multiTurn.turns[idx].text);
    assert.equal(body.store, false);
    assert.equal(body.response_format.mime_type, "audio/l16");
  });
  const master = readWav(await (await library.get("audio:" + ep.id)).arrayBuffer());
  const windowAmp = (startSec, freq) => {
    const s = Math.floor(startSec * RATE),
      e = s + Math.floor(0.5 * RATE);
    let re = 0,
      im = 0;
    for (let i = s; i < e; i++) {
      const ph = (2 * Math.PI * freq * i) / RATE;
      re += master.pcm[i] * Math.cos(ph);
      im += master.pcm[i] * Math.sin(ph);
    }
    return (2 * Math.hypot(re, im)) / (e - s);
  };
  // Each turn is 1.0s + 0.22s pause -> Turn 0 at 0.2s (Host 440Hz), Turn 1 at 1.42s (Guest 880Hz), Turn 3 at 3.86s (Guest 880Hz)
  assert.ok(windowAmp(0.2, 440) > 0.15 && windowAmp(0.2, 880) < 0.02);
  assert.ok(windowAmp(1.45, 880) > 0.15 && windowAmp(1.45, 440) < 0.02);
  assert.ok(windowAmp(3.9, 880) > 0.15 && windowAmp(3.9, 440) < 0.02);
});
test("per-turn synthesis retries transient 429 errors, checkpoints turns and ignores legacy batch cache", async () => {
  const fourTurns = {
    ...structuredClone(content),
    script: "Host: One.\nGuest: Two.\nHost: Three.\nGuest: Four.",
    turns: [
      { speaker: "Host", text: "One." },
      { speaker: "Guest", text: "Two." },
      { speaker: "Host", text: "Three." },
      { speaker: "Guest", text: "Four." },
    ],
  };
  let seenTexts = [],
    failFourth = true,
    rateLimitSecondOnce = true,
    sleeps = [];
  const { api, library, show } = await fixture({
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    retryBaseMs: 10,
    editor: async () => structuredClone(fourTurns),
    synthesize: async (_snap, text, opts) => {
      seenTexts.push({ text, voice: opts.voice, single: opts.single });
      if (text === "Two." && rateLimitSecondOnce) {
        rateLimitSecondOnce = false;
        throw new Error("Google 请求失败（HTTP 429）。配额或速率受限，请稍后重试。");
      }
      if (text === "Four." && failFourth) {
        throw new Error("controlled failure on final turn");
      }
      return [audioPart];
    },
  });
  await call(api, `/api/shows/${show.id}/episodes`, "POST", {
    request_id: "checkpoint-first",
    episode_wish: "这一集讲合租里的一件小事",
  });
  const first = await finished(api, show.id);
  assert.equal(first.ep.status, "failed");
  assert.deepEqual(sleeps, [10]);
  assert.ok(await library.get(`voice:${first.ep.id}:turn:0`));
  assert.ok(await library.get(`voice:${first.ep.id}:turn:1`));
  assert.ok(await library.get(`voice:${first.ep.id}:turn:2`));
  assert.equal(await library.get(`voice:${first.ep.id}:turn:3`), undefined);
  // Plant a legacy pre-2.4.1 multi-speaker batch key at index 3; per-turn resume must ignore it.
  await library.write([
    [`voice:${first.ep.id}:3`, new Blob(["corrupt-legacy-batch"])],
  ]);
  seenTexts = [];
  failFourth = false;
  await call(api, `/api/shows/${show.id}/episodes`, "POST", {
    request_id: "checkpoint-retry",
    retry_episode_id: first.ep.id,
  });
  const second = await finished(api, show.id);
  assert.equal(second.ep.status, "ready");
  assert.deepEqual(seenTexts, [{ text: "Four.", voice: "Puck", single: true }]);
});
test("speechTurns parses fallback scripts, strips duplicate labels and DSP helpers preserve healthy audio", () => {
  const parsed = speechTurns(
    [],
    "Host: Host: Welcome back!\nGuest: Guest: Happy to join.",
  );
  assert.deepEqual(parsed, [
    { speaker: "Host", text: "Welcome back!" },
    { speaker: "Guest", text: "Happy to join." },
  ]);
  const longSentence = "This is a clear radio sentence. ";
  const split = speechTurns(
    [{ speaker: "Guest", text: longSentence.repeat(80) }],
    "",
    600,
  );
  assert.ok(split.length >= 4);
  assert.ok(split.every((t) => t.speaker === "Guest" && t.text.length <= 600));
  const padded = new Float32Array(RATE * 2);
  const voice = tonePCM(440, 1, 0.03);
  padded.set(voice, Math.floor(RATE * 0.5));
  const trimmed = trimSilencePCM(padded);
  assert.ok(trimmed.length < RATE * 1.15 && trimmed.length >= RATE);
  const lifted = normalizeTurnPCM(trimmed);
  const origPeak = Math.max(...trimmed.map(Math.abs));
  const liftedPeak = Math.max(...lifted.map(Math.abs));
  assert.ok(liftedPeak > origPeak * 2, "quiet turns should be lifted");
  const healthy = tonePCM(440, 1, 0.25);
  assert.equal(normalizeTurnPCM(healthy), healthy);
});
test("retry after a speech contract upgrade keeps the script but regenerates old voice fragments", async () => {
  let fail = true, edits = 0;
  const seen = [];
  const { api, library, show } = await fixture({
    editor: async () => { edits++; return structuredClone(content); },
    synthesize: async (_snap, text) => {
      seen.push(text);
      if (fail && text === "Welcome.") throw new Error("controlled failure");
      return [audioPart];
    },
  });
  await call(api, `/api/shows/${show.id}/episodes`, "POST", episodeBody());
  const first = await finished(api, show.id);
  assert.equal(first.ep.status, "failed");
  const shows = await library.get("shows");
  delete shows[0].episodes[0].speech_version;
  await library.write([["shows", shows], [`voice:${first.ep.id}:turn:0`, new Blob(["old spoken prompt"])]]);
  fail = false;
  seen.length = 0;
  await call(api, `/api/shows/${show.id}/episodes`, "POST", episodeBody({ retry_episode_id: first.ep.id }));
  const result = await finished(api, show.id);
  assert.equal(result.ep.status, "ready");
  assert.deepEqual(seen, ["Hello.", "Welcome."]);
  assert.equal(edits, 1);
  assert.equal(result.ep.speech_version, SPEECH_VERSION);
});

test('Japanese naturalness review uses the existing one-revision budget', async () => {
  const text = 'そうですね。たしかに、今日は少し困りました。でも、友達と話して気持ちが楽になりました。'.repeat(2) + '本当に。';
  const draft = { title: 'A little mix-up', summary: 'Fictional conversation', turns: Array.from({ length: 8 }, (_, i) => ({ speaker: i % 2 ? 'Guest' : 'Host', text })) };
  const plan = { expressions: ['そうですね', 'たしかに'], needs_search: false };
  assert.deepEqual(validateEpisode(draft, 'ja', [624, 975], plan.expressions), []);
  const prompts = [];
  const result = await generate({ language: 'ja', difficulty: 'basic', length: 'BRIEF' }, { models: DEFAULT_MODELS }, '', async () => {}, async () => {}, { plan, draft }, async (_snap, prompt) => {
    prompts.push(prompt);
    if (prompts.length === 1) return { text: JSON.stringify({ passed: false, issues: ['助词搭配不自然，请修改对应原句。'] }) };
    if (prompts.length === 2) return { text: JSON.stringify(draft) };
    return { text: JSON.stringify({ passed: true, issues: [] }) };
  });
  assert.equal(result.review.passed, true);
  assert.equal(prompts.length, 3, 'review → one revision → review');
  assert.match(prompts[0], /日语专项.*助词与常见搭配/);
  assert.match(prompts[2], /日语专项/);
  let calls = 0;
  await assert.rejects(generate({ language: 'ja', difficulty: 'basic', length: 'BRIEF' }, { models: DEFAULT_MODELS }, '', async () => {}, async () => {}, { plan, draft }, async () => {
    calls++;
    return { text: JSON.stringify(calls === 2 ? draft : { passed: false, issues: ['仍然不自然'] }) };
  }), /内容检查未通过/);
  assert.equal(calls, 3, 'no unbounded rewrite loop or extra reviewer');
});

test("provider HTTP codes and response text survive unchanged except an echoed active key", async () => {
  for (const code of [400, 401, 403, 404, 429, 500, 503]) {
    const raw = '{\n "error": {"code": ' + code + ', "status": "PROVIDER_CODE", "message": "provider says exactly this", "details": [{"reason": "MODEL_ACCESS"}]}\n}\n';
    await assert.rejects(googleRequest({ key: KEY }, "models/test-model:generateContent", {}, {
      fetcher: async () => new Response(raw, { status: code, statusText: "Provider status" }),
    }), error => error.httpStatus === code && error.message === `HTTP ${code} Provider status\n${raw}`);
  }
  for (const raw of ["service unavailable\nrequest: abc-123", "<html><script>doNotRun()</script>upstream failed</html>", ""]) {
    await assert.rejects(googleRequest({ key: KEY }, "interactions", {}, {
      fetcher: async () => new Response(raw, { status: 502 }),
    }), error => error.message === `HTTP 502${raw ? '\n' + raw : ''}`);
  }
  const raw = JSON.stringify({ error: { message: KEY + ": original provider reason" } });
  await assert.rejects(googleRequest({ key: KEY }, "interactions", {}, {
    fetcher: async () => new Response(raw, { status: 403 }),
  }), error => error.message === "HTTP 403\n" + raw.replace(KEY, "[REDACTED]"));
});

test("network failures expose their actual browser exception without inventing HTTP codes", async () => {
  for (const exception of [new TypeError("Failed to fetch"), new DOMException("The operation was aborted.", "AbortError")]) {
    await assert.rejects(googleRequest({ key: KEY }, "interactions", {}, { fetcher: async () => { throw exception; } }),
      error => error.message === `${exception.name}: ${exception.message}` && error.httpStatus === undefined);
  }
});

test("HTTP 200 provider failures, blocked/truncated content and malformed responses retain the original response", async () => {
  const bodies = [
    '{ "error": {"code": 13, "message": "provider failure", "status": "INTERNAL"} }\n',
    '{ "status": "failed", "error": {"code": "MODEL_UNAVAILABLE", "message": "offline"} }',
    '{ "candidates": [{"finishReason": "MAX_TOKENS", "content": {"parts": [{"text": "partial"}]}}] }',
    '{ "promptFeedback": {"blockReason": "SAFETY"} }',
    '<html>bad gateway from upstream</html>',
  ];
  for (const body of bodies) {
    await assert.rejects(textResult({ key: KEY, models: DEFAULT_MODELS }, "test", {
      request: (snap, path, payload) => googleRequest(snap, path, payload, { fetcher: async () => new Response(body, { status: 200 }) }),
    }), error => error.message === `HTTP 200\n${body}`);
  }
});

test("text and speech failures persist original provider errors; music failures retain the playable episode and raw diagnostics", async () => {
  const raw = '{ "error": { "code": 404, "status": "NOT_FOUND", "message": "Exact provider reason: test-model is unavailable" } }';
  const expected = `HTTP 404 Not Found\n${raw}`;
  const request = (snap, path, body) => googleRequest(snap, path, body, { fetcher: async () => new Response(raw, { status: 404, statusText: "Not Found" }) });
  for (const stage of ["text", "speech", "music"]) {
    const { api, library, show } = await fixture({
      request,
      ...(stage === "text" ? { editor: async (_show, snap) => textResult(snap, "test", { request }) } : {}),
      ...(stage === "speech" ? { synthesize: speech } : {}),
      ...(stage === "music" ? { makeMusic: music } : {}),
    });
    // Reuse a real music preset rather than assuming a provider-specific style ID.
    if (stage === "music") {
      const presets = (await call(api, "/api/presets")).data;
      const shows = await library.get("shows");
      shows[0].music_style = presets.music.find(p => p.id !== "none").id;
      await library.write([["shows", shows]]);
    }
    await call(api, `/api/shows/${show.id}/episodes`, "POST", episodeBody());
    const result = await finished(api, show.id);
    assert.equal(result.ep.status, stage === "music" ? "ready" : "failed");
    assert.equal(stage === "music" ? result.ep.music_error : result.ep.error, expected);
    const saved = (await library.get("shows"))[0].episodes[0];
    assert.equal(stage === "music" ? saved.music_error : saved.error, expected);
    const preview = await api.fetch("/api/voices/preview", jsonRequest("POST", { voice: "Puck", language: "en", force: true }));
    if (stage === "speech") assert.equal((await preview.json()).message, expected);
  }
});
