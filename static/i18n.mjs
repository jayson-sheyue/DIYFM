import { MESSAGES } from "./messages.mjs?v=2.4.1";
export const LOCALES = Object.freeze(["en", "ja", "zh-CN"]);
export const LOCALE_STORAGE = "diyfm:ui-language";
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const escapeHTML = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const keyOf = (parts) =>
  parts.map((p, i) => p + (i < parts.length - 1 ? `{${i}}` : "")).join("");
// Only these UI parameters are themselves localized labels. User titles and wishes stay verbatim.
const labelParameters = new Set([
  "{0} · {1} · 虚构来信电台。制作时会根据你的愿望编排故事。",
  "{0}。可以在应用内换页，进度与结果都在「消息」中。请保持此网页打开。",
  "{0} · {1}试听",
  "{0} · 声线试听",
]);
const numericParameters = new Set([
  "{0}分{1}秒",
  "{0} 集可听",
  "请求失败（{0}）",
  "已导入 {0} 个频道、{1} 条记录。已有频道和模型设置保留。",
]);
export function createI18n({ storage, messages = MESSAGES } = {}) {
  let language = "en";
  try {
    const saved = JSON.parse(storage?.getItem(LOCALE_STORAGE) || "null");
    if (LOCALES.includes(saved)) language = saved;
  } catch {
    /* Storage is optional. English is always the first-run default. */
  }
  const aliases = new Map(),
    patterns = [];
  for (const [key, entry] of Object.entries(messages)) {
    aliases.set(key, key);
    for (const value of Object.values(entry)) {
      if (!value) continue;
      aliases.set(value, key);
      if (/\{\d+\}/.test(value)) {
        const indices = [...value.matchAll(/\{(\d+)\}/g)].map((m) =>
          Number(m[1]),
        );
        patterns.push({
          key,
          indices,
          regex: new RegExp(
            "^" +
              value
                .split(/\{\d+\}/)
                .map(escapeRegex)
                .join(numericParameters.has(key) ? "(\\d+)" : "([\\s\\S]*?)") +
              "$",
          ),
        });
      }
    }
  }
  const literalKeys = Object.keys(messages)
    .filter((k) => !/\{\d+\}/.test(k))
    .sort((a, b) => b.length - a.length);
  const htmlPattern = new RegExp(literalKeys.map(escapeRegex).join("|"), "g");
  function t(source, values) {
    if (source == null) return "";
    const text = String(source);
    let key = aliases.get(text),
      args = values;
    if (!key && values === undefined) {
      // Canonical errors are kept separate from UI language and translated only when presented.
      const http = text.match(/^Google 请求失败（HTTP (\d+)）。([\s\S]*)$/);
      if (http)
        return t("Google 请求失败（HTTP {0}）。{1}", [http[1], t(http[2])]);
      for (const pattern of patterns) {
        const match = text.match(pattern.regex);
        if (match) {
          key = pattern.key;
          args = [];
          pattern.indices.forEach((n, i) => {
            args[n] = match[i + 1];
          });
          if (labelParameters.has(key)) args = args.map((v) => t(v));
          break;
        }
      }
    }
    if (!key) return text; // Unknown saved/provider text is content, not a translation key.
    const entry = messages[key],
      translated = entry[language] || entry.en;
    return translated.replace(/\{(\d+)\}/g, (full, i) =>
      args?.[i] == null ? full : String(args[i]),
    );
  }
  function html(parts, ...values) {
    // Translate literal markup only. Interpolations have already been escaped by their caller.
    return parts
      .map(
        (part, i) =>
          part
            .replace(/\s+/g, " ")
            .replace(htmlPattern, (key) => escapeHTML(t(key))) +
          (values[i] ?? ""),
      )
      .join("");
  }
  return Object.freeze({
    t,
    html,
    msg: (parts, ...values) => t(keyOf(parts), values),
    locale: () => language,
    setLocale(value) {
      if (!LOCALES.includes(value)) return false;
      language = value;
      try {
        storage?.setItem(LOCALE_STORAGE, JSON.stringify(language));
      } catch {
        /* Switching still works for this page. */
      }
      return true;
    },
    apply(document) {
      document.documentElement.lang = language;
      document.querySelectorAll("[data-i18n]").forEach((el) => {
        el.textContent = t(el.getAttribute("data-i18n"));
      });
      for (const attr of ["placeholder", "aria-label", "title"]) {
        document.querySelectorAll(`[data-i18n-${attr}]`).forEach((el) => {
          el.setAttribute(attr, t(el.getAttribute(`data-i18n-${attr}`)));
        });
      }
      const select = document.getElementById("ui-language");
      if (select) select.value = language;
    },
  });
}
let storage;
try {
  if (typeof window !== "undefined") storage = globalThis.localStorage;
} catch {
  /* Private/restricted browsers can deny storage access. */
}
export const i18n = createI18n({ storage });
