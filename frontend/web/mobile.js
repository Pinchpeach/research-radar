// Entry point of the Android app (see mobile/). The desktop app talks to a local FastAPI server;
// here the same API is answered in the page by the JavaScript port of the backend, then the
// usual app.js starts.

import { createApi } from "./core/api.js";
import { inScope, loginPage, loginUrl, normalizeProxy, onPublisher, SIGN_IN_TARGET, through } from "./core/library.js";
import { RELEASES_REPO, VERSION } from "./core/version.js";

const plugins = (window.Capacitor && window.Capacitor.Plugins) || {};
const { CapacitorCookies, Filesystem, LibraryWeb } = plugins;

/** Bytes of a file in the app's storage, through the app's local server (Capacitor's convertFileSrc). */
async function localBytes(uri) {
  const response = await fetch(window.Capacitor.convertFileSrc(uri));
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

// PDFs the person picked for a document, kept in the app's storage (pdfs/<id>.pdf)
const keptPath = (id) => ({ path: `pdfs/${id}.pdf`, directory: "DATA" });
const pdfFiles = Filesystem && {
  read: async (id) => {
    try {
      await Filesystem.stat(keptPath(id));
      return await localBytes((await Filesystem.getUri(keptPath(id))).uri);
    } catch { return null; } // none kept
  },
  write: (id, bytes) => Filesystem.writeFile({ ...keptPath(id), data: window.radarBase64(bytes), recursive: true }),
  remove: async (id) => { try { await Filesystem.deleteFile(keptPath(id)); return true; } catch { return false; } },
};

window.radarLocalApi = createApi({
  // With CapacitorHttp enabled, fetch goes through Android's network stack (no CORS limits).
  fetch: (url, init) => window.fetch(url, init),
  storage: window.localStorage,
  version: VERSION,
  releasesRepo: RELEASES_REPO,
  posterTemplate: async () => (await fetch("shared/poster.html")).text(),
  dataDir: "app storage",
  clearCookies: async () => { if (CapacitorCookies) await CapacitorCookies.clearAllCookies(); },
  pdfFiles,
});

// The library inside the app: LibraryWeb (mobile/android/.../LibraryWebPlugin.java), a plain web
// view in a screen of its own that shares the app's cookie store. Some proxies (Yonsei's link.n2s)
// show a blank page until the person has signed in on the library's site, so that page comes
// first; once they've left it the view goes on through the proxy. Signing in (Settings) ends on a
// publisher's page. Getting a paper goes on to the PDF there: the view is a browser, which
// publishers let through where the app's own requests may be turned away (bot checks), so the
// page's PDF link is followed in the view and the download it starts is the paper.
const LIBRARY_SESSION = "radar.library.session";
const sessionOf = () => { try { return localStorage.getItem(LIBRARY_SESSION); } catch { return null; } };

async function libraryPrefix() {
  try { return normalizeProxy((await window.radarLocalApi("GET", "/settings")).library_proxy.value); } catch { return ""; }
}

/** Sign in (paper null: resolves to whether it worked) or get a paper's PDF at link (resolves to its bytes, or null). */
async function libraryView(link = null) {
  const prefix = await libraryPrefix();
  if (!prefix) return link ? null : false;
  const first = loginPage(prefix), onward = link || through(prefix, SIGN_IN_TARGET);
  // signed in before: straight to the paper (back to the sign-in page if the proxy stays blank)
  let stage = first && !(link && sessionOf() === prefix) ? "library" : "proxy";
  let result = null, steps = 0, finish, blank = null;
  const done = new Promise((resolve) => (finish = resolve));
  const handles = await Promise.all([
    LibraryWeb.addListener("navigated", async (data) => {
      const here = data && data.url;
      if (!here) return;
      clearTimeout(blank);
      if (stage === "library") {
        const now = new URL(here), page = new URL(first);
        if (now.hostname === page.hostname && !now.pathname.startsWith(page.pathname)) { // signed in: on the library's site
          stage = "proxy";
          LibraryWeb.navigate({ url: onward });
        }
      } else if (stage === "proxy" && !link && onPublisher(here, prefix)) {
        stage = "done";
        result = true;
        LibraryWeb.close();
      } else if (stage === "proxy" && link) {
        if (first && !onPublisher(here, prefix) && inScope(here, prefix)) {
          // still on the proxy's own link page: a sign-in that ran out leaves it blank
          blank = setTimeout(() => { stage = "library"; LibraryWeb.navigate({ url: first }); }, 8000);
          return;
        }
        if (!inScope(here, prefix) || steps >= 3) return; // the school's sign-in, or left to the person
        const found = await LibraryWeb.findPdf().catch(() => null);
        if (found && found.link && stage === "proxy") {
          steps += 1;
          LibraryWeb.navigate({ url: through(prefix, found.link) });
        }
      }
    }),
    LibraryWeb.addListener("downloaded", async (data) => {
      if (!link || !data || !data.path) return;
      try {
        const bytes = await localBytes("file://" + data.path);
        if (!new TextDecoder().decode(bytes.slice(0, 1024)).trimStart().startsWith("%PDF")) return;
        stage = "done";
        result = bytes;
        LibraryWeb.close();
      } catch { /* left open: the person can try again or close it */ }
    }),
    LibraryWeb.addListener("closed", () => { clearTimeout(blank); finish(result); }),
  ]);
  try {
    await LibraryWeb.open({ url: stage === "library" ? first : onward, closeText: t("rd.close") });
    const got = await done;
    if (got) try { localStorage.setItem(LIBRARY_SESSION, prefix); } catch { /* fine */ }
    return link ? got || null : got === true;
  } finally {
    for (const handle of handles) handle.remove();
  }
}

/**
 * A paper's PDF through the library: the app's own request first (quick, unseen), then, when
 * that doesn't bring it, the library's web view. Not signed in yet: the reader offers it (401).
 */
async function libraryPdf(doi) {
  const signedIn = sessionOf();
  try {
    return await window.radarLocalApi("GET", `/library/pdf?doi=${encodeURIComponent(doi)}`);
  } catch (error) {
    if (error.status === 422 || (error.status === 401 && !signedIn)) throw error;
    const detail = error.detail && typeof error.detail === "object" ? error.detail : {};
    let link = detail.page_url || detail.login_url;
    if (!link) try { link = await loginUrl(window.fetch, await libraryPrefix(), doi); } catch { throw error; }
    const bytes = await libraryView(link);
    if (bytes) return bytes;
    throw error;
  }
}

if (LibraryWeb) {
  window.radarLibrarySignIn = () => libraryView(); // Settings › Library
  window.radarLibraryPdf = libraryPdf; // the reader
  // the reader's sign-in button: signs in and gets the paper in one go, resolving to its bytes
  window.radarLibraryLogin = async (doi, url) => libraryView(url || await loginUrl(window.fetch, await libraryPrefix(), doi));
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
const { Share } = plugins;
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
