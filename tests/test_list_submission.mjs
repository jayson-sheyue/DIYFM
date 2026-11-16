import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexedDB } from "fake-indexeddb";
import { Library } from "../static/library.mjs";
import { createBrowserAPI } from "../static/browser-api.mjs";
import { wavBlob, RATE } from "../static/audio.mjs";
import {
  extractPackageUrl,
  assertApproverPermission,
  redactUrl,
  downloadPackage,
  listApprovedSubmission,
  successComment,
  failureComment,
  APPROVED_LABEL,
} from "../scripts/list-submission.mjs";
import { validateCatalog } from "../scripts/catalog.mjs";

const credit = { author: "Lister", source_url: "https://example.org/ch", license: "Personal listening" };
const tone = wavBlob(Float32Array.from({ length: RATE }, (_, i) => .1 * Math.sin(2 * Math.PI * 440 * i / RATE)));

async function sampleZip() {
  const db = new Library({ indexedDB, name: "list-" + crypto.randomUUID() });
  await db.ready;
  const show = {
    id: "show_list_me",
    title: "List me",
    language: "en",
    difficulty: "basic",
    host_voice: "Kore",
    guest_voice: "Puck",
    length: "SHORT",
    music_style: "morning_acoustic",
    revision: 0,
    episodes: [{ id: "ep1", title: "One", summary: "s", script: "Host: Hi.\nGuest: Hello.", expressions: [], status: "ready", duration_seconds: 1, created_at: "2026-11-16T00:00:00Z", music_source: "generated" }],
  };
  await db.write([["shows", [show]], ["audio:ep1", tone]]);
  const api = createBrowserAPI({ library: db, request: () => { throw Error("no network"); } });
  await api.ready;
  return new Uint8Array(await (await api.exportChannel(show.id, { ...credit, description: "A listed sample.", episodeIds: ["ep1"] })).arrayBuffer());
}

test("extractPackageUrl prefers markdown ZIP links and ignores unrelated https text", () => {
  const body = `### Channel package\n\nSee https://example.org/about and [pkg](https://github.com/user-attachments/files/1/diyfm-channel-show_abc.zip)\n`;
  assert.equal(extractPackageUrl(body), "https://github.com/user-attachments/files/1/diyfm-channel-show_abc.zip");
  assert.equal(
    extractPackageUrl("https://cdn.example.org/files/diyfm-channel-show_x.zip"),
    "https://cdn.example.org/files/diyfm-channel-show_x.zip",
  );
  assert.throws(() => extractPackageUrl("no link here"), /no HTTPS channel package/);
  assert.throws(() => extractPackageUrl("http://evil.example/x.zip"), /no HTTPS channel package/);
});

test("approver permission and URL redaction", () => {
  assert.doesNotThrow(() => assertApproverPermission("write"));
  assert.doesNotThrow(() => assertApproverPermission("admin"));
  assert.throws(() => assertApproverPermission("triage"), /write access/);
  assert.throws(() => assertApproverPermission("read"), /write access/);
  assert.match(
    redactUrl("https://objects.githubusercontent.com/file?X-Amz-Credential=AKIA&X-Amz-Signature=abc"),
    /\[redacted\]$/,
  );
});

test("downloadPackage follows HTTPS redirects, enforces size, and rejects http redirects", async () => {
  const bytes = new Uint8Array(64).fill(7);
  const fetchImpl = async (url, init) => {
    assert.equal(init.redirect, "manual");
    if (String(url).includes("start")) {
      return { status: 302, ok: false, headers: { get: k => k === "location" ? "https://cdn.example/file.zip" : null } };
    }
    if (String(url).includes("http-redirect")) {
      return { status: 302, ok: false, headers: { get: k => k === "location" ? "http://evil.example/x.zip" : null } };
    }
    if (String(url).includes("huge")) {
      return { status: 200, ok: true, headers: { get: k => k === "content-length" ? String(200 * 1024 * 1024) : null }, arrayBuffer: async () => bytes.buffer };
    }
    return { status: 200, ok: true, headers: { get: () => null }, arrayBuffer: async () => bytes.buffer.slice(0) };
  };
  assert.deepEqual(await downloadPackage("https://github.com/start", { fetchImpl }), bytes);
  await assert.rejects(downloadPackage("https://github.com/http-redirect", { fetchImpl }), /non-HTTPS/);
  await assert.rejects(downloadPackage("https://github.com/huge", { fetchImpl }), /100MB/);
});

test("listApprovedSubmission validates the ZIP and updates a catalog directory", async () => {
  const zip = await sampleZip();
  const catalogDir = await mkdtemp(join(tmpdir(), "diyfm-cat-"));
  await mkdir(join(catalogDir, "packages"), { recursive: true });
  await writeFile(join(catalogDir, "index.json"), JSON.stringify({ format: "diyfm-catalog", version: 1, channels: [] }, null, 2) + "\n");
  const fetchImpl = async (url) => {
    if (String(url).includes("/collaborators/")) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ permission: "admin" }) };
    }
    if (String(url).endsWith(".zip") || String(url).includes("attachments")) {
      return { status: 200, ok: true, headers: { get: () => null }, arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) };
    }
    throw Error("unexpected fetch " + url);
  };
  // Bypass GitHub issue fetch by supplying the body directly; still checks permission via API.
  const original = listApprovedSubmission;
  const result = await original({
    token: "test-token",
    repository: "jayson-sheyue/DIYFM",
    issueNumber: 1,
    actor: "maintainer",
    catalogDir,
    fetchImpl,
    issueBody: "### Channel package\n\n[z](https://github.com/user-attachments/files/9/diyfm-channel-show_list.zip)\n",
    permission: "admin",
  });
  assert.equal(result.channel.id, "show_list_me");
  assert.equal(result.channel.title, "List me");
  assert.equal(result.replaced, false);
  assert.match(result.digest, /^[a-f0-9]{64}$/);
  assert.equal(await validateCatalog(catalogDir), 1);
  const index = JSON.parse(await readFile(join(catalogDir, "index.json"), "utf8"));
  assert.equal(index.channels[0].sha256, result.digest);
  assert.match(successComment(result), new RegExp(APPROVED_LABEL));
  assert.match(successComment(result), /Listed/);
  assert.match(
    successComment({ ...result, replaced: true, previousDigest: "abc", episodes: 2 }),
    /Updated Discover listing|replaced the previous snapshot/,
  );
  assert.match(failureComment("boom"), /boom/);
  await rm(catalogDir, { recursive: true, force: true });
});
