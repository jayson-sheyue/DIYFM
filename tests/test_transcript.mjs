import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { indexedDB } from 'fake-indexeddb';
import { Library } from '../static/library.mjs';
import { createBrowserAPI } from '../static/browser-api.mjs';
import { transcriptCues, validTurnTiming, cueAt, sentenceParts } from '../static/transcript.mjs';
import { encodeChannel, decodeChannel } from '../static/sharing.mjs';
import { wavBlob, RATE } from '../static/audio.mjs';

const script = 'Host: Hello there. Welcome back!\nGuest: This is a much longer answer. It ends here.';
const timing = { version: 1, gap: 0.22, durations: [2, 7] };
const library = () => new Library({ indexedDB, name: 'transcript-' + crypto.randomUUID() });

test('sentence estimates stay inside measured turns; seeking backwards and gaps do not drift', () => {
  const cues = transcriptCues(script, 9.22, 'en', timing);
  assert.equal(cues.length, 4);
  assert.equal(cues[0].start, 0);
  assert.equal(cues[1].end, 2);
  assert.equal(cues[2].start, 2.22);
  assert.ok(Math.abs(cues[3].end - 9.22) < 1e-9);
  assert.equal(cueAt(cues, 2.1), -1);
  assert.equal(cueAt(cues, 7), 3);
  assert.equal(cueAt(cues, .1), 0);
  assert.equal(cueAt(cues, -1), -1);
  assert.equal(cueAt(cues, NaN), -1);
  assert.equal(cueAt(cues, 10), -1);
});

test('older audio falls back to bounded estimates; Japanese and missing sentence segmenter remain readable', () => {
  const ja = 'Host: こんばんは。今日は雨ですね！\nGuest: そうですね。';
  const cues = transcriptCues(ja, 20, 'ja');
  assert.equal(cues.length, 3);
  assert.equal(cues[0].text, 'こんばんは。');
  assert.ok(Math.abs(cues.at(-1).end - 20) < 1e-9);
  for (let i = 0; i < cues.length; i++) {
    assert.ok(cues[i].end > cues[i].start);
    if (i) assert.equal(cues[i].start, cues[i - 1].end);
  }
  assert.equal(validTurnTiming({ ...timing, durations: [-1, 1] }, script, 9.22), null);
  assert.equal(validTurnTiming(timing, script, 40), null);
  assert.equal(validTurnTiming({ ...timing, durations: [9] }, script, 9), null);
  assert.deepEqual(transcriptCues('', 10, 'en'), []);
  const original = Intl.Segmenter;
  try {
    Intl.Segmenter = undefined;
    assert.deepEqual(sentenceParts('一文です。次です！', 'ja'), ['一文です。', '次です！']);
  } finally { Intl.Segmenter = original; }
});

test('timing survives channel export, validation, import and library backup', async () => {
  const wav = wavBlob(new Float32Array(Math.round(9.22 * RATE)));
  const show = { id: 'show_timed', title: 'Timed', language: 'en', difficulty: 'basic', description: '',
    episodes: [{ id: 'ep_timed', title: 'A story', status: 'ready', script, duration_seconds: 9.22, transcript_timing: timing }] };
  const blob = await encodeChannel(show, { author: 'Test', license: 'Personal listening', episodeIds: ['ep_timed'] }, async () => wav);
  const decoded = await decodeChannel(await blob.arrayBuffer());
  assert.deepEqual(decoded.manifest.episodes[0].transcript_timing, timing);
  const api = createBrowserAPI({ library: library() });
  const preview = await api.prepareImport(await blob.arrayBuffer());
  const saved = await api.commitImport(preview.token);
  const data = await (await api.fetch('/api/shows')).json();
  const ep = data.shows.find(s => s.id === saved.showId).episodes[0];
  const transcript = await (await api.fetch(`/api/episodes/${ep.id}/transcript`)).json();
  assert.deepEqual(transcript.transcript_timing, timing);
  const backup = await (await api.fetch('/api/backup')).arrayBuffer();
  const target = createBrowserAPI({ library: library() });
  await target.importBackup(backup);
  const restored = await (await target.fetch('/api/shows')).json();
  assert.deepEqual(restored.shows[0].episodes[0].transcript_timing, timing);
  api.dispose(); target.dispose();
});

test('first-run APIs do not wait for samples; concurrent previews fetch only the selected package and never import it', async () => {
  const catalog = JSON.parse(await readFile(new URL('../static/catalog/index.json', import.meta.url), 'utf8'));
  const paths = [];
  let failOnce = true;
  const api = createBrowserAPI({ library: library(), bundledCatalogURL: 'https://example.test/catalog/index.json',
    request: () => { throw Error('Unexpected model request'); },
    fetcher: async url => {
      const path = new URL(url).pathname.replace('/catalog/', '');
      paths.push(path);
      if (path === 'index.json') return new Response(JSON.stringify(catalog));
      if (failOnce) { failOnce = false; throw Error('Disconnected'); }
      return new Response(await readFile(new URL('../static/catalog/' + path, import.meta.url)));
    },
  });
  await api.ready;
  assert.deepEqual(paths, []);
  assert.deepEqual((await (await api.fetch('/api/shows')).json()).shows, []);
  await assert.rejects(api.featured('en'));
  const [first, second] = await Promise.all([api.featured('en'), api.featured('en')]);
  assert.equal(first, second);
  assert.ok(first.url.startsWith('blob:'));
  assert.match(first.script, /Host:/);
  assert.equal((await api.featured('en')).url, first.url);
  assert.equal(paths.filter(p => p.endsWith('.zip')).length, 2, 'one failed request and one shared retry');
  assert.ok(paths.every(p => p === 'index.json' || p.endsWith(catalog.channels.find(c => c.id === 'show_starter_en').package.split('/').at(-1))));
  assert.deepEqual((await (await api.fetch('/api/shows')).json()).shows, []);
  await api.featured('ja');
  assert.equal(paths.filter(p => p.endsWith('.zip')).length, 3);
  api.dispose();
});
