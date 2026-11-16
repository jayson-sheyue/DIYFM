import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createSharingUI, SUBMIT_URL } from "../static/sharing-ui.mjs";
import { createI18n } from "../static/i18n.mjs";

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
// Just enough DOM for the Discover page to paint into; no browser behavior is simulated.
function page() {
  const nodes = new Map();
  const node = () => ({ setAttribute() {}, addEventListener() {}, querySelectorAll: () => [], innerHTML: "" });
  globalThis.document = { createElement: node, body: { append() {} }, getElementById: id => nodes.get(id) || nodes.set(id, node()).get(id) };
  return nodes;
}

test("Discover's submission link opens the issue form that the repository actually ships", async () => {
  const url = new URL(SUBMIT_URL);
  assert.equal(url.origin + url.pathname, "https://github.com/jayson-sheyue/DIYFM/issues/new");
  const template = url.searchParams.get("template");
  assert.match(template, /^[\w-]+\.yml$/);
  const form = await readFile(new URL(`../.github/ISSUE_TEMPLATE/${template}`, import.meta.url), "utf8");
  assert.match(form, /^name: \S/m);
  assert.match(form, /^description: \S/m);
  assert.match(form, /^body:$/m);
  assert.match(form, /public/i);
});

test("the submission prompt is shown in every language, whether or not the catalog has loaded", async () => {
  const nodes = page(), ui = createI18n();
  const entry = { id: "show_listed", title: "Listed", description: "A listed channel.", language: "en", difficulty: "basic", episodes: 1, bytes: 1048576, attribution: { author: "Creator", license: "Personal listening" } };
  const sharing = createSharingUI({ runtime: { catalog: async () => [entry], discardImport() {} }, tr: ui.t, escapeHtml });
  const link = `<a class="quiet" href="${SUBMIT_URL}" target="_blank" rel="noopener noreferrer">`;
  const html = () => nodes.get("resources-view").innerHTML;
  assert.ok(html().includes(link + "Submit your channel"), "before the first refresh");
  assert.match(html(), /Want your channel listed here\?/);
  assert.match(html(), /Submissions are public and need a GitHub account; a maintainer reviews each one before it is listed\./);
  await sharing.refresh();
  assert.match(html(), /data-catalog-add="show_listed"/);
  assert.ok(html().includes(link + "Submit your channel"), "below listed channels");
  ui.setLocale("ja"); sharing.repaint();
  assert.ok(html().includes(link + "チャンネルを投稿"));
  assert.match(html(), /メンテナーの審査後に掲載されます。/);
  ui.setLocale("zh-CN"); sharing.repaint();
  assert.ok(html().includes(link + "投稿你的频道"));
  assert.match(html(), /维护者人工审核后才会上架。/);
});
