import test from "node:test";
import assert from "node:assert/strict";
import { createI18n, LOCALE_STORAGE } from "../static/i18n.mjs";
import { MESSAGES } from "../static/messages.mjs";
const storage = () => {
  const values = new Map();
  return {
    values,
    getItem: (k) => values.get(k),
    setItem: (k, v) => values.set(k, v),
  };
};
test("English is the first-run default and an explicit locale survives reload", () => {
  const store = storage(),
    ui = createI18n({ storage: store });
  assert.equal(ui.locale(), "en");
  assert.equal(ui.t("设置"), "Settings");
  assert.equal(ui.setLocale("ja"), true);
  assert.equal(ui.t("设置"), "設定");
  assert.equal(createI18n({ storage: store }).locale(), "ja");
  assert.equal(ui.setLocale("zh-CN"), true);
  assert.equal(createI18n({ storage: store }).t("设置"), "设置");
  assert.equal(ui.setLocale("de"), false);
  assert.deepEqual([...store.values.keys()], [LOCALE_STORAGE]);
  store.setItem(LOCALE_STORAGE, '"unsupported"');
  assert.equal(createI18n({ storage: store }).locale(), "en");
});
test("unavailable storage does not block switching; missing Japanese falls back to English", () => {
  const ui = createI18n({
    storage: {
      getItem() {
        throw Error();
      },
      setItem() {
        throw Error();
      },
    },
    messages: { sample: { en: "English fallback" } },
  });
  assert.equal(ui.locale(), "en");
  assert.equal(ui.setLocale("ja"), true);
  assert.equal(ui.t("sample"), "English fallback");
});
test("translation never rewrites interpolated titles, markup, or original script text", () => {
  const ui = createI18n();
  const title = "设置 <script>alert(1)</script> 日本語";
  const escaped = "设置 &lt;script&gt;alert(1)&lt;/script&gt; 日本語";
  assert.equal(
    ui.html`<p>频道愿望：${escaped}</p>`,
    `<p>Channel wish: ${escaped}</p>`,
  );
  assert.ok(
    ui.msg`删除「${title}」这一集及其台本和音频？频道偏好和其他来信会保留，此操作无法撤销。`.includes(
      title,
    ),
  );
  assert.ok(ui.t("频道愿望：").includes("Channel"));
  assert.equal(
    ui.t("unrecognized saved story text"),
    "unrecognized saved story text",
  );
  assert.equal(ui.t("custom message ends"), "custom message ends");
});
test("saved task messages and status parameters can change language without regenerating", () => {
  const ui = createI18n();
  const status = ui.msg`${ui.t("正在混音")}。可以在应用内换页，进度与结果都在「消息」中。请保持此网页打开。`;
  ui.setLocale("ja");
  assert.match(ui.t(status), /音声をミックスしています/);
  assert.match(
    ui.t("Google 请求失败（HTTP 429）。配额或速率受限，请稍后重试。"),
    /利用枠またはレート制限/,
  );
  ui.setLocale("zh-CN");
  assert.match(ui.t(status), /正在混音/);
});
test("all shipped locales keep complete messages and the same interpolation parameters", () => {
  const slots = (s) => [...s.matchAll(/\{\d+\}/g)].map((m) => m[0]).sort();
  for (const [key, translations] of Object.entries(MESSAGES)) {
    for (const locale of ["en", "ja", "zh-CN"]) {
      assert.ok(translations[locale]?.trim(), `${locale}: ${key}`);
      assert.deepEqual(
        slots(translations[locale]),
        slots(key),
        `${locale}: ${key}`,
      );
    }
  }
});
test("formatted HTML line breaks do not leave partially translated hints", () => {
  const ui = createI18n();
  ui.setLocale("ja");
  const hint = ui.html([
    `<p>相同模型、声线和语言会复用 7
    天内的试听。重新生成会再次请求服务；失败时旧试听仍保留。</p>`,
  ]);
  assert.match(hint, /同じモデル・声・言語/);
  assert.doesNotMatch(hint, /相同|会复用|重新生成/);
});
