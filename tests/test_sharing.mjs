import test from "node:test";
import assert from "node:assert/strict";
import { indexedDB } from "fake-indexeddb";
import { Library } from "../static/library.mjs";
import { createBrowserAPI } from "../static/browser-api.mjs";
import { encodeChannel, decodeChannel, parseCatalog, readBounded, sha256, SHARE_LIMIT } from "../static/sharing.mjs";
import { wavBlob, RATE } from "../static/audio.mjs";
import { unzipSync, zipSync, strFromU8, strToU8 } from "../static/vendor/fflate.mjs";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addCatalogPackage, validateCatalog } from "../scripts/catalog.mjs";
const library = () => new Library({ indexedDB, name: "sharing-" + crypto.randomUUID() });
const credit = { author: "Radio creator / ラジオ作者", source_url: "https://example.org/channel", license: "Personal listening only" };
const tone = wavBlob(Float32Array.from({ length: RATE }, (_, i) => .2 * Math.sin(2 * Math.PI * 880 * i / RATE) + .02 * Math.sin(2 * Math.PI * 220 * i / RATE)));
async function source() {
  const db = library(); await db.ready;
  const show = { id: "show_source", title: "A letter from the wrong train / 乗り間違い", language: "en", difficulty: "basic", host_voice: "Kore", guest_voice: "Puck", length: "SHORT", music_style: "morning_acoustic", revision: 0, wish: "PRIVATE_WISH", episodes: [
    { id: "ep_ready", title: "The wrong train", summary: "An original fictional letter.", script: "Host: I took the wrong train.\nGuest: Where did you end up?", expressions: ["end up"], status: "ready", duration_seconds: 1, created_at: "2026-11-10T00:00:00Z", research: { secret: "PRIVATE_RESEARCH" }, input: { wish: "PRIVATE_INPUT" }, music_source: "generated" },
    { id: "ep_failed", title: "Private failure", status: "failed", script: "PRIVATE_DRAFT" },
  ] };
  await db.write([["shows", [show]], ["audio:ep_ready", tone], ["models", { llm_model: "PRIVATE_MODEL" }], ["voice:ep_failed", tone]]);
  const api = createBrowserAPI({ library: db, request: () => { throw Error("Unexpected cloud call"); } }); await api.ready;
  return { db, show, api, blob: await api.exportChannel(show.id, { ...credit, description: "An English listening channel.", episodeIds: ["ep_ready"] }) };
}
const list = async api => (await (await api.fetch("/api/shows")).json()).shows;
async function target(options = {}) { const db = options.library || library(), api = createBrowserAPI({ ...options, library: db }); await api.ready; return { db, api }; }
function rewrite(buffer, change) {
  const files = unzipSync(new Uint8Array(buffer)), manifest = JSON.parse(strFromU8(files["channel.json"])); change(manifest, files); files["channel.json"] = strToU8(JSON.stringify(manifest)); return zipSync(files).buffer;
}

test("channel export whitelists selected finished content and preserves the exact BGM mix", async () => {
  const s = await source(), bytes = await s.blob.arrayBuffer(), files = unzipSync(new Uint8Array(bytes));
  assert.deepEqual(Object.keys(files).sort(), ["audio/ep_ready.wav", "channel.json"]);
  const metadata = strFromU8(files["channel.json"]);
  assert.doesNotMatch(metadata, /PRIVATE_|settings|host_voice|research|input/);
  assert.deepEqual(files["audio/ep_ready.wav"], new Uint8Array(await tone.arrayBuffer()));
  assert.equal((await decodeChannel(bytes)).manifest.attribution.author, credit.author);
  await assert.rejects(s.api.exportChannel(s.show.id, { ...credit, episodeIds: ["ep_failed"] }), /发生变化/);
  await assert.rejects(s.api.exportChannel(s.show.id, { ...credit, episodeIds: [] }), /1 至 50/);
  assert.equal((await list(s.api)).length, 1);
});

test("preview and cancellation do not write; duplicate/concurrent commits add only one channel and survive reload", async () => {
  const s = await source(), { api, db } = await target();
  await db.write([["models", { llm_model: "keep-custom-model" }]]);
  await api.setKey("unit-test-key-" + "x".repeat(40));
  const bytes = await s.blob.arrayBuffer(), p = await api.prepareImport(bytes);
  assert.equal(p.channels[0].attribution.author, credit.author); assert.equal((await list(api)).length, 0);
  api.discardImport(p.token); await assert.rejects(api.commitImport(p.token), /预览已关闭/);
  const q = await api.prepareImport(bytes), [a, b] = await Promise.all([api.commitImport(q.token), api.commitImport(q.token)]);
  assert.equal(a.showId, b.showId); assert.equal((await list(api)).length, 1);
  const again = await api.prepareImport(bytes); assert.equal(again.duplicate, true);
  assert.equal((await api.commitImport(again.token)).duplicate, true);
  assert.equal(api.hasKey(), true); assert.equal((await db.get("models")).llm_model, "keep-custom-model");
  const reload = createBrowserAPI({ library: db }); await reload.ready;
  const saved = (await list(reload))[0]; assert.equal(saved.provenance.author, credit.author); assert.equal(saved.episodes.length, 1);
  assert.deepEqual(new Uint8Array(await (await db.get("audio:" + saved.episodes[0].id)).arrayBuffer()), new Uint8Array(await tone.arrayBuffer()));
  const transcript = await (await reload.fetch(`/api/episodes/${saved.episodes[0].id}/transcript`)).json();
  assert.match(transcript.script, /wrong train/); assert.equal(reload.hasKey(), false);
});

test("changed public versions stay separate and never overwrite local edits", async () => {
  const s = await source(), { api, db } = await target();
  const p = await api.prepareImport(await s.blob.arrayBuffer()), first = await api.commitImport(p.token);
  await db.mutate("shows", shows => { shows[0].title = "My private edited title"; return { puts: [["shows", shows]] }; });
  const newer = await s.api.exportChannel(s.show.id, { ...credit, description: "A revised public introduction.", episodeIds: ["ep_ready"] });
  const q = await api.prepareImport(await newer.arrayBuffer()); assert.equal(q.separateVersion, true); assert.equal(q.duplicate, false);
  await api.commitImport(q.token);
  assert.equal((await list(api)).length, 2); assert.equal((await list(api)).find(x => x.id === first.showId).title, "My private edited title");
});

test("re-sharing and full backup/restore retain original credits without copying private settings", async () => {
  const s = await source(), { api } = await target(), p = await api.prepareImport(await s.blob.arrayBuffer()), imported = await api.commitImport(p.token);
  const saved = (await list(api))[0];
  const blob = await api.exportChannel(imported.showId, { author: "Community curator", source_url: "", license: "Redistribute with attribution", episodeIds: saved.episodes.map(e => e.id) });
  const data = await decodeChannel(await blob.arrayBuffer());
  assert.equal(data.manifest.attribution.author, "Community curator"); assert.equal(data.manifest.channel.origin.author, credit.author); assert.equal(data.manifest.episodes[0].origin.author, credit.author);
  const backup = await (await api.fetch("/api/backup")).arrayBuffer(), other = await target(), preview = await other.api.prepareImport(backup);
  assert.equal(preview.kind, "backup"); assert.equal((await list(other.api)).length, 0);
  await other.api.commitImport(preview.token); const restored = (await list(other.api))[0];
  assert.equal(restored.provenance.author, credit.author); assert.equal(restored.description, "An English listening channel.");
  assert.equal(restored.episodes[0].provenance.author, credit.author);
});

test("invalid packages fail before writes: hashes, paths, versions, references and audio bounds", async t => {
  const s = await source(), bytes = await s.blob.arrayBuffer(), { api } = await target();
  const cases = [
    m => m.version = 99,
    m => m.episodes.push(m.episodes[0]),
    m => m.episodes[0].audio.path = "../private.wav",
    m => m.episodes[0].audio.bytes = 1,
    m => m.episodes[0].audio.sha256 = "0".repeat(64),
    m => m.episodes[0].duration_seconds = 100,
    m => m.attribution.source_url = "javascript:alert(1)",
    (m, f) => delete f[m.episodes[0].audio.path],
    (m, f) => f["settings.json"] = strToU8('{"private":true}'),
  ];
  for (let i = 0; i < cases.length; i++) await t.test(`invalid variant ${i + 1}`, async () => {
    await assert.rejects(api.prepareImport(rewrite(bytes, cases[i]))); assert.equal((await list(api)).length, 0);
  });
  await assert.rejects(api.prepareImport(new Uint8Array([1, 2, 3]).buffer));
});

test("new previews, immediate cancellation and disposal invalidate old pending imports", async () => {
  const s = await source(), bytes = await s.blob.arrayBuffer(), { api } = await target();
  const [a, b] = await Promise.allSettled([api.prepareImport(bytes), api.prepareImport(bytes)]);
  assert.equal(a.status, "rejected"); assert.equal(a.reason.name, "AbortError"); assert.equal(b.status, "fulfilled");
  const p = api.prepareImport(bytes); api.discardImport(); await assert.rejects(p, { name: "AbortError" });
  const q = api.prepareImport(bytes); api.dispose(); await assert.rejects(q, { name: "AbortError" });
  assert.equal((await list(api)).length, 0);
});

test("parallel independent tabs deduplicate within the IndexedDB transaction", async () => {
  const s = await source(), db = library(), a = await target({ library: db }), b = await target({ library: db });
  const bytes = await s.blob.arrayBuffer(), x = await a.api.prepareImport(bytes), y = await b.api.prepareImport(bytes);
  const results = await Promise.all([a.api.commitImport(x.token), b.api.commitImport(y.token)]);
  assert.equal(results.filter(r => r.duplicate).length, 1); assert.equal((await list(a.api)).length, 1);
});

test("a failed atomic save retains the library and the preview can be retried", async () => {
  const s = await source(), db = library(), { api } = await target({ library: db });
  await db.write([["shows", [{ id: "existing", title: "Keep me", episodes: [] }]]]);
  const p = await api.prepareImport(await s.blob.arrayBuffer()), mutate = db.mutate.bind(db);
  db.mutate = async () => { throw Error("Simulated storage failure"); };
  await assert.rejects(api.commitImport(p.token), /storage failure/);
  assert.equal((await list(api)).length, 1); assert.equal((await list(api))[0].title, "Keep me");
  db.mutate = mutate;
  await api.commitImport(p.token); assert.equal((await list(api)).length, 2);
});

test("catalog one-click chain uses data-only trusted paths, no credentials and verified package bytes", async () => {
  const s = await source(), bytes = await s.blob.arrayBuffer(), decoded = await decodeChannel(bytes);
  const entry = { ...decoded.manifest.channel, attribution: credit, episodes: 1, package: "packages/sample.zip", bytes: bytes.byteLength, sha256: await sha256(bytes) };
  const catalog = { format: "diyfm-catalog", version: 1, channels: [entry] }, requests = [];
  const { api } = await target({ catalogURL: "https://example.org/catalog/index.json", fetcher: async (url, options) => {
    requests.push({ url, options }); return url.endsWith("index.json") ? Response.json(catalog) : new Response(bytes);
  } });
  const rows = await api.catalog(); assert.equal(rows.length, 1);
  const p = await api.prepareCatalog(rows[0].id), result = await api.commitImport(p.token);
  assert.equal(result.episodes, 1); assert.equal((await list(api))[0].provenance.author, credit.author);
  assert.equal(requests.length, 2);
  for (const { options } of requests) { assert.equal(options.credentials, "omit"); assert.equal(options.redirect, "error"); assert.equal(options.headers, undefined); }
  for (const url of ["https://evil.example/sample.zip", "../sample.zip", "packages/../sample.zip", "packages/%2e%2e/sample.zip", "packages/sample.zip?token=secret"]) {
    assert.throws(() => parseCatalog({ ...catalog, channels: [{ ...entry, package: url }] }, "https://example.org/catalog/index.json"));
  }
});

test("catalog tampering and cancelled downloads never add content", async () => {
  const s = await source(), bytes = await s.blob.arrayBuffer(), decoded = await decodeChannel(bytes);
  const entry = { ...decoded.manifest.channel, attribution: credit, episodes: 1, package: "packages/a.zip", bytes: bytes.byteLength, sha256: "0".repeat(64) };
  const doc = { format: "diyfm-catalog", version: 1, channels: [entry] };
  const { api } = await target({ catalogURL: "https://example.org/catalog/index.json", fetcher: async url => url.endsWith(".json") ? Response.json(doc) : new Response(bytes) });
  await api.catalog(); await assert.rejects(api.prepareCatalog(entry.id), /校验失败/); assert.equal((await list(api)).length, 0);
  entry.sha256 = await sha256(bytes); entry.title = "Misleading title"; await api.catalog();
  await assert.rejects(api.prepareCatalog(entry.id), /资料与分享包不一致/); assert.equal((await list(api)).length, 0);
  const controller = new AbortController(); controller.abort(); await assert.rejects(api.prepareCatalog(entry.id, controller.signal), { name: "AbortError" });
});

test("bounded resource reads reject excessive declared and streamed data", async () => {
  await assert.rejects(readBounded(new Response("a", { headers: { "Content-Length": String(SHARE_LIMIT + 1) } }), SHARE_LIMIT));
  await assert.rejects(readBounded(new Response(new Uint8Array(12)), 10));
  assert.deepEqual(new Uint8Array(await readBounded(new Response(new Uint8Array([1, 2])), 10)), new Uint8Array([1, 2]));
});

test("curator preparation derives listing metadata and build validation catches damaged assets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "diyfm-catalog-"));
  try {
    await writeFile(join(directory, "index.json"), JSON.stringify({ format: "diyfm-catalog", version: 1, channels: [] }));
    const s = await source(), file = join(directory, "input.zip"); await writeFile(file, new Uint8Array(await s.blob.arrayBuffer()));
    const digest = await addCatalogPackage(file, directory);
    assert.equal(await validateCatalog(directory), 1);
    const doc = JSON.parse(await readFile(join(directory, "index.json")));
    assert.equal(doc.channels[0].attribution.author, credit.author); assert.equal(doc.channels[0].sha256, digest);
    await addCatalogPackage(file, directory); assert.equal(await validateCatalog(directory), 1);
    await writeFile(join(directory, "packages", digest + ".zip"), "broken"); await assert.rejects(validateCatalog(directory), /size mismatch/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
