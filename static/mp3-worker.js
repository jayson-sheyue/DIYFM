/* lamejs is self-hosted; no network or credentials are used by the encoder. */
importScripts("./vendor/lame.min.js?v=1.2.1");
self.onmessage = (event) => {
  try {
    const { pcm, rate } = event.data,
      encoder = new lamejs.Mp3Encoder(1, rate, 128),
      chunks = [];
    const samples = new Int16Array(pcm.length);
    for (let i = 0; i < pcm.length; i++)
      samples[i] = Math.max(-32768, Math.min(32767, pcm[i] * 32767));
    for (let i = 0; i < samples.length; i += 1152) {
      const output = encoder.encodeBuffer(samples.subarray(i, i + 1152));
      if (output.length) chunks.push(new Uint8Array(output));
    }
    const end = encoder.flush();
    if (end.length) chunks.push(new Uint8Array(end));
    self.postMessage(
      { chunks },
      chunks.map((c) => c.buffer),
    );
  } catch {
    self.postMessage({ error: true });
  }
};

self.postMessage({ ready: true });
