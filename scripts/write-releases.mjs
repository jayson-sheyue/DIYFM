#!/usr/bin/env node
// Rewrite static/releases/index.json after a GitHub Release's assets exist.
// Usage:
//   node scripts/write-releases.mjs 2.4.9 \
//     --android-sha <hex> --mac-dmg-sha <hex> --mac-zip-sha <hex> \
//     [--published-at 2026-11-16]
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const version = args[0];
if (!/^\d+\.\d+\.\d+$/.test(version || "")) {
  console.error(
    "Usage: node scripts/write-releases.mjs <semver> --android-sha <hex> --mac-dmg-sha <hex> --mac-zip-sha <hex>",
  );
  process.exit(1);
}
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : "";
};
const android = flag("--android-sha");
const macDmg = flag("--mac-dmg-sha");
const macZip = flag("--mac-zip-sha");
const published = flag("--published-at") || new Date().toISOString().slice(0, 10);
const hex = (value, label) => {
  if (!/^[a-f0-9]{64}$/.test(value || "")) {
    console.error(`Missing or invalid ${label}`);
    process.exit(1);
  }
  return value;
};
const doc = {
  format: "diyfm-releases",
  version: 1,
  latest: version,
  published_at: published,
  notes_url: `https://github.com/jayson-sheyue/DIYFM/releases/tag/v${version}`,
  assets: {
    android: {
      name: `DIYFM-${version}-android.apk`,
      url: `https://github.com/jayson-sheyue/DIYFM/releases/download/v${version}/DIYFM-${version}-android.apk`,
      sha256: hex(android, "--android-sha"),
    },
    mac_dmg: {
      name: `DIYFM-${version}-mac-universal.dmg`,
      url: `https://github.com/jayson-sheyue/DIYFM/releases/download/v${version}/DIYFM-${version}-mac-universal.dmg`,
      sha256: hex(macDmg, "--mac-dmg-sha"),
    },
    mac_zip: {
      name: `DIYFM-${version}-mac-universal.zip`,
      url: `https://github.com/jayson-sheyue/DIYFM/releases/download/v${version}/DIYFM-${version}-mac-universal.zip`,
      sha256: hex(macZip, "--mac-zip-sha"),
    },
  },
};
const path = resolve("static/releases/index.json");
await writeFile(path, JSON.stringify(doc, null, 2) + "\n");
console.log(`Wrote ${path} for DIYFM ${version}`);
