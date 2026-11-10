"use strict";
const i18n = globalThis.DIYFM_I18N;
const tr = (key, values) => (i18n ? i18n.t(key, values) : key);
const trText = (parts, ...values) =>
  i18n
    ? i18n.msg(parts, ...values)
    : parts.reduce((s, p, i) => s + p + (values[i] ?? ""), "");
const trHTML = (parts, ...values) =>
  i18n
    ? i18n.html(parts, ...values)
    : parts.reduce((s, p, i) => s + p + (values[i] ?? ""), "");
const localizedLabels = (labels) =>
  new Proxy(labels, { get: (target, key) => tr(target[key]) });
const runtime = globalThis.DIYFM;
const fmFetch = (path, config) =>
  runtime ? runtime.fetch(path, config) : fetch(path, config);
const $ = (id) => document.getElementById(id);
const escapeHtml = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const PHASE = localizedLabels({
  plan: "正在理解愿望、策划来信",
  research: "正在搜索和核对背景",
  script: "正在写双人台本",
  review: "正在检查故事与语言",
  voice: "正在合成双人语音",
  music: "正在准备底乐",
  mix: "正在混音",
  interrupted: "制作已中断",
});
const LANG = localizedLabels({ en: "英语", ja: "日语" });
const LEVEL = localizedLabels({
  beginner: "入门",
  basic: "基础",
  advanced: "进阶",
});
const TOPICS = [
  ["生活趣事", "想听日常生活里有点离谱的小事，轻松好笑，但不要幼稚。"],
  ["恋爱与友情", "想听朋友相处和感情里的小误会，温暖一点，不要说教。"],
  ["职场见闻", "想听同事之间的尴尬小事，有幽默感，不要职场成功学。"],
  ["来点意外", "帮我选一个意想不到但容易听懂的生活来信话题。"],
];
function icon(name) {
  const paths = {
    letter:
      '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m3 6 9 7 9-7"/>',
    heart:
      '<path d="M20 5c-3-3-6-1-8 1-2-2-5-4-8-1-4 4 1 10 8 15 7-5 12-11 8-15Z"/>',
    case: '<rect x="3" y="7" width="18" height="14" rx="3"/><path d="M8 7V4h8v3M3 12c6 4 12 4 18 0M12 12v4"/>',
    spark:
      '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5ZM20 2v4M18 4h4"/>',
    trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
    headphones:
      '<path d="M4 14v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="12" width="5" height="9" rx="2"/><rect x="16" y="12" width="5" height="9" rx="2"/>',
  };
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.letter}</svg>`;
}
function readLocal(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem("diyfm:" + key)) ?? fallback;
  } catch (_) {
    return fallback;
  }
}
function writeLocal(key, value) {
  try {
    if (value === null) localStorage.removeItem("diyfm:" + key);
    else localStorage.setItem("diyfm:" + key, JSON.stringify(value));
  } catch (_) {
    /* Server-saved results remain available. */
  }
}
const state = {
  shows: [],
  presets: null,
  current: null,
  view: "studio",
  tab: "listen",
  settings: null,
  notice: null,
  conflict: null,
  submitting: false,
  saving: false,
  polling: false,
  inbox: false,
  inboxTask: null,
  signature: "",
  tasks: readLocal("tasks", []),
  transcripts: new Map(),
  opened: new Set(),
  settingsDirty: false,
  deleting: new Set(),
  libraryVersion: 0,
  playbackMode:
    readLocal("playback-mode", "channel") === "single" ? "single" : "channel",
};
state.tasks = state.tasks.map((t) =>
  t.status === "generating" && t.kind !== "bgm"
    ? {
        ...t,
        status: "unknown",
        error:
          t.kind === "voice"
            ? tr("页面曾刷新，试听等待已结束。再次试听会优先使用本浏览器缓存。")
            : tr("页面曾刷新，请重新确认下载结果，已有作品仍保留。"),
      }
    : t,
);
const nativeClient = globalThis.DIYFM_NATIVE;
const audio = nativeClient
  ? nativeClient.createAudio($("shared-audio"), {
      translate: tr,
      onTrack: (id, title) => {
        playback.episodeId = id;
        if (!id) $("player").hidden = true;
        $("player-title").textContent = title;
        updatePlayButtons();
      },
    })
  : $("shared-audio");
const playback = { token: 0, url: "", episodeId: null, waiting: false };
const voiceCache = new Map(),
  voiceInflight = new Map(),
  voiceEpoch = new Map(),
  voiceForce = new Set(),
  bgmCache = new Map();
const currentShow = () => state.shows.find((s) => s.id === state.current);
const generating = (s) =>
  (s?.episodes || []).find((e) => e.status === "generating");
const durationLabel = (n) =>
  trText`${Math.floor(n / 60)}分${String(Math.round(n) % 60).padStart(2, "0")}秒`;
const formatDate = (s) => {
  const d = new Date(s);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleString(i18n?.locale() || "en", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
};
const options = (items, selected) =>
  items
    .map(
      (i) =>
        `<option value="${escapeHtml(i.id)}" ${i.id === selected ? "selected" : ""}>${escapeHtml(tr(i.label))}</option>`,
    )
    .join("");
function uid() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}
async function api(path, config = {}) {
  const controller = new AbortController(),
    timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const r = await fmFetch(path, { ...config, signal: controller.signal });
    const body = await r.json();
    if (!r.ok) {
      const e = new Error(body.message || trText`请求失败（${r.status}）`);
      e.status = r.status;
      e.show = body.show;
      throw e;
    }
    return body;
  } catch (e) {
    if (e.name === "AbortError")
      throw new Error(
        tr("连接等待超时。输入已保留，可在消息中查看任务后重试。"),
      );
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}
const jsonRequest = (method, body) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
function notice(message, tone = "error") {
  state.notice = { message, tone };
  renderStatus();
}
function replaceShow(show) {
  state.libraryVersion++;
  const i = state.shows.findIndex((s) => s.id === show.id);
  if (i < 0) state.shows.unshift(show);
  else state.shows[i] = show;
  reconcilePlayback();
  nativeClient?.prune();
  renderSidebar();
  renderStatus();
}
function draftKey() {
  return state.current || "new";
}
function formValues() {
  return {
    title: $("channel-title")?.value.trim() || currentShow()?.title || "",
    language: $("language")?.value || "en",
    difficulty: $("difficulty")?.value || "basic",
    wish: $("wish")?.value.trim() || "",
    length: $("length")?.value || "SHORT",
    host_voice: $("host")?.value || currentShow()?.host_voice || "Kore",
    guest_voice: $("guest")?.value || currentShow()?.guest_voice || "Puck",
    music_style:
      $("music")?.value || currentShow()?.music_style || "morning_acoustic",
    revision: Number($("wish-form")?.dataset.revision || 0),
  };
}
function captureDraft() {
  if (!$("wish-form")) return;
  writeLocal("draft:" + draftKey(), {
    ...formValues(),
    wish: $("wish")?.value || "",
    ...($("channel-title") ? { title: $("channel-title").value } : {}),
    episode_wish: $("episode-wish")?.value || "",
  });
}
function loadDraft(show) {
  return {
    language: show?.language || "en",
    difficulty: show?.difficulty || "basic",
    wish: show?.wish || "",
    length: show?.length || "SHORT",
    title: show?.title || "",
    revision: show?.revision || 0,
    host_voice: show?.host_voice || "Kore",
    guest_voice: show?.guest_voice || "Puck",
    music_style: show?.music_style || "morning_acoustic",
    ...(readLocal("draft:" + (show?.id || "new"), null) || {}),
  };
}
function stopPlayback() {
  ++playback.token;
  audio.onended = null;
  audio.loop = false;
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  if (playback.url) URL.revokeObjectURL(playback.url);
  playback.url = "";
  playback.episodeId = null;
  playback.waiting = false;
  $("player").hidden = true;
  updatePlayButtons();
}
function claimPlayback() {
  stopPlayback();
  return playback.token;
}
async function playSource(source, title, token, episodeId = null) {
  if (token !== playback.token) return;
  if (source instanceof Blob) {
    playback.url = URL.createObjectURL(source);
    source = playback.url;
  }
  audio.setContext?.({
    title,
    episodeId,
    queue: episodeId
      ? (
          state.shows.find((s) =>
            (s.episodes || []).some((e) => e.id === episodeId),
          )?.episodes || []
        )
          .filter((e) => e.status === "ready" && e.url)
          .map((e) => ({ id: e.id, title: e.title, url: e.url }))
      : [],
  });
  audio.src = source;
  audio.playbackRate = Number($("playback-speed").value);
  playback.episodeId = episodeId;
  audio.onended = nativeClient ? null : () => advanceEpisode(token, episodeId);
  syncPlaybackMode();
  playback.waiting = false;
  audio.hidden = false;
  $("stop-player").textContent = tr("停止播放");
  $("player").hidden = false;
  $("player-title").textContent = title;
  try {
    await audio.play();
    if (token === playback.token) updatePlayButtons();
  } catch (e) {
    if (token === playback.token)
      notice(
        nativeClient
          ? e.message
          : tr("音频已就绪，但浏览器没有播放。可在下方播放器重试。"),
      );
  }
}
function playbackModeOptions() {
  return options(
    [
      { id: "single", label: tr("单曲循环") },
      { id: "channel", label: tr("频道内连播") },
    ],
    state.playbackMode,
  );
}
function setPlaybackMode(mode) {
  if (!["single", "channel"].includes(mode)) return;
  state.playbackMode = mode;
  writeLocal("playback-mode", mode);
  syncPlaybackMode();
}
function syncPlaybackMode() {
  audio.loop = !!playback.episodeId && state.playbackMode === "single";
  document.querySelectorAll("[data-playback-mode]").forEach((select) => {
    select.value = state.playbackMode;
    select.onchange = () => setPlaybackMode(select.value);
  });
  $("playback-mode").title = playback.episodeId
    ? tr("频道内按来信列表顺序连播，最后一集回到第一集")
    : tr("播放模式仅用于已完成的来信，试听只播放一次");
}
function reconcilePlayback() {
  if (
    playback.episodeId &&
    !state.shows.some((s) =>
      (s.episodes || []).some(
        (ep) => ep.id === playback.episodeId && ep.status === "ready",
      ),
    )
  )
    stopPlayback();
  audio.reconcile?.(
    state.shows.flatMap((show) =>
      (show.episodes || [])
        .filter((ep) => ep.status === "ready")
        .map((ep) => ep.id),
    ),
  );
}
async function advanceEpisode(token, episodeId) {
  // Stale media events, pauses, stops and previews must never start a playlist.
  if (
    token !== playback.token ||
    !episodeId ||
    playback.episodeId !== episodeId ||
    !audio.ended
  )
    return;
  if (state.playbackMode === "single") return; // Native media looping retains the current source.
  const show = state.shows.find((s) =>
    (s.episodes || []).some((ep) => ep.id === episodeId),
  );
  const queue = (show?.episodes || []).filter(
    (ep) => ep.status === "ready" && ep.url,
  );
  const index = queue.findIndex((ep) => ep.id === episodeId);
  if (index < 0) {
    stopPlayback();
    return;
  }
  const next = queue[(index + 1) % queue.length];
  const nextToken = claimPlayback();
  await playSource(next.url, next.title, nextToken, next.id);
}
function updatePlayButtons() {
  document.querySelectorAll("[data-play]").forEach((b) => {
    b.textContent =
      b.dataset.play === playback.episodeId && !audio.paused
        ? tr("暂停")
        : tr("播放");
  });
}
$("stop-player").onclick = () => {
  const waiting = playback.waiting;
  stopPlayback();
  if (waiting)
    notice(
      tr("已停止等待。已发出的 Google 请求仍可能继续，结果可在消息中查看。"),
      "info",
    );
};
$("playback-speed").onchange = () => {
  audio.playbackRate = Number($("playback-speed").value);
};
$("playback-mode").innerHTML = playbackModeOptions();
syncPlaybackMode();
audio.addEventListener("play", updatePlayButtons);
audio.addEventListener("pause", updatePlayButtons);
audio.addEventListener("error", () => {
  if (audio.hasAttribute("src"))
    notice(tr("音频暂时无法播放，请检查文件或网络后重试。"));
});
function openShow(id, { saveDraft = true } = {}) {
  if (saveDraft) captureDraft();
  stopPlayback();
  state.current = id;
  state.tab = "listen";
  state.view = "studio";
  state.notice = null;
  state.conflict = null;
  writeLocal("current", id);
  showView();
  renderSidebar();
  renderStudio();
  $("studio").scrollTop = 0;
  if (window.matchMedia("(max-width:720px)").matches) window.scrollTo(0, 0);
}
function setView(view) {
  captureDraft();
  stopPlayback();
  state.view = view;
  state.notice = null;
  showView();
  if (view === "settings" && !state.settingsDirty)
    loadSettings().catch((e) => notice(e.message));
  renderStatus();
  if (view === "resources") sharingUI?.enter();
}
function showView() {
  $("studio").hidden = state.view !== "studio";
  $("settings-view").hidden = state.view !== "settings";
  $("resources-view").hidden = state.view !== "resources";
  $("nav-studio").classList.toggle("is-on", state.view === "studio");
  $("nav-settings").classList.toggle("is-on", state.view === "settings");
  $("nav-resources").classList.toggle("is-on", state.view === "resources");
}
function renderSidebar() {
  $("show-list").innerHTML = state.shows.length
    ? state.shows
        .map(
          (s) =>
            `<li><button type="button" class="${s.id === state.current ? "active" : ""}" data-channel="${escapeHtml(s.id)}"><span class="station-monogram" aria-hidden="true">${s.language === "ja" ? "JP" : "EN"}</span><span class="station-caption"><strong>${escapeHtml(s.title)}</strong><small>${LANG[s.language] || tr("英语")} · ${generating(s) ? tr("制作中") : trText`${(s.episodes || []).filter((e) => e.status === "ready").length} 集可听`}</small></span></button></li>`,
        )
        .join("")
    : trHTML(['<li class="rack-empty">你的频道会保存在这里。</li>']);
  document
    .querySelectorAll("[data-channel]")
    .forEach((b) => (b.onclick = () => openShow(b.dataset.channel)));
}
function renderStudio() {
  const show = currentShow(),
    d = loadDraft(show),
    fresh = !show;
  $("studio").innerHTML = `
        <header class="radio-heading"><div><p class="eyebrow">${fresh ? tr("LETTERS, JUST FOR YOUR EARS") : tr("YOUR OWN FREQUENCY")}</p>
        ${fresh ? trHTML(["<h1>听一封来信，<br>走进另一种语言。</h1>"]) : `<h1>${escapeHtml(show.title)}</h1>`}
        <p class="intro">${fresh ? tr("两位主持，一封虚构来信。让日常里的小意外，成为今天想听的故事。") : tr("频道记住你的口味，每一集都是新的来信。")}</p></div>
        <img class="station-art" src="./letter-radio.svg" alt="" width="260" height="188"></header>
        ${
          fresh
            ? ""
            : trHTML`<div class="channel-toolbar">
                <nav class="tabs" aria-label="频道页面">
                  <button
                    type="button"
                    data-tab="listen"
                    class="${state.tab === "listen" ? "is-on" : ""}"
                  >
                    收听与偏好</button
                  ><button
                    type="button"
                    data-tab="voice"
                    class="${state.tab === "voice" ? "is-on" : ""}"
                  >
                    声音设置
                  </button>
                </nav>
                <button type="button" class="quiet" id="share-channel" ${(show.episodes || []).some(e => e.status === "ready") ? "" : "disabled"}>${tr("分享频道")}</button>
                <button
                  type="button"
                  class="delete-control"
                  id="delete-channel"
                >
                  ${icon("trash")}删除频道
                </button>
              </div>`
        }
        ${show?.provenance ? sourceCredit(show.provenance) : ""}
        <div id="channel-body">${
          state.tab === "voice" && show
            ? ""
            : trHTML`
                <form
                  id="wish-form"
                  class="wish-card"
                  data-revision="${d.revision}"
                >
                  <div class="wish-top">
                    <label for="language">想听什么语言？</label
                    ><select id="language">
                      ${options(state.presets.languages, d.language)}
                    </select>
                  </div>
                  <label for="wish" class="wish-label"
                    >${
                      fresh ? tr("想听点什么？") : tr("这个频道，想听点什么？")
                    }</label
                  >
                  <textarea
                    id="wish"
                    rows="3"
                    maxlength="1200"
                    placeholder="比如：想听日本职场里的尴尬小事，轻松好笑一点，日语别太难。"
                  ></textarea>
                  <div class="topic-chips" aria-label="选题灵感">
                    ${TOPICS.map(
                      ([label], i) =>
                        `<button type="button" class="topic-chip" data-topic="${i}">${icon(["letter", "heart", "case", "spark"][i])}${escapeHtml(tr(label))}</button>`,
                    ).join("")}
                  </div>
                  <div class="listening-options">
                    <label for="difficulty"
                      >收听难度
                      <select id="difficulty">
                        ${options(state.presets.difficulties, d.difficulty)}
                      </select></label
                    >
                    <label for="length"
                      >大约听多久
                      <select id="length">
                        ${options(state.presets.lengths, d.length)}
                      </select></label
                    >
                  </div>
                  <p class="understanding" id="understanding"></p>
                  ${
                    fresh
                      ? trHTML`<details class="first-sound" id="first-sound">
                        <summary>
                          声音与底乐 <span>首次制作前也可以选择、试听</span>
                        </summary>
                        ${voiceFields(d)}
                      </details>`
                      : ""
                  }
                  ${
                    fresh
                      ? ""
                      : trHTML`<label for="episode-wish" class="episode-wish-label"
                          >这期换个口味 <span>可选，只影响这一集</span></label
                        ><input
                          id="episode-wish"
                          maxlength="600"
                          value="${escapeHtml(d.episode_wish || "")}"
                          placeholder="比如：今天温暖一点，不聊工作"
                        />`
                  }
                  <div class="wish-actions">
                    <p class="hint">
                      ${
                        fresh
                          ? tr("没有想法也没关系，可以直接开始。")
                          : tr("偏好会保存，已生成的节目会保存在本浏览器。")
                      }
                    </p>
                    <div>
                      ${
                        fresh
                          ? ""
                          : trHTML([
                              '<button class="quiet" type="button" id="save-channel">保存偏好</button>',
                            ])
                      }<button class="primary" id="make" type="submit">
                        ${fresh ? tr("开始收听") : tr("制作新一期")}
                      </button>
                    </div>
                  </div>
                  ${
                    fresh
                      ? ""
                      : trHTML`<details class="channel-management">
                        <summary>修改频道名称</summary>
                        <label
                          >频道名称<input
                            id="channel-title"
                            maxlength="80"
                            value="${escapeHtml(d.title)}"
                        /></label>
                      </details>`
                  }
                </form>
                ${
                  fresh
                    ? trHTML`<div class="quiet-notes">
                      <span>${icon("letter")}原创虚构来信</span
                      ><span>${icon("headphones")}按难度编排</span
                      ><span>${icon("spark")}自动保存 · 可下载</span>
                    </div>`
                    : trHTML`<section class="episode-section">
                      <div class="section-heading">
                        <h2>频道里的来信</h2>
                        <label class="mode-control"
                          >播放模式<select
                            id="channel-playback-mode"
                            data-playback-mode
                            title="频道内按来信列表顺序连播，最后一集回到第一集"
                          >
                            ${playbackModeOptions()}
                          </select></label
                        >
                      </div>
                      <div id="episode-mount"></div>
                    </section>`
                }
              `
        }</div>`;
  document.querySelectorAll("[data-tab]").forEach(
    (b) =>
      (b.onclick = () => {
        captureDraft();
        stopPlayback();
        state.tab = b.dataset.tab;
        renderStudio();
      }),
  );
  if ($("delete-channel")) $("delete-channel").onclick = () => deleteChannel();
  if ($("share-channel")) $("share-channel").onclick = () => sharingUI?.share();
  if (state.tab === "voice" && show) {
    renderVoice(show);
    renderStatus();
    return;
  }
  $("wish").value = d.wish;
  $("wish-form").onsubmit = (e) => {
    e.preventDefault();
    makeEpisode();
  };
  $("wish-form").addEventListener("input", () => {
    captureDraft();
    renderUnderstanding();
  });
  $("wish-form").addEventListener("change", () => {
    captureDraft();
    renderUnderstanding();
  });
  document.querySelectorAll("[data-topic]").forEach(
    (b) =>
      (b.onclick = () => {
        $("wish").value = tr(TOPICS[Number(b.dataset.topic)][1]);
        captureDraft();
        renderUnderstanding();
        $("wish").focus();
      }),
  );
  if ($("save-channel")) $("save-channel").onclick = () => saveChannel();
  if (fresh) bindVoiceControls(null);
  renderUnderstanding();
  syncPlaybackMode();
  renderEpisodes();
  renderStatus();
  renderConflict();
}
function renderUnderstanding() {
  if (!$("understanding")) return;
  const f = formValues();
  $("wish").placeholder =
    f.language === "ja"
      ? tr("比如：想听日本职场里的尴尬小事，轻松好笑一点，日语别太难。")
      : tr("比如：想听室友之间的生活误会，轻松好笑一点，英语别太难。");
  $("understanding").textContent =
    trText`${LANG[f.language]} · ${LEVEL[f.difficulty]} · 虚构来信电台。制作时会根据你的愿望编排故事。`;
}
function renderStatus() {
  const job = generating(currentShow());
  let msg = state.notice;
  if (!msg)
    msg = job
      ? {
          message: trText`${PHASE[job.phase] || tr("正在制作")}。可以在应用内换页，进度与结果都在「消息」中。请保持此网页打开。`,
          tone: "busy",
        }
      : {
          message:
            state.view === "settings"
              ? tr("配置保存在本浏览器，新任务使用新配置。")
              : currentShow()
                ? tr("想听的时候，制作新一期。已有节目可以反复播放。")
                : tr("选择语言，说说想听什么，就能开始。"),
          tone: "info",
        };
  $("status-text").textContent = tr(msg.message);
  $("statusbar").dataset.tone = msg.tone;
  $("status-dismiss").hidden = msg.tone !== "error";
  const make = $("make");
  if (make) {
    make.disabled =
      state.submitting ||
      state.saving ||
      state.deleting.size > 0 ||
      !!job ||
      !!state.conflict;
    make.textContent = state.submitting
      ? tr("正在开始…")
      : job
        ? tr("正在制作…")
        : currentShow()
          ? tr("制作新一期")
          : tr("开始收听");
  }
  if ($("save-channel"))
    $("save-channel").disabled =
      state.saving || state.submitting || state.deleting.size > 0;
  if ($("delete-channel")) {
    $("delete-channel").disabled =
      state.deleting.size > 0 || state.saving || state.submitting || !!job;
    $("delete-channel").title = job
      ? tr("制作完成后可以删除频道")
      : tr("删除频道及其全部来信和音频");
  }
  renderInbox();
}
function renderConflict() {
  const c = state.conflict,
    bar = $("conflict-bar");
  bar.hidden = !c;
  if (!c) return;
  bar.innerHTML = trHTML`<p>${escapeHtml(tr(c.message))} 当前输入仍保留。</p>
    <div class="fold-actions">
      <button type="button" class="quiet" id="reload-channel">
        重新载入已保存版本</button
      ><button type="button" class="quiet" id="overwrite-channel">
        用当前输入覆盖
      </button>
    </div>`;
  $("reload-channel").onclick = () => {
    writeLocal("draft:" + state.current, null);
    replaceShow(c.show);
    state.conflict = null;
    renderStudio();
  };
  $("overwrite-channel").onclick = () => saveChannel(true);
}
async function saveChannel(overwrite = false, quiet = false) {
  const show = currentShow();
  if (!show || state.saving || state.deleting.size) return false;
  const id = show.id,
    values = formValues();
  captureDraft();
  state.saving = true;
  renderStatus();
  try {
    const revision = overwrite ? state.conflict.show.revision : values.revision;
    const { show: saved } = await api(
      `/api/shows/${id}`,
      jsonRequest("PATCH", { ...values, revision }),
    );
    replaceShow(saved);
    state.conflict = null;
    const draft = readLocal("draft:" + id, values);
    draft.revision = saved.revision;
    writeLocal("draft:" + id, draft);
    if (state.current === id && $("wish-form"))
      $("wish-form").dataset.revision = saved.revision;
    if (state.current === id) {
      const title = document.querySelector(".radio-heading h1");
      if (title) title.textContent = saved.title;
      if (!quiet) notice(tr("频道偏好已保存。"), "ok");
    }
    renderConflict();
    return true;
  } catch (e) {
    if (e.status === 409 && e.show && state.current === id) {
      state.conflict = { message: e.message, show: e.show };
      renderConflict();
    }
    if (state.current === id) notice(e.message);
    return false;
  } finally {
    state.saving = false;
    renderStatus();
  }
}
async function makeEpisode(retryEpisodeId = "", showId = state.current) {
  if (runtime && !runtime.hasKey()) {
    setView("settings");
    notice(tr("请先填写自己的 AI Studio API Key。收听愿望已保留。"), "info");
    return;
  }
  if (
    state.submitting ||
    state.saving ||
    state.deleting.size > 0 ||
    generating(state.shows.find((s) => s.id === showId)) ||
    (!retryEpisodeId && state.conflict)
  )
    return;
  captureDraft();
  state.submitting = true;
  state.notice = null;
  renderStatus();
  let id = showId;
  try {
    if (!id) {
      const values = formValues(),
        data = await api("/api/shows", jsonRequest("POST", values));
      id = data.show.id;
      replaceShow(data.show);
      state.current = id;
      writeLocal("current", id);
      writeLocal("draft:new", null);
      renderStudio();
    } else if (!retryEpisodeId && !readLocal("pending:" + id, null)) {
      if (!(await saveChannel(false, true))) return;
    }
    let pending = readLocal("pending:" + id, null);
    if (!pending) {
      pending = {
        request_id: uid(),
        episode_wish: retryEpisodeId
          ? ""
          : $("episode-wish")?.value.trim() || "",
        revision: state.shows.find((s) => s.id === id).revision,
        retry_episode_id: retryEpisodeId,
      };
      writeLocal("pending:" + id, pending);
    }
    const data = await api(
      `/api/shows/${id}/episodes`,
      jsonRequest("POST", pending),
    );
    writeLocal("pending:" + id, null);
    replaceShow(data.show);
    if (state.current === id) {
      if (
        !pending.retry_episode_id &&
        $("episode-wish") &&
        $("episode-wish").value.trim() === pending.episode_wish
      )
        $("episode-wish").value = "";
      captureDraft();
      renderEpisodes();
      if (data.episode.status === "failed")
        notice(data.episode.error || tr("上次请求已结束，可再次制作。"));
    }
  } catch (e) {
    if (e.status && e.status < 500) writeLocal("pending:" + id, null);
    if (e.status === 409 && e.show && id === state.current) {
      state.conflict = { message: e.message, show: e.show };
      renderConflict();
    }
    notice(
      e.message +
        (e.status ? "" : tr(" 再次点击会复用同一个请求编号，避免重复制作。")),
    );
  } finally {
    state.submitting = false;
    renderStatus();
  }
}
function forgetLibraryRecords(showId, episodeIds, wholeChannel = false) {
  const ids = new Set(episodeIds),
    seen = readLocal("seen", {});
  state.tasks = state.tasks.filter((t) => {
    if (wholeChannel && t.showId === showId && t.kind === "bgm") {
      // Music jobs belong to the shared music library, not the deleted channel.
      t.showId = null;
      return true;
    }
    const remove =
      (wholeChannel && t.showId === showId) || ids.has(t.episodeId);
    if (remove) delete seen[t.id];
    return !remove;
  });
  for (const id of ids) {
    state.transcripts.delete(id);
    state.opened.delete(id);
    delete seen[id];
  }
  if (ids.has(state.inboxTask)) state.inboxTask = null;
  writeLocal("seen", seen);
  if (wholeChannel) {
    writeLocal("draft:" + showId, null);
    writeLocal("pending:" + showId, null);
  }
  persistTasks();
}
async function deleteChannel() {
  const s = currentShow();
  if (!s || state.deleting.size || state.submitting || state.saving) return;
  if (generating(s))
    return notice(tr("请等这个频道制作完成后再删除。"), "info");
  if (
    !confirm(
      trText`删除「${s.title}」频道及其全部来信、台本和音频？此操作无法撤销，可先在设置导出备份。`,
    )
  )
    return;
  state.deleting.add(s.id);
  renderStatus();
  try {
    await api(`/api/shows/${s.id}`, { method: "DELETE" });
    state.libraryVersion++;
    state.shows = state.shows.filter((v) => v.id !== s.id);
    if ((s.episodes || []).some((ep) => ep.id === playback.episodeId))
      stopPlayback();
    forgetLibraryRecords(
      s.id,
      (s.episodes || []).map((ep) => ep.id),
      true,
    );
    if (state.current === s.id) openShow(null, { saveDraft: false });
    else renderSidebar();
    notice(tr("频道与音频已删除。"), "ok");
  } catch (e) {
    notice(e.message);
  } finally {
    state.deleting.delete(s.id);
    renderStatus();
  }
}
async function deleteEpisode(id, showId = state.current) {
  const s = state.shows.find((v) => v.id === showId),
    ep = s?.episodes?.find((e) => e.id === id);
  if (!ep || state.deleting.size || state.submitting || state.saving) return;
  if (generating(s))
    return notice(tr("请等这个频道制作完成后再删除来信。"), "info");
  if (
    !confirm(
      trText`删除「${ep.title}」这一集及其台本和音频？频道偏好和其他来信会保留，此操作无法撤销。`,
    )
  )
    return;
  if (state.current === showId) captureDraft();
  state.deleting.add(id);
  renderEpisodes();
  renderStatus();
  try {
    const { show } = await api(`/api/shows/${showId}/episodes/${id}`, {
      method: "DELETE",
    });
    if (playback.episodeId === id) stopPlayback();
    const draft = readLocal("draft:" + showId, null);
    if (draft && draft.revision === s.revision) {
      draft.revision = show.revision;
      writeLocal("draft:" + showId, draft);
    }
    if (
      state.current === showId &&
      Number($("wish-form")?.dataset.revision) === s.revision
    )
      $("wish-form").dataset.revision = show.revision;
    replaceShow(show);
    forgetLibraryRecords(showId, [id]);
    notice(tr("这封来信与音频已删除，频道偏好已保留。"), "ok");
  } catch (e) {
    notice(e.message);
  } finally {
    state.deleting.delete(id);
    renderEpisodes();
    renderStatus();
  }
}
function episodeTitle(ep) {
  return ep.status !== "ready" && !ep.has_script ? tr(ep.title) : ep.title;
}
function sourceCredit(source) {
  return `<aside class="source-credit channel-credit"><strong>${escapeHtml(tr("创作者署名"))}: ${escapeHtml(source.author)}</strong><span>${escapeHtml(tr("使用条款"))}: ${escapeHtml(source.license)}</span>${source.source_url ? `<a href="${escapeHtml(source.source_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(tr("查看来源"))} ↗</a>` : ""}</aside>`;
}
function renderEpisodes() {
  const mount = $("episode-mount"),
    show = currentShow();
  if (!mount || !show) return;
  const eps = (show.episodes || []).filter(
    (ep) => ep.status === "ready" || ep.status === "generating",
  );
  if (!eps.length) {
    mount.innerHTML = trHTML([
      '<div class="empty-episodes"><span aria-hidden="true">✉</span><p>还没有可播放的来信。</p><small>制作完成后保存在这里，进度与未完成记录可在「消息」中查看。</small></div>',
    ]);
    return;
  }
  mount.innerHTML = eps
    .map(
      (ep) => `<article class="letter-episode ${ep.status}">
        <div class="episode-heading"><span class="episode-type">${icon("letter")}${ep.status === "ready" ? tr("一封虚构来信") : tr("本期正在制作")}</span><div class="episode-tools"><time>${escapeHtml(formatDate(ep.created_at))}</time>${ep.status === "ready" ? trHTML`<button type="button" class="delete-control" data-delete-episode="${escapeHtml(ep.id)}" aria-label="删除这一集：${escapeHtml(episodeTitle(ep))}" ${state.deleting.size || generating(show) ? "disabled" : ""}>${icon("trash")}${state.deleting.has(ep.id) ? tr("删除中…") : tr("删除本集")}</button>` : ""}</div></div>
        <h3>${escapeHtml(episodeTitle(ep))}</h3>
        ${ep.provenance && ep.provenance.content_id !== show.provenance?.content_id ? sourceCredit(ep.provenance) : ""}
        ${ep.interpretation ? `<p class="episode-description">${escapeHtml(ep.interpretation)}</p>` : ""}
        ${ep.input?.episode_wish ? trHTML`<p class="hint">这期的口味：${escapeHtml(ep.input.episode_wish)}</p>` : ""}
        ${ep.status === "generating" ? trHTML`<p class="job-stage" role="status"><span class="spinner"></span>${escapeHtml(PHASE[ep.phase] || tr("正在制作"))}。应用内换页不会取消，请保持此网页打开。</p>` : ""}
        ${ep.status === "ready" ? trHTML`<div class="episode-actions"><button type="button" class="primary" data-play="${escapeHtml(ep.id)}">播放</button><button type="button" class="quiet" data-download="${escapeHtml(ep.id)}">下载 MP3</button><span class="hint">${ep.duration_seconds ? `${durationLabel(ep.duration_seconds)} · ` : ""}${LANG[ep.language] || tr("历史成片")}${ep.music_source === "skipped" ? tr(" · 无底乐") : ""}</span></div>` : ""}
        ${
          ep.has_script
            ? trHTML`<details
                class="transcript"
                data-transcript="${escapeHtml(ep.id)}"
                ${state.opened.has(ep.id) ? "open" : ""}
              >
                <summary>台本与本期信息</summary>
                <div
                  class="transcript-body"
                  id="transcript-${escapeHtml(ep.id)}"
                ></div>
              </details>`
            : ""
        }
        </article>`,
    )
    .join("");
  mount.querySelectorAll("[data-play]").forEach(
    (b) =>
      (b.onclick = () => {
        const ep = eps.find((e) => e.id === b.dataset.play);
        if (playback.episodeId === ep.id) {
          if (audio.paused)
            audio
              .play()
              .catch(() => notice(tr("浏览器未能播放，可在播放器重试。")));
          else audio.pause();
          return;
        }
        const token = claimPlayback();
        playSource(ep.url, ep.title, token, ep.id);
      }),
  );
  mount
    .querySelectorAll("[data-delete-episode]")
    .forEach((b) => (b.onclick = () => deleteEpisode(b.dataset.deleteEpisode)));
  mount
    .querySelectorAll("[data-download]")
    .forEach((b) => (b.onclick = () => downloadMp3(b.dataset.download, b)));
  mount.querySelectorAll("[data-transcript]").forEach((d) => {
    d.ontoggle = () => {
      if (d.open) {
        state.opened.add(d.dataset.transcript);
        loadTranscript(d.dataset.transcript);
      } else state.opened.delete(d.dataset.transcript);
    };
    if (d.open) loadTranscript(d.dataset.transcript);
  });
  updatePlayButtons();
}
async function loadTranscript(id) {
  const target = $("transcript-" + id);
  if (!target) return;
  try {
    if (!state.transcripts.has(id)) {
      target.textContent = tr("正在读取已保存的台本…");
      state.transcripts.set(id, api(`/api/episodes/${id}/transcript`));
    }
    const data = await state.transcripts.get(id);
    if (!$("transcript-" + id)) return;
    const body = $("transcript-" + id);
    body.innerHTML = trHTML`<p class="hint">
        重点表达是播出记录，不代表已经掌握。
      </p>
      <p class="expression-list">
        ${(data.expressions || [])
          .map((e) => `<span>${escapeHtml(e)}</span>`)
          .join("")}
      </p>
      <pre>${escapeHtml(data.script)}</pre>
      ${
        (data.sources || []).length
          ? trHTML`<h4>本期参考资料</h4>
            <p class="hint">用于核对背景，来信情节为原创虚构。</p>
            <ul>
              ${data.sources
                .filter((s) => /^https:\/\//.test(s.url))
                .map(
                  (s) =>
                    `<li><a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.title)}</a></li>`,
                )
                .join("")}
            </ul>`
          : trHTML([
              '<p class="hint">本期为原创情境，没有使用外部搜索来源。</p>',
            ])
      }
      <p class="hint">
        频道愿望：${escapeHtml(data.input?.wish || tr("自由选题"))}<br />当期愿望：${escapeHtml(
          data.input?.episode_wish || tr("沿用频道口味"),
        )}
      </p>`;
    const html = data.research?.search_suggestions;
    if (html) {
      const frame = document.createElement("iframe");
      frame.title = tr("Google 搜索建议");
      frame.className = "search-suggestions";
      frame.setAttribute(
        "sandbox",
        "allow-popups allow-popups-to-escape-sandbox",
      );
      frame.referrerPolicy = "no-referrer";
      frame.srcdoc =
        "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; base-uri 'none'; form-action 'none'\">" +
        html;
      body.append(frame);
    }
  } catch (e) {
    state.transcripts.delete(id);
    if ($("transcript-" + id))
      $("transcript-" + id).textContent = tr(e.message);
  }
}
async function saveDownload(blob, name) {
  if (nativeClient) return nativeClient.saveFile(blob, name);
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return true;
}
async function downloadMp3(id, button) {
  const title =
    (currentShow()?.episodes || []).find((e) => e.id === id)?.title || id;
  const task = addTask({
    kind: "download",
    title: `MP3 · ${title}`,
    showId: state.current,
    episodeId: id,
  });
  button.disabled = true;
  button.textContent = tr("正在准备…");
  try {
    const r = await fmFetch(`/api/episodes/${id}/download`);
    if (!r.ok) throw new Error((await r.json()).message || tr("下载失败"));
    const saved = await saveDownload(await r.blob(), title + ".mp3");
    task.status = saved ? "ready" : "cancelled";
    if (!saved) notice(tr("保存已取消，原节目仍保留。"), "info");
  } catch (e) {
    task.status = "failed";
    task.error = e.message;
    notice(e.message);
  } finally {
    button.disabled = false;
    button.textContent = tr("下载 MP3");
    persistTasks();
  }
}
function addTask(task) {
  const t = {
    id: uid(),
    created_at: new Date().toISOString(),
    status: "generating",
    ...task,
  };
  state.tasks.unshift(t);
  state.tasks = state.tasks.slice(0, 24);
  persistTasks();
  return t;
}
function persistTasks() {
  writeLocal("tasks", state.tasks);
  renderInbox();
}
function voiceFields(show) {
  return trHTML` <div class="voice-row">
      <label
        >主持一<select id="host">
          ${options(state.presets.voices, show.host_voice)}
        </select></label
      ><button type="button" class="quiet" data-preview="host">试听</button
      ><button type="button" class="linkish" data-force="host">
        重新生成试听
      </button>
    </div>
    <div class="voice-row">
      <label
        >主持二<select id="guest">
          ${options(state.presets.voices, show.guest_voice)}
        </select></label
      ><button type="button" class="quiet" data-preview="guest">试听</button
      ><button type="button" class="linkish" data-force="guest">
        重新生成试听
      </button>
    </div>
    <div class="voice-row">
      <label
        >背景音乐<select id="music">
          ${options(state.presets.music, show.music_style)}
        </select></label
      ><button type="button" class="quiet" id="preview-music">试听</button
      ><button type="button" class="linkish" id="regenerate-music">
        重新生成底乐
      </button>
    </div>
    <p class="hint">
      相同模型、声线和语言会复用 7
      天内的试听。重新生成会再次请求服务；失败时旧试听仍保留。
    </p>`;
}
function renderVoice(show) {
  $("channel-body").innerHTML = trHTML`<section class="wish-card voice-card">
    <h2>给频道选一种声音</h2>
    <p class="intro">
      试听使用频道的${
        LANG[show.language]
      }，切页会停止播放，已发出的生成仍会继续。修改只影响后续制作，正在制作的一集使用开始时的选择。
    </p>
    ${voiceFields(show)}
  </section>`;
  bindVoiceControls(show);
}
function bindVoiceControls(show) {
  document
    .querySelectorAll(".voice-row select")
    .forEach((el) => (el.disabled = state.saving));
  for (const [id, field] of [
    ["host", "host_voice"],
    ["guest", "guest_voice"],
    ["music", "music_style"],
  ])
    $(id).onchange = () => {
      if (show) saveVoice(show.id, field, $(id).value);
      else captureDraft();
    };
  document
    .querySelectorAll("[data-preview]")
    .forEach((b) => (b.onclick = () => previewVoice(b.dataset.preview, false)));
  document
    .querySelectorAll("[data-force]")
    .forEach((b) => (b.onclick = () => previewVoice(b.dataset.force, true)));
  $("preview-music").onclick = previewMusic;
  $("regenerate-music").onclick = regenerateMusic;
}
async function saveVoice(id, field, value) {
  const show = state.shows.find((s) => s.id === id);
  if (state.saving) return;
  state.saving = true;
  document
    .querySelectorAll(".voice-row select")
    .forEach((el) => (el.disabled = true));
  try {
    const data = await api(
      `/api/shows/${id}`,
      jsonRequest("PATCH", { [field]: value, revision: show.revision }),
    );
    replaceShow(data.show);
    const draft = readLocal("draft:" + id, null);
    if (draft) {
      draft.revision = data.show.revision;
      writeLocal("draft:" + id, draft);
    }
  } catch (e) {
    if (e.show) replaceShow(e.show);
    notice(e.message);
    if (state.current === id && state.tab === "voice")
      renderVoice(currentShow());
  } finally {
    state.saving = false;
    document
      .querySelectorAll(".voice-row select")
      .forEach((el) => (el.disabled = false));
    renderStatus();
  }
}
async function previewVoice(role, force) {
  const show = currentShow() || loadDraft(null);
  const voice = $(role).value,
    language = $("language")?.value || show.language,
    model = state.settings?.settings?.tts_model || "";
  const key = [
    state.settings?.effective_project_id,
    language,
    voice,
    role,
    model,
  ].join("|");
  const token = claimPlayback();
  playback.waiting = true;
  $("player").hidden = false;
  audio.hidden = true;
  $("stop-player").textContent = tr("停止等待");
  $("player-title").textContent = tr("正在准备声线试听…");
  try {
    let result = voiceCache.get(key);
    if (result && Date.now() - Date.parse(result.created) > 7 * 86400000)
      result = null;
    if (force || !result) {
      let job = force && !voiceForce.has(key) ? null : voiceInflight.get(key);
      if (!job) {
        const epoch = (voiceEpoch.get(key) || 0) + (force ? 1 : 0);
        voiceEpoch.set(key, epoch);
        const task = addTask({
          kind: "voice",
          title: trText`${LANG[language]} · ${role === "host" ? tr("主持一") : tr("主持二")}试听`,
          showId: show.id,
        });
        job = (async () => {
          try {
            const r = await fmFetch(
              "/api/voices/preview",
              jsonRequest("POST", { role, voice, language, force }),
            );
            if (!r.ok)
              throw new Error((await r.json()).message || tr("试听失败"));
            const item = {
              blob: await r.blob(),
              created:
                r.headers.get("X-DIYFM-Cached-At") || new Date().toISOString(),
            };
            if (voiceEpoch.get(key) === epoch) voiceCache.set(key, item);
            task.status = "ready";
            task.error = "";
            if (r.headers.get("X-DIYFM-Cache") === "hit")
              state.tasks = state.tasks.filter((t) => t.id !== task.id);
            persistTasks();
            return item;
          } catch (e) {
            task.status = "failed";
            task.error = e.message;
            persistTasks();
            throw e;
          }
        })();
        voiceInflight.set(key, job);
        if (force) voiceForce.add(key);
        job
          .finally(() => {
            if (voiceInflight.get(key) === job) {
              voiceInflight.delete(key);
              voiceForce.delete(key);
            }
          })
          .catch(() => {});
      }
      notice(tr("正在准备试听，进度可以在消息中查看。"), "busy");
      result = await job;
    }
    if (token !== playback.token) return;
    state.notice = null;
    renderStatus();
    await playSource(result.blob, trText`${LANG[language]} · 声线试听`, token);
  } catch (e) {
    if (token === playback.token) {
      stopPlayback();
      notice(e.message);
    }
  }
}
async function previewMusic() {
  const style = $("music").value,
    token = claimPlayback();
  try {
    let blob = bgmCache.get(style);
    if (!blob) {
      const r = await fmFetch(`/media/bgm/${encodeURIComponent(style)}.wav`);
      if (!r.ok)
        throw new Error(
          (await r.json()).message || tr("底乐还没有生成，请先生成底乐。"),
        );
      blob = await r.blob();
      bgmCache.set(style, blob);
    }
    await playSource(blob, tr("底乐试听"), token);
  } catch (e) {
    if (token === playback.token) notice(e.message);
  }
}
async function regenerateMusic() {
  const style = $("music").value;
  if (
    state.tasks.some(
      (t) => t.kind === "bgm" && t.style === style && t.status === "generating",
    )
  ) {
    notice(tr("这条底乐正在生成，可在消息中查看。"), "busy");
    return;
  }
  const task = addTask({
    kind: "bgm",
    title: tr("重新生成底乐"),
    style,
    showId: state.current,
  });
  try {
    await api(`/api/bgm/${encodeURIComponent(style)}/regenerate`, {
      method: "POST",
    });
    notice(tr("底乐正在生成，完成后可再次试听。"), "busy");
  } catch (e) {
    task.status = "failed";
    task.error = e.message;
    persistTasks();
    notice(e.message);
  }
}
function inboxRows() {
  const episodes = state.shows.flatMap((s) =>
    (s.episodes || []).map((ep) => ({
      ...ep,
      showId: s.id,
      channelTitle: s.title,
      kind: "episode",
    })),
  );
  return [...episodes, ...state.tasks]
    .sort(
      (a, b) =>
        (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0),
    )
    .slice(0, 32);
}
function signature(row) {
  return [row.status, row.phase, row.error].join("|");
}
function renderInbox() {
  const rows = inboxRows(),
    seen = readLocal("seen", {}),
    unread = rows.filter((r) => seen[r.id] !== signature(r));
  $("inbox-badge").hidden = !unread.length;
  $("inbox-badge").textContent = unread.length;
  const inboxHtml = rows.length
    ? rows
        .map(
          (r) =>
            `<li><button type="button" data-task="${escapeHtml(r.id)}" ${r.kind === "episode" && r.status === "failed" ? `aria-expanded="${state.inboxTask === r.id}"` : ""}><strong>${escapeHtml(r.channelTitle || tr(r.title))}</strong><small>${escapeHtml(r.kind === "episode" ? episodeTitle(r) : "")} · ${escapeHtml(r.status === "generating" ? PHASE[r.phase] || tr("正在处理") : r.status === "ready" ? (r.kind === "episode" ? tr("可播放") : ["download", "backup", "share"].includes(r.kind) ? tr("已准备并请求下载") : tr("已完成，可再次试听")) : tr(r.status === "cancelled" ? "已取消" : "未完成，点击查看"))}</small><small>${escapeHtml(formatDate(r.created_at))}</small></button>
            ${
              state.inboxTask === r.id &&
              r.status !== "ready" &&
              r.status !== "generating"
                ? `<div class="inbox-failure"><p class="inbox-error">${escapeHtml(tr(r.error) || tr("制作未完成，请重试。"))}</p>${
                    r.kind === "episode"
                      ? trHTML`<p class="hint">
                            愿望与已完成阶段保留。重试沿用本期原输入，使用当前模型配置。
                          </p>
                          <button
                            type="button"
                            class="quiet"
                            data-retry-task="${escapeHtml(r.id)}"
                            ${
                              state.submitting ||
                              generating(
                                state.shows.find((s) => s.id === r.showId),
                              )
                                ? "disabled"
                                : ""
                            }
                          >
                            重试本期</button
                          ><button
                            type="button"
                            class="linkish"
                            data-task-channel="${escapeHtml(r.showId)}"
                          >
                            查看频道
                          </button>`
                      : r.kind === "share" && r.showId ? trHTML`<button type="button" class="quiet" data-task-channel="${escapeHtml(r.showId)}">查看频道</button>` : ""
                  }</div>`
                : ""
            }</li>`,
        )
        .join("")
    : trHTML(['<li class="hint">开始制作后，进度和结果会出现在这里。</li>']);
  if (state.inboxMarkup !== inboxHtml) {
    $("inbox-list").innerHTML = inboxHtml;
    state.inboxMarkup = inboxHtml;
  }
  document.querySelectorAll("[data-task]").forEach(
    (b) =>
      (b.onclick = () => {
        const row = rows.find((r) => r.id === b.dataset.task);
        if (row && !["ready", "generating"].includes(row.status)) {
          state.inboxTask = state.inboxTask === row.id ? null : row.id;
          renderInbox();
          return;
        }
        if (row?.kind === "backup") {
          toggleInbox(false);
          setView("settings");
          return;
        }
        if (row?.showId) {
          toggleInbox(false);
          openShow(row.showId);
          if (["voice", "bgm"].includes(row.kind)) {
            state.tab = "voice";
            renderStudio();
          }
        } else if (row && ["voice", "bgm"].includes(row.kind)) {
          toggleInbox(false);
          openShow(null);
          $("first-sound").open = true;
        }
      }),
  );
  document.querySelectorAll("[data-retry-task]").forEach(
    (b) =>
      (b.onclick = () => {
        const row = rows.find((r) => r.id === b.dataset.retryTask);
        if (row) makeEpisode(row.id, row.showId);
      }),
  );
  document.querySelectorAll("[data-task-channel]").forEach(
    (b) =>
      (b.onclick = () => {
        toggleInbox(false);
        openShow(b.dataset.taskChannel);
      }),
  );
  if (state.inbox) {
    rows.forEach((r) => (seen[r.id] = signature(r)));
    writeLocal("seen", seen);
    $("inbox-badge").hidden = true;
  }
}
function toggleInbox(open) {
  state.inbox = open;
  $("inbox").hidden = !open;
  $("inbox-btn").setAttribute("aria-expanded", String(open));
  renderInbox();
}
$("inbox-btn").onclick = () => toggleInbox(!state.inbox);
$("inbox-close").onclick = () => toggleInbox(false);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.inbox) {
    toggleInbox(false);
    $("inbox-btn").focus();
  }
});
function setInterfaceLanguage(language) {
  if (!i18n || !["en", "ja", "zh-CN"].includes(language)) return;
  captureDraft();
  const firstSoundOpen = $("first-sound")?.open;
  const managementOpen = document.querySelector?.(".channel-management")?.open;
  i18n.setLocale(language);
  i18n.apply(document);
  window.dispatchEvent?.(new Event("diyfm:locale"));
  renderSidebar();
  if (state.presets) {
    renderStudio();
    if ($("first-sound")) $("first-sound").open = !!firstSoundOpen;
    const management = document.querySelector?.(".channel-management");
    if (management) management.open = !!managementOpen;
  }
  // Repaint labels only; do not save/reload settings, change the media source, or reset the Key.
  if (state.settings) {
    $("auth-note").textContent = tr(state.settings.auth_note);
    $("settings-effect").textContent = [
      tr(state.settings.effect),
      tr(state.settings.priority),
    ].join(" ");
    $("key-state").textContent = tr(
      state.settings.has_key ? "本页 Key 已启用" : "尚未填写 Key",
    );
  }
  $("playback-mode").innerHTML = playbackModeOptions();
  syncPlaybackMode();
  $("stop-player").textContent = tr(playback.waiting ? "停止等待" : "停止播放");
  if (!playback.episodeId)
    $("player-title").textContent = tr($("player-title").textContent);
  renderStatus();
  sharingUI?.repaint();
}
$("ui-language").onchange = () => setInterfaceLanguage($("ui-language").value);
$("new-channel").onclick = () => openShow(null);
$("nav-studio").onclick = () => {
  setView("studio");
  renderStudio();
};
$("nav-settings").onclick = () => setView("settings");
$("nav-resources").onclick = () => setView("resources");
$("status-dismiss").onclick = () => {
  state.notice = null;
  renderStatus();
};
const settingsFields = {
  "set-llm": "llm_model",
  "set-tts": "tts_model",
  "set-lyria": "lyria_model",
};
function paintSettings(data) {
  state.settings = data;
  for (const [id, key] of Object.entries(settingsFields))
    $(id).value = data.settings[key] || "";
  $("auth-note").textContent = tr(data.auth_note);
  $("settings-effect").textContent = [tr(data.effect), tr(data.priority)].join(
    " ",
  );
  $("key-state").textContent = data.has_key
    ? tr("本页 Key 已启用")
    : tr("尚未填写 Key");
  $("clear-api-key").disabled = !data.has_key;
}
async function loadSettings() {
  const data = await api("/api/settings");
  if (!state.settingsDirty) paintSettings(data);
}
Object.keys(settingsFields).forEach((id) =>
  $(id).addEventListener("input", () => (state.settingsDirty = true)),
);
$("enable-api-key").onclick = async () => {
  const button = $("enable-api-key");
  button.disabled = true;
  try {
    paintSettings(await runtime.setKey($("api-key").value));
    voiceCache.clear();
    notice(
      tr("Key 已在本页启用。可以回到收听开始制作；刷新后需要重新填写。"),
      "ok",
    );
  } catch (e) {
    notice(e.message);
  } finally {
    $("api-key").value = "";
    button.disabled = false;
  }
};
$("clear-api-key").onclick = async () => {
  stopPlayback();
  paintSettings(await runtime.clearKey());
  voiceCache.clear();
  notice(
    tr("本页 Key 已清除。已提交的任务仍可能继续，后续新请求需要重新填写 Key。"),
    "info",
  );
};
$("test-api-key").onclick = async () => {
  const button = $("test-api-key");
  button.disabled = true;
  try {
    notice(await runtime.testKey(), "ok");
  } catch (e) {
    notice(e.message);
  } finally {
    button.disabled = false;
  }
};
$("import-backup").onclick = () => sharingUI?.chooseFile();
$("backup-file").onchange = async () => {
  const file = $("backup-file").files?.[0];
  if (!file) return;
  sharingUI?.prepareFile(file);
  $("backup-file").value = "";
};
window.addEventListener?.("beforeunload", (event) => {
  if (runtime?.isBusy() || sharingUI?.isBusy()) {
    event.preventDefault();
    event.returnValue = "";
  }
});
$("save-settings").onclick = async () => {
  const b = $("save-settings");
  b.disabled = true;
  try {
    const values = Object.fromEntries(
      Object.entries(settingsFields).map(([id, key]) => [
        key,
        $(id).value.trim(),
      ]),
    );
    const data = await api("/api/settings", jsonRequest("PUT", values));
    state.settingsDirty = false;
    paintSettings(data);
    voiceCache.clear();
    bgmCache.clear();
    notice(tr("设置已保存，新制作与试听会使用新配置。"), "ok");
  } catch (e) {
    notice(e.message);
  } finally {
    b.disabled = false;
  }
};
$("restore-settings").onclick = async () => {
  try {
    const data = await api("/api/settings/restore", { method: "POST" });
    state.settingsDirty = false;
    paintSettings(data);
    voiceCache.clear();
    bgmCache.clear();
    notice(tr("已恢复模型默认值，当前页的 Key 不变。"), "ok");
  } catch (e) {
    notice(e.message);
  }
};
$("clear-preview-cache").onclick = async () => {
  try {
    const data = await api("/api/voices/cache/clear", { method: "POST" });
    voiceCache.clear();
    notice(data.message, "ok");
  } catch (e) {
    notice(e.message);
  }
};
$("export-backup").onclick = async () => {
  const task = addTask({ kind: "backup", title: tr("导出电台备份") });
  const b = $("export-backup");
  b.disabled = true;
  try {
    const r = await fmFetch("/api/backup");
    if (!r.ok) throw new Error(tr("备份导出失败，请重试。"));
    const saved = await saveDownload(await r.blob(), "diyfm-backup.zip");
    notice(
      tr(
        saved
          ? "备份已下载，包含频道、台本、设置与音频。"
          : "保存已取消，原节目仍保留。",
      ),
      saved ? "ok" : "info",
    );
    task.status = saved ? "ready" : "cancelled";
  } catch (e) {
    task.status = "failed";
    task.error = e.message;
    notice(e.message);
  } finally {
    b.disabled = false;
    persistTasks();
  }
};
async function poll() {
  if (state.polling) return;
  state.polling = true;
  const version = state.libraryVersion;
  try {
    const data = await api("/api/shows");
    if (version !== state.libraryVersion) return;
    if (
      tr(state.notice?.message) ===
      tr("暂时无法更新任务状态。输入与已有节目已保留，正在尝试重新连接。")
    )
      state.notice = null;
    const before = JSON.stringify(
      (currentShow()?.episodes || []).map((e) => [
        e.id,
        e.status,
        e.phase,
        e.interpretation,
      ]),
    );
    state.shows = data.shows;
    reconcilePlayback();
    const after = JSON.stringify(
      (currentShow()?.episodes || []).map((e) => [
        e.id,
        e.status,
        e.phase,
        e.interpretation,
      ]),
    );
    if (before !== after) renderEpisodes();
    if (
      state.tasks.some((t) => t.kind === "bgm" && t.status === "generating")
    ) {
      const jobs = await api("/api/bgm/jobs");
      state.tasks
        .filter((t) => t.kind === "bgm" && t.status === "generating")
        .forEach((t) => {
          const job = jobs.jobs[t.style];
          if (job && job.status !== "running") {
            t.status = job.status;
            t.error = job.error || "";
            bgmCache.delete(t.style);
          } else if (!job) {
            t.status = "unknown";
            t.error = tr("服务已重启，底乐任务状态未知。可再次试听本地结果。");
          }
        });
      persistTasks();
    }
    renderSidebar();
    renderStatus();
  } catch (e) {
    if (!state.notice)
      notice(
        tr("暂时无法更新任务状态。输入与已有节目已保留，正在尝试重新连接。"),
        "warn",
      );
  } finally {
    state.polling = false;
  }
}
const sharingUI = globalThis.DIYFM_SHARE_UI?.({
  runtime, tr, escapeHtml, saveDownload, addTask, persistTasks, currentShow,
  onImported: async result => {
    state.libraryVersion++;
    state.shows = (await api("/api/shows")).shows;
    openShow(result.showId || state.current);
    notice(tr(result.duplicate ? "相同内容已在本地，已打开已有频道。" : "已保存到本地，可以离线收听。"), "ok");
  },
});
Promise.all([api("/api/presets"), api("/api/shows"), api("/api/settings")])
  .then(([presets, shows, settings]) => {
    state.presets = presets;
    state.shows = shows.shows;
    state.settings = settings;
    const saved = readLocal("current", null);
    state.current = state.shows.some((s) => s.id === saved) ? saved : null;
    paintSettings(settings);
    renderSidebar();
    renderStudio();
    renderStatus();
    const restored = nativeClient?.info.state;
    if (restored?.id && !restored.ended) {
      const owner = state.shows.find((show) =>
        (show.episodes || []).some((ep) => ep.id === restored.id),
      );
      const episode = owner?.episodes.find((ep) => ep.id === restored.id);
      if (episode?.url) {
        audio.setContext({ episodeId: episode.id, title: episode.title });
        audio._src = episode.url;
        audio.loaded = true;
        audio._rate = Number(restored.rate) || 1;
        $("playback-speed").value = String(audio._rate);
        playback.episodeId = episode.id;
        $("player").hidden = false;
        audio.hidden = false;
        $("player-title").textContent = episode.title;
        audio.apply(restored);
      }
    }
    setInterval(poll, 4000);
  })
  .catch((e) => notice(e.message));

if (nativeClient) {
  document.documentElement.classList.add("native-client");
  const nativeInfo = document.createElement("p");
  nativeInfo.className = "hint";
  nativeInfo.textContent = `DIYFM ${nativeClient.info.version} · ${nativeClient.info.platform}`;
  const updateButton = document.createElement("button");
  updateButton.type = "button";
  updateButton.className = "quiet";
  updateButton.textContent = tr("下载客户端更新");
  updateButton.onclick = () =>
    nativeClient
      .updates()
      .catch(() => notice(tr("客户端操作未完成，原节目仍保留。请重试。")));
  $("settings-view").append(nativeInfo, updateButton);
  setInterval(() => {
    audio.poll();
    nativeClient.setBusy(runtime.isBusy() || sharingUI?.isBusy());
  }, 750);
  window.addEventListener("focus", () => audio.poll());
  window.addEventListener("diyfm:locale", () => {
    audio.paint();
    updateButton.textContent = tr("下载客户端更新");
  });
}
