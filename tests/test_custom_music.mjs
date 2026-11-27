import test from "node:test";
import assert from "node:assert/strict";
import { indexedDB } from "fake-indexeddb";
import { Library } from "../static/library.mjs";
import { createBrowserAPI, cleanPreferences, assertSeriesPreferencesLocked } from "../static/browser-api.mjs";
import { DEFAULT_MODELS } from "../static/gemini.mjs";
import { musicInput, musicInputKey, musicSpec, polishMusic } from "../static/music.mjs";
import { wavBlob, readWav } from "../static/audio.mjs";

const KEY = "unit-test-only-key-" + "a".repeat(30);
const json = (method, body) => ({ method, body: JSON.stringify(body) });
const call = async (api, path, method = "GET", body) => {
  const r = await api.fetch(path, body === undefined ? { method } : json(method, body));
  return { status: r.status, data: await r.json() };
};
const words = "悲伤、心碎，情侣争吵后的雨夜";
const polished = "Melancholic instrumental piano and restrained low strings, minor harmony, slow pulse, tense pauses, intimate rainy-night atmosphere, loop-friendly and quiet beneath dialogue.";
const pcm = Float32Array.from({ length: 4800 }, (_, i) => Math.sin(i / 10) * 0.15);
const audio = Buffer.from(await wavBlob(pcm).arrayBuffer()).toString("base64");
async function fixture(control = {}) {
  const library = new Library({ indexedDB, name: "music-" + crypto.randomUUID() });
  const calls = [];
  const api = createBrowserAPI({
    library,
    request: async (snapshot, path, body) => {
      calls.push({ snapshot: { ...snapshot, models: { ...snapshot.models } }, path, body });
      if (control.request) await control.request(path, body);
      if (path === "interactions") return { status: "completed", steps: [{ type: "model_output", content: [{ type: "audio", mime_type: "audio/wav", data: audio }] }] };
      return { candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ prompt: polished }) }] } }] };
    },
    editor: async () => ({ title: "Music test", summary: "Synthetic QA", script: "Host: Hi.\nGuest: Hello.", turns: [{speaker:"Host",text:"Hi."},{speaker:"Guest",text:"Hello."}], plan: {}, review: {passed:true}, expressions: [], sources: [] }),
    synthesize: async () => [{ mime: "audio/wav", data: audio }],
  });
  await api.ready; await api.setKey(KEY);
  return { api, library, calls };
}
async function generate(api, keywords = words, style = "custom") {
  const reply = await call(api, `/api/bgm/${style}/regenerate`, "POST", { keywords });
  assert.equal(reply.status, 200, JSON.stringify(reply.data));
  return reply.data.job_key;
}
async function done(api, key) {
  for (let i = 0; i < 200; i++) {
    const job = (await call(api, "/api/bgm/jobs")).data.jobs[key];
    if (job?.status !== "running") return job;
    await new Promise(r => setTimeout(r, 5));
  }
  throw Error("Controlled music job did not finish");
}
async function preview(api, keywords = words, style = "custom") {
  return api.fetch("/api/bgm/preview", json("POST", { style, keywords }));
}

test("custom music accepts short multilingual keywords, validates early, and participates in locked snapshots", async () => {
  assert.deepEqual(musicInput("custom", "  悲伤、心碎\n雨夜  "), { style: "custom", keywords: "悲伤、心碎 雨夜" });
  assert.throws(() => musicInput("custom", "  "), /请填写/);
  assert.throws(() => musicInput("custom", "x".repeat(241)), /240/);
  assert.throws(() => musicInput("unknown", "sad"), /选择/);
  const settings = cleanPreferences({ music_style: "custom", music_keywords: words, host_voice: "Kore", guest_voice: "Puck" });
  assert.equal(settings.music_keywords, words);
  assert.throws(() => assertSeriesPreferencesLocked({ music_keywords: "史诗" }, settings), /不可修改/);
  const { api, calls } = await fixture();
  assert.equal((await call(api, "/api/bgm/custom/regenerate", "POST", { keywords: " " })).status, 400);
  assert.equal((await call(api, "/api/shows", "POST", { title: "Test", theme_id: "custom", wish: "Test radio concept", music_style: "custom", music_keywords: "" })).status, 400);
  assert.equal(calls.length, 0, "invalid input must not incur model calls");
});

test("custom generation polishes once and sends the enriched instrumental direction to the selected Lyria model", async () => {
  const { api, calls } = await fixture();
  const key = await generate(api);
  assert.equal((await done(api, key)).status, "ready");
  assert.equal(calls.length, 2);
  assert.match(calls[0].path, new RegExp(`models/${DEFAULT_MODELS.llm_model}`));
  assert.ok(calls[0].body.contents[0].parts[0].text.includes(words));
  assert.match(calls[0].body.contents[0].parts[0].text, /sadness, heartbreak, tense couple arguments or epic grandeur/);
  assert.equal(calls[1].body.model, DEFAULT_MODELS.lyria_model);
  assert.ok(calls[1].body.input.startsWith(polished));
  assert.match(calls[1].body.input, /no vocals, singing, speech or lyrics/);
  const response = await preview(api);
  assert.equal(response.status, 200);
  assert.ok(readWav(await response.arrayBuffer()));
  await preview(api); await preview(api);
  assert.equal(calls.length, 2, "playing again must not regenerate or repolish");
  const next = await generate(api);
  await done(api, next);
  assert.equal(calls.filter(c => c.path !== "interactions").length, 1);
  assert.equal(calls.filter(c => c.path === "interactions").length, 2);
});

test("music identity includes keywords, text and music models; A to B to A reuses the right result", async () => {
  const { api, calls } = await fixture();
  const a = await generate(api, "心碎"); await done(api, a);
  const b = await generate(api, "史诗般宏大"); await done(api, b);
  assert.notEqual(a, b);
  assert.equal((await preview(api, "心碎")).status, 200);
  assert.equal((await preview(api, "史诗般宏大")).status, 200);
  assert.equal(calls.length, 4);
  const first = await musicSpec(musicInput("custom", " 心碎 \n"), DEFAULT_MODELS);
  assert.equal(first.key, a);
  await call(api, "/api/settings", "PUT", { llm_model: "other-writer" });
  assert.equal((await preview(api, "心碎")).status, 404);
  const c = await generate(api, "心碎"); await done(api, c);
  assert.notEqual(c, a);
  await call(api, "/api/settings", "PUT", { lyria_model: "other-music" });
  const d = await generate(api, "心碎"); await done(api, d);
  assert.notEqual(d, c);
  assert.notEqual(musicInputKey(musicInput("custom", "心碎"), DEFAULT_MODELS), musicInputKey(musicInput("custom", "史诗"), DEFAULT_MODELS));
});

test("failed polishing makes no music call; failed Lyria preserves the prompt checkpoint and the old playable clip", async () => {
  let failure = "text";
  const raw = 'HTTP 503\n{"error":{"code":503,"message":"provider unavailable","status":"UNAVAILABLE"}}';
  const { api, calls } = await fixture({ request: async path => {
    if ((failure === "text" && path !== "interactions") || (failure === "music" && path === "interactions")) throw Error(raw);
  } });
  let key = await generate(api); assert.equal((await done(api, key)).error, raw);
  assert.equal(calls.filter(c => c.path === "interactions").length, 0);
  failure = "music";
  key = await generate(api); assert.equal((await done(api, key)).error, raw);
  const polishedCalls = calls.filter(c => c.path !== "interactions").length;
  failure = "";
  key = await generate(api); assert.equal((await done(api, key)).status, "ready");
  assert.equal(calls.filter(c => c.path !== "interactions").length, polishedCalls, "retry should reuse successful prompt polishing");
  const old = await (await preview(api)).arrayBuffer();
  failure = "music";
  key = await generate(api); assert.equal((await done(api, key)).error, raw);
  assert.deepEqual(await (await preview(api)).arrayBuffer(), old);
});

test("same in-flight custom input is shared; different jobs keep their original model snapshot", async () => {
  let resolve;
  const gate = new Promise(r => resolve = r);
  const { api, calls } = await fixture({ request: async path => { if (path !== "interactions") await gate; } });
  const key = await generate(api);
  assert.equal(await generate(api), key);
  await call(api, "/api/settings", "PUT", { llm_model: "new-writer", lyria_model: "new-music" });
  resolve();
  assert.equal((await done(api, key)).status, "ready");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.model, DEFAULT_MODELS.lyria_model);
  assert.equal(calls[1].snapshot.models.llm_model, DEFAULT_MODELS.llm_model);
});

test("custom music survives generation and library backup; presets bypass polishing and retain legacy cache keys", async () => {
  const { api, library, calls } = await fixture();
  const show = (await call(api, "/api/shows", "POST", { title: "Scene music", theme_id:"custom", wish:"Short stories about everyday life", language:"en", music_style:"custom", music_keywords:words })).data.show;
  await call(api, `/api/shows/${show.id}/episodes`, "POST", { request_id:"custom-music-episode" });
  let ep;
  for (let i=0;i<200;i++) {
    ep=(await call(api,"/api/shows")).data.shows.find(s=>s.id===show.id).episodes[0];
    if(ep?.status!=="generating")break;
    await new Promise(r=>setTimeout(r,5));
  }
  assert.equal(ep.status,"ready");
  assert.equal(ep.input.music_keywords,words);
  assert.equal(ep.music_prompt,polished);
  const archive = await (await api.fetch("/api/backup")).arrayBuffer();
  const restored = await fixture(); await restored.api.importBackup(archive);
  const imported = (await call(restored.api,"/api/shows")).data.shows[0];
  assert.equal(imported.music_keywords,words);
  assert.equal(imported.episodes[0].music_prompt,polished);
  const n=calls.length;
  const key=await generate(api,"","focus_lofi");await done(api,key);
  assert.equal(calls.length,n+1);
  assert.ok(await library.get(`music:${DEFAULT_MODELS.lyria_model}:focus_lofi`));
});

test("custom audio cache is bounded without removing finished episode assets", async () => {
  const { api, library } = await fixture();
  await library.write([["audio:saved-work",new Blob(["saved mixed master"])]]);
  for(let i=0;i<21;i++){const key=await generate(api,`scene ${i}`);await done(api,key);}
  assert.equal((await library.get("music-custom-index")).length,20);
  assert.equal((await preview(api,"scene 0")).status,404);
  assert.equal((await preview(api,"scene 20")).status,200);
  assert.equal(await (await library.get("audio:saved-work")).text(),"saved mixed master");
});

test("malformed polishing output is visible and never reaches Lyria", async () => {
  await assert.rejects(polishMusic({key:KEY,models:DEFAULT_MODELS}, words, async()=>({candidates:[{finishReason:"STOP",content:{parts:[{text:"not JSON"}]}}]})), /not JSON/);
});

test("custom music limits distinct concurrent jobs without cancelling or duplicating the first two", async () => {
  let release;
  const gate = new Promise(r => release = r);
  const { api, calls } = await fixture({ request: async path => { if (path !== 'interactions') await gate; } });
  const a = await generate(api,'scene A'), b = await generate(api,'scene B');
  assert.equal(await generate(api,'scene A'),a);
  const c = await generate(api,'scene C');
  assert.match((await done(api,c)).error,/最多同时生成两条/);
  release();
  assert.equal((await done(api,a)).status,'ready');
  assert.equal((await done(api,b)).status,'ready');
  assert.equal(calls.length,4);
});
