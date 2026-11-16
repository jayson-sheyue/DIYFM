import { readFile, writeFile, mkdir, copyFile, stat, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { decodeChannel, parseCatalog, sha256, SHARE_LIMIT, CATALOG_URL } from "../static/sharing.mjs";
const root = resolve(new URL("../static/catalog/", import.meta.url).pathname);
export async function validateCatalog(directory = root) {
  const document = JSON.parse(await readFile(join(directory, "index.json"), "utf8"));
  const entries = parseCatalog(document);
  for (const entry of entries) {
    const path = join(directory, "packages", new URL(entry.url).pathname.split("/").at(-1));
    if ((await stat(path)).size !== entry.bytes) throw Error("Catalog package size mismatch");
    const bytes = new Uint8Array(await readFile(path));
    if (await sha256(bytes) !== entry.sha256) throw Error("Catalog package digest mismatch");
    const { manifest } = await decodeChannel(bytes.buffer);
    if (manifest.channel.id !== entry.id || manifest.channel.title !== entry.title || manifest.channel.language !== entry.language || manifest.channel.difficulty !== entry.difficulty || manifest.channel.description !== entry.description || manifest.episodes.length !== entry.episodes || JSON.stringify(manifest.attribution) !== JSON.stringify(entry.attribution)) throw Error("Catalog metadata does not match package");
  }
  return entries.length;
}
export async function addCatalogPackage(file, directory = root) {
    if ((await stat(file)).size > SHARE_LIMIT) throw Error("Package exceeds 100MB");
    const bytes = new Uint8Array(await readFile(file)), { manifest } = await decodeChannel(bytes.buffer);
    const digest = await sha256(bytes), name = `${digest}.zip`;
    const doc = JSON.parse(await readFile(join(directory, "index.json"), "utf8"));
    parseCatalog(doc, CATALOG_URL);
    const previous = doc.channels.find((c) => c.id === manifest.channel.id) || null;
    const replaced = !!(previous && previous.sha256 !== digest);
    await mkdir(join(directory, "packages"), { recursive: true });
    await copyFile(file, join(directory, "packages", name));
    doc.channels = [{ ...manifest.channel, attribution: manifest.attribution, episodes: manifest.episodes.length, package: `packages/${name}`, bytes: bytes.length, sha256: digest }, ...doc.channels.filter(c => c.id !== manifest.channel.id)];
    await writeFile(join(directory, "index.json"), JSON.stringify(doc, null, 2) + "\n");
    // Drop the previous ZIP for this channel id when the digest changed and nothing else references it.
    if (replaced && previous?.sha256) {
      const stillUsed = doc.channels.some((c) => c.sha256 === previous.sha256);
      if (!stillUsed) {
        try { await unlink(join(directory, "packages", `${previous.sha256}.zip`)); }
        catch (error) { if (error?.code !== "ENOENT") throw error; }
      }
    }
    return { digest, replaced, previousDigest: previous?.sha256 || "", channelId: manifest.channel.id, episodes: manifest.episodes.length };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === "add" && process.argv[3]) {
    const result = await addCatalogPackage(resolve(process.argv[3]));
    console.log(result.replaced
      ? `Replaced Discover listing for ${result.channelId} (${result.episodes} episodes). Review before committing/publishing.`
      : "Prepared a public catalog entry locally. Review its metadata, audio and usage rights before committing/publishing.");
  } else if (process.argv[2] !== "check") throw Error("Usage: node scripts/catalog.mjs check | add /path/to/channel.zip");
  console.log(`Validated ${await validateCatalog()} curated channel(s).`);
}
