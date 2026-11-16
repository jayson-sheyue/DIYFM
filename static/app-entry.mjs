import { createNativeClient } from "./native.mjs?v=2.4.9";
import { i18n } from "./i18n.mjs?v=2.4.9";
import { createBrowserAPI } from "./browser-api.mjs?v=2.4.9";
import { createSharingUI } from "./sharing-ui.mjs?v=2.4.9";
import {
  APP_VERSION,
  checkClientUpdate,
  RELEASES_URL,
  RELEASES_PAGE,
  isAllowedUpdateURL,
} from "./updates.mjs?v=2.4.9";
window.DIYFM_NATIVE = await createNativeClient();
window.DIYFM_I18N = i18n;
window.DIYFM_UPDATES = {
  APP_VERSION,
  checkClientUpdate,
  RELEASES_URL,
  RELEASES_PAGE,
  isAllowedUpdateURL,
};
i18n.apply(document);
const legacy =
  ["localhost", "127.0.0.1"].includes(location.hostname) &&
  location.pathname.startsWith("/static/");
const localCatalogURL = new URL("./catalog/index.json", location.href).href;
window.DIYFM = createBrowserAPI({
  legacy,
  bundledCatalogURL: localCatalogURL,
  seedStarterChannels: true,
  ...(window.DIYFM_NATIVE ? {} : { catalogURL: localCatalogURL }),
});
window.DIYFM_SHARE_UI = createSharingUI;
window.addEventListener("pagehide", () => window.DIYFM.dispose());
await import("./app.js?v=2.4.9");
