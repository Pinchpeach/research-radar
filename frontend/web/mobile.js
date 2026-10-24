// Entry point of the Android app (see mobile/). The desktop app talks to a local FastAPI server;
// here the same API is answered in the page by the JavaScript port of the backend, then the
// usual app.js starts.

import { createApi } from "./core/api.js";
import { loginPage, normalizeProxy, onPublisher, SIGN_IN_TARGET, through } from "./core/library.js";
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

// Sign in to the library inside the app (@capacitor/inappbrowser's web view, in the app's own
// process with its cookies kept), so the downloads the app makes with CapacitorHttp carry the
// same sign-in and papers open by themselves. Some proxies (Yonsei's link.n2s) show a blank page
// until the person has signed in on the library's site, so that page comes first; once they've
// left it, a publisher's page through the proxy follows, and reaching it means done. Nothing
// else talks to the proxy meanwhile: its sign-in lives in the same cookie store.
const LIBRARY_SESSION = "radar.library.session";
const WEBVIEW = {
  showToolbar: true, showURL: true, clearCache: false, clearSessionCache: false, // keep the sign-in
  mediaPlaybackRequiresUserAction: true, closeButtonText: "✕", toolbarPosition: 0,
  showNavigationButtons: true, leftToRight: false, customWebViewUserAgent: null,
  android: { allowZoom: true, hardwareBack: true, pauseMedia: true, isIsolated: false }, // the app's cookie store
  iOS: { allowOverScroll: true, enableViewportScale: false, allowInLineMediaPlayback: false, surpressIncrementalRendering: false,
    viewStyle: 2, animationEffect: 2, allowsBackForwardNavigationGestures: true },
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Sign in to the library; true once the web view reached a publisher's page through the proxy. */
async function signInInApp() {
  let prefix = "";
  try { prefix = normalizeProxy((await window.radarLocalApi("GET", "/settings")).library_proxy.value); } catch { /* none */ }
  if (!prefix) return false;
  const first = loginPage(prefix), onward = through(prefix, SIGN_IN_TARGET);
  let stage = first ? "library" : "proxy", finish;
  const done = new Promise((resolve) => (finish = resolve));
  const open = (url) => InAppBrowser.openInWebView({ url, options: { ...WEBVIEW, closeButtonText: t("rd.close") } });
  const handles = await Promise.all([
    InAppBrowser.addListener("browserPageNavigationCompleted", (data) => {
      const here = data && data.url;
      if (!here) return;
      if (stage === "library") {
        const now = new URL(here), page = new URL(first);
        if (now.hostname === page.hostname && !now.pathname.startsWith(page.pathname)) { // signed in: on the library's site
          stage = "to-proxy";
          InAppBrowser.close().catch(() => {});
        }
      } else if (stage === "proxy" && onPublisher(here, prefix)) {
        stage = "done";
        InAppBrowser.close().catch(() => {});
      }
    }),
    InAppBrowser.addListener("browserClosed", async () => {
      if (stage === "to-proxy") { // the web view can't be pointed elsewhere: open it again on the proxy
        stage = "proxy";
        await pause(300);
        return open(onward).catch(() => finish(false));
      }
      finish(stage === "done");
    }),
  ]);
  try {
    await open(first || onward);
    const ok = await done;
    if (ok) try { localStorage.setItem(LIBRARY_SESSION, prefix); } catch { /* fine */ }
    return ok;
  } finally {
    for (const handle of handles) handle.remove();
  }
}

if (InAppBrowser) {
  window.radarLibrarySignIn = signInInApp; // Settings › Library
  window.radarLibraryLogin = () => signInInApp(); // the reader, when a paper needs it: then it fetches again
}

/** A PDF handed to the app ("Open with Research Radar", e.g. one downloaded in a browser). */
async function openHandedPdf(uri) {
  if (!/^(content|file):/i.test(uri || "")) return;
  // the app's local server reads content:// addresses for the page (Capacitor's convertFileSrc)
  const blob = await (await fetch(window.Capacitor.convertFileSrc(uri))).blob();
  while (!window.radarOpenFile) await new Promise((resolve) => setTimeout(resolve, 100)); // app.js still loading
  window.radarOpenFile(new File([blob], "paper.pdf", { type: "application/pdf" }), null);
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
