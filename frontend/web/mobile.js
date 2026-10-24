// Entry point of the Android app (see mobile/). The desktop app talks to a local FastAPI server;
// here the same API is answered in the page by the JavaScript port of the backend, then the
// usual app.js starts.

import { createApi } from "./core/api.js";
import { RELEASES_REPO, VERSION } from "./core/version.js";

const plugins = (window.Capacitor && window.Capacitor.Plugins) || {};
const { CapacitorCookies, InAppBrowser } = plugins;

window.radarLocalApi = createApi({
  // With CapacitorHttp enabled, fetch goes through Android's network stack (no CORS limits).
  fetch: (url, init) => window.fetch(url, init),
  storage: window.localStorage,
  version: VERSION,
  releasesRepo: RELEASES_REPO,
  posterTemplate: async () => (await fetch("shared/poster.html")).text(),
  dataDir: "app storage",
  clearCookies: async () => { if (CapacitorCookies) await CapacitorCookies.clearAllCookies(); },
});

// Sign in to the library in Chrome (a Custom Tab, from @capacitor/inappbrowser). An in-app web
// view left Yonsei's proxy on a blank page, and Chrome is where people sign in anyway. Chrome
// keeps its cookies to itself, so the app can't fetch the PDF: the person downloads it there and
// opens it with Research Radar (AndroidManifest's PDF intent filter), and it opens on the paper
// they were signing in for (remembered for two hours).
const PENDING = "radar.library.pending";
const CHROME = {
  android: { showTitle: true, hideToolbarOnScroll: false, viewStyle: 1, startAnimation: 0, exitAnimation: 1 }, // full screen
  iOS: { closeButtonText: 2, viewStyle: 2, animationEffect: 2, enableBarsCollapsing: true, enableReadersMode: false },
};
if (InAppBrowser) {
  // the library's own sign-in page first, for proxies that need it (reader.js loginButtons)
  window.radarOpenInBrowser = (url) => InAppBrowser.openInSystemBrowser({ url, options: CHROME });
  window.radarLibraryLogin = async (doi, url, paper) => {
    if (!url) return false;
    try { localStorage.setItem(PENDING, JSON.stringify({ paper, at: Date.now() })); } catch { /* still works, without the paper */ }
    await InAppBrowser.openInSystemBrowser({ url, options: CHROME });
    return "browser";
  };
}

/** A PDF handed to the app ("Open with Research Radar"): opened on the paper being signed in for. */
async function openHandedPdf(uri) {
  if (!/^(content|file):/i.test(uri || "")) return;
  let pending = null;
  try { pending = JSON.parse(localStorage.getItem(PENDING) || "null"); } catch { /* none */ }
  const paper = pending && Date.now() - pending.at < 2 * 3600 * 1000 ? pending.paper : null;
  try { localStorage.removeItem(PENDING); } catch { /* fine */ }
  // the app's local server reads content:// addresses for the page (Capacitor's convertFileSrc)
  const blob = await (await fetch(window.Capacitor.convertFileSrc(uri))).blob();
  const name = (paper && paper.title ? paper.title.slice(0, 80) : "paper") + ".pdf";
  while (!window.radarOpenFile) await new Promise((resolve) => setTimeout(resolve, 100)); // app.js still loading
  window.radarOpenFile(new File([blob], name, { type: "application/pdf" }), paper);
}
const { App } = plugins;
if (App) {
  App.addListener("appUrlOpen", (event) => openHandedPdf(event && event.url).catch(() => {}));
  App.getLaunchUrl().then((launch) => launch && openHandedPdf(launch.url)).catch(() => {});
}

// Save a file: write it to the app's cache and open Android's share sheet (Drive, e-mail, Files...).
const { Filesystem, Share } = plugins;
if (Filesystem && Share) {
  window.radarSaveFile = async (name, content) => {
    // text as UTF-8; bytes (a saved PDF) as base64, which is what writeFile takes without an encoding
    const file = content instanceof Uint8Array ? { data: window.radarBase64(content) } : { data: content, encoding: "utf8" };
    const written = await Filesystem.writeFile({ path: name, directory: "CACHE", ...file });
    try {
      await Share.share({ title: name, files: [written.uri] });
    } catch {
      return t("file.cancelled"); // closed the share sheet
    }
    return t("file.shared", { name });
  };
}

document.documentElement.classList.add("mobile-app");
const app = document.createElement("script");
app.src = "app.js";
document.body.append(app);
