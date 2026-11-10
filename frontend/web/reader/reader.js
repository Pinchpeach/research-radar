// The PDF reader with handwriting. The app loads it on demand: openReader({ ... }).
//
// Each PDF page (and each blank note page) is a "surface": the page image (pdf.js) with an SVG
// on top that holds the handwriting. Handwriting is stored per document through the app's API
// (/annotations/<id>) in page units, so it stays sharp at any zoom and maps straight into the
// PDF when saved (export.js).
//
// The Reader is one class, written in parts:
//   reader.js     tools, pages, note pages, drawing and undo, saving the note
//   opening.js    getting the PDF and the note         frame.js      the toolbar and panels
//   input.js      pen, finger and mouse                selection.js  the lasso and text boxes
//   panels.js     search, thumbnails, highlights       saving.js     saving PDF files

import { clone, el, svgEl } from "./dom.js";
import { NOTE_PAGE } from "./export.js";
import { frame } from "./frame.js";
import {
  HIGHLIGHT_OPACITY,
  linePath,
  PEN_TYPES,
  polygonPath,
  safeColour,
  strokeOutline,
  TEXT_LINE,
  textLines,
} from "./ink.js";
import { input } from "./input.js";
import { opening } from "./opening.js";
import { panels } from "./panels.js";
import { saving } from "./saving.js";
import { selection } from "./selection.js";

const PEN_COLOURS = ["#1b1b1a", "#e5484d", "#2a78d6", "#1a7f4b", "#c98500", "#8e4ec6"];
const HIGHLIGHT_COLOURS = ["#ffd400", "#7ee081", "#ff8fb1", "#8ecbff"];
const SIZES = { pen: [0.8, 6, 1.6], highlighter: [6, 28, 12], text: [8, 32, 12] }; // min, max, default
const ERASER_MODES = ["area", "stroke", "highlight"]; // part of a stroke, whole strokes, highlighter only
const MAX_UNDO = 200;

/**
 * Open the reader.
 *   paper     the paper it belongs to (id, title, open_access_url), if any
 *   url       an http(s) PDF to fetch, or
 *   file      a File the person picked, or
 *   pdfBytes  a PDF already fetched (the library's sign-in screen on Android)
 *   docId     a document opened again from the reading list
 *   api       the app's api(method, path, body)
 *   saveFile  the app's saveFile(name, content, mime)
 *   onOpened(paper), onFinished(paper)   reading-record hooks
 */
let current = null; // one reader at a time: a PDF handed to the app replaces the one waiting for it
export async function openReader(options) {
  if (current && current.root && current.root.isConnected) current.close(false);
  const reader = (current = new Reader(options));
  await reader.start();
  return reader;
}

class Reader {
  constructor({
    paper = null,
    url = null,
    file = null,
    pdfBytes = null,
    docId = null,
    libraryOnly = false,
    api,
    saveFile,
    onOpened,
    onFinished,
    onAttachNote,
    onClose,
  }) {
    Object.assign(this, {
      paper,
      url,
      file,
      pdfBytes,
      libraryOnly,
      api,
      saveFile,
      onOpened,
      onFinished,
      onAttachNote,
      onClose,
    });
    this.givenId = docId; // a document opened again from the reading list
    this.tool = "pen";
    this.colours = { pen: PEN_COLOURS[0], highlighter: HIGHLIGHT_COLOURS[0], text: PEN_COLOURS[0] };
    this.sizes = { pen: SIZES.pen[2], highlighter: SIZES.highlighter[2], text: SIZES.text[2] };
    this.penOnly = false;
    this.penOnlyChosen = false;
    this.penType = "fountain";
    this.eraserMode = "area";
    this.straightHighlight = false;
    this.zoom = 1;
    this.undo = [];
    this.redo = [];
    this.selection = null;
    this.surfaces = new Map();
    this.viewports = new Map();
    this.textCache = new Map();
    this.doc = null;
    this.docId = null;
    this.bytes = null;
    this.pdf = null;
    this.finished = false;
    this.saveTimer = null;
    this.touches = new Map();
  }

  // ───────────── tools ─────────────

  setTool(name) {
    this.finishEditing();
    if (name !== "select") this.select(null);
    this.tool = name;
    this.root.dataset.tool = name;
    this.root.querySelectorAll(".rd-tool").forEach((b) => b.classList.toggle("on", b.dataset.tool === name));
    const kind = this.kind;
    const palette = kind === "highlighter" ? HIGHLIGHT_COLOURS : PEN_COLOURS;
    this.colourRow.replaceChildren(
      ...palette.map((c) =>
        el("button", {
          type: "button",
          class: "rd-colour",
          style: `--c:${c}`,
          "data-colour": c,
          title: c,
          "aria-label": c,
          onclick: () => this.setColour(c),
        }),
      ),
    );
    const [min, max] = SIZES[kind];
    Object.assign(this.sizeInput, { min, max, step: kind === "pen" ? 0.2 : 1, value: this.sizes[kind] });
    this.showColour(kind);
    this.showOptions();
  }

  /** The current tool's own choices, as the note apps have them: pen types, eraser modes, a straight highlighter. */
  showOptions() {
    const choice = (value, current, label, set) =>
      el("button", {
        type: "button",
        class: `rd-opt${value === current ? " on" : ""}`,
        "data-opt": value,
        text: label,
        onclick: () => {
          set(value);
          this.showOptions();
        },
      });
    let options = [];
    if (this.tool === "pen")
      options = PEN_TYPES.map((p) => choice(p, this.penType, t(`rd.pen_${p}`), (v) => (this.penType = v)));
    else if (this.tool === "eraser")
      options = ERASER_MODES.map((m) => choice(m, this.eraserMode, t(`rd.erase_${m}`), (v) => (this.eraserMode = v)));
    else if (this.tool === "highlighter") {
      options = [
        choice(
          "straight",
          this.straightHighlight ? "straight" : "",
          t("rd.straight"),
          () => (this.straightHighlight = !this.straightHighlight),
        ),
      ];
    }
    this.optionsRow.replaceChildren(...options);
    this.optionsRow.hidden = !options.length;
  }

  get kind() {
    return this.tool === "highlighter" ? "highlighter" : this.tool === "text" ? "text" : "pen";
  }

  showColour(kind = this.kind) {
    this.root
      .querySelectorAll(".rd-colour")
      .forEach((b) => b.classList.toggle("on", b.dataset.colour === this.colours[kind]));
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
    this.root
      .querySelector(panel === this.thumbsEl ? ".rd-thumbs-btn" : ".rd-annots-btn")
      .classList.toggle("on", !panel.hidden);
  }

  toggleNotes(show = this.notesEl.hidden) {
    this.notesEl.hidden = !show;
    this.root.classList.toggle("notes-open", show);
    this.root.querySelector(".rd-notes-btn").classList.toggle("on", show);
    if (show && !this.doc.notes.length) {
      this.doc.notes.push([]); // a first page to write on: not a change to undo or save
      this.renderNotes();
    }
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
        this.pagesEl.replaceChildren(
          ...[...this.viewports.keys()].map((n) => this.makeSurface(`p:${n}`, this.viewports.get(n)).el),
        );
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
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const s = this.surfaces.get(entry.target.dataset.key);
          if (!s) continue;
          s.visible = entry.isIntersecting;
          if (s.visible && (!s.renderedAt || s.stale)) this.renderPage(s);
        }
      },
      { root: this.pagesEl, rootMargin: "600px 0px" },
    );
    for (const [key, s] of this.surfaces) if (key.startsWith("p:")) this.observer.observe(s.el);
  }

  renderVisible() {
    for (const s of this.surfaces.values()) if (s.visible && s.page && (s.stale || !s.renderedAt)) this.renderPage(s);
  }

  async renderPage(s) {
    if (s.rendering) {
      s.again = true;
      return;
    }
    s.rendering = true;
    try {
      const page = await this.pdf.getPage(s.page);
      const width = parseFloat(s.el.style.width);
      const scale = (width / s.width) * Math.min(window.devicePixelRatio || 1, 2.5);
      const viewport = page.getViewport({ scale });
      const canvas = el("canvas", {
        class: "rd-canvas",
        width: Math.floor(viewport.width),
        height: Math.floor(viewport.height),
      });
      await page.render({ canvas, canvasContext: canvas.getContext("2d"), viewport }).promise;
      s.canvas.replaceWith(canvas);
      s.canvas = canvas;
      s.renderedAt = width;
      s.stale = false;
    } catch {
      /* closed while rendering */
    }
    s.rendering = false;
    if (s.again) {
      s.again = false;
      if (s.stale) this.renderPage(s);
    }
  }

  makeSurface(key, { width, height }) {
    const svg = svgEl("svg", { class: "rd-ink", viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "none" });
    const items = svgEl("g", { class: "rd-items" }),
      live = svgEl("g", { class: "rd-live" }),
      found = svgEl("g", { class: "rd-found" });
    svg.append(found, items, live);
    const canvas = el("canvas", { class: "rd-canvas" });
    const page = key.startsWith("p:") ? Number(key.slice(2)) : null;
    const wrapper = el(
      "div",
      { class: page ? "rd-page" : "rd-page rd-note", "data-key": key, "data-page": page ?? "" },
      page ? canvas : null,
      svg,
      el("span", { class: "rd-page-no", text: page ? String(page) : "" }),
    );
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
      if (items.length) this.doc.pages[key.slice(2)] = items;
      else delete this.doc.pages[key.slice(2)];
    } else this.doc.notes[Number(key.slice(2))] = items;
  }

  // ───────────── note pages ─────────────

  renderNotes() {
    for (const key of [...this.surfaces.keys()]) if (key.startsWith("n:")) this.surfaces.delete(key);
    const pages = this.doc.notes.map(
      (_, i) => this.makeSurface(`n:${i}`, { width: NOTE_PAGE[0], height: NOTE_PAGE[1] }).el,
    );
    pages.forEach((p, i) => (p.querySelector(".rd-page-no").textContent = t("rd.notePage", { n: i + 1 })));
    this.notesEl.replaceChildren(
      ...pages,
      el("button", { type: "button", class: "rd-add-note", text: t("rd.addNote"), onclick: () => this.addNotePage() }),
    );
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

  addNotePage() {
    this.record("notes", () => this.doc.notes.push([]));
    this.renderNotes();
    this.notesEl.lastElementChild.previousElementSibling.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ───────────── drawing items ─────────────

  drawSurface(s) {
    s.itemsG.replaceChildren(...this.itemsOf(s.key).map((item) => this.itemNode(item)));
    this.drawSelection();
  }

  itemNode(item) {
    const colour = safeColour(item.color);
    let node;
    if (item.type === "ink")
      node = svgEl("path", { d: polygonPath(strokeOutline(item.points, item.width, item.pen)), fill: colour });
    else if (item.type === "highlight") {
      node = svgEl("path", {
        d: linePath(item.points),
        fill: "none",
        stroke: colour,
        "stroke-width": item.width,
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
        opacity: HIGHLIGHT_OPACITY,
        class: "rd-hl",
      });
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
    this.remember({ key, before, after });
  }

  remember(step) {
    this.undo.push(step);
    if (this.undo.length > MAX_UNDO) this.undo.shift();
    this.redo = [];
    this.changed();
  }

  applyState(key, items) {
    if (key === "notes") {
      this.doc.notes = clone(items);
      this.renderNotes();
    } else {
      this.setItems(key, clone(items));
      const s = this.surfaces.get(key);
      if (s) this.drawSurface(s);
    }
    this.changed();
  }

  doUndo() {
    this.finishEditing();
    const op = this.undo.pop();
    if (op) {
      this.redo.push(op);
      this.select(null);
      this.applyState(op.key, op.before);
    }
  }
  doRedo() {
    this.finishEditing();
    const op = this.redo.pop();
    if (op) {
      this.undo.push(op);
      this.select(null);
      this.applyState(op.key, op.after);
    }
  }

  changed() {
    this.root.querySelector(".rd-undo").disabled = !this.undo.length;
    this.root.querySelector(".rd-redo").disabled = !this.redo.length;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 700);
  }

  /** Something to come back to: a PDF, or anything written. (An empty note page or a paper that wouldn't open is not.) */
  worthSaving() {
    const written = [...Object.values(this.doc.pages), ...this.doc.notes].some((items) => items.length);
    return this.saved || Boolean(this.pdf) || written;
  }

  async flush() {
    clearTimeout(this.saveTimer);
    if (!this.doc || !this.worthSaving()) return;
    try {
      await this.api("PUT", `/annotations/${encodeURIComponent(this.docId)}`, this.doc);
      this.saved = true;
      this.root.classList.remove("unsaved");
    } catch (e) {
      this.root.classList.add("unsaved");
      this.toast(t("rd.saveFailed", { error: e.message }));
    }
  }
}

Object.assign(Reader.prototype, opening, frame, input, selection, panels, saving);
