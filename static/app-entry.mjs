import { createNativeClient } from "./native.mjs?v=2.3.0";
import { i18n } from "./i18n.mjs?v=2.3.0";
import { createBrowserAPI } from "./browser-api.mjs?v=2.3.0";
import { createSharingUI } from "./sharing-ui.mjs?v=2.3.0";
window.DIYFM_NATIVE = await createNativeClient();
window.DIYFM_I18N = i18n;
i18n.apply(document);
const legacy =
  ["localhost", "127.0.0.1"].includes(location.hostname) &&
  location.pathname.startsWith("/static/");
window.DIYFM = createBrowserAPI({ legacy, ...(window.DIYFM_NATIVE ? {} : { catalogURL: new URL("./catalog/index.json", location.href).href }) });
window.DIYFM_SHARE_UI = createSharingUI;
window.addEventListener("pagehide", () => window.DIYFM.dispose());
await import("./app.js?v=2.3.0");
