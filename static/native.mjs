// Optional native capabilities. The web application never creates a native transport.
const CHUNK = 192 * 1024;
const MAX_FILE = 500 * 1024 * 1024;
const safeError = () => new Error("客户端操作未完成，原节目仍保留。请重试。");
const bytes64 = (bytes) => {
  let value = "";
  for (let i = 0; i < bytes.length; i += 16384)
    value += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return btoa(value);
};
export function detectTransport(scope = globalThis) {
  if (scope.webkit?.messageHandlers?.diyfm) {
    return {
      request: (command, data = {}) =>
        scope.webkit.messageHandlers.diyfm
          .postMessage({ command, data })
          .catch(() => {
            throw safeError();
          }),
    };
  }
  const port = scope.diyfmNative;
  if (!port?.postMessage) return null;
  const pending = new Map();
  port.onmessage = (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    clearTimeout(item.timer);
    message.error ? item.reject(safeError()) : item.resolve(message.result);
  };
  return {
    request(command, data = {}) {
      return new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(safeError());
        }, 300000);
        pending.set(id, { resolve, reject, timer });
        try {
          port.postMessage(JSON.stringify({ id, command, data }));
        } catch {
          clearTimeout(timer);
          pending.delete(id);
          reject(safeError());
        }
      });
    },
  };
}
export async function transferBlob(
  bridge,
  blob,
  { kind, id, name, active = () => true } = {},
) {
  if (!(blob instanceof Blob) || blob.size > MAX_FILE) throw safeError();
  const begin = await bridge.request("file.begin", {
    kind,
    id,
    name,
    size: blob.size,
  });
  if (begin.cancelled) return false;
  if (begin.exists) return true;
  const ticket = begin.ticket;
  try {
    for (let offset = 0; offset < blob.size; offset += CHUNK) {
      if (!active()) throw new DOMException("Stopped", "AbortError");
      const bytes = new Uint8Array(
        await blob.slice(offset, offset + CHUNK).arrayBuffer(),
      );
      const ack = await bridge.request("file.chunk", {
        ticket,
        offset,
        data: bytes64(bytes),
      });
      if (ack.written !== offset + bytes.length) throw safeError();
    }
    if (!active()) throw new DOMException("Stopped", "AbortError");
    await bridge.request("file.commit", { ticket });
    return true;
  } catch (error) {
    await bridge.request("file.abort", { ticket }).catch(() => {});
    throw error;
  }
}
export class NativeAudio extends EventTarget {
  constructor(
    bridge,
    {
      generation = 0,
      fetcher = (...args) => fetch(...args),
      onTrack = () => {},
      element,
      document = globalThis.document,
      translate = (s) => s,
    } = {},
  ) {
    super();
    Object.assign(this, {
      bridge,
      fetcher,
      onTrack,
      element,
      document,
      translate,
    });
    this.serial = generation;
    this._src = "";
    this._rate = 1;
    this._loop = false;
    this.paused = true;
    this.ended = false;
    this.currentTime = 0;
    this.duration = 0;
    this.loaded = false;
    this.context = {};
    this.controls = null;
    this.waiting = false;
    this.polling = false;
    if (element && document) this.mount();
  }
  emit(type) {
    this.dispatchEvent(new Event(type));
    if (type === "ended") this.onended?.();
    this.paint();
  }
  setContext(value) {
    this.context = value;
  }
  get src() {
    return this._src;
  }
  set src(value) {
    this._src = value;
    this.loaded = false;
    this.serial++;
    this.ended = false;
  }
  get hidden() {
    return this.controls?.hidden ?? true;
  }
  set hidden(value) {
    if (this.element) this.element.hidden = true;
    if (this.controls) this.controls.hidden = value;
  }
  get loop() {
    return this._loop;
  }
  set loop(value) {
    this._loop = !!value;
    this.configure();
  }
  get playbackRate() {
    return this._rate;
  }
  set playbackRate(value) {
    this._rate = Number(value);
    this.configure();
  }
  hasAttribute(name) {
    return name === "src" && !!this._src;
  }
  removeAttribute(name) {
    if (name === "src") {
      this._src = "";
      this.loaded = false;
      this.context = {};
      this.serial++;
      this.command("player.stop");
    }
  }
  load() {
    this.currentTime = 0;
    this.duration = 0;
    this.ended = false;
    this.paint();
  }
  mode() {
    return this.context.episodeId
      ? this._loop
        ? "single"
        : "channel"
      : "once";
  }
  command(command, extra = {}) {
    return this.bridge.request(command, { revision: this.serial, ...extra });
  }
  configure() {
    if (this.loaded)
      this.command("player.configure", {
        mode: this.mode(),
        rate: this._rate,
      }).catch(() => this.emit("error"));
  }
  async play() {
    const revision = ++this.serial;
    if (this.loaded) {
      await this.command("player.play");
      if (revision === this.serial) {
        this.paused = false;
        this.emit("play");
      }
      return;
    }
    if (!this._src) throw safeError();
    const context = this.context,
      active = () => revision === this.serial;
    this.waiting = true;
    this.paint();
    let phase = "read";
    try {
      const selected = context.episodeId || "preview";
      const queue = context.episodeId
        ? context.queue || []
        : [{ id: selected, title: context.title || "", url: this._src }];
      const tracks = [];
      for (const entry of queue) {
        if (!active()) return;
        if (typeof entry.url !== "string" || !entry.url.startsWith("blob:"))
          throw safeError();
        const response = await this.fetcher(entry.url);
        if (!response.ok) throw safeError();
        const blob = await response.blob();
        phase = "hash";
        const digest = await crypto.subtle.digest(
          "SHA-256",
          await blob.arrayBuffer(),
        );
        const key = Array.from(new Uint8Array(digest), (n) =>
          n.toString(16).padStart(2, "0"),
        ).join("");
        if (!active()) return;
        phase = "transfer";
        await transferBlob(this.bridge, blob, {
          kind: "media",
          id: key,
          active,
        });
        tracks.push({ id: entry.id, key, title: entry.title });
      }
      if (!active()) return;
      phase = "play";
      const status = await this.command("player.load", {
        tracks: tracks.filter(
          (track) =>
            !context.episodeId ||
            !this.allowedIds ||
            this.allowedIds.has(track.id),
        ),
        selected,
        mode: this.mode(),
        rate: this._rate,
      });
      if (!active()) return;
      this.loaded = true;
      this.apply(status);
    } catch (error) {
      if (!active()) return;
      if (error.name === "AbortError") throw error;
      throw new Error(
        this.translate(
          {
            read: "无法读取本机音频，原节目仍保留。",
            hash: "无法校验本机音频，原节目仍保留。",
            transfer: "无法准备系统播放文件，原节目仍保留。",
            play: "系统播放器启动失败，原节目仍保留。",
          }[phase],
        ),
      );
    } finally {
      if (active()) {
        this.waiting = false;
        this.paint();
      }
    }
  }
  pause() {
    this.serial++;
    this.waiting = false;
    this.paused = true;
    this.command("player.pause").catch(() => this.emit("error"));
    this.emit("pause");
  }
  async seek(value) {
    if (this.loaded)
      this.apply(
        await this.command("player.seek", {
          time: Math.max(0, Number(value) || 0),
        }),
      );
  }
  reconcile(ids) {
    this.allowedIds = new Set(ids);
    if (this.loaded && this.context.episodeId) {
      this.serial++;
      return this.command("player.reconcile", { ids })
        .then((state) => this.apply(state))
        .catch(() => this.emit("error"));
    }
  }
  async poll() {
    if (this.polling || !this.loaded) return;
    this.polling = true;
    try {
      this.apply(await this.bridge.request("player.state"));
    } catch {
      /* A transient status read must not stop the player. */
    } finally {
      this.polling = false;
    }
  }
  apply(status) {
    if (!status || status.revision !== this.serial) return;
    const wasPaused = this.paused,
      wasEnded = this.ended;
    this.paused = !!status.paused;
    this.ended = !!status.ended;
    this.currentTime = Number(status.time) || 0;
    this.duration = Number(status.duration) || 0;
    if (this.context.episodeId) {
      if (status.id) this.onTrack(status.id, status.title);
      else {
        this.loaded = false;
        this._src = "";
        this.onTrack(null, "");
      }
    }
    if (status.error) this.emit("error");
    else if (this.ended && !wasEnded) this.emit("ended");
    else if (wasPaused !== this.paused)
      this.emit(this.paused ? "pause" : "play");
    this.paint();
  }
  mount() {
    const box = this.document.createElement("div");
    box.className = "native-audio";
    box.hidden = true;
    const button = this.document.createElement("button");
    button.type = "button";
    button.className = "quiet";
    const seek = this.document.createElement("input");
    seek.type = "range";
    seek.min = "0";
    seek.max = "0";
    seek.step = "0.1";
    seek.value = "0";
    const time = this.document.createElement("span");
    time.className = "hint";
    box.append(button, seek, time);
    this.element.after(box);
    Object.assign(this, {
      controls: box,
      playButton: button,
      seekControl: seek,
      timeLabel: time,
    });
    button.onclick = () =>
      this.paused ? this.play().catch(() => this.emit("error")) : this.pause();
    seek.onchange = () => this.seek(seek.value).catch(() => this.emit("error"));
    this.paint();
  }
  paint() {
    if (!this.controls) return;
    this.playButton.textContent = this.translate(
      this.waiting ? "正在准备…" : this.paused ? "播放" : "暂停",
    );
    this.playButton.disabled = this.waiting;
    this.seekControl.setAttribute("aria-label", this.translate("播放进度"));
    this.seekControl.max = String(this.duration);
    this.seekControl.value = String(this.currentTime);
    this.seekControl.disabled = !this.loaded || !this.duration;
    const label = (seconds) =>
      `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
    this.timeLabel.textContent = `${label(this.currentTime)} / ${label(this.duration)}`;
  }
}
export async function createNativeClient(bridge = detectTransport()) {
  if (!bridge) return null;
  const info = await bridge.request("app.info");
  let activeAudio;
  return {
    info,
    bridge,
    createAudio: (element, options) =>
      (activeAudio = new NativeAudio(bridge, {
        ...options,
        element,
        generation: info.generation,
      })),
    saveFile: (blob, name) =>
      transferBlob(bridge, blob, { kind: "export", name }),
    setBusy: (busy) =>
      bridge
        .request("app.busy", {
          busy,
          locale: globalThis.DIYFM_I18N?.locale() || "en",
        })
        .catch(() => {}),
    prune: () =>
      activeAudio?.waiting
        ? Promise.resolve()
        : bridge.request("media.prune").catch(() => {}),
    updates: () => bridge.request("app.updates"),
  };
}
