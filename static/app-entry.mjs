import { createNativeClient } from "./native.mjs?v=2.5.1";
import { i18n } from "./i18n.mjs?v=2.5.1";
import { createBrowserAPI } from "./browser-api.mjs?v=2.5.1";
import { createSharingUI } from "./sharing-ui.mjs?v=2.5.1";
import * as transcript from "./transcript.mjs?v=2.5.1";
import {
  APP_VERSION,
  checkClientUpdate,
  RELEASES_URL,
  RELEASES_PAGE,
  isAllowedUpdateURL,
} from "./updates.mjs?v=2.5.1";
window.DIYFM_NATIVE = await createNativeClient();
window.DIYFM_I18N = i18n;
window.DIYFM_TRANSCRIPT = transcript;
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
  // Homepage previews load one bundled sample on demand, without blocking
  // startup on the entire Discover catalog or adding channels to the library.
  seedStarterChannels: false,
  ...(window.DIYFM_NATIVE ? {} : { catalogURL: localCatalogURL }),
});
window.DIYFM_SHARE_UI = createSharingUI;
window.addEventListener("pagehide", () => window.DIYFM.dispose());
await import("./app.js?v=2.5.1");
