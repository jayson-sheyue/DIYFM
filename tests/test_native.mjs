import test from "node:test";
import assert from "node:assert/strict";
import {
  NativeAudio,
  transferBlob,
  detectTransport,
} from "../static/native.mjs";
import { wavBlob } from "../static/audio.mjs";
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
function fixture() {
  const calls = [];
  let status = {
    revision: 0,
    paused: true,
    id: "",
    title: "",
    time: 0,
    duration: 4,
  };
  const bridge = {
    async request(command, data = {}) {
      calls.push({ command, data });
      if (command === "file.begin") return { exists: true };
      if (command === "player.state") return { ...status };
      if (command.startsWith("player.") && data.revision >= status.revision) {
        status.revision = data.revision;
        if (command === "player.load") {
          const track = data.tracks.find((t) => t.id === data.selected);
          Object.assign(status, {
            id: track.id,
            title: track.title,
            paused: false,
          });
        }
        if (command === "player.pause") status.paused = true;
        if (command === "player.play") status.paused = false;
        if (command === "player.stop")
          Object.assign(status, { paused: true, id: "" });
      }
      return { ...status };
    },
  };
  const blob = wavBlob(new Float32Array(24000));
  const tracks = [];
  const audio = new NativeAudio(bridge, {
    fetcher: async () => new Response(blob),
    onTrack: (...args) => tracks.push(args),
  });
  return {
    audio,
    bridge,
    calls,
    tracks,
    blob,
    setStatus: (value) => Object.assign(status, value),
    getStatus: () => status,
  };
}
test("native channel playback prepares a self-contained queue and follows system track/pause changes", async () => {
  const f = fixture();
  f.audio.setContext({
    title: "原始标题",
    episodeId: "a",
    queue: [
      { id: "a", title: "原始标题", url: "blob:a" },
      { id: "b", title: "第二集", url: "blob:b" },
    ],
  });
  f.audio.src = "blob:a";
  f.audio.playbackRate = 1.25;
  await f.audio.play();
  const load = f.calls.find((c) => c.command === "player.load").data;
  assert.deepEqual(
    load.tracks.map((t) => t.id),
    ["a", "b"],
  );
  assert.equal(load.mode, "channel");
  assert.equal(load.rate, 1.25);
  assert.equal(f.audio.paused, false);
  f.setStatus({ id: "b", title: "第二集", time: 2, paused: true });
  await f.audio.poll();
  assert.equal(f.audio.currentTime, 2);
  assert.equal(f.audio.paused, true);
  assert.deepEqual(f.tracks.at(-1), ["b", "第二集"]);
  f.audio.loop = true;
  await Promise.resolve();
  assert.equal(f.calls.at(-1).data.mode, "single");
  await f.audio.play();
  assert.equal(f.calls.at(-1).command, "player.play");
  assert.equal(f.calls.filter((c) => c.command === "player.load").length, 1);
});
test("stop or A→B while a native transfer waits cannot let A start or overwrite B", async () => {
  const f = fixture(),
    gate = deferred(),
    entered = deferred(),
    original = f.bridge.request;
  let first = true;
  f.bridge.request = async (command, data) => {
    if (command === "file.begin" && first) {
      first = false;
      entered.resolve();
      await gate.promise;
    }
    return original(command, data);
  };
  f.audio.setContext({ title: "A" });
  f.audio.src = "blob:a";
  const a = f.audio.play();
  await entered.promise;
  f.audio.pause();
  f.audio.removeAttribute("src");
  f.audio.load();
  f.audio.setContext({ title: "B" });
  f.audio.src = "blob:b";
  await f.audio.play();
  gate.resolve();
  await a;
  const loads = f.calls.filter((c) => c.command === "player.load");
  assert.equal(loads.length, 1);
  assert.equal(loads[0].data.tracks[0].title, "B");
  assert.equal(f.audio.paused, false);
});
test("late native load replies and stale status cannot undo a newer stop", async () => {
  const f = fixture(),
    gate = deferred(),
    entered = deferred(),
    original = f.bridge.request;
  f.bridge.request = async (command, data) => {
    if (command === "player.load") {
      entered.resolve();
      await gate.promise;
    }
    return original(command, data);
  };
  f.audio.setContext({ title: "A" });
  f.audio.src = "blob:a";
  const pending = f.audio.play();
  await entered.promise;
  f.audio.pause();
  f.audio.removeAttribute("src");
  f.audio.load();
  gate.resolve();
  await pending;
  assert.equal(f.audio.paused, true);
  assert.equal(f.audio.loaded, false);
  assert.equal(f.tracks.length, 0);
  f.audio.apply({ revision: 1, paused: false, id: "a", title: "stale" });
  assert.equal(f.audio.paused, true);
});
test("file export chunks preserve exact bytes, commits only complete files and cancellation sends no data", async () => {
  const data = crypto.getRandomValues(new Uint8Array(60000));
  const blob = new Blob([data, data, data, data]);
  let bytes = [],
    length = 0,
    committed = false;
  const bridge = {
    async request(command, value) {
      if (command === "file.begin") return { ticket: "transfer" };
      if (command === "file.chunk") {
        assert.equal(value.offset, length);
        const part = Buffer.from(value.data, "base64");
        bytes.push(part);
        length += part.length;
        return { written: length };
      }
      if (command === "file.commit") {
        committed = true;
        assert.equal(length, blob.size);
        return {};
      }
    },
  };
  await transferBlob(bridge, blob, { kind: "export", name: "音声.mp3" });
  assert.equal(committed, true);
  assert.deepEqual(Buffer.concat(bytes), Buffer.from(await blob.arrayBuffer()));
  let calls = 0;
  assert.equal(
    await transferBlob(
      {
        request: async () => {
          calls++;
          return { cancelled: true };
        },
      },
      blob,
      { kind: "export", name: "backup.zip" },
    ),
    false,
  );
  assert.equal(calls, 1);
});
test("failed or stopped native transfers abort staging and never commit a partial result", async () => {
  const calls = [];
  const bridge = {
    async request(command) {
      calls.push(command);
      if (command === "file.begin") return { ticket: "transfer" };
      if (command === "file.chunk") throw Error("disk full");
      return {};
    },
  };
  await assert.rejects(
    transferBlob(bridge, new Blob(["source"]), {
      kind: "export",
      name: "a.mp3",
    }),
  );
  assert.equal(calls.at(-1), "file.abort");
  assert.ok(!calls.includes("file.commit"));
  calls.length = 0;
  await assert.rejects(
    transferBlob(bridge, new Blob(["source"]), {
      kind: "media",
      active: () => false,
    }),
    { name: "AbortError" },
  );
  assert.ok(!calls.includes("file.chunk"));
  assert.ok(!calls.includes("file.commit"));
});
test("web pages do not create or simulate native capabilities", () => {
  assert.equal(detectTransport({}), null);
});

test("deleted queue entries are excluded even when their file preparation was already in flight", async () => {
  const f = fixture(),
    gate = deferred(),
    entered = deferred(),
    original = f.bridge.request;
  let first = true;
  f.bridge.request = async (command, data) => {
    if (command === "file.begin" && first) {
      first = false;
      entered.resolve();
      await gate.promise;
    }
    return original(command, data);
  };
  f.audio.setContext({
    title: "A",
    episodeId: "a",
    queue: [
      { id: "a", title: "A", url: "blob:a" },
      { id: "b", title: "B", url: "blob:b" },
    ],
  });
  f.audio.src = "blob:a";
  const play = f.audio.play();
  await entered.promise;
  f.audio.reconcile(["a"]);
  gate.resolve();
  await play;
  assert.deepEqual(
    f.calls
      .find((c) => c.command === "player.load")
      .data.tracks.map((t) => t.id),
    ["a"],
  );
});
test("native preparation rejects remote media URLs before fetching or transferring any content", async () => {
  const f = fixture();
  let fetched = false;
  f.audio.fetcher = async () => {
    fetched = true;
    throw Error("unexpected");
  };
  f.audio.setContext({
    episodeId: "a",
    queue: [{ id: "a", url: "https://untrusted.invalid/audio.wav" }],
  });
  f.audio.src = "blob:a";
  await assert.rejects(f.audio.play(), /无法读取本机音频/);
  assert.equal(fetched, false);
  assert.ok(!f.calls.some((c) => c.command === "player.load"));
});

test("library reconciliation invalidates old system snapshots and clears removed current tracks", async () => {
  const f = fixture();
  f.audio.setContext({
    title: "A",
    episodeId: "a",
    queue: [{ id: "a", title: "A", url: "blob:a" }],
  });
  f.audio.src = "blob:a";
  await f.audio.play();
  const old = f.audio.serial,
    original = f.bridge.request;
  f.bridge.request = async (command, data) =>
    command === "player.reconcile"
      ? {
          revision: data.revision,
          id: data.ids.length ? "a" : "",
          title: "A",
          paused: true,
          time: 0,
          duration: 4,
        }
      : original(command, data);
  await f.audio.reconcile(["a"]);
  f.audio.apply({
    revision: old,
    id: "removed",
    title: "stale",
    paused: false,
    time: 2,
    duration: 4,
  });
  assert.deepEqual(f.tracks.at(-1), ["a", "A"]);
  assert.equal(f.audio.paused, true);
  await f.audio.reconcile([]);
  assert.equal(f.audio.loaded, false);
  assert.deepEqual(f.tracks.at(-1), [null, ""]);
});
