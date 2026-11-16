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

test("series pitch helpers require theme_id and allow empty episode angles", () => {
  assert.throws(() => assertSeriesPitch({ title: "", theme_id: "daily", wish: "enough text here" }), /栏目起个名字/);
  assert.throws(() => assertSeriesPitch({ title: "Show", theme_id: "", wish: "enough text here" }), /栏目主题/);
  assert.throws(() => assertSeriesPitch({ title: "Show", theme_id: "daily", wish: "short" }), /栏目主题/);
  assert.doesNotThrow(() => assertSeriesPitch({ title: "Show", theme_id: "work", wish: "Light Japanese workplace stories" }));
  assert.doesNotThrow(() => assertEpisodeAngle(""));
  assert.doesNotThrow(() => assertEpisodeAngle("Episode one: wrong station"));
  assert.doesNotThrow(() => assertEpisodeAngle("", { retry: true }));
  assert.throws(() => assertEpisodeAngle("x".repeat(601)), /600/);
});

test("creating a show requires theme; episodes can omit an angle", async () => {
  const api = createBrowserAPI({ library: library(), request: () => { throw Error("no network"); } });
  await api.ready;
  await api.setKey("unit-test-only-key-" + "a".repeat(30));
  assert.equal((await call(api, "/api/shows", "POST", { language: "en", wish: "too" })).status, 400);
  assert.equal((await call(api, "/api/shows", "POST", {
    title: "Campus Radio",
    theme_id: "custom",
    wish: "Warm English stories about dorm life",
    language: "en",
    difficulty: "basic",
    host_voice: "Kore",
    guest_voice: "Puck",
  })).status, 200);
  const show = (await call(api, "/api/shows")).data.shows[0];
  assert.equal(show.theme_id, "custom");
  assert.equal(show.description, "Warm English stories about dorm life");
  const started = await call(api, `/api/shows/${show.id}/episodes`, "POST", {
    request_id: "req_series_1",
    revision: show.revision,
    episode_wish: "",
  });
  assert.equal(started.status, 200);
  assert.equal(started.data.episode.input.episode_wish, "");
});

test("cleanPreferences migrates missing theme_id and syncs description from wish", () => {
  const next = cleanPreferences({ wish: "A longer ongoing theme text" }, {
    title: "Keep", language: "en", difficulty: "basic", wish: "old", description: "", length: "SHORT", host_voice: "Kore", guest_voice: "Puck", music_style: "none",
  });
  assert.equal(next.theme_id, "custom");
  assert.equal(next.description, "A longer ongoing theme text");
  const ui = createI18n();
  assert.match(ui.t("第 {0} 期", [3]), /3/);
  ui.setLocale("zh-CN");
  assert.equal(ui.t("第 {0} 期", [2]), "第 2 期");
  ui.setLocale("ja");
  assert.equal(ui.t("第 {0} 期", [1]), "第1話");
});
