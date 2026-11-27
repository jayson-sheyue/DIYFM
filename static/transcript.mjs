import { speechTurns } from "./harness.mjs?v=2.6.0";

// TTS returns audio per turn, not sentence timestamps. Sentence positions within
// each turn are estimates; old recordings fall back to whole-recording estimates.
export function sentenceParts(text, language = "en") {
  if (globalThis.Intl?.Segmenter) {
    return [...new Intl.Segmenter(language, { granularity: "sentence" }).segment(text)]
      .map(part => part.segment.trim()).filter(Boolean);
  }
  return (text.match(/[^.!?。！？]+(?:[.!?。！？]+["'」』”’]*)?|[.!?。！？]+/gu) || [text])
    .map(part => part.trim()).filter(Boolean);
}
const weight = text => Math.max(1,
  (text.match(/[\u3040-\u30ff\u3400-\u9fff]/gu) || []).length +
  (text.match(/[\p{L}\p{N}]+/gu) || []).filter(word => !/[\u3040-\u30ff\u3400-\u9fff]/u.test(word)).length * 2);

export function validTurnTiming(timing, script, duration) {
  if (!timing || timing.version !== 1 || !Array.isArray(timing.durations) ||
      timing.durations.length !== speechTurns([], script).length ||
      timing.durations.length > 500 || !timing.durations.length ||
      !Number.isFinite(timing.gap) || timing.gap < 0 || timing.gap > 2 ||
      timing.durations.some(n => !Number.isFinite(n) || n <= 0 || n > 1200)) return null;
  const total = timing.durations.reduce((sum, n) => sum + n, 0) + timing.gap * (timing.durations.length - 1);
  if (!Number.isFinite(duration) || Math.abs(total - duration) > 0.1) return null;
  return { version: 1, gap: timing.gap, durations: [...timing.durations] };
}

export function transcriptCues(script, duration, language, timing) {
  const turns = speechTurns([], script);
  if (!turns.length || !Number.isFinite(duration) || duration <= 0) return [];
  const valid = validTurnTiming(timing, script, duration);
  const totalWeight = turns.reduce((sum, t) => sum + weight(t.text), 0);
  let start = 0;
  return turns.flatMap((turn, turnIndex) => {
    const span = valid ? valid.durations[turnIndex] : duration * weight(turn.text) / totalWeight;
    const parts = sentenceParts(turn.text, language);
    const sum = parts.reduce((n, text) => n + weight(text), 0);
    const cues = parts.map(text => {
      const length = span * weight(text) / sum;
      const cue = { speaker: turn.speaker, text, start, end: start + length };
      start += length;
      return cue;
    });
    if (valid && turnIndex < turns.length - 1) start += valid.gap;
    return cues;
  });
}

export function cueAt(cues, time) {
  if (!Number.isFinite(time) || time < 0) return -1;
  return cues.findIndex(cue => time >= cue.start && time < cue.end);
}
