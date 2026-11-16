import test from "node:test";
import assert from "node:assert/strict";
import { indexedDB } from "fake-indexeddb";
import { Library } from "../static/library.mjs";
import { createBrowserAPI, assertSeriesPitch, assertEpisodeAngle, cleanPreferences } from "../static/browser-api.mjs";
import { createI18n } from "../static/i18n.mjs";

const library = () => new Library({ indexedDB, name: "series-" + crypto.randomUUID() });
async function call(api, path, method = "GET", body) {
  const response = await api.fetch(path, body === undefined ? { method } : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}

test("series pitch helpers reject thin channel or episode angles", () => {
  assert.throws(() => assertSeriesPitch({ title: "", description: "enough text here", wish: "enough text here" }), /栏目起个名字/);
  assert.throws(() => assertSeriesPitch({ title: "Show", description: "short", wish: "enough text here" }), /栏目是什么/);
  assert.throws(() => assertSeriesPitch({ title: "Show", description: "enough text here", wish: "short" }), /人设或主题/);
  assert.doesNotThrow(() => assertSeriesPitch({ title: "Show", description: "Weekend awkward moments radio", wish: "Light Japanese workplace stories" }));
  assert.throws(() => assertEpisodeAngle(""), /系列里想讲什么/);
  assert.throws(() => assertEpisodeAngle("ab"), /系列里想讲什么/);
  assert.doesNotThrow(() => assertEpisodeAngle("Episode one: wrong station", { retry: false }));
  assert.doesNotThrow(() => assertEpisodeAngle("", { retry: true }));
});

test("creating a show requires series name, pitch and theme; episodes require an angle", async () => {
  const api = createBrowserAPI({ library: library(), request: () => { throw Error("no network"); } });
  await api.ready;
  await api.setKey("unit-test-only-key-" + "a".repeat(30));
  assert.equal((await call(api, "/api/shows", "POST", { language: "en", wish: "too" })).status, 400);
  assert.equal((await call(api, "/api/shows", "POST", {
    title: "Campus Radio",
    description: "Two hosts on campus life",
    wish: "Warm English stories about dorm life",
    language: "en",
    difficulty: "basic",
    host_voice: "Kore",
    guest_voice: "Puck",
  })).status, 200);
  const show = (await call(api, "/api/shows")).data.shows[0];
  assert.equal(show.description, "Two hosts on campus life");
  assert.equal((await call(api, `/api/shows/${show.id}/episodes`, "POST", { request_id: "req_series_1", revision: 0, episode_wish: "" })).status, 400);
  // Without a real Gemini path the job fails after creation; validation must pass first.
  const started = await call(api, `/api/shows/${show.id}/episodes`, "POST", {
    request_id: "req_series_2",
    revision: show.revision,
    episode_wish: "Episode 1 about a lost laundry card",
  });
  assert.equal(started.status, 200);
  assert.equal(started.data.episode.input.episode_wish, "Episode 1 about a lost laundry card");
});

test("cleanPreferences keeps description on patch and i18n covers episode ordinal", () => {
  const next = cleanPreferences({ description: "A longer series pitch text", wish: "A longer ongoing theme text" }, {
    title: "Keep", language: "en", difficulty: "basic", wish: "old", description: "", length: "SHORT", host_voice: "Kore", guest_voice: "Puck", music_style: "none",
  });
  assert.equal(next.description, "A longer series pitch text");
  const ui = createI18n();
  assert.match(ui.t("第 {0} 期", [3]), /3/);
  ui.setLocale("zh-CN");
  assert.equal(ui.t("第 {0} 期", [2]), "第 2 期");
  ui.setLocale("ja");
  assert.equal(ui.t("第 {0} 期", [1]), "第1話");
});
