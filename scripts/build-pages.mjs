import { rm, mkdir, cp, writeFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
await rm("dist", { recursive: true, force: true });
await mkdir("dist");
await cp("static", "dist", { recursive: true });
await writeFile("dist/.nojekyll", "");
const forbidden =
  /(?:AIza[\w-]{25,}|AQ\.[A-Za-z0-9._-]{20,}|github_pat_[\w-]{20,}|gh[pousr]_[\w-]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/;
async function audit(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await audit(path);
    else {
      const text = await readFile(path, "utf8");
      if (forbidden.test(text))
        throw new Error("Possible credential in publish artifact: " + path);
    }
  }
}
await audit("dist");
console.log(
  "Built static GitHub Pages artifact in dist/; credential pattern check passed.",
);
