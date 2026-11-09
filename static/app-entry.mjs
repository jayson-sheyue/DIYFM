import { createNativeClient } from "./native.mjs?v=2.2.1";
import { i18n } from "./i18n.mjs";
import { createBrowserAPI } from "./browser-api.mjs?v=2.1.2";
window.DIYFM_NATIVE = await createNativeClient();
window.DIYFM_I18N = i18n;
i18n.apply(document);
const legacy =
  ["localhost", "127.0.0.1"].includes(location.hostname) &&
  location.pathname.startsWith("/static/");
window.DIYFM = createBrowserAPI({ legacy });
window.addEventListener("pagehide", () => window.DIYFM.dispose());
await import("./app.js?v=2.2.1");
