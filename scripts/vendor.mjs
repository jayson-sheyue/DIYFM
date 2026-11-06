import { mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
await mkdir("static/vendor", { recursive: true });
for (const [from, to] of [
  ["node_modules/lamejs/lame.min.js", "lame.min.js"],
  ["node_modules/lamejs/lame.all.js", "lame.all.js"],
  ["node_modules/lamejs/LICENSE", "lamejs-LICENSE.txt"],
  ["node_modules/fflate/esm/browser.js", "fflate.mjs"],
  ["node_modules/fflate/LICENSE", "fflate-LICENSE.txt"],
])
  await copyFile(from, `static/vendor/${to}`);
console.log("Vendored pinned MP3/ZIP libraries and licenses.");

// The fallback imports the pinned encoder as a module, without eval or injected scripts.
await writeFile(
  "static/vendor/lame-encoder.mjs",
  (await readFile("node_modules/lamejs/lame.min.js", "utf8")) +
    "\nexport default lamejs;\n",
);
