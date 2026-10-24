// The PDF reader with handwriting. app.js loads it on demand: openReader({ ... }).
//
// Each PDF page (and each blank note page) is a "surface": the page image (pdf.js) with an SVG
// on top that holds the handwriting. Handwriting is stored per document through the app's API
// (/annotations/<id>) in page units, so it stays sharp at any zoom and maps straight into the
// PDF when saved (export.js).

import {
  bbox, hits, HIGHLIGHT_OPACITY, lassoed, linePath, moved, newId, polygonPath, safeColour, simplify,
  strokeOutline, TEXT_LINE, textLines,
} from "./ink.js";
import { annotatedPdf, NOTE_PAGE, notesPdf } from "./export.js";

const SVG = "http://www.w3.org/2000/svg";
const PDFJS = new URL("../vendor/pdfjs/", import.meta.url);
const PDFLIB = new URL("../vendor/pdf-lib/pdf-lib.esm.min.js", import.meta.url);
const PEN_COLOURS = ["#1b1b1a", "#e5484d", "#2a78d6", "#1a7f4b", "#c98500", "#8e4ec6"];
const HIGHLIGHT_COLOURS = ["#ffd400", "#7ee081", "#ff8fb1", "#8ecbff"];
const SIZES = { pen: [0.8, 6, 1.6], highlighter: [6, 28, 12], text: [8, 32, 12] }; // min, max, default
const MAX_ZOOM = 4, MIN_ZOOM = 0.5;

let pdfjsLib = null;
async function loadPdfjs() {
  if (!pdfjsLib) {
    pdfjsLib = await import(new URL("pdf.min.js", PDFJS).href);
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("pdf.worker.min.js", PDFJS).href;
  }
  return pdfjsLib;
}

const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
};
const svgEl = (tag, attrs = {}) => {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) node.setAttribute(k, v);
  return node;
};
const clone = (v) => JSON.parse(JSON.stringify(v));

/** A document id for a PDF opened from a file: the start of its SHA-256. */
async function fileId(bytes) {
  try {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return "file-" + [...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    let h = 2166136261; // no WebCrypto (not a secure context): FNV-1a of a sample is enough to recognise the file again
    for (let i = 0; i < bytes.length; i += Math.max(1, Math.floor(bytes.length / 65536))) h = Math.imul(h ^ bytes[i], 16777619);
    return `file-${(h >>> 0).toString(16)}-${bytes.length}`;
  }
}

/**
 * Open the reader.
 *   paper     the paper it belongs to (id, title, open_access_url), if any
 *   url       an http(s) PDF to fetch, or
 *   file      a File the person picked
 *   api       app.js's api(method, path, body)
 *   saveFile  app.js's saveFile(name, content, mime)
 *   onOpened(paper), onFinished(paper)   reading-record hooks
 */
export async function openReader(options) {
  const reader = new Reader(options);
  await reader.start();
  return reader;
}

class Reader {
  constructor({ paper = null, url = null, file = null, docId = null, libraryOnly = false, api, saveFile, onOpened, onFinished, onAttachNote, onClose }) {
    Object.assign(this, { paper, url, file, libraryOnly, api, saveFile, onOpened, onFinished, onAttachNote, onClose });
    this.givenId = docId; // a notes-only document opened again
    this.tool = "pen";
    this.colours = { pen: PEN_COLOURS[0], highlighter: HIGHLIGHT_COLOURS[0], text: PEN_COLOURS[0] };
    this.sizes = { pen: SIZES.pen[2], highlighter: SIZES.highlighter[2], text: SIZES.text[2] };
    this.penOnly = false; this.penOnlyChosen = false;
    this.zoom = 1; this.undo = []; this.redo = []; this.selection = null;
    this.surfaces = new Map(); this.viewports = new Map(); this.textCache = new Map();
    this.doc = null; this.docId = null; this.bytes = null; this.pdf = null;
    this.finished = false; this.saveTimer = null; this.touches = new Map();
  }

  // ───────────── opening ─────────────

  async start() {
    this.build();
    document.body.classList.add("reader-open");
    let error = null;
    try {
      if (this.file) this.bytes = new Uint8Array(await this.file.arrayBuffer());
      else if (this.url || (this.paper && !this.givenId)) this.bytes = await this.findPdf();
    } catch (e) { error = e; }
    if (this.bytes) this.docId = this.paper ? shortId(this.paper.id) : await fileId(this.bytes);
    else if (this.paper) this.docId = shortId(this.paper.id);
    else this.docId = this.givenId || `notes-${newId()}`;
    this.doc = await this.loadDoc();
    if (this.bytes) {
      try { await this.loadPdf(); } catch (e) { error = e; this.bytes = null; }
    }
    if (!this.bytes && (this.url || this.file || (this.paper && !this.givenId) || error)) this.showUnavailable(error);
    else if (!this.bytes) this.pagesEl.hidden = true; // just note pages
    const notesOnly = !this.bytes && !this.url && !this.file && !error && !(this.paper && !this.givenId);
    if (this.doc.notes.length || notesOnly) this.toggleNotes(true);
    this.renderNotes();
    if (this.onOpened && this.paper) this.onOpened(this.paper);
  }

  /**
   * A paper's PDF, from the first place that has it: the free copy OpenAlex links to, the ones
   * Unpaywall knows, then the person's university library (backend/library.py). Null if none.
   */
  async findPdf() {
    const doi = bareDoi(this.paper && this.paper.doi);
    let lastError = null;
    const attempt = async (message, get) => {
      this.pagesEl.replaceChildren(el("div", { class: "rd-unavailable" }, el("p", { class: "rd-finding", text: message })));
      try { return await get(); } catch (e) { lastError = e; return null; }
    };
    if (!this.libraryOnly) {
      if (this.url) {
        const bytes = await attempt(t("rd.findingFree"), () => this.fetchPdf(this.url));
        if (bytes) return bytes;
      }
      let links = [];
      if (doi) try { links = (await this.api("GET", `/unpaywall?doi=${encodeURIComponent(doi)}`)).pdf_urls || []; } catch { /* no e-mail set, or offline */ }
      for (const link of links.filter((l) => l !== this.url)) {
        const bytes = await attempt(t("rd.findingFree"), () => this.fetchPdf(link));
        if (bytes) { this.url = link; return bytes; }
      }
    }
    if (doi) {
      const bytes = await attempt(t("rd.findingLibrary"), () => this.libraryPdf(doi));
      if (bytes) return bytes;
    }
    if (lastError) throw lastError;
    return null;
  }

  /** The PDF through the library: the desktop server (backend/library.py) or, on Android, core/library.js. */
  async libraryPdf(doi) {
    const path = `/library/pdf?doi=${encodeURIComponent(doi)}`;
    let status, detail = null;
    if (window.radarLocalApi) {
      try { return await window.radarLocalApi("GET", path); } catch (e) { status = e.status || 502; detail = e.detail || e.message; }
    } else {
      const response = await fetch(path);
      if (response.ok) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (new TextDecoder().decode(bytes.slice(0, 1024)).trimStart().startsWith("%PDF")) return bytes;
        throw new Error(t("rd.notPdf"));
      }
      status = response.status;
      try { detail = (await response.json()).detail; } catch { /* not JSON */ }
    }
    if (status === 422) return null; // no library set up: nothing to say
    if (status === 401) this.libraryLogin = { doi, url: detail && detail.login_url };
    if (status === 404 && detail && detail.page_url) this.libraryPage = detail.page_url;
    const key = { 401: "rd.library401", 404: "rd.library404" }[status] || "rd.libraryFailed";
    throw new Error(t(key, { error: (detail && (detail.message || detail)) || `HTTP ${status}` }));
  }

  async fetchPdf(url) {
    // Android: CapacitorHttp lets the page fetch any site; the desktop page goes through its server
    const target = window.radarLocalApi ? url : `/pdf?url=${encodeURIComponent(url)}`;
    const response = await fetch(target);
    if (!response.ok) {
      let detail = "";
      try { detail = (await response.json()).detail || ""; } catch { /* not JSON */ }
      throw new Error(detail || `HTTP ${response.status}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!new TextDecoder().decode(bytes.slice(0, 1024)).trimStart().startsWith("%PDF")) throw new Error(t("rd.notPdf"));
    return bytes;
  }

  async loadDoc() {
    let doc = null;
    try { doc = await this.api("GET", `/annotations/${encodeURIComponent(this.docId)}`); } catch { /* first time */ }
    return {
      title: (this.paper && this.paper.title) || (this.file && this.file.name) || t("rd.untitled"),
      paper_id: this.paper ? shortId(this.paper.id) : null,
      source: this.url || (doc && doc.source) || null,
      page_count: 0, last_page: 1, pages: {}, notes: [],
      ...(doc || {}),
    };
  }

  async loadPdf() {
    const lib = await loadPdfjs();
    this.loading = lib.getDocument({
      data: this.bytes.slice(), // pdf.js takes ownership of what it gets; keep our copy for saving
      cMapUrl: new URL("cmaps/", PDFJS).href, cMapPacked: true,
      standardFontDataUrl: new URL("standard_fonts/", PDFJS).href, wasmUrl: new URL("wasm/", PDFJS).href,
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
  }

  showUnavailable(error) {
    const pick = el("input", { type: "file", accept: "application/pdf,.pdf", class: "rd-file" });
    pick.addEventListener("change", () => pick.files[0] && this.reopen({ file: pick.files[0] }));
    const box = el("div", { class: "rd-unavailable" },
      el("h3", { text: this.url ? t("rd.cantOpen") : this.paper ? t("rd.noFree") : t("rd.noPdf") }),
      error ? el("p", { class: "rd-error", text: String(error.message || error) }) : null,
      el("p", { text: this.libraryLogin ? t("rd.loginHint") : this.paper && !this.url ? t("rd.libraryHint") : t("rd.cantOpenHint") }),
      el("div", { class: "rd-row" },
        this.libraryLogin && signIn() ? this.loginButton() : null,
        this.browserLink() ? el("a", { href: this.browserLink(), target: "_blank", rel: "noopener", class: "rd-btn", text: t("rd.openInBrowser") }) : null,
        el("label", { class: "rd-btn primary" }, t("rd.pickFile"), pick)));
    this.pagesEl.replaceChildren(box);
  }

  /** Where the browser can try: the free copy, else the paper through the library. */
  browserLink() {
    const link = this.url || this.libraryPage || (this.libraryLogin && this.libraryLogin.url);
    return /^https?:\/\//i.test(link || "") ? link : null;
  }

  /** Sign in to the library in a window of its own (signIn()), then open the paper from there. */
  loginButton() {
    const button = el("button", { type: "button", class: "rd-btn primary rd-login", text: t("rd.login") });
    button.addEventListener("click", async () => {
      button.disabled = true;
      button.textContent = t("rd.loggingIn");
      let ok = false;
      try { ok = await signIn()(this.libraryLogin.doi, this.libraryLogin.url); } catch { /* the window failed to open */ }
      if (ok) return this.reopen({ libraryOnly: true });
      button.disabled = false;
      button.textContent = t("rd.login");
      this.toast(t("rd.loginClosed"));
    });
    return button;
  }

  async reopen(options) {
    await this.flush();
    this.close(false);
    await openReader({ paper: this.paper, api: this.api, saveFile: this.saveFile, onOpened: this.onOpened,
      onFinished: this.onFinished, onAttachNote: this.onAttachNote, onClose: this.onClose, ...options });
  }

  // ───────────── the frame ─────────────

  build() {
    const tool = (name, label, icon) => el("button", { type: "button", class: "rd-tool", "data-tool": name, title: label, "aria-label": label,
      onclick: () => this.setTool(name) }, icon);
    this.colourRow = el("div", { class: "rd-colours" });
    this.sizeInput = el("input", { type: "range", class: "rd-size", "aria-label": t("rd.size"), oninput: () => this.setSize(Number(this.sizeInput.value)) });
    this.customColour = el("input", { type: "color", class: "rd-custom", title: t("rd.customColour"), "aria-label": t("rd.customColour"),
      oninput: () => this.setColour(this.customColour.value) });
    const action = (cls, label, icon, handler) => el("button", { type: "button", class: `rd-act ${cls}`, title: label, "aria-label": label, onclick: handler }, icon);
    this.saveMenu = el("div", { class: "rd-menu", hidden: true },
      el("button", { type: "button", class: "rd-save-pdf", text: t("rd.savePdf"), onclick: () => this.savePdf() }),
      el("button", { type: "button", class: "rd-save-notes", text: t("rd.saveNotes"), onclick: () => this.saveNotes() }));
    this.searchInput = el("input", { type: "search", class: "rd-search-input", placeholder: t("rd.searchPlaceholder"), enterkeyhint: "search" });
    this.searchCount = el("span", { class: "rd-search-count" });
    this.searchBar = el("form", { class: "rd-searchbar", hidden: true, onsubmit: (e) => { e.preventDefault(); this.search(this.searchInput.value, 1); } },
      this.searchInput, this.searchCount,
      el("button", { type: "button", text: "↑", "aria-label": t("rd.prev"), onclick: () => this.search(this.searchInput.value, -1) }),
      el("button", { type: "submit", text: "↓", "aria-label": t("rd.next") }));
    this.titleEl = el("span", { class: "rd-title" });
    this.pagesEl = el("div", { class: "rd-pages", tabindex: "0" });
    this.notesEl = el("div", { class: "rd-notes", hidden: true });
    this.thumbsEl = el("aside", { class: "rd-thumbs", hidden: true });
    this.annotsEl = el("aside", { class: "rd-annots", hidden: true });
    this.toastEl = el("div", { class: "rd-toast", role: "status" });
    const I = (d) => { const s = svgEl("svg", { viewBox: "0 0 24 24", class: "ic", "aria-hidden": "true" }); s.innerHTML = d; return s; }; // our own static icons
    this.root = el("section", { class: "reader", role: "dialog", "aria-modal": "true", "aria-label": t("rd.reader") },
      el("header", { class: "rd-top" },
        el("div", { class: "rd-row rd-head" },
          action("rd-close", t("rd.close"), I('<path d="M15 5l-7 7 7 7"/>'), () => this.close()),
          this.titleEl,
          action("rd-undo", t("rd.undo"), I('<path d="M9 7H4v5"/><path d="M4 12a8 8 0 1 0 2.3-5.6L4 9"/>'), () => this.doUndo()),
          action("rd-redo", t("rd.redo"), I('<path d="M15 7h5v5"/><path d="M20 12a8 8 0 1 1-2.3-5.6L20 9"/>'), () => this.doRedo()),
          el("div", { class: "rd-save-wrap" }, action("rd-save", t("rd.save"), I('<path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>'),
            () => (this.saveMenu.hidden = !this.saveMenu.hidden)), this.saveMenu)),
        el("div", { class: "rd-row rd-toolbar" },
          tool("hand", t("rd.hand"), I('<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12"/><path d="M11 11.5v-8a1.5 1.5 0 0 1 3 0V12"/><path d="M14 11.5V5a1.5 1.5 0 0 1 3 0v8"/><path d="M17 9.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-1.5a6 6 0 0 1-4.6-2.2L4.5 14.5a1.5 1.5 0 0 1 2.3-1.9L8 14"/>')),
          tool("pen", t("rd.pen"), I('<path d="M4 20l4-1 11-11-3-3L5 16z"/><path d="M14 6l3 3"/>')),
          tool("highlighter", t("rd.highlighter"), I('<path d="M5 19h6"/><path d="m9 15-2-2 8-8 4 4-8 8z"/><path d="m7 13-2 4 4-2"/>')),
          tool("eraser", t("rd.eraser"), I('<path d="m4 15 9-9 7 7-6 6H8z"/><path d="M9 20h11"/>')),
          tool("text", t("rd.text"), I('<path d="M5 6V4h14v2"/><path d="M12 4v16"/><path d="M9 20h6"/>')),
          tool("select", t("rd.select"), I('<path d="M4 7V4h3M17 4h3v3M20 17v3h-3M7 20H4v-3"/><path d="m10 9 6 3-3 1-1 3z"/>')),
          el("span", { class: "rd-sep" }), this.colourRow, this.customColour, this.sizeInput,
          el("span", { class: "rd-sep" }),
          action("rd-delete", t("rd.deleteSelection"), I('<path d="M5 7h14"/><path d="M10 7V5h4v2"/><path d="M7 7l1 13h8l1-13"/>'), () => this.deleteSelection())),
        el("div", { class: "rd-row rd-views" },
          action("rd-penonly", t("rd.penOnly"), I('<path d="M4 20l4-1 11-11-3-3L5 16z"/><path d="M3 3l18 18"/>'), () => this.setPenOnly(!this.penOnly, true)),
          action("rd-hide", t("rd.hide"), I('<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'), () => this.toggleHidden()),
          action("rd-find", t("rd.search"), I('<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>'), () => this.toggleSearch()),
          action("rd-thumbs-btn", t("rd.thumbs"), I('<rect x="4" y="4" width="6" height="7"/><rect x="14" y="4" width="6" height="7"/><rect x="4" y="14" width="6" height="7"/><rect x="14" y="14" width="6" height="7"/>'), () => this.togglePanel(this.thumbsEl)),
          action("rd-annots-btn", t("rd.annots"), I('<path d="M5 5h14v10H9l-4 4z"/><path d="M8 9h8M8 12h5"/>'), () => { this.togglePanel(this.annotsEl); this.renderAnnots(); }),
          action("rd-notes-btn", t("rd.notes"), I('<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/>'), () => this.toggleNotes()),
          el("span", { class: "rd-spacer" }),
          action("rd-zoom-out", t("rd.zoomOut"), I('<path d="M6 12h12"/>'), () => this.setZoom(this.zoom / 1.25)),
          el("span", { class: "rd-zoom-label" }),
          action("rd-zoom-in", t("rd.zoomIn"), I('<path d="M6 12h12M12 6v12"/>'), () => this.setZoom(this.zoom * 1.25))),
        this.searchBar),
      el("div", { class: "rd-body" }, this.thumbsEl, this.pagesEl, this.notesEl, this.annotsEl),
      this.toastEl);
    if (!document.querySelector("link[data-reader-css]")) {
      document.head.append(el("link", { rel: "stylesheet", href: new URL("reader.css", import.meta.url).href, "data-reader-css": "" }));
    }
    document.body.append(this.root);
    this.root.querySelector(".rd-undo").disabled = this.root.querySelector(".rd-redo").disabled = true;
    this.titleEl.textContent = (this.paper && this.paper.title) || (this.file && this.file.name) || t("rd.untitled");
    this.setTool("pen");
    this.updateZoomLabel();
    this.pagesEl.addEventListener("scroll", () => this.onScroll(), { passive: true });
    this.pagesEl.addEventListener("wheel", (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      this.setZoom(this.zoom * Math.exp(-e.deltaY * 0.002), e);
    }, { passive: false });
    this.keyHandler = (e) => this.onKey(e);
    document.addEventListener("keydown", this.keyHandler);
    window.addEventListener("resize", this.resizeHandler = () => this.layoutPages());
  }

  close(notify = true) {
    this.flush();
    document.removeEventListener("keydown", this.keyHandler);
    window.removeEventListener("resize", this.resizeHandler);
    if (this.observer) this.observer.disconnect();
    if (this.loading) this.loading.destroy().catch(() => {}); // frees the worker and the pages
    this.root.remove();
    document.body.classList.remove("reader-open");
    if (notify && this.onClose) this.onClose();
  }

  toast(message) {
    this.toastEl.textContent = message;
    this.toastEl.classList.add("on");
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toastEl.classList.remove("on"), 2600);
  }

  // ───────────── tools ─────────────

  setTool(name) {
    this.finishEditing();
    if (name !== "select") this.select(null);
    this.tool = name;
    this.root.dataset.tool = name;
    this.root.querySelectorAll(".rd-tool").forEach((b) => b.classList.toggle("on", b.dataset.tool === name));
    const kind = name === "highlighter" ? "highlighter" : name === "text" ? "text" : "pen";
    const palette = kind === "highlighter" ? HIGHLIGHT_COLOURS : PEN_COLOURS;
    this.colourRow.replaceChildren(...palette.map((c) => el("button", { type: "button", class: "rd-colour", style: `--c:${c}`,
      "data-colour": c, title: c, "aria-label": c, onclick: () => this.setColour(c) })));
    const [min, max] = SIZES[kind];
    Object.assign(this.sizeInput, { min, max, step: kind === "pen" ? 0.2 : 1, value: this.sizes[kind] });
    this.showColour(kind);
  }

  get kind() { return this.tool === "highlighter" ? "highlighter" : this.tool === "text" ? "text" : "pen"; }

  showColour(kind = this.kind) {
    this.root.querySelectorAll(".rd-colour").forEach((b) => b.classList.toggle("on", b.dataset.colour === this.colours[kind]));
    this.customColour.value = this.colours[kind].length === 7 ? this.colours[kind] : "#000000";
  }

  setColour(c) {
    c = safeColour(c);
    if (this.selection && this.selection.ids.size) return this.restyleSelection({ color: c });
    this.colours[this.kind] = c;
    this.showColour();
  }

  setSize(v) {
    if (this.selection && this.selection.ids.size && this.tool === "select") return;
    this.sizes[this.kind] = v;
  }

  setPenOnly(on, chosen = false) {
    this.penOnly = on;
    if (chosen) this.penOnlyChosen = true;
    this.root.classList.toggle("pen-only", on);
    this.root.querySelector(".rd-penonly").classList.toggle("on", on);
  }

  toggleHidden() {
    const hidden = this.root.classList.toggle("ink-hidden");
    this.root.querySelector(".rd-hide").classList.toggle("on", hidden);
    this.toast(t(hidden ? "rd.hidden" : "rd.shown"));
  }

  togglePanel(panel) {
    panel.hidden = !panel.hidden;
    this.root.querySelector(panel === this.thumbsEl ? ".rd-thumbs-btn" : ".rd-annots-btn").classList.toggle("on", !panel.hidden);
  }

  toggleNotes(show = this.notesEl.hidden) {
    this.notesEl.hidden = !show;
    this.root.classList.toggle("notes-open", show);
    this.root.querySelector(".rd-notes-btn").classList.toggle("on", show);
    if (show && !this.doc.notes.length) this.addNotePage(false);
    this.layoutPages();
  }

  // ───────────── pages ─────────────

  /** CSS width of a PDF page at the current zoom: the page column's width, at most 1000px. */
  pageWidth() {
    const room = Math.max(240, this.pagesEl.clientWidth - 24);
    return Math.min(room, 1000) * this.zoom;
  }

  layoutPages() {
    if (this.pdf) {
      if (!this.surfaces.size || ![...this.surfaces.keys()].some((k) => k.startsWith("p:"))) {
        this.pagesEl.replaceChildren(...[...this.viewports.keys()].map((n) => this.makeSurface(`p:${n}`, this.viewports.get(n)).el));
      }
      const width = this.pageWidth();
      for (const [n, vp] of this.viewports) {
        const s = this.surfaces.get(`p:${n}`);
        s.el.style.width = `${width}px`;
        s.el.style.height = `${(width * vp.height) / vp.width}px`;
        if (s.renderedAt && Math.abs(s.renderedAt - width) > 1) s.stale = true;
      }
      clearTimeout(this.renderTimer);
      this.renderTimer = setTimeout(() => this.renderVisible(), 120);
    }
    this.layoutNotes();
  }

  observePages() {
    this.observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const s = this.surfaces.get(entry.target.dataset.key);
        if (!s) continue;
        s.visible = entry.isIntersecting;
        if (s.visible && (!s.renderedAt || s.stale)) this.renderPage(s);
      }
    }, { root: this.pagesEl, rootMargin: "600px 0px" });
    for (const [key, s] of this.surfaces) if (key.startsWith("p:")) this.observer.observe(s.el);
  }

  renderVisible() {
    for (const s of this.surfaces.values()) if (s.visible && s.page && (s.stale || !s.renderedAt)) this.renderPage(s);
  }

  async renderPage(s) {
    if (s.rendering) { s.again = true; return; }
    s.rendering = true;
    try {
      const page = await this.pdf.getPage(s.page);
      const width = parseFloat(s.el.style.width);
      const scale = (width / s.width) * Math.min(window.devicePixelRatio || 1, 2.5);
      const viewport = page.getViewport({ scale });
      const canvas = el("canvas", { class: "rd-canvas", width: Math.floor(viewport.width), height: Math.floor(viewport.height) });
      await page.render({ canvas, canvasContext: canvas.getContext("2d"), viewport }).promise;
      s.canvas.replaceWith(canvas);
      s.canvas = canvas;
      s.renderedAt = width; s.stale = false;
    } catch { /* closed while rendering */ }
    s.rendering = false;
    if (s.again) { s.again = false; if (s.stale) this.renderPage(s); }
  }

  makeSurface(key, { width, height }) {
    const svg = svgEl("svg", { class: "rd-ink", viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "none" });
    const items = svgEl("g", { class: "rd-items" }), live = svgEl("g", { class: "rd-live" }), found = svgEl("g", { class: "rd-found" });
    svg.append(found, items, live);
    const canvas = el("canvas", { class: "rd-canvas" });
    const page = key.startsWith("p:") ? Number(key.slice(2)) : null;
    const wrapper = el("div", { class: page ? "rd-page" : "rd-page rd-note", "data-key": key, "data-page": page ?? "" },
      page ? canvas : null, svg, el("span", { class: "rd-page-no", text: page ? String(page) : "" }));
    const s = { key, el: wrapper, svg, itemsG: items, liveG: live, foundG: found, canvas, width, height, page };
    this.surfaces.set(key, s);
    this.bindInput(s);
    this.drawSurface(s);
    return s;
  }

  itemsOf(key) {
    if (key.startsWith("p:")) return (this.doc.pages[key.slice(2)] ||= []);
    return this.doc.notes[Number(key.slice(2))];
  }

  setItems(key, items) {
    if (key.startsWith("p:")) {
      if (items.length) this.doc.pages[key.slice(2)] = items; else delete this.doc.pages[key.slice(2)];
    } else this.doc.notes[Number(key.slice(2))] = items;
  }

  // ───────────── note pages ─────────────

  renderNotes() {
    for (const key of [...this.surfaces.keys()]) if (key.startsWith("n:")) this.surfaces.delete(key);
    const pages = this.doc.notes.map((_, i) => this.makeSurface(`n:${i}`, { width: NOTE_PAGE[0], height: NOTE_PAGE[1] }).el);
    pages.forEach((p, i) => p.querySelector(".rd-page-no").textContent = t("rd.notePage", { n: i + 1 }));
    this.notesEl.replaceChildren(...pages,
      el("button", { type: "button", class: "rd-add-note", text: t("rd.addNote"), onclick: () => this.addNotePage() }));
    this.layoutNotes();
  }

  layoutNotes() {
    const width = Math.min(Math.max(220, this.notesEl.clientWidth - 24), 760) * (this.pdf ? 1 : this.zoom);
    for (const [key, s] of this.surfaces) {
      if (!key.startsWith("n:")) continue;
      s.el.style.width = `${width}px`;
      s.el.style.height = `${(width * NOTE_PAGE[1]) / NOTE_PAGE[0]}px`;
    }
  }

  addNotePage(scroll = true) {
    this.record("notes", () => this.doc.notes.push([]));
    this.renderNotes();
    if (scroll) this.notesEl.lastElementChild.previousElementSibling.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ───────────── drawing items ─────────────

  drawSurface(s) {
    s.itemsG.replaceChildren(...this.itemsOf(s.key).map((item) => this.itemNode(item)));
    this.drawSelection();
  }

  itemNode(item) {
    const colour = safeColour(item.color);
    let node;
    if (item.type === "ink") node = svgEl("path", { d: polygonPath(strokeOutline(item.points, item.width)), fill: colour });
    else if (item.type === "highlight") {
      node = svgEl("path", { d: linePath(item.points), fill: "none", stroke: colour, "stroke-width": item.width,
        "stroke-linecap": "round", "stroke-linejoin": "round", opacity: HIGHLIGHT_OPACITY, class: "rd-hl" });
    } else {
      node = svgEl("text", { x: item.x, y: item.y, "font-size": item.size, fill: colour, class: "rd-text" });
      textLines(item).forEach((line, i) => {
        const span = svgEl("tspan", { x: item.x, dy: i ? item.size * TEXT_LINE : item.size });
        span.textContent = line || " ";
        node.append(span);
      });
    }
    node.dataset.id = item.id;
    return node;
  }

  /** Run `change` on the document and remember how to undo it. `key` is a surface or "notes". */
  record(key, change) {
    const before = key === "notes" ? clone(this.doc.notes) : clone(this.itemsOf(key));
    change();
    const after = key === "notes" ? clone(this.doc.notes) : clone(this.itemsOf(key));
    this.undo.push({ key, before, after });
    if (this.undo.length > 200) this.undo.shift();
    this.redo = [];
    this.changed();
  }

  applyState(key, items) {
    if (key === "notes") { this.doc.notes = clone(items); this.renderNotes(); }
    else { this.setItems(key, clone(items)); const s = this.surfaces.get(key); if (s) this.drawSurface(s); }
    this.changed();
  }

  doUndo() { this.finishEditing(); const op = this.undo.pop(); if (op) { this.redo.push(op); this.select(null); this.applyState(op.key, op.before); } }
  doRedo() { const op = this.redo.pop(); if (op) { this.undo.push(op); this.select(null); this.applyState(op.key, op.after); } }

  changed() {
    this.root.querySelector(".rd-undo").disabled = !this.undo.length;
    this.root.querySelector(".rd-redo").disabled = !this.redo.length;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 700);
  }

  async flush() {
    clearTimeout(this.saveTimer);
    if (!this.doc) return;
    try {
      await this.api("PUT", `/annotations/${encodeURIComponent(this.docId)}`, this.doc);
      this.root.classList.remove("unsaved");
    } catch (e) {
      this.root.classList.add("unsaved");
      this.toast(t("rd.saveFailed", { error: e.message }));
    }
  }

  // ───────────── input ─────────────

  /** Page units under a pointer event. */
  pointOn(s, e) {
    const r = s.svg.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * s.width, ((e.clientY - r.top) / r.height) * s.height];
  }

  unitsPerPx(s) { return s.width / s.svg.getBoundingClientRect().width; }

  bindInput(s) {
    const svg = s.svg;
    svg.addEventListener("pointerdown", (e) => this.down(s, e));
    svg.addEventListener("pointermove", (e) => this.move(s, e));
    svg.addEventListener("pointerup", (e) => this.up(s, e));
    svg.addEventListener("pointercancel", (e) => this.up(s, e, true));
    svg.addEventListener("dblclick", (e) => {
      const item = this.itemAt(s, this.pointOn(s, e), (i) => i.type === "text");
      if (item) this.editText(s, item);
    });
  }

  /** Is this pointer for moving around (fingers when only the pen writes, two fingers, the hand tool)? */
  navigates(e) {
    if (this.tool === "hand" || this.root.classList.contains("ink-hidden")) return true;
    if (e.pointerType === "touch") return this.penOnly || this.touches.size > 1;
    return e.pointerType === "mouse" && e.button !== 0;
  }

  down(s, e) {
    if (e.pointerType === "pen" && !this.penOnly && !this.penOnlyChosen) {
      this.setPenOnly(true); // a stylus: fingers now only scroll and zoom (palm rejection)
      this.toast(t("rd.penDetected"));
    }
    if (e.pointerType === "touch") this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.gesture && this.gesture.kind === "draw" && e.pointerType === "touch" && this.touches.size > 1) {
      s.liveG.replaceChildren(); this.gesture = null; // a second finger: it was a pinch, not a line
    }
    if (this.navigates(e)) { this.startNavigation(e); return; }
    if (this.gesture) return; // one stroke at a time
    e.preventDefault();
    try { s.svg.setPointerCapture(e.pointerId); } catch { /* not a live pointer (synthetic events) */ }
    const p = this.pointOn(s, e), pressure = e.pointerType === "pen" ? e.pressure || 0.5 : 0;
    if (this.tool === "pen" || this.tool === "highlighter") {
      this.gesture = { kind: "draw", s, id: e.pointerId, points: [[...p, pressure]] };
      this.drawLive();
    } else if (this.tool === "eraser") {
      this.gesture = { kind: "erase", s, id: e.pointerId, before: clone(this.itemsOf(s.key)), removed: 0 };
      this.eraseAt(s, p);
    } else if (this.tool === "text") {
      const item = this.itemAt(s, p, (i) => i.type === "text");
      if (item) this.editText(s, item);
      else this.newText(s, p);
    } else if (this.tool === "select") {
      const sel = this.selection;
      const grabbed = sel && sel.key === s.key && this.insideSelection(p);
      const item = grabbed ? null : this.itemAt(s, p);
      if (item) this.select({ key: s.key, ids: new Set([item.id]) });
      if (grabbed || item) this.gesture = { kind: "move", s, id: e.pointerId, from: p, dx: 0, dy: 0 };
      else { this.select(null); this.gesture = { kind: "lasso", s, id: e.pointerId, points: [p] }; }
    }
  }

  move(s, e) {
    if (e.pointerType === "touch" && this.touches.has(e.pointerId)) this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.nav) { this.navigate(e); return; }
    const g = this.gesture;
    if (!g || g.id !== e.pointerId || g.s !== s) return;
    e.preventDefault();
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    if (g.kind === "draw") {
      for (const ev of events.length ? events : [e]) g.points.push([...this.pointOn(s, ev), e.pointerType === "pen" ? ev.pressure || 0.5 : 0]);
      this.drawLive();
    } else if (g.kind === "erase") {
      for (const ev of events.length ? events : [e]) this.eraseAt(s, this.pointOn(s, ev));
    } else if (g.kind === "move") {
      const p = this.pointOn(s, e);
      g.dx = p[0] - g.from[0]; g.dy = p[1] - g.from[1];
      for (const node of s.itemsG.children) if (this.selection.ids.has(node.dataset.id)) node.setAttribute("transform", `translate(${g.dx} ${g.dy})`);
      this.drawSelection(g.dx, g.dy);
    } else if (g.kind === "lasso") {
      g.points.push(this.pointOn(s, e));
      s.liveG.replaceChildren(svgEl("polygon", { points: g.points.map((q) => q.join(",")).join(" "), class: "rd-lasso" }));
    }
  }

  up(s, e, cancelled = false) {
    if (e.pointerType === "touch") this.touches.delete(e.pointerId);
    if (this.nav) { if (!this.touches.size || e.pointerType !== "touch") this.nav = null; else this.startNavigation(e); return; }
    const g = this.gesture;
    if (!g || g.id !== e.pointerId) return;
    this.gesture = null;
    s.liveG.replaceChildren();
    if (cancelled) { this.drawSurface(s); return; }
    if (g.kind === "draw") {
      const highlight = this.tool === "highlighter";
      const points = simplify(g.points, 0.25 * this.unitsPerPx(s));
      const item = { id: newId(), type: highlight ? "highlight" : "ink", color: this.colours[highlight ? "highlighter" : "pen"],
        width: Math.round(this.sizes[highlight ? "highlighter" : "pen"] * 10) / 10,
        points: highlight ? points.map(([x, y]) => [x, y]) : points };
      this.record(s.key, () => this.itemsOf(s.key).push(item));
      this.drawSurface(s);
    } else if (g.kind === "erase") {
      if (g.removed) { this.undo.push({ key: s.key, before: g.before, after: clone(this.itemsOf(s.key)) }); this.redo = []; this.changed(); }
    } else if (g.kind === "move") {
      if (Math.abs(g.dx) + Math.abs(g.dy) > 0.2) {
        const ids = this.selection.ids;
        this.record(s.key, () => this.setItems(s.key, this.itemsOf(s.key).map((i) => (ids.has(i.id) ? moved(i, g.dx, g.dy) : i))));
      }
      this.drawSurface(s);
    } else if (g.kind === "lasso") {
      const caught = lassoed(this.itemsOf(s.key), g.points);
      this.select(caught.length ? { key: s.key, ids: new Set(caught.map((i) => i.id)) } : null);
    }
  }

  drawLive() {
    const g = this.gesture, highlight = this.tool === "highlighter";
    const colour = this.colours[highlight ? "highlighter" : "pen"], width = this.sizes[highlight ? "highlighter" : "pen"];
    const node = highlight
      ? svgEl("path", { d: linePath(g.points), fill: "none", stroke: colour, "stroke-width": width, "stroke-linecap": "round", opacity: HIGHLIGHT_OPACITY, class: "rd-hl" })
      : svgEl("path", { d: polygonPath(strokeOutline(g.points, width)), fill: colour });
    g.s.liveG.replaceChildren(node);
  }

  itemAt(s, [x, y], filter = () => true) {
    const items = this.itemsOf(s.key), tolerance = 6 * this.unitsPerPx(s);
    for (let i = items.length - 1; i >= 0; i--) if (filter(items[i]) && hits(items[i], x, y, tolerance)) return items[i];
    return null;
  }

  eraseAt(s, [x, y]) {
    const items = this.itemsOf(s.key), tolerance = Math.max(4, this.sizes.pen * 2) * this.unitsPerPx(s);
    const kept = items.filter((i) => !hits(i, x, y, tolerance));
    if (kept.length !== items.length) {
      this.gesture.removed += items.length - kept.length;
      this.setItems(s.key, kept);
      this.drawSurface(s);
    }
  }

  // ───────────── moving around ─────────────

  startNavigation(e) {
    const pts = [...this.touches.values()];
    const mid = pts.length > 1 ? { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 } : { x: e.clientX, y: e.clientY };
    this.nav = { last: mid, dist: pts.length > 1 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0, zoom: this.zoom };
  }

  navigate(e) {
    const pts = e.pointerType === "touch" ? [...this.touches.values()] : [{ x: e.clientX, y: e.clientY }];
    const mid = pts.length > 1 ? { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 } : pts[0];
    const scroller = this.scrollerAt(e);
    scroller.scrollLeft -= mid.x - this.nav.last.x;
    scroller.scrollTop -= mid.y - this.nav.last.y;
    this.nav.last = mid;
    if (pts.length > 1 && this.nav.dist) {
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      this.setZoom(this.nav.zoom * (dist / this.nav.dist), { clientX: mid.x, clientY: mid.y });
    }
  }

  scrollerAt(e) { return this.notesEl.contains(e.target) ? this.notesEl : this.pagesEl; }

  setZoom(z, at = null) {
    z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
    if (Math.abs(z - this.zoom) < 0.001) return;
    const box = this.pagesEl.getBoundingClientRect();
    const ax = at ? at.clientX - box.left : box.width / 2, ay = at ? at.clientY - box.top : box.height / 2;
    const fx = (this.pagesEl.scrollLeft + ax) / (this.pagesEl.scrollWidth || 1), fy = (this.pagesEl.scrollTop + ay) / (this.pagesEl.scrollHeight || 1);
    this.zoom = z;
    this.layoutPages();
    this.pagesEl.scrollLeft = fx * this.pagesEl.scrollWidth - ax;
    this.pagesEl.scrollTop = fy * this.pagesEl.scrollHeight - ay;
    this.updateZoomLabel();
  }

  updateZoomLabel() { this.root.querySelector(".rd-zoom-label").textContent = `${Math.round(this.zoom * 100)}%`; }

  scrollToPage(n, smooth = true) {
    const s = this.surfaces.get(`p:${n}`);
    if (s) this.pagesEl.scrollTo({ top: s.el.offsetTop - 8, behavior: smooth ? "smooth" : "auto" });
  }

  currentPage() {
    const middle = this.pagesEl.scrollTop + this.pagesEl.clientHeight / 3;
    let page = 1;
    for (const [key, s] of this.surfaces) if (key.startsWith("p:") && s.el.offsetTop <= middle) page = s.page;
    return page;
  }

  onScroll() {
    if (!this.pdf) return;
    const page = this.currentPage();
    if (page !== this.doc.last_page) { this.doc.last_page = page; this.changed(); }
    this.thumbsEl.querySelectorAll(".rd-thumb").forEach((b) => b.classList.toggle("on", Number(b.dataset.page) === page));
    // reached the end of the last page: the paper has been read
    const lastPage = this.surfaces.get(`p:${this.pdf.numPages}`);
    if (!this.finished && lastPage && this.pagesEl.scrollTop + this.pagesEl.clientHeight >= lastPage.el.offsetTop + lastPage.el.offsetHeight - 40) {
      this.finished = true;
      if (this.onFinished && this.paper) this.onFinished(this.paper).then((marked) => marked && this.toast(t("rd.finished")));
    }
  }

  onKey(e) {
    if (this.editor) { if (e.key === "Escape") this.finishEditing(); return; }
    if (e.target.closest && e.target.closest("input, textarea")) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) this.doRedo(); else this.doUndo(); }
    else if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); this.doRedo(); }
    else if ((e.key === "Delete" || e.key === "Backspace") && this.selection) { e.preventDefault(); this.deleteSelection(); }
    else if (e.key === "Escape") { if (this.selection) this.select(null); else this.close(); }
    else if (mod && e.key.toLowerCase() === "f" && this.pdf) { e.preventDefault(); this.toggleSearch(true); }
  }

  // ───────────── selection ─────────────

  select(selection) {
    this.selection = selection && selection.ids.size ? selection : null;
    this.root.classList.toggle("has-selection", !!this.selection);
    for (const s of this.surfaces.values()) s.svg.querySelectorAll(".rd-selbox").forEach((n) => n.remove());
    this.drawSelection();
  }

  selectionBox(dx = 0, dy = 0) {
    const items = this.itemsOf(this.selection.key).filter((i) => this.selection.ids.has(i.id));
    if (!items.length) return null;
    const boxes = items.map(bbox);
    return [Math.min(...boxes.map((b) => b[0])) + dx, Math.min(...boxes.map((b) => b[1])) + dy,
      Math.max(...boxes.map((b) => b[2])) + dx, Math.max(...boxes.map((b) => b[3])) + dy];
  }

  insideSelection([x, y]) {
    const b = this.selectionBox();
    return b && x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];
  }

  drawSelection(dx = 0, dy = 0) {
    if (!this.selection) return;
    const s = this.surfaces.get(this.selection.key), b = this.selectionBox(dx, dy);
    if (!s || !b) return;
    s.svg.querySelectorAll(".rd-selbox").forEach((n) => n.remove());
    const pad = 3 * this.unitsPerPx(s);
    s.svg.append(svgEl("rect", { class: "rd-selbox", x: b[0] - pad, y: b[1] - pad, width: b[2] - b[0] + 2 * pad, height: b[3] - b[1] + 2 * pad }));
  }

  deleteSelection() {
    if (!this.selection) return;
    const { key, ids } = this.selection;
    this.record(key, () => this.setItems(key, this.itemsOf(key).filter((i) => !ids.has(i.id))));
    this.select(null);
    this.drawSurface(this.surfaces.get(key));
  }

  restyleSelection(change) {
    const { key, ids } = this.selection;
    this.record(key, () => this.setItems(key, this.itemsOf(key).map((i) => (ids.has(i.id) ? { ...i, ...change } : i))));
    this.drawSurface(this.surfaces.get(key));
  }

  // ───────────── text boxes ─────────────

  newText(s, [x, y]) {
    const size = this.sizes.text;
    const item = { id: newId(), type: "text", color: this.colours.text, size, x: Math.round(x), y: Math.round(y - size / 2),
      w: Math.round(Math.min(s.width - x - 4, Math.max(120, s.width * 0.35))), text: "" };
    this.editText(s, item, true);
  }

  editText(s, item, isNew = false) {
    this.finishEditing();
    const scale = 1 / this.unitsPerPx(s);
    const area = el("textarea", { class: "rd-editor", spellcheck: "false", "aria-label": t("rd.text") });
    area.value = item.text;
    Object.assign(area.style, { left: `${item.x * scale}px`, top: `${item.y * scale}px`, width: `${item.w * scale}px`,
      fontSize: `${item.size * scale}px`, lineHeight: String(TEXT_LINE), color: safeColour(item.color) });
    const fit = () => { area.style.height = "auto"; area.style.height = `${area.scrollHeight + 2}px`; };
    area.addEventListener("input", fit);
    area.addEventListener("blur", () => this.finishEditing());
    s.el.append(area);
    s.itemsG.querySelector(`[data-id="${item.id}"]`)?.setAttribute("visibility", "hidden");
    this.editor = { s, item, isNew, area };
    fit();
    area.focus(); // at once, so typing right after the tap lands in the box
    setTimeout(() => area.focus(), 0); // and again once the tap is over
  }

  finishEditing() {
    const ed = this.editor;
    if (!ed) return;
    this.editor = null;
    const text = ed.area.value.replace(/\s+$/, "");
    ed.area.remove();
    const items = this.itemsOf(ed.s.key);
    if (ed.isNew) {
      if (text) this.record(ed.s.key, () => items.push({ ...ed.item, text }));
    } else if (!text) {
      this.record(ed.s.key, () => this.setItems(ed.s.key, items.filter((i) => i.id !== ed.item.id)));
    } else if (text !== ed.item.text) {
      this.record(ed.s.key, () => this.setItems(ed.s.key, items.map((i) => (i.id === ed.item.id ? { ...i, text } : i))));
    }
    this.drawSurface(ed.s);
  }

  // ───────────── search, thumbnails, annotation list ─────────────

  toggleSearch(show = this.searchBar.hidden) {
    if (!this.pdf) return;
    this.searchBar.hidden = !show;
    this.root.querySelector(".rd-find").classList.toggle("on", show);
    if (show) this.searchInput.focus();
    else for (const s of this.surfaces.values()) s.foundG.replaceChildren();
  }

  /** Text items of a page with their boxes in page units. */
  async pageText(n) {
    if (!this.textCache.has(n)) {
      const page = await this.pdf.getPage(n), vp = this.viewports.get(n);
      const content = await page.getTextContent();
      this.textCache.set(n, content.items.filter((i) => i.str && i.str.trim()).map((i) => {
        const tx = pdfjsLib.Util.transform(vp.transform, i.transform), h = Math.hypot(tx[2], tx[3]);
        return { str: i.str, box: [tx[4], tx[5] - h, tx[4] + i.width * vp.scale, tx[5]] };
      }));
    }
    return this.textCache.get(n);
  }

  async search(query, direction) {
    query = query.trim().toLowerCase();
    if (!query) return;
    if (this.searchQuery !== query) {
      this.searchQuery = query; this.hits = []; this.hitAt = -1;
      for (let n = 1; n <= this.pdf.numPages; n++) {
        for (const item of await this.pageText(n)) if (item.str.toLowerCase().includes(query)) this.hits.push({ page: n, box: item.box });
      }
    }
    for (const s of this.surfaces.values()) s.foundG.replaceChildren();
    if (!this.hits.length) { this.searchCount.textContent = t("rd.noMatches"); return; }
    this.hitAt = (this.hitAt + direction + this.hits.length) % this.hits.length;
    const hit = this.hits[this.hitAt], s = this.surfaces.get(`p:${hit.page}`);
    this.searchCount.textContent = `${this.hitAt + 1} / ${this.hits.length}`;
    for (const h of this.hits.filter((x) => x.page === hit.page)) {
      s.foundG.append(svgEl("rect", { class: h === hit ? "rd-hit on" : "rd-hit", x: h.box[0] - 1, y: h.box[1] - 1, width: h.box[2] - h.box[0] + 2, height: h.box[3] - h.box[1] + 2 }));
    }
    const scale = s.el.offsetWidth / s.width;
    this.pagesEl.scrollTo({ top: s.el.offsetTop + hit.box[1] * scale - this.pagesEl.clientHeight / 3, behavior: "smooth" });
  }

  buildThumbnails() {
    const buttons = [...this.viewports.keys()].map((n) => el("button", { type: "button", class: "rd-thumb", "data-page": n,
      "aria-label": t("rd.goToPage", { n }), onclick: () => this.scrollToPage(n) }, el("canvas"), el("span", { text: String(n) })));
    this.thumbsEl.replaceChildren(...buttons);
    const observer = new IntersectionObserver(async (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting || entry.target.dataset.done) continue;
        entry.target.dataset.done = "1";
        const n = Number(entry.target.dataset.page), page = await this.pdf.getPage(n);
        const viewport = page.getViewport({ scale: 96 / this.viewports.get(n).width });
        const canvas = entry.target.querySelector("canvas");
        Object.assign(canvas, { width: Math.floor(viewport.width), height: Math.floor(viewport.height) });
        page.render({ canvas, canvasContext: canvas.getContext("2d"), viewport });
      }
    }, { root: this.thumbsEl, rootMargin: "300px" });
    buttons.forEach((b) => observer.observe(b));
  }

  /** Highlights (with the text under them), text boxes and note pages, in page order. */
  async annotationList() {
    const out = [];
    const pages = Object.keys(this.doc.pages).map(Number).sort((a, b) => a - b);
    for (const n of pages) {
      const text = this.pdf ? await this.pageText(n) : [];
      for (const item of this.doc.pages[n]) {
        if (item.type === "text") out.push({ page: n, kind: "text", text: item.text });
        else if (item.type === "highlight") {
          const [x0, y0, x1, y1] = bbox(item);
          const under = text.filter(({ box }) => box[0] < x1 && box[2] > x0 && box[1] < y1 && box[3] > y0).map((i) => i.str).join(" ").trim();
          out.push({ page: n, kind: "highlight", text: under || t("rd.highlightNoText"), colour: item.color });
        }
      }
    }
    this.doc.notes.forEach((items, i) => items.filter((x) => x.type === "text").forEach((x) => out.push({ note: i + 1, kind: "text", text: x.text })));
    return out;
  }

  async renderAnnots() {
    if (this.annotsEl.hidden) return;
    const list = await this.annotationList();
    const lines = list.map((a) => `${a.page ? `p.${a.page}` : t("rd.notePage", { n: a.note })} ${a.kind === "highlight" ? "▍" : "✎"} ${a.text}`);
    const copy = el("button", { type: "button", class: "rd-btn rd-to-note", text: t("rd.toBookmarkNote"),
      onclick: async () => { if (this.onAttachNote && this.paper) this.toast(await this.onAttachNote(this.paper, lines.join("\n"))); } });
    copy.hidden = !this.paper || !list.length;
    this.annotsEl.replaceChildren(el("h3", { text: t("rd.annots") }),
      list.length ? null : el("p", { class: "rd-empty", text: t("rd.annotsEmpty") }),
      el("ol", {}, list.map((a, i) => el("li", { class: `rd-annot ${a.kind}` },
        el("button", { type: "button", onclick: () => (a.page ? this.scrollToPage(a.page) : null) },
          el("b", { text: a.page ? `p.${a.page}` : t("rd.notePage", { n: a.note }) }),
          el("span", { class: "rd-swatch", style: a.colour ? `--c:${safeColour(a.colour)}` : null }),
          el("span", { text: a.text }))))),
      copy);
  }

  // ───────────── saving files ─────────────

  async rasterize(item) {
    const lines = textLines(item), scale = 3;
    const width = item.w, height = Math.max(1, lines.length) * item.size * TEXT_LINE;
    const canvas = el("canvas", { width: Math.ceil(width * scale), height: Math.ceil(height * scale) });
    const ctx = canvas.getContext("2d");
    ctx.scale(scale, scale);
    ctx.fillStyle = safeColour(item.color);
    ctx.font = `${item.size}px NanumSquareRound, sans-serif`;
    ctx.textBaseline = "alphabetic";
    lines.forEach((line, i) => ctx.fillText(line, 0, item.size + i * item.size * TEXT_LINE));
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    return { png: new Uint8Array(await blob.arrayBuffer()), width, height };
  }

  fileName(suffix) {
    const base = (this.doc.title || "document").replace(/\.pdf$/i, "").replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 80) || "document";
    return `${base} ${suffix}.pdf`;
  }

  async savePdf() {
    this.saveMenu.hidden = true;
    if (!this.bytes) return this.toast(t("rd.noPdfToSave"));
    this.finishEditing();
    this.toast(t("rd.saving"));
    try {
      const PDFLib = await import(PDFLIB.href);
      const data = await annotatedPdf(PDFLib, this.bytes, this.doc,
        (n, x, y) => this.viewports.get(n).convertToPdfPoint(x, y), (item) => this.rasterize(item));
      this.toast(await this.saveFile(this.fileName(t("rd.suffixAnnotated")), new Uint8Array(data), "application/pdf"));
    } catch (e) { this.toast(t("rd.saveFailed", { error: e.message })); }
  }

  async saveNotes() {
    this.saveMenu.hidden = true;
    this.finishEditing();
    if (!this.doc.notes.some((items) => items.length)) return this.toast(t("rd.noNotes"));
    try {
      const PDFLib = await import(PDFLIB.href);
      const data = await notesPdf(PDFLib, this.doc, (item) => this.rasterize(item), this.doc.title);
      this.toast(await this.saveFile(this.fileName(t("rd.suffixNotes")), new Uint8Array(data), "application/pdf"));
    } catch (e) { this.toast(t("rd.saveFailed", { error: e.message })); }
  }
}

/**
 * How this app signs in to the library: desktop/main.py's window, or mobile.js's in-app web view.
 * Resolves to true once the PDF came through.
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

function shortId(id) { return String(id).replace(/\/+$/, "").split("/").pop(); }
