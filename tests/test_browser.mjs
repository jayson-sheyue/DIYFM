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
  music,
  DEFAULT_MODELS,
} from "../static/gemini.mjs";
import { wavBlob, readWav, partsBlob, RATE } from "../static/audio.mjs";
import { generate, validateEpisode } from "../static/harness.mjs";
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
  const library = makeLibrary(),
    api = createBrowserAPI({
      library,
      editor: async () => structuredClone(content),
      synthesize: async () => [audioPart],
      makeMusic: async () => ({
        mime: "audio/wav",
        data: Buffer.from(
          await wavBlob(new Float32Array(2400)).arrayBuffer(),
        ).toString("base64"),
      }),
      ...overrides,
    });
  await api.ready;
  await api.setKey(KEY);
  const show = (
    await call(api, "/api/shows", "POST", {
      wish: "室友趣事",
      music_style: "none",
    })
  ).data.show;
  return { library, api, show };
}
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
    body.generationConfig.speechConfig.multiSpeakerVoiceConfig.speakerVoiceConfigs.map(
      (v) => v.voiceConfig.prebuiltVoiceConfig.voiceName,
    ),
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
  const input = { request_id: "controlled_request", revision: 0 };
  const first = await call(
    api,
    `/api/shows/${show.id}/episodes`,
    "POST",
    input,
  );
  await call(api, `/api/shows/${show.id}/episodes`, "POST", input);
  await call(api, `/api/shows/${show.id}`, "PATCH", {
    wish: "后来修改",
    revision: 0,
  });
  await api.clearKey();
  unblock();
  const { ep } = await finished(api, show.id);
  assert.equal(ep.id, first.data.episode.id);
  assert.equal(ep.status, "ready");
  assert.equal(editorCalls, 1);
  assert.equal(snapshot.wish, "室友趣事");
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
  });
  const original = await finished(api, show.id);
  assert.equal(original.ep.status, "failed");
  await call(api, `/api/shows/${show.id}`, "PATCH", {
    wish: "另一个愿望",
    revision: 0,
  });
  failed = false;
  await call(api, `/api/shows/${show.id}/episodes`, "POST", {
    request_id: "retry_attempt",
    retry_episode_id: original.ep.id,
    revision: 1,
  });
  const retry = await finished(api, show.id);
  assert.equal(retry.ep.status, "ready");
  assert.equal(edits, 1);
  assert.equal(retry.ep.input.wish, "室友趣事");
  assert.equal(retry.ep.title, "测试来信");
});
test("single episode deletion removes its media and progress, channel preferences and others survive", async () => {
  const { api, library, show } = await fixture();
  await call(api, `/api/shows/${show.id}/episodes`, "POST", {
    request_id: "saved_audio",
  });
  const { ep } = await finished(api, show.id);
  const other = (await call(api, "/api/shows", "POST", { wish: "保留" })).data
    .show;
  const result = await call(
    api,
    `/api/shows/${show.id}/episodes/${ep.id}`,
    "DELETE",
  );
  assert.equal(result.status, 200);
  assert.equal(result.data.show.wish, "室友趣事");
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
  const { i18n } = await import("../static/i18n.mjs?v=2.3.0");
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
    synthesize: async () => [await tonePart(tonePCM(880, 3, 0.25))],
    makeMusic: async () => tonePart(tonePCM(220, 1, 0.25)),
    mp3: async (pcm) => {
      encoded = pcm.slice();
      calls++;
      return new Blob(["encoded-mixed-" + calls], { type: "audio/mpeg" });
    },
  });
  await call(api, `/api/shows/${show.id}`, "PATCH", {
    music_style: "focus_lofi",
    revision: 0,
  });
  await call(api, `/api/shows/${show.id}/episodes`, "POST", {
    request_id: "mixed-mp3-regression",
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
