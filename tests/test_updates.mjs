import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  APP_VERSION,
  compareSemver,
  parseReleases,
  assetForPlatform,
  checkClientUpdate,
  isAllowedUpdateURL,
  RELEASES_URL,
  RELEASES_PAGE,
} from "../static/updates.mjs";

const fixture = {
  format: "diyfm-releases",
  version: 1,
  latest: "2.4.9",
  published_at: "2026-11-16",
  notes_url: "https://github.com/jayson-sheyue/DIYFM/releases/tag/v2.4.9",
  assets: {
    android: {
      name: "DIYFM-2.4.9-android.apk",
      url: "https://github.com/jayson-sheyue/DIYFM/releases/download/v2.4.9/DIYFM-2.4.9-android.apk",
      sha256: "a".repeat(64),
    },
    mac_dmg: {
      name: "DIYFM-2.4.9-mac-universal.dmg",
      url: "https://github.com/jayson-sheyue/DIYFM/releases/download/v2.4.9/DIYFM-2.4.9-mac-universal.dmg",
      sha256: "b".repeat(64),
    },
    mac_zip: {
      name: "DIYFM-2.4.9-mac-universal.zip",
      url: "https://github.com/jayson-sheyue/DIYFM/releases/download/v2.4.9/DIYFM-2.4.9-mac-universal.zip",
      sha256: "c".repeat(64),
    },
  },
};

test("APP_VERSION matches package.json for Settings display", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url)));
  assert.equal(APP_VERSION, pkg.version);
  assert.match(APP_VERSION, /^\d+\.\d+\.\d+$/);
});

test("semver compares numeric segments, not strings", () => {
  assert.equal(compareSemver("1.10.0", "1.9.0"), 1);
  assert.equal(compareSemver("2.4.8", "2.4.8"), 0);
  assert.equal(compareSemver("2.4.7", "2.4.8"), -1);
});

test("parseReleases accepts only GitHub DIYFM release assets", () => {
  const parsed = parseReleases(fixture);
  assert.equal(parsed.latest, "2.4.9");
  assert.equal(parsed.assets.android.name, "DIYFM-2.4.9-android.apk");
  assert.throws(
    () =>
      parseReleases({
        ...fixture,
        assets: {
          ...fixture.assets,
          android: {
            ...fixture.assets.android,
            url: "https://evil.example/DIYFM-2.4.9-android.apk",
          },
        },
      }),
    /更新下载地址无效/,
  );
  assert.throws(
    () =>
      parseReleases({
        ...fixture,
        notes_url: "https://github.com/other/DIYFM/releases/tag/v2.4.9",
      }),
    /更新说明地址无效/,
  );
});

test("shipped releases index matches the published 2.4.9 assets", async () => {
  const raw = JSON.parse(
    await readFile(new URL("../static/releases/index.json", import.meta.url)),
  );
  const parsed = parseReleases(raw, RELEASES_URL);
  assert.equal(parsed.latest, "2.4.9");
  assert.match(parsed.assets.mac_dmg.url, /mac-universal\.dmg$/);
  assert.equal(parsed.assets.android.sha256.length, 64);
});

test("checkClientUpdate reports available, current, and platform assets", async () => {
  const fetcher = async () =>
    new Response(JSON.stringify(fixture), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  const available = await checkClientUpdate({
    currentVersion: "2.4.8",
    platform: "macOS",
    fetcher,
  });
  assert.equal(available.status, "available");
  assert.equal(available.latest, "2.4.9");
  assert.equal(available.openURL, fixture.assets.mac_dmg.url);
  assert.equal(
    assetForPlatform(parseReleases(fixture), "Android").name,
    "DIYFM-2.4.9-android.apk",
  );
  const current = await checkClientUpdate({
    currentVersion: "2.4.9",
    platform: "Android",
    fetcher,
  });
  assert.equal(current.status, "current");
  assert.equal(current.openURL, RELEASES_PAGE);
  assert.equal(current.asset.name, "DIYFM-2.4.9-android.apk");
});

test("update URLs stay on the DIYFM GitHub releases tree", () => {
  assert.equal(isAllowedUpdateURL(RELEASES_PAGE), true);
  assert.equal(
    isAllowedUpdateURL(
      "https://github.com/jayson-sheyue/DIYFM/releases/download/v2.4.9/DIYFM-2.4.9-android.apk",
    ),
    true,
  );
  assert.equal(isAllowedUpdateURL("https://evil.example/x.apk"), false);
  assert.equal(
    isAllowedUpdateURL(
      "https://github.com/jayson-sheyue/DIYFM/releases/download/v2.4.9/x.apk?token=1",
    ),
    false,
  );
});
