// Entry point of the Android app (see mobile/). The desktop app talks to a local FastAPI server;
// here the same API is answered in the page by the JavaScript port of the backend, then the
// usual app.js starts.

import { createApi } from "./core/api.js";
import { inScope, normalizeProxy } from "./core/library.js";
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
// are the ones CapacitorHttp sends. Once the web view is on the paper's page through the proxy,
// the PDF is tried; when it comes through, the web view closes and the reader asks again.
//
// The two share one cookie store, so nothing else may talk to the proxy while the person signs
// in: the proxy keeps its sign-in progress in a session cookie, and a request of ours in between
// would start that over (Yonsei's link.n2s then shows a blank page). So the proxy's old cookies
// (from the reader's first try) are cleared first, and the PDF is only asked for from the
// paper's page.
if (InAppBrowser) {
  window.radarLibraryLogin = async (doi, url) => {
    if (!url) return false;
    let prefix = "";
    try { prefix = normalizeProxy((await window.radarLocalApi("GET", "/settings")).library_proxy.value); } catch { /* none */ }
    const proxyHost = (() => { try { return new URL(prefix).hostname; } catch { return ""; } })();
    /** The paper's page through the proxy: past the link and the sign-in pages. */
    const onPaper = (page) => {
      if (!page || page === url || !inScope(page, prefix)) return false;
      const host = new URL(page).hostname;
      return host !== proxyHost || page.startsWith(prefix); // www-nature-com-ssl.access.yonsei.ac.kr, or .../_Lib_Proxy_Url/https://...
    };
    let busy = false, finish;
    const done = new Promise((resolve) => (finish = resolve));
    const tryPdf = async () => {
      if (busy || !onPaper(window.radarLibraryLastUrl)) return;
      busy = true;
      try {
        await window.radarLocalApi("GET", `/library/pdf?doi=${encodeURIComponent(doi)}`);
        finish(true);
        await InAppBrowser.close().catch(() => {});
      } catch { /* not signed in yet: the person carries on in the web view */ } finally { busy = false; }
    };
    window.radarLibraryLastUrl = url; // where the web view got to, shown if signing in doesn't finish
    const handles = await Promise.all([
      InAppBrowser.addListener("browserPageLoaded", tryPdf),
      InAppBrowser.addListener("browserPageNavigationCompleted", (data) => {
        if (data && data.url) window.radarLibraryLastUrl = data.url;
        tryPdf();
      }),
      InAppBrowser.addListener("browserClosed", async () => { // closed by hand, maybe on the paper's page: one last try
        let ok = false;
        try { await window.radarLocalApi("GET", `/library/pdf?doi=${encodeURIComponent(doi)}`); ok = true; } catch { /* no */ }
        finish(ok);
      }),
    ]);
    try {
      if (CapacitorCookies) await CapacitorCookies.clearAllCookies().catch(() => {});
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
