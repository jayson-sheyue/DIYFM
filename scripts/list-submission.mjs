import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SHARE_LIMIT, decodeChannel } from "../static/sharing.mjs";
import { addCatalogPackage, validateCatalog } from "./catalog.mjs";

export const APPROVED_LABEL = "channel-approved";
export const LISTED_LABEL = "channel-listed";
const WRITE_PERMS = new Set(["admin", "maintain", "write"]);

/** Pull the first usable package URL out of a submission issue body. */
export function extractPackageUrl(body) {
  const text = String(body || "");
  const candidates = [];
  for (const match of text.matchAll(/\[[^\]]*]\((https:\/\/[^)\s]+)\)/g)) candidates.push(match[1]);
  for (const match of text.matchAll(/(?<![(\w])(https:\/\/[^\s<>\]"'`]+)/g)) candidates.push(match[1]);
  for (const raw of candidates) {
    let url;
    try { url = new URL(raw.replace(/[.,;)]+$/, "")); } catch { continue; }
    if (url.protocol !== "https:") continue;
    const path = url.pathname.toLowerCase();
    if (path.endsWith(".zip") || path.includes("/user-attachments/files/") || path.includes("/files/")) return url.href;
  }
  throw Error("Issue body has no HTTPS channel package ZIP or download link.");
}

export function assertApproverPermission(permission) {
  if (!WRITE_PERMS.has(permission)) throw Error(`Only repository write access can approve listings (got ${permission || "none"}).`);
}

export function redactUrl(value) {
  try {
    const url = new URL(value);
    if ([...url.searchParams.keys()].some(k => /amz|token|sign|credential/i.test(k))) return `${url.origin}${url.pathname}?[redacted]`;
    return url.href;
  } catch { return "[invalid-url]"; }
}

export function successComment(result) {
  const action = result.replaced
    ? `Updated Discover listing for **${result.channel.title}** (\`${result.channel.id}\`) — same channel id replaced the previous snapshot.`
    : `Listed **${result.channel.title}** (\`${result.channel.id}\`) for Discover.`;
  return [
    action,
    ``,
    `- Package SHA-256: \`${result.digest}\``,
    ...(result.replaced && result.previousDigest
      ? [`- Previous package SHA-256: \`${result.previousDigest}\``]
      : []),
    `- Episodes in package: ${result.episodes ?? result.channel?.episodes ?? "?"}`,
    `- Language: \`${result.channel.language}\``,
    `- Credit in package: ${result.attribution.author}`,
    `- Source URL used: ${result.packageUrl}`,
    ``,
    `Discover updates when this workflow finishes deploying Pages. Already-downloaded local copies are not overwritten; listeners add the new snapshot explicitly if they want the new episodes.`,
    `To retry later, remove \`${APPROVED_LABEL}\` and add it again.`,
  ].join("\n");
}

export function failureComment(message) {
  return [
    `Automatic listing failed.`,
    ``,
    "```",
    String(message || "Unknown error").slice(0, 2000),
    "```",
    ``,
    `Fix the package or link, then remove \`${APPROVED_LABEL}\` and add it again.`,
  ].join("\n");
}

export async function downloadPackage(url, { token = "", limit = SHARE_LIMIT, fetchImpl = fetch } = {}) {
  let current = url;
  for (let hop = 0; hop < 6; hop++) {
    const headers = { Accept: "application/zip,application/octet-stream,*/*", "User-Agent": "DIYFM-catalog-lister" };
    if (token && /(^|\.)github\.com$|(^|\.)githubusercontent\.com$/.test(new URL(current).hostname)) {
      headers.Authorization = `Bearer ${token}`;
    }
    const response = await fetchImpl(current, { method: "GET", redirect: "manual", headers });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = response.headers.get("location");
      if (!next) throw Error("Package download redirect missing Location.");
      const resolved = new URL(next, current);
      if (resolved.protocol !== "https:") throw Error("Refusing non-HTTPS package redirect.");
      current = resolved.href;
      continue;
    }
    if (!response.ok) throw Error(`Package download failed (${response.status}) for ${redactUrl(current)}.`);
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > limit) throw Error("Package exceeds 100MB.");
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength < 44 || buffer.byteLength > limit) throw Error("Downloaded package is empty or exceeds 100MB.");
    return buffer;
  }
  throw Error("Too many redirects while downloading the package.");
}

async function githubJson(path, { token, method = "GET", body, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "DIYFM-catalog-lister",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw Error(`GitHub API ${method} ${path} failed (${response.status}): ${data?.message || text}`);
  return data;
}

export async function listApprovedSubmission({
  token,
  repository,
  issueNumber,
  actor,
  catalogDir,
  fetchImpl = fetch,
  addPackage = addCatalogPackage,
  validate = validateCatalog,
  issueBody,
  permission,
} = {}) {
  if (!token && issueBody == null) throw Error("GITHUB_TOKEN is required.");
  if (!repository || !repository.includes("/")) throw Error("GITHUB_REPOSITORY must look like owner/name.");
  const number = Number(issueNumber);
  if (!Number.isInteger(number) || number < 1) throw Error("ISSUE_NUMBER must be a positive integer.");
  if (!actor) throw Error("Actor (label sender) is required.");

  const [owner, repo] = repository.split("/");
  const resolvedPermission = permission || (await githubJson(`/repos/${owner}/${repo}/collaborators/${encodeURIComponent(actor)}/permission`, { token, fetchImpl })).permission;
  assertApproverPermission(resolvedPermission);

  const body = issueBody == null
    ? (await githubJson(`/repos/${owner}/${repo}/issues/${number}`, { token, fetchImpl })).body
    : issueBody;
  const packageUrl = extractPackageUrl(body);
  const bytes = await downloadPackage(packageUrl, { token, fetchImpl });
  const { manifest } = await decodeChannel(bytes.buffer);

  const dir = await mkdtemp(join(tmpdir(), "diyfm-list-"));
  const file = join(dir, "channel.zip");
  try {
    await writeFile(file, bytes);
    const listed = await addPackage(file, catalogDir);
    const digest = typeof listed === "string" ? listed : listed.digest;
    const replaced = typeof listed === "object" && !!listed.replaced;
    const previousDigest = typeof listed === "object" ? listed.previousDigest || "" : "";
    const episodes = typeof listed === "object" && listed.episodes != null
      ? listed.episodes
      : manifest.episodes.length;
    await validate(catalogDir);
    return {
      digest,
      replaced,
      previousDigest,
      episodes,
      channel: manifest.channel,
      attribution: manifest.attribution,
      packageUrl: redactUrl(packageUrl),
      issueNumber: number,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function commentOnIssue({ token, repository, issueNumber, body, fetchImpl = fetch }) {
  const [owner, repo] = repository.split("/");
  return githubJson(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, { token, method: "POST", body: { body }, fetchImpl });
}

export async function ensureIssueLabel({ token, repository, issueNumber, label, fetchImpl = fetch }) {
  const [owner, repo] = repository.split("/");
  try {
    await githubJson(`/repos/${owner}/${repo}/issues/${issueNumber}/labels`, { token, method: "POST", body: { labels: [label] }, fetchImpl });
  } catch (error) {
    if (!String(error.message).includes("422")) throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = new Set(process.argv.slice(2));
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  const issueNumber = process.env.ISSUE_NUMBER;
  const actor = process.env.ACTOR;
  const resultPath = process.env.LIST_RESULT_PATH || "list-result.json";

  if (args.has("--comment-success")) {
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    await commentOnIssue({ token, repository, issueNumber: result.issueNumber || issueNumber, body: successComment(result) });
    await ensureIssueLabel({ token, repository, issueNumber: result.issueNumber || issueNumber, label: LISTED_LABEL });
    process.exit(0);
  }

  try {
    const result = await listApprovedSubmission({ token, repository, issueNumber, actor });
    await writeFile(resultPath, JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify({ ok: true, digest: result.digest, id: result.channel.id, title: result.channel.title }));
  } catch (error) {
    const message = error?.message || String(error);
    try {
      if (token && repository && issueNumber) {
        await commentOnIssue({ token, repository, issueNumber, body: failureComment(message) });
      }
    } catch (commentError) {
      console.error("Also failed to comment on the issue:", commentError.message);
    }
    console.error(message);
    process.exit(1);
  }
}
