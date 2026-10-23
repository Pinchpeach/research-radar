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

// Sign in to the library (core/library.js): an in-app web view on the paper through the proxy.
// It runs in the app's own process with its cookie store kept, so the session cookies it gets
// are the ones CapacitorHttp sends. After each page, the PDF is tried; once it comes through,
// the web view closes and the reader asks again (core/library.js keeps nothing in between).
if (InAppBrowser) {
  window.radarLibraryLogin = async (doi, url) => {
    if (!url) return false;
    let busy = false, finish;
    const done = new Promise((resolve) => (finish = resolve));
    const tryPdf = async () => {
      if (busy) return;
      busy = true;
      try {
        await window.radarLocalApi("GET", `/library/pdf?doi=${encodeURIComponent(doi)}`);
        finish(true);
        await InAppBrowser.close().catch(() => {});
      } catch { /* not signed in yet: the person carries on in the web view */ } finally { busy = false; }
    };
    const handles = await Promise.all([
      InAppBrowser.addListener("browserPageLoaded", tryPdf),
      InAppBrowser.addListener("browserPageNavigationCompleted", tryPdf),
      InAppBrowser.addListener("browserClosed", () => finish(false)),
    ]);
    try {
      await InAppBrowser.openInWebView({ url, options: {
        showToolbar: true, showURL: true, clearCache: false, clearSessionCache: false, // keep the sign-in
        mediaPlaybackRequiresUserAction: true, closeButtonText: t("rd.close"), toolbarPosition: 0,
        showNavigationButtons: true, leftToRight: false, customWebViewUserAgent: null,
        android: { allowZoom: true, hardwareBack: true, pauseMedia: true, isIsolated: false }, // the app's cookie store
        iOS: { allowOverScroll: true, enableViewportScale: false, allowInLineMediaPlayback: false, surpressIncrementalRendering: false,
          viewStyle: 2, animationEffect: 2, allowsBackForwardNavigationGestures: true },
      } });
      return await done;
    } finally {
      for (const handle of handles) handle.remove();
    }
  };
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
