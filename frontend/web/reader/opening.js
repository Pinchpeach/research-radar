// Opening a document: its PDF from wherever it can be had (kept with its note, a free copy, the
// person's library, a file), the note itself, and what to show when there is no PDF.

import { el } from "./dom.js";
import { newId } from "./ink.js";
import { openReader } from "./reader.js";

const PDFJS = new URL("../vendor/pdfjs/", import.meta.url);

/** pdf.js, loaded the first time a PDF opens. */
export let pdfjsLib = null;
async function loadPdfjs() {
  if (!pdfjsLib) {
    pdfjsLib = await import(new URL("pdf.min.js", PDFJS).href);
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("pdf.worker.min.js", PDFJS).href;
  }
  return pdfjsLib;
}

const isPdf = (bytes) => new TextDecoder().decode(bytes.slice(0, 1024)).trimStart().startsWith("%PDF");

/** What the app's server said went wrong (`detail` of its JSON answer), or null. */
async function errorDetail(response) {
  try {
    return (await response.json()).detail || null;
  } catch {
    return null; // not JSON
  }
}

/** A document id for a PDF opened from a file: the start of its SHA-256. */
async function fileId(bytes) {
  try {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return "file-" + [...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    let h = 2166136261; // no WebCrypto (not a secure context): FNV-1a of a sample is enough to recognise the file again
    for (let i = 0; i < bytes.length; i += Math.max(1, Math.floor(bytes.length / 65536)))
      h = Math.imul(h ^ bytes[i], 16777619);
    return `file-${(h >>> 0).toString(16)}-${bytes.length}`;
  }
}

/**
 * How this app signs in to the library: desktop/main.py's window, or mobile.js's in-app web view.
 * Resolves to true once the PDF came through (desktop), or to the PDF's bytes (Android).
 */
function signIn() {
  if (window.radarLibraryLogin) return window.radarLibraryLogin;
  const desktop = window.pywebview && window.pywebview.api;
  return desktop && desktop.library_login ? (doi) => desktop.library_login(doi) : null;
}

/** "10.1/x" from a DOI link (https://doi.org/10.1/x), or null. */
function bareDoi(doi) {
  const match = /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:)?(10\.\d{4,9}\/\S+)$/i.exec(String(doi || "").trim());
  return match ? decodeURIComponent(match[1]) : null;
}

function shortId(id) {
  return String(id).replace(/\/+$/, "").split("/").pop();
}

export const opening = {
  async start() {
    this.build();
    document.body.classList.add("reader-open");
    const paperId = this.paper ? shortId(this.paper.id) : null;
    // a PDF is expected (to look for, or a file's document opened again), not only note pages
    const wantsPdf = Boolean(
      this.paper || this.url || this.file || (this.givenId && !this.givenId.startsWith("notes-")),
    );
    let error = null;
    try {
      this.bytes = await this.source(paperId || this.givenId);
    } catch (e) {
      error = e;
    }
    this.docId = paperId || this.givenId || (this.bytes ? await fileId(this.bytes) : `notes-${newId()}`);
    this.doc = await this.loadDoc();
    if (this.bytes) {
      try {
        await this.loadPdf();
      } catch (e) {
        error = e;
        this.bytes = null;
      }
    }
    if (this.bytes && this.kept) this.toast(t("rd.openedKept"));
    else if (this.bytes) this.keep();
    else if (wantsPdf || error) this.showUnavailable(error);
    else this.pagesEl.hidden = true; // just note pages
    if (this.doc.notes.length || this.pagesEl.hidden) this.toggleNotes(true);
    this.renderNotes();
    if (this.onOpened && this.paper) this.onOpened(this.paper);
  },

  /**
   * The PDF to show, or null: the one handed over; else the one kept with this document when it
   * was opened before, as it is, with no new download or sign-in; else one found for the paper.
   */
  async source(id) {
    if (this.pdfBytes) return this.pdfBytes;
    if (this.file) return new Uint8Array(await this.file.arrayBuffer());
    const kept = id ? await this.keptPdf(id) : null;
    if (kept) {
      this.kept = true;
      return kept;
    }
    return this.paper || this.url ? this.findPdf() : null;
  },

  showFinding(message) {
    this.pagesEl.replaceChildren(
      el("div", { class: "rd-unavailable" }, el("p", { class: "rd-finding", text: message })),
    );
  },

  /**
   * A paper's PDF, from the first place that has it: the free copy OpenAlex links to, every other
   * free copy the app can find (Unpaywall, OpenAlex, Europe PMC, arXiv), then the person's
   * university library (backend/library.py). Null if none.
   */
  async findPdf() {
    const doi = bareDoi(this.paper && this.paper.doi);
    let lastError = null;
    const attempt = async (message, get) => {
      this.showFinding(message);
      try {
        return await get();
      } catch (e) {
        lastError = e;
        return null;
      }
    };
    if (!this.libraryOnly) {
      if (this.url) {
        const bytes = await attempt(t("rd.findingFree"), () => this.fetchPdf(this.url));
        if (bytes) return bytes;
      }
      let links = [];
      // Unpaywall, OpenAlex's other locations, Europe PMC, arXiv (backend/services/freecopies.py)
      if (doi)
        try {
          links = (await this.api("GET", `/free-pdfs?doi=${encodeURIComponent(doi)}`)).pdf_urls || [];
        } catch {
          /* offline */
        }
      for (const link of links.filter((l) => l !== this.url)) {
        const bytes = await attempt(t("rd.findingFree"), () => this.fetchPdf(link));
        if (bytes) {
          this.url = link;
          return bytes;
        }
      }
    }
    if (doi) {
      const bytes = await attempt(t("rd.findingLibrary"), () => this.libraryPdf(doi));
      if (bytes) return bytes;
    }
    if (lastError) throw lastError;
    return null;
  },

  /** The PDF kept for this document when it was opened before (backend/annotations.py), or null. */
  async keptPdf(id) {
    const path = `/annotations/${encodeURIComponent(id)}/pdf`;
    try {
      if (window.radarLocalApi) return await window.radarLocalApi("GET", path);
      const response = await fetch(path);
      return response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
    } catch {
      return null;
    }
  },

  /** Keep the PDF with its document (picked, or fetched for a paper), so it opens again as it is. */
  async keep() {
    const path = `/annotations/${encodeURIComponent(this.docId)}/pdf`;
    try {
      if (window.radarLocalApi) await window.radarLocalApi("PUT", path, this.bytes);
      else {
        const response = await fetch(path, {
          method: "PUT",
          headers: { "Content-Type": "application/pdf" },
          body: this.bytes,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      }
      await this.flush(); // listed under Reading, where it opens again (and can be removed)
      this.toast(t("rd.keptNote"));
    } catch {
      /* still open now; found again next time */
    }
  },

  /** The PDF through the library: the desktop server (backend/library.py) or, on Android, mobile.js. */
  async libraryPdf(doi) {
    const path = `/library/pdf?doi=${encodeURIComponent(doi)}`;
    let status,
      detail = null;
    if (window.radarLocalApi) {
      try {
        return await (window.radarLibraryPdf ? window.radarLibraryPdf(doi) : window.radarLocalApi("GET", path));
      } catch (e) {
        status = e.status || 502;
        detail = e.detail || e.message;
      }
    } else {
      const get = async () => {
        const response = await fetch(path);
        if (response.ok) {
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (isPdf(bytes)) return bytes;
          throw new Error(t("rd.notPdf"));
        }
        status = response.status;
        detail = await errorDetail(response);
        return null;
      };
      let bytes = await get();
      // signed in, but the app's own request didn't bring it (a publisher's bot check): the
      // library's window gets it in the page (desktop/main.py library_login), then it's asked again
      const desktop = window.pywebview && window.pywebview.api;
      if (!bytes && (status === 404 || status === 502) && desktop && desktop.library_login) {
        this.showFinding(t("rd.findingLibrary"));
        try {
          if (await desktop.library_login(doi)) bytes = await get();
        } catch {
          /* the window failed to open */
        }
      }
      if (bytes) return bytes;
    }
    if (status === 422) return null; // no library set up: nothing to say
    if (status === 401)
      this.libraryLogin = { doi, url: detail && detail.login_url, first: detail && detail.library_login };
    // the library's window can still try, where the app's own request failed (Android: mobile.js)
    else if (signIn()) this.libraryLogin = { doi, url: detail && (detail.page_url || detail.login_url) };
    if (status === 404 && detail && detail.page_url) this.libraryPage = detail.page_url;
    const key = { 401: "rd.library401", 404: "rd.library404" }[status] || "rd.libraryFailed";
    throw new Error(t(key, { error: (detail && (detail.message || detail)) || `HTTP ${status}` }));
  },

  async fetchPdf(url) {
    // Android: CapacitorHttp lets the page fetch any site; the desktop page goes through its server
    const target = window.radarLocalApi ? url : `/pdf?url=${encodeURIComponent(url)}`;
    const response = await fetch(target);
    if (!response.ok) throw new Error((await errorDetail(response)) || `HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!isPdf(bytes)) throw new Error(t("rd.notPdf"));
    return bytes;
  },

  async loadDoc() {
    let doc = null;
    try {
      doc = await this.api("GET", `/annotations/${encodeURIComponent(this.docId)}`);
    } catch {
      /* first time */
    }
    this.saved = Boolean(doc); // already in the reading list
    return {
      title: (this.paper && this.paper.title) || (this.file && this.file.name) || t("rd.untitled"),
      paper_id: this.paper ? shortId(this.paper.id) : null,
      source: this.url || (doc && doc.source) || null,
      page_count: 0,
      last_page: 1,
      pages: {},
      notes: [],
      ...(doc || {}),
    };
  },

  async loadPdf() {
    const lib = await loadPdfjs();
    this.loading = lib.getDocument({
      data: this.bytes.slice(), // pdf.js takes ownership of what it gets; keep our copy for saving
      cMapUrl: new URL("cmaps/", PDFJS).href,
      cMapPacked: true,
      standardFontDataUrl: new URL("standard_fonts/", PDFJS).href,
      wasmUrl: new URL("wasm/", PDFJS).href,
      isEvalSupported: false, // the PDF is third-party: no generated code
    });
    this.pdf = await this.loading.promise;
    this.doc.page_count = this.pdf.numPages;
    this.root.classList.add("has-pdf");
    for (let n = 1; n <= this.pdf.numPages; n++) {
      const page = await this.pdf.getPage(n);
      this.viewports.set(n, page.getViewport({ scale: 1 }));
    }
    this.layoutPages();
    this.observePages();
    this.buildThumbnails();
    requestAnimationFrame(() => this.scrollToPage(Math.min(this.doc.last_page || 1, this.pdf.numPages), false));
  },

  showUnavailable(error) {
    const pick = el("input", { type: "file", accept: "application/pdf,.pdf", class: "rd-file" });
    pick.addEventListener("change", () => pick.files[0] && this.reopen({ file: pick.files[0] }));
    const box = el(
      "div",
      { class: "rd-unavailable" },
      el("h3", { text: this.url ? t("rd.cantOpen") : this.paper ? t("rd.noFree") : t("rd.noPdf") }),
      error ? el("p", { class: "rd-error", text: String(error.message || error) }) : null,
      el("p", {
        text: this.libraryLogin
          ? t("rd.loginHint")
          : this.paper && !this.url
            ? t("rd.libraryHint")
            : t("rd.cantOpenHint"),
      }),
      el(
        "div",
        { class: "rd-row" },
        this.libraryLogin && signIn() ? this.loginButton() : null,
        this.browserLink()
          ? el("a", {
              href: this.browserLink(),
              target: "_blank",
              rel: "noopener",
              class: "rd-btn",
              text: t("rd.openInBrowser"),
            })
          : null,
        el("label", { class: "rd-btn primary" }, t("rd.pickFile"), pick),
      ),
    );
    this.pagesEl.replaceChildren(box);
  },

  /** Where the browser can try: the free copy, else the paper through the library. */
  browserLink() {
    const link = this.url || this.libraryPage || (this.libraryLogin && this.libraryLogin.url);
    return /^https?:\/\//i.test(link || "") ? link : null;
  },

  /** Sign in to the library in a window of its own (signIn()), then open the paper from there. */
  loginButton(label = t("rd.login")) {
    const button = el("button", { type: "button", class: "rd-btn primary rd-login", text: label });
    button.addEventListener("click", async () => {
      button.disabled = true;
      button.textContent = t("rd.loggingIn");
      let ok = false;
      try {
        ok = await signIn()(this.libraryLogin.doi, this.libraryLogin.url, this.paper);
      } catch {
        /* the window failed to open */
      }
      if (ok instanceof Uint8Array) return this.reopen({ pdfBytes: ok }); // Android: got in the sign-in screen
      if (ok === true) return this.reopen({ libraryOnly: true });
      button.disabled = false;
      button.textContent = label;
      this.toast(t("rd.loginClosed"));
    });
    return button;
  },

  async reopen(options) {
    await this.flush();
    this.close(false);
    await openReader({
      paper: this.paper,
      api: this.api,
      saveFile: this.saveFile,
      onOpened: this.onOpened,
      onFinished: this.onFinished,
      onAttachNote: this.onAttachNote,
      onClose: this.onClose,
      ...options,
    });
  },
};
