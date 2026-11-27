// Soft client updates: compare the installed native version to a fixed Pages
// releases manifest, then open the matching GitHub Release asset in the browser.
// No automatic download or install is claimed.

/** Keep in sync with package.json version (and cache-bust query strings). */
export const APP_VERSION = "2.6.0";

export const RELEASES_URL =
  "https://jayson-sheyue.github.io/DIYFM/releases/index.json";
export const RELEASES_PAGE =
  "https://github.com/jayson-sheyue/DIYFM/releases";
const REPO = "jayson-sheyue/DIYFM";
const ASSET_KEYS = Object.freeze(["android", "mac_dmg", "mac_zip"]);
const fail = (key) => {
  throw new Error(key);
};
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const semver = (value) =>
  typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value) ? value : "";
const hash = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export function compareSemver(a, b) {
  const left = semver(a),
    right = semver(b);
  if (!left || !right) fail("更新清单格式无效，请稍后重试。");
  const pa = left.split(".").map(Number),
    pb = right.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

function releaseDownloadURL(url, expectedVersion, expectedName) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    fail("更新下载地址无效。");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "github.com" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    fail("更新下载地址无效。");
  const prefix = `/${REPO}/releases/download/v${expectedVersion}/`;
  if (
    !parsed.pathname.startsWith(prefix) ||
    parsed.pathname.slice(prefix.length) !== expectedName ||
    !/^[A-Za-z0-9_.-]+$/.test(expectedName)
  )
    fail("更新下载地址无效。");
  return parsed.href;
}

function notesURL(url, expectedVersion) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    fail("更新说明地址无效。");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "github.com" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== `/${REPO}/releases/tag/v${expectedVersion}`
  )
    fail("更新说明地址无效。");
  return parsed.href;
}

function asset(value, version) {
  if (!object(value) || !hash(value.sha256)) fail("更新清单格式无效，请稍后重试。");
  const name =
    typeof value.name === "string" &&
    /^DIYFM-\d+\.\d+\.\d+-(android\.apk|mac-universal\.(dmg|zip))$/.test(
      value.name,
    )
      ? value.name
      : "";
  if (!name || !name.includes(version)) fail("更新清单格式无效，请稍后重试。");
  return {
    name,
    url: releaseDownloadURL(value.url, version, name),
    sha256: value.sha256,
  };
}

export function parseReleases(value, releasesURL = RELEASES_URL) {
  if (
    !object(value) ||
    value.format !== "diyfm-releases" ||
    value.version !== 1 ||
    !semver(value.latest) ||
    !object(value.assets)
  )
    fail("更新清单格式无效，请稍后重试。");
  // Keep the URL parameter so callers bind the fixed origin they fetched from.
  void new URL(releasesURL);
  const latest = value.latest;
  const assets = {};
  for (const key of ASSET_KEYS) {
    if (!(key in value.assets)) fail("更新清单格式无效，请稍后重试。");
    assets[key] = asset(value.assets[key], latest);
  }
  for (const key of Object.keys(value.assets)) {
    if (!ASSET_KEYS.includes(key)) fail("更新清单格式无效，请稍后重试。");
  }
  return {
    format: "diyfm-releases",
    version: 1,
    latest,
    notes_url: notesURL(value.notes_url, latest),
    published_at:
      typeof value.published_at === "string" && value.published_at.length <= 40
        ? value.published_at
        : "",
    assets,
  };
}

export function assetForPlatform(manifest, platform) {
  if (!manifest?.assets) return null;
  if (platform === "Android") return manifest.assets.android;
  if (platform === "macOS") return manifest.assets.mac_dmg || manifest.assets.mac_zip;
  return null;
}

export function isAllowedUpdateURL(url) {
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== "github.com" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    )
      return false;
    return (
      parsed.pathname === `/${REPO}/releases` ||
      parsed.pathname === `/${REPO}/releases/` ||
      parsed.pathname.startsWith(`/${REPO}/releases/tag/`) ||
      parsed.pathname.startsWith(`/${REPO}/releases/download/`)
    );
  } catch {
    return false;
  }
}

export async function fetchReleases(
  fetcher = fetch,
  releasesURL = RELEASES_URL,
  signal,
) {
  const response = await fetcher(releasesURL, {
    signal,
    credentials: "omit",
    referrerPolicy: "no-referrer",
    redirect: "error",
    cache: "no-store",
  });
  if (!response.ok || response.type === "opaque")
    fail("无法检查更新，请检查网络后重试。");
  const text = await response.text();
  if (text.length > 64 * 1024) fail("更新清单格式无效，请稍后重试。");
  return parseReleases(JSON.parse(text), releasesURL);
}

export async function checkClientUpdate({
  currentVersion,
  platform,
  fetcher = fetch,
  releasesURL = RELEASES_URL,
  signal,
} = {}) {
  if (!semver(currentVersion)) fail("更新清单格式无效，请稍后重试。");
  const manifest = await fetchReleases(fetcher, releasesURL, signal);
  const cmp = compareSemver(manifest.latest, currentVersion);
  const selected = assetForPlatform(manifest, platform);
  if (cmp <= 0) {
    return {
      status: "current",
      currentVersion,
      latest: manifest.latest,
      notes_url: manifest.notes_url,
      asset: selected,
      openURL: RELEASES_PAGE,
    };
  }
  if (!selected) fail("当前平台没有可用的更新包。");
  return {
    status: "available",
    currentVersion,
    latest: manifest.latest,
    notes_url: manifest.notes_url,
    asset: selected,
    openURL: selected.url,
  };
}
