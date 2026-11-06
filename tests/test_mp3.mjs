import test from "node:test";
import assert from "node:assert/strict";
import { encodeMP3, RATE } from "../static/audio.mjs";
const tone = () =>
  Float32Array.from(
    { length: RATE },
    (_, i) => 0.25 * Math.sin((2 * Math.PI * 440 * i) / RATE),
  );
test("Worker construction failure falls back to the real local MP3 encoder without detaching the master", async () => {
  const pcm = tone();
  const blob = await encodeMP3(pcm, {
    workerFactory() {
      throw new Error("Worker blocked");
    },
  });
  assert.equal(blob.type, "audio/mpeg");
  assert.ok(blob.size > 1000);
  assert.equal(pcm.length, RATE);
});
const workerHarness = () => {
  let terminated = 0,
    sent;
  const worker = {
    terminate() {
      terminated++;
    },
    postMessage(value) {
      sent = value;
    },
  };
  return { worker, stopped: () => terminated, sent: () => sent };
};
test("Worker startup errors and late callbacks fall back once and yield between encoding batches", async () => {
  const h = workerHarness();
  let loads = 0,
    yields = 0;
  const pending = encodeMP3(tone(), {
    workerFactory: () => h.worker,
    loadEncoder: async () => {
      loads++;
      return import("../static/vendor/lame-encoder.mjs");
    },
    yieldToPage: async () => {
      yields++;
    },
  });
  const late = h.worker.onmessage,
    failure = h.worker.onerror;
  failure({ preventDefault() {} });
  failure({ preventDefault() {} });
  late({ data: { chunks: [new Uint8Array([0])] } });
  const blob = await pending;
  assert.ok(blob.size > 1000);
  assert.equal(loads, 1);
  assert.ok(yields > 1);
  assert.equal(h.stopped(), 1);
});
test("normal Worker encoding sends the mixed PCM only after readiness and cleans up", async () => {
  const h = workerHarness(),
    pcm = tone();
  const pending = encodeMP3(pcm, {
    workerFactory: () => h.worker,
    loadEncoder: () => {
      throw Error("unexpected fallback");
    },
  });
  assert.equal(h.sent(), undefined);
  h.worker.onmessage({ data: { ready: true } });
  assert.equal(h.sent().pcm, pcm);
  assert.equal(h.sent().rate, RATE);
  h.worker.onmessage({ data: { chunks: [new Uint8Array([1, 2, 3])] } });
  assert.deepEqual(
    new Uint8Array(await (await pending).arrayBuffer()),
    new Uint8Array([1, 2, 3]),
  );
  assert.equal(h.stopped(), 1);
});
test("unavailable fallback and encoding failures report failure and leave PCM intact", async () => {
  const pcm = tone();
  await assert.rejects(
    encodeMP3(pcm, {
      workerFactory() {
        throw Error("blocked");
      },
      loadEncoder: async () => {
        throw Error("offline");
      },
    }),
    /原音频仍保留/,
  );
  assert.equal(pcm.length, RATE);
  const h = workerHarness();
  const pending = encodeMP3(pcm, { workerFactory: () => h.worker });
  h.worker.onmessage({ data: { error: true } });
  await assert.rejects(pending, /编码未完成/);
  assert.equal(h.stopped(), 1);
});
test("a Worker that never becomes ready times out into fallback instead of hanging the download", async (t) => {
  const module = await import("../static/vendor/lame-encoder.mjs");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = workerHarness();
  const pending = encodeMP3(tone(), {
    workerFactory: () => h.worker,
    loadEncoder: async () => module,
    yieldToPage: async () => {},
  });
  t.mock.timers.tick(8000);
  assert.ok((await pending).size > 1000);
  assert.equal(h.stopped(), 1);
  t.mock.timers.reset();
});
