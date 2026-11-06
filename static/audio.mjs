export const RATE = 24000;
export function base64Bytes(data) {
  const raw = atob(data),
    bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
export function wavBlob(pcm, rate = RATE) {
  const data = new ArrayBuffer(44 + pcm.length * 2),
    v = new DataView(data);
  const str = (offset, s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(offset + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  v.setUint32(4, data.byteLength - 8, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++)
    v.setInt16(
      44 + i * 2,
      Math.max(-32768, Math.min(32767, Math.round(pcm[i] * 32767))),
      true,
    );
  return new Blob([data], { type: "audio/wav" });
}
export function readWav(buffer) {
  const v = new DataView(buffer),
    text = (n, k) => String.fromCharCode(...new Uint8Array(buffer, n, k));
  if (buffer.byteLength < 44 || text(0, 4) !== "RIFF" || text(8, 4) !== "WAVE")
    return null;
  let rate = 0,
    channels = 0,
    bits = 0,
    format = 0;
  for (let offset = 12; offset + 8 <= v.byteLength; ) {
    const name = text(offset, 4),
      size = v.getUint32(offset + 4, true),
      start = offset + 8;
    if (start + size > v.byteLength) throw new Error("音频文件不完整。");
    if (name === "fmt " && size >= 16) {
      format = v.getUint16(start, true);
      channels = v.getUint16(start + 2, true);
      rate = v.getUint32(start + 4, true);
      bits = v.getUint16(start + 14, true);
    }
    if (name === "data" && format === 1 && bits === 16 && channels && rate) {
      const pcm = new Float32Array(Math.floor(size / (channels * 2)));
      for (let i = 0; i < pcm.length; i++) {
        let sum = 0;
        for (let c = 0; c < channels; c++)
          sum += v.getInt16(start + (i * channels + c) * 2, true) / 32768;
        pcm[i] = sum / channels;
      }
      return { pcm, rate };
    }
    offset = start + size + (size % 2);
  }
  return null;
}
export function resample(pcm, from, to = RATE) {
  if (from === to) return pcm;
  const out = new Float32Array(Math.round((pcm.length * to) / from));
  for (let i = 0; i < out.length; i++) {
    const p = (i * from) / to,
      a = Math.floor(p),
      b = Math.min(pcm.length - 1, a + 1);
    out[i] = (pcm[a] || 0) * (1 - (p - a)) + (pcm[b] || 0) * (p - a);
  }
  return out;
}
export async function blobPCM(blob) {
  const buffer = await blob.arrayBuffer(),
    wav = readWav(buffer);
  if (wav) return resample(wav.pcm, wav.rate);
  const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!Context)
    throw new Error(
      "当前浏览器不支持音频解码，请使用较新的 Chrome、Edge、Firefox 或 Safari。",
    );
  const ctx = new Context();
  try {
    const decoded = await ctx.decodeAudioData(buffer),
      mono = new Float32Array(decoded.length);
    for (let c = 0; c < decoded.numberOfChannels; c++) {
      const channel = decoded.getChannelData(c);
      for (let i = 0; i < mono.length; i++)
        mono[i] += channel[i] / decoded.numberOfChannels;
    }
    return resample(mono, decoded.sampleRate);
  } catch {
    throw new Error("浏览器未能解码音频，台本与已有音频仍保留。");
  } finally {
    await ctx.close();
  }
}
export async function partsBlob(parts) {
  const blocks = [];
  for (const part of parts) {
    const bytes = base64Bytes(part.data);
    if (/(?:L16|pcm)/i.test(part.mime)) {
      if (bytes.length % 2) throw new Error("语音 PCM 长度无效，台本已保留。");
      const v = new DataView(bytes.buffer),
        pcm = new Float32Array(bytes.length / 2);
      for (let i = 0; i < pcm.length; i++)
        pcm[i] = v.getInt16(i * 2, true) / 32768;
      const rate = Number(part.mime.match(/rate=(\d+)/i)?.[1] || RATE);
      blocks.push(resample(pcm, rate));
    } else blocks.push(await blobPCM(new Blob([bytes], { type: part.mime })));
  }
  return wavBlob(joinPCM(blocks));
}
export function joinPCM(blocks, gap = 0) {
  const length =
    blocks.reduce((n, b) => n + b.length, 0) +
    Math.max(0, blocks.length - 1) * gap;
  if (length > RATE * 1200)
    throw new Error("生成音频超过 20 分钟，请缩短时长。");
  const out = new Float32Array(length);
  let offset = 0;
  for (const block of blocks) {
    out.set(block, offset);
    offset += block.length + gap;
  }
  return out;
}
export function mixPCM(voice, music) {
  if (!music?.length) return voice;
  const out = new Float32Array(voice.length),
    fade = Math.min(RATE * 2, music.length / 8);
  for (let i = 0; i < out.length; i++) {
    const p = i % music.length,
      edge = Math.min(1, p / fade, (music.length - p) / fade),
      envelope = Math.min(1, i / RATE, (out.length - i) / RATE);
    out[i] = Math.max(
      -0.99,
      Math.min(0.99, voice[i] + music[p] * 0.12 * edge * envelope),
    );
  }
  return out;
}
export function encodeMP3(
  pcm,
  {
    workerFactory = () =>
      new Worker(new URL("./mp3-worker.js?v=2.1.2", import.meta.url)),
    loadEncoder = () => import("./vendor/lame-encoder.mjs?v=1.2.1"),
    yieldToPage = () => new Promise((resolve) => setTimeout(resolve, 0)),
  } = {},
) {
  return new Promise((resolve, reject) => {
    let worker,
      startup,
      phase = "worker";
    const stopWorker = () => {
      clearTimeout(startup);
      if (worker) {
        worker.onmessage = worker.onerror = worker.onmessageerror = null;
        worker.terminate();
        worker = null;
      }
    };
    const finish = (failure, blob) => {
      if (phase === "done") return;
      phase = "done";
      clearTimeout(timeout);
      stopWorker();
      failure ? reject(failure) : resolve(blob);
    };
    const timeout = setTimeout(
      () => finish(new Error("MP3 编码超时，请重试，原音频仍保留。")),
      180000,
    );
    const fallback = async () => {
      if (phase !== "worker") return;
      phase = "fallback";
      stopWorker();
      try {
        const { default: lame } = await loadEncoder();
        if (phase === "done") return;
        const encoder = new lame.Mp3Encoder(1, RATE, 128),
          chunks = [];
        // Small batches keep navigation responsive and avoid a second full-size PCM buffer.
        for (let offset = 0; offset < pcm.length; offset += 1152) {
          if (phase === "done") return;
          const samples = new Int16Array(Math.min(1152, pcm.length - offset));
          for (let i = 0; i < samples.length; i++)
            samples[i] = Math.max(
              -32768,
              Math.min(32767, pcm[offset + i] * 32767),
            );
          const output = encoder.encodeBuffer(samples);
          if (output.length) chunks.push(new Uint8Array(output));
          if (offset % (1152 * 16) === 0) await yieldToPage();
        }
        if (phase === "done") return;
        const end = encoder.flush();
        if (end.length) chunks.push(new Uint8Array(end));
        finish(null, new Blob(chunks, { type: "audio/mpeg" }));
      } catch {
        finish(
          new Error(
            "MP3 编码器加载或运行失败，请刷新页面后重试。原音频仍保留。",
          ),
        );
      }
    };
    try {
      worker = workerFactory();
      worker.onmessage = (event) => {
        if (phase !== "worker") return;
        if (event.data?.ready) {
          clearTimeout(startup);
          try {
            // Preserve the input for fallback if the Worker fails after startup.
            worker.postMessage({ pcm, rate: RATE });
          } catch {
            void fallback();
          }
        } else if (event.data?.error) {
          finish(new Error("MP3 编码未完成，原音频仍保留。"));
        } else if (
          Array.isArray(event.data?.chunks) &&
          event.data.chunks.length
        ) {
          finish(null, new Blob(event.data.chunks, { type: "audio/mpeg" }));
        } else {
          void fallback();
        }
      };
      worker.onerror = (event) => {
        event.preventDefault?.();
        void fallback();
      };
      worker.onmessageerror = () => {
        void fallback();
      };
      startup = setTimeout(() => {
        void fallback();
      }, 8000);
    } catch {
      void fallback();
    }
  });
}
