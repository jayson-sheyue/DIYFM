import { createBrowserAPI } from "./browser-api.mjs";
const legacy =
  ["localhost", "127.0.0.1"].includes(location.hostname) &&
  location.pathname.startsWith("/static/");
window.DIYFM = createBrowserAPI({ legacy });
window.addEventListener("pagehide", () => window.DIYFM.dispose());
await import("./app.js");
