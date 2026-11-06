import { mkdir, copyFile } from "node:fs/promises";
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
