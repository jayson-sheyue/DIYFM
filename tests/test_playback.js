// Controlled races for the shared player; no browser/service calls.
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
function setup(initialStorage = {}) {
  const elements = new Map(),
    storage = new Map(Object.entries(initialStorage));
  const element = (id) => {
    if (!elements.has(id))
      elements.set(id, {
        id,
        value: id === "playback-speed" ? "1" : "Kore",
        dataset: {},
        hidden: false,
        innerHTML: "",
        textContent: "",
        paused: true,
        addEventListener() {},
        setAttribute(k, v) {
          this[k] = v;
        },
        removeAttribute(k) {
          delete this[k];
        },
        hasAttribute(k) {
          return k in this;
        },
        querySelectorAll() {
          return [];
        },
        load() {},
        pause() {
          this.paused = true;
        },
        play() {
          this.paused = false;
          return Promise.resolve();
        },
        classList: { toggle() {} },
      });
    return elements.get(id);
  };
  const ctx = {
    document: {
      getElementById: element,
      querySelectorAll: () => [],
      addEventListener() {},
    },
    localStorage: {
      getItem: (k) => storage.get(k),
      setItem: (k, v) => storage.set(k, v),
      removeItem: (k) => storage.delete(k),
    },
    fetch: () => new Promise(() => {}),
    AbortController,
    Blob,
    URL: {
      createObjectURL: () => `blob:${Math.random()}`,
      revokeObjectURL() {},
    },
    crypto: { randomUUID: () => `req_${Math.random()}` },
    confirm: () => true,
    window: { matchMedia: () => ({ matches: false }), scrollTo() {} },
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 1,
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync("static/app.js", "utf8"), ctx);
  vm.runInContext(
    "state.shows=[{id:'channel',language:'en',episodes:[]}];state.current='channel';state.settings={settings:{tts_model:'model'},effective_project_id:'project'}",
    ctx,
  );
  return { ctx, elements, storage, run: (s) => vm.runInContext(s, ctx) };
}
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const response = () => ({
  ok: true,
  headers: { get: () => new Date().toISOString() },
  blob: async () => new Blob(["audio"]),
});
test("A → B, with A last to finish, only B may set the audio source", async () => {
  const { ctx, run } = setup(),
    a = deferred(),
    b = deferred();
  let count = 0;
  ctx.fetch = () => (++count === 1 ? a.promise : b.promise);
  const first = run("previewVoice('host',false)"),
    second = run("previewVoice('guest',false)");
  b.resolve(response());
  await second;
  const owner = run("audio.src");
  a.resolve(response());
  await first;
  assert.equal(run("audio.src"), owner);
  assert.equal(run("state.tasks.filter(t=>t.status==='ready').length"), 2);
});
test("switching away while a preview waits preserves result but never starts playback", async () => {
  const { ctx, run } = setup(),
    a = deferred();
  ctx.fetch = () => a.promise;
  const request = run("previewVoice('host',false)");
  run("stopPlayback()");
  a.resolve(response());
  await request;
  assert.equal(run("audio.paused"), true);
  assert.equal(run('audio.hasAttribute("src")'), false);
  assert.equal(run("voiceCache.size"), 1);
});
test("A → B → A reuses A in flight while retaining the final playback intent", async () => {
  const { ctx, run } = setup(),
    a = deferred(),
    b = deferred();
  let calls = 0;
  ctx.fetch = () => (++calls === 1 ? a.promise : b.promise);
  const first = run("previewVoice('host',false)"),
    second = run("previewVoice('guest',false)"),
    last = run("previewVoice('host',false)");
  a.resolve(response());
  await Promise.all([first, last]);
  const owner = run("audio.src");
  b.resolve(response());
  await second;
  assert.equal(calls, 2);
  assert.equal(run("audio.src"), owner);
  await run("previewVoice('host',false)");
  assert.equal(calls, 2);
});
test("a late failure from A cannot replace B status or resume the old audio", async () => {
  const { ctx, run } = setup(),
    a = deferred(),
    b = deferred();
  let count = 0;
  ctx.fetch = () => (++count === 1 ? a.promise : b.promise);
  const first = run("previewVoice('host',false)"),
    second = run("previewVoice('guest',false)");
  b.resolve(response());
  await second;
  const src = run("audio.src");
  a.reject(new Error("old failure"));
  await first;
  assert.equal(run("audio.src"), src);
  assert.equal(run("state.notice"), null);
});
test("repeated regenerate clicks while pending share one new generation", async () => {
  const { ctx, run } = setup(),
    a = deferred();
  let calls = 0;
  ctx.fetch = () => {
    calls++;
    return a.promise;
  };
  const first = run("previewVoice('host',true)"),
    second = run("previewVoice('host',true)");
  a.resolve(response());
  await Promise.all([first, second]);
  assert.equal(calls, 1);
});
test("task history sorts local-offset and UTC timestamps by actual time", () => {
  const { run } = setup();
  run(
    "state.shows=[{id:'channel',episodes:[{id:'episode',created_at:'2026-11-05T11:10:00+08:00'}]}];state.tasks=[{id:'backup',created_at:'2026-11-05T03:19:00.000Z'}]",
  );
  assert.equal(run("inboxRows()[0].id"), "backup");
});
test("new channel draft retains sound choices and exposes them before first generation", () => {
  const { run, elements } = setup();
  run(
    "state.current=null;state.presets={languages:[{id:'en',label:'英语'}],difficulties:[{id:'basic',label:'基础'}],lengths:[{id:'SHORT',label:'5分钟'}],voices:[{id:'Zephyr',label:'Zephyr'},{id:'Charon',label:'Charon'}],music:[{id:'night_drive',label:'夜间'}]};writeLocal('draft:new',{language:'en',difficulty:'basic',wish:'室友趣事',host_voice:'Zephyr',guest_voice:'Charon',music_style:'night_drive'});renderStudio()",
  );
  assert.match(elements.get("studio").innerHTML, /id="first-sound"/);
  assert.match(elements.get("studio").innerHTML, /value="Zephyr" selected/);
  assert.match(elements.get("studio").innerHTML, /value="Charon" selected/);
  assert.match(
    elements.get("studio").innerHTML,
    /value="night_drive" selected/,
  );
  assert.equal(run("state.current"), null);
  for (const [id, value] of Object.entries({
    host: "Zephyr",
    guest: "Charon",
    music: "night_drive",
  }))
    elements.get(id).value = value;
  run("captureDraft()");
  assert.equal(run("loadDraft(null).host_voice"), "Zephyr");
  assert.equal(run("formValues().music_style"), "night_drive");
});
test("failed attempts stay in messages and never render as channel episodes", () => {
  const { run, elements } = setup();
  run(
    "state.shows[0].episodes=[{id:'failed',status:'failed',title:'old failure',error:'HTTP 429',created_at:'2026-11-05T10:00:00'},{id:'ready',status:'ready',title:'finished letter',created_at:'2026-11-05T11:00:00'},{id:'active',status:'generating',title:'current production',created_at:'2026-11-05T12:00:00'}];renderEpisodes()",
  );
  const main = elements.get("episode-mount").innerHTML;
  assert.match(main, /finished letter/);
  assert.match(main, /current production/);
  assert.doesNotMatch(main, /old failure|HTTP 429|重试本期/);
  run("state.inboxTask='failed';renderInbox()");
  assert.match(elements.get("inbox-list").innerHTML, /old failure/);
  assert.match(elements.get("inbox-list").innerHTML, /HTTP 429/);
  assert.match(
    elements.get("inbox-list").innerHTML,
    /data-retry-task="failed"/,
  );
  assert.equal(run("state.shows[0].episodes.length"), 3);
});
test("message retry targets its own channel without changing the channel being viewed", async () => {
  const { run, ctx } = setup();
  run(
    "state.shows.push({id:'other',revision:7,language:'ja',episodes:[{id:'failed_other',status:'failed'}]})",
  );
  const calls = [];
  ctx.fetch = async (path, config) => {
    calls.push({ path, body: JSON.parse(config.body) });
    return {
      ok: true,
      json: async () => ({
        episode: { status: "generating" },
        show: {
          id: "other",
          revision: 7,
          language: "ja",
          episodes: [{ id: "retry_job", status: "generating" }],
        },
      }),
    };
  };
  await run("makeEpisode('failed_other','other')");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/api/shows/other/episodes");
  assert.equal(calls[0].body.retry_episode_id, "failed_other");
  assert.equal(calls[0].body.revision, 7);
  assert.equal(run("state.current"), "channel");
});
test("voice preview works before a channel exists and uses the selected language", async () => {
  const { ctx, run, elements } = setup();
  run("state.current=null;writeLocal('draft:new',{language:'ja'})");
  elements.set("language", { value: "ja" });
  elements.set("host", { value: "Zephyr" });
  let request;
  ctx.fetch = async (path, config) => {
    request = { path, body: JSON.parse(config.body) };
    return response();
  };
  await run("previewVoice('host',false)");
  assert.equal(request.path, "/api/voices/preview");
  assert.equal(request.body.language, "ja");
  assert.equal(request.body.voice, "Zephyr");
  assert.equal(run("state.current"), null);
});

test("deleting a playing episode clears audio, its messages and transcript while retaining preferences", async () => {
  const { ctx, run, elements } = setup();
  run(
    "state.shows[0].revision=0;state.shows[0].wish='keep wish';state.shows[0].episodes=[{id:'one',title:'first letter',status:'ready'},{id:'two',title:'second letter',status:'ready'}];state.tasks=[{id:'download_one',kind:'download',episodeId:'one',showId:'channel'},{id:'download_two',kind:'download',episodeId:'two',showId:'channel'}];state.transcripts.set('one','cached script');state.opened.add('one');playback.episodeId='one';audio.src='/api/episodes/one/audio';audio.paused=false",
  );
  run("$('wish-form').dataset.revision='0';$('wish').value='keep wish'");
  ctx.fetch = async () => ({
    ok: true,
    json: async () => ({
      show: {
        id: "channel",
        revision: 1,
        wish: "keep wish",
        episodes: [{ id: "two", status: "ready", title: "second letter" }],
      },
    }),
  });
  await run("deleteEpisode('one')");
  assert.equal(run("audio.hasAttribute('src')"), false);
  assert.equal(run("state.transcripts.has('one')"), false);
  assert.equal(run("state.opened.has('one')"), false);
  assert.equal(run("state.tasks.length"), 1);
  assert.equal(run("state.tasks[0].episodeId"), "two");
  assert.equal(run("currentShow().wish"), "keep wish");
  assert.equal(run("loadDraft(currentShow()).revision"), 1);
  assert.doesNotMatch(elements.get("episode-mount").innerHTML, /first letter/);
  assert.match(elements.get("episode-mount").innerHTML, /second letter/);
});
test("cancelled or rejected deletion preserves the library and playing result", async () => {
  const { ctx, run } = setup();
  let requests = 0;
  run(
    "state.shows[0].episodes=[{id:'one',title:'letter',status:'ready'}];playback.episodeId='one';audio.src='saved.wav'",
  );
  ctx.fetch = async () => {
    requests++;
    return {
      ok: false,
      status: 409,
      json: async () => ({ message: "制作完成后可以删除" }),
    };
  };
  ctx.confirm = () => false;
  await run("deleteEpisode('one')");
  assert.equal(requests, 0);
  ctx.confirm = () => true;
  await run("deleteEpisode('one')");
  assert.equal(run("currentShow().episodes.length"), 1);
  assert.equal(run("audio.src"), "saved.wav");
  assert.equal(run("state.deleting.size"), 0);
  assert.match(run("state.notice.message"), /制作完成/);
});
test("late polling cannot resurrect a channel deleted while the user changed channels", async () => {
  const { ctx, run } = setup(),
    snapshot = deferred(),
    deletion = deferred();
  run(
    "state.shows.push({id:'other',episodes:[]});writeLocal('draft:channel',{wish:'remove this draft'});writeLocal('pending:channel',{request_id:'old'});state.tasks=[{id:'preview',showId:'channel',kind:'voice'},{id:'music',showId:'channel',kind:'bgm',status:'generating',style:'shared'}]",
  );
  ctx.fetch = (path, config) =>
    config?.method === "DELETE" ? deletion.promise : snapshot.promise;
  const polling = run("poll()"),
    removing = run("deleteChannel()");
  // Navigation is permitted while deletion is pending, without losing the new page.
  run("state.current='other'");
  deletion.resolve({ ok: true, json: async () => ({ ok: true }) });
  await removing;
  snapshot.resolve({
    ok: true,
    json: async () => ({
      shows: [
        { id: "channel", episodes: [] },
        { id: "other", episodes: [] },
      ],
    }),
  });
  await polling;
  assert.equal(run("state.shows.some(s=>s.id==='channel')"), false);
  assert.equal(run("state.current"), "other");
  assert.equal(run("readLocal('draft:channel',null)"), null);
  assert.equal(run("readLocal('pending:channel',null)"), null);
  assert.equal(run("state.tasks.length"), 1);
  assert.equal(run("state.tasks[0].showId"), null);
  assert.equal(run("state.tasks[0].kind"), "bgm");
});
test("deleting the selected channel does not recreate its saved draft during navigation", async () => {
  const { ctx, run } = setup();
  run(
    "state.presets={languages:[],difficulties:[],lengths:[],voices:[],music:[]};writeLocal('draft:channel',{wish:'old draft'})",
  );
  ctx.fetch = async () => ({ ok: true, json: async () => ({ ok: true }) });
  await run("deleteChannel()");
  assert.equal(run("state.current"), null);
  assert.equal(run("readLocal('draft:channel',null)"), null);
  assert.equal(run("state.shows.length"), 0);
});

function playlist(run) {
  run(
    "state.shows=[{id:'channel',episodes:[{id:'new',status:'ready',title:'New letter',url:'/new.wav'},{id:'failed',status:'failed',title:'Failed'},{id:'pending',status:'generating',title:'Pending'},{id:'old',status:'ready',title:'Old letter',url:'/old.wav'}]},{id:'other',episodes:[{id:'elsewhere',status:'ready',url:'/other.wav'}]}];state.current='channel'",
  );
}
test("channel playback follows ready list order and wraps within its own channel", async () => {
  const { run } = setup();
  playlist(run);
  await run("playSource('/new.wav','New letter',claimPlayback(),'new')");
  run("audio.ended=true");
  await run("audio.onended()");
  assert.equal(run("playback.episodeId"), "old");
  assert.equal(run("audio.src"), "/old.wav");
  run("audio.ended=true");
  await run("audio.onended()");
  assert.equal(run("playback.episodeId"), "new");
  assert.equal(run("audio.loop"), false);
});
test("single looping applies immediately without changing source, time, speed or pause state", async () => {
  const { run } = setup();
  playlist(run);
  await run("playSource('/new.wav','New letter',claimPlayback(),'new')");
  run(
    "audio.currentTime=12;audio.playbackRate=.75;audio.pause();setPlaybackMode('single')",
  );
  assert.equal(run("audio.loop"), true);
  assert.equal(run("audio.src"), "/new.wav");
  assert.equal(run("audio.currentTime"), 12);
  assert.equal(run("audio.playbackRate"), 0.75);
  assert.equal(run("audio.paused"), true);
  run('setPlaybackMode("channel")');
  assert.equal(run("audio.loop"), false);
  assert.equal(run("audio.paused"), true);
});
test("one ready episode repeats in channel mode and preserves the selected speed", async () => {
  const { run } = setup();
  run(
    "state.shows[0].episodes=[{id:'only',status:'ready',title:'Only letter',url:'/only.wav'}];$('playback-speed').value='0.75'",
  );
  await run("playSource('/only.wav','Only letter',claimPlayback(),'only')");
  run("audio.ended=true");
  await run("audio.onended()");
  assert.equal(run("playback.episodeId"), "only");
  assert.equal(run("audio.playbackRate"), 0.75);
});
test("preview audio never loops or enters the channel queue", async () => {
  const { run } = setup();
  playlist(run);
  run("setPlaybackMode('single')");
  await run(
    "playSource(new Blob(['preview']),'Voice preview',claimPlayback())",
  );
  assert.equal(run("audio.loop"), false);
  const token = run("playback.token");
  run("audio.ended=true");
  await run("audio.onended()");
  assert.equal(run("playback.token"), token);
  assert.equal(run("playback.episodeId"), null);
});
test("stale ended events and pauses cannot replace a new intent or restart stopped playback", async () => {
  const { ctx, run } = setup();
  playlist(run);
  await run(
    "playSource('/new.wav','New letter',claimPlayback(),'new');savedEnd=audio.onended",
  );
  await run("playSource('/old.wav','Old letter',claimPlayback(),'old')");
  run("audio.ended=true");
  await run("savedEnd()");
  assert.equal(run("playback.episodeId"), "old");
  run("audio.ended=false;audio.pause()");
  await run("audio.onended()");
  assert.equal(run("audio.paused"), true);
  run("stopPlayback();audio.ended=true");
  await run("savedEnd()");
  assert.equal(run("playback.episodeId"), null);
  assert.equal(run("audio.onended"), null);
});
test("removed playing episode stops looping and a removed next episode is skipped", async () => {
  const { run } = setup();
  playlist(run);
  await run("playSource('/new.wav','New letter',claimPlayback(),'new')");
  run(
    "state.shows[0].episodes=state.shows[0].episodes.filter(e=>e.id!=='old');audio.ended=true",
  );
  await run("audio.onended()");
  assert.equal(run("playback.episodeId"), "new");
  run(
    "setPlaybackMode('single');state.shows[0].episodes=[];reconcilePlayback()",
  );
  assert.equal(run("audio.loop"), false);
  assert.equal(run('audio.hasAttribute("src")'), false);
});
test("playback mode is restored after reload with a safe default for invalid saved values", () => {
  const { run, storage } = setup();
  run("setPlaybackMode('single')");
  assert.equal(storage.get("diyfm:playback-mode"), '"single"');
  const restored = setup(Object.fromEntries(storage));
  assert.equal(restored.run("state.playbackMode"), "single");
  assert.equal(
    setup({ "diyfm:playback-mode": '"unexpected"' }).run("state.playbackMode"),
    "channel",
  );
});
