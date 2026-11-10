// The reader's frame: the toolbar rows, the page column and the side panels; closing it.

import { el, svgEl } from "./dom.js";

export const frame = {
  build() {
    const tool = (name, label, icon) =>
      el(
        "button",
        {
          type: "button",
          class: "rd-tool",
          "data-tool": name,
          title: label,
          "aria-label": label,
          onclick: () => this.setTool(name),
        },
        icon,
      );
    this.colourRow = el("div", { class: "rd-colours" });
    this.optionsRow = el("div", { class: "rd-options" }); // the tool's own choices: pen type, eraser mode, straight highlighter
    this.sizeInput = el("input", {
      type: "range",
      class: "rd-size",
      "aria-label": t("rd.size"),
      oninput: () => this.setSize(Number(this.sizeInput.value)),
    });
    this.customColour = el("input", {
      type: "color",
      class: "rd-custom",
      title: t("rd.customColour"),
      "aria-label": t("rd.customColour"),
      oninput: () => this.setColour(this.customColour.value),
    });
    const action = (cls, label, icon, handler) =>
      el(
        "button",
        { type: "button", class: `rd-act ${cls}`, title: label, "aria-label": label, onclick: handler },
        icon,
      );
    this.saveMenu = el(
      "div",
      { class: "rd-menu", hidden: true },
      el("button", { type: "button", class: "rd-save-pdf", text: t("rd.savePdf"), onclick: () => this.savePdf() }),
      el("button", {
        type: "button",
        class: "rd-save-notes",
        text: t("rd.saveNotes"),
        onclick: () => this.saveNotes(),
      }),
    );
    this.searchInput = el("input", {
      type: "search",
      class: "rd-search-input",
      placeholder: t("rd.searchPlaceholder"),
      enterkeyhint: "search",
    });
    this.searchCount = el("span", { class: "rd-search-count" });
    this.searchBar = el(
      "form",
      {
        class: "rd-searchbar",
        hidden: true,
        onsubmit: (e) => {
          e.preventDefault();
          this.search(this.searchInput.value, 1);
        },
      },
      this.searchInput,
      this.searchCount,
      el("button", {
        type: "button",
        text: "↑",
        "aria-label": t("rd.prev"),
        onclick: () => this.search(this.searchInput.value, -1),
      }),
      el("button", { type: "submit", text: "↓", "aria-label": t("rd.next") }),
    );
    this.titleEl = el("span", { class: "rd-title" });
    this.pagesEl = el("div", { class: "rd-pages", tabindex: "0" });
    this.notesEl = el("div", { class: "rd-notes", hidden: true });
    this.thumbsEl = el("aside", { class: "rd-thumbs", hidden: true });
    this.annotsEl = el("aside", { class: "rd-annots", hidden: true });
    this.toastEl = el("div", { class: "rd-toast", role: "status" });
    const I = (d) => {
      const s = svgEl("svg", { viewBox: "0 0 24 24", class: "ic", "aria-hidden": "true" });
      s.innerHTML = d;
      return s;
    }; // our own static icons
    this.root = el(
      "section",
      { class: "reader", role: "dialog", "aria-modal": "true", "aria-label": t("rd.reader") },
      el(
        "header",
        { class: "rd-top" },
        el(
          "div",
          { class: "rd-row rd-head" },
          action("rd-close", t("rd.close"), I('<path d="M15 5l-7 7 7 7"/>'), () => this.close()),
          this.titleEl,
          action("rd-undo", t("rd.undo"), I('<path d="M9 7H4v5"/><path d="M4 12a8 8 0 1 0 2.3-5.6L4 9"/>'), () =>
            this.doUndo(),
          ),
          action("rd-redo", t("rd.redo"), I('<path d="M15 7h5v5"/><path d="M20 12a8 8 0 1 1-2.3-5.6L20 9"/>'), () =>
            this.doRedo(),
          ),
          el(
            "div",
            { class: "rd-save-wrap" },
            action(
              "rd-save",
              t("rd.save"),
              I('<path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>'),
              () => (this.saveMenu.hidden = !this.saveMenu.hidden),
            ),
            this.saveMenu,
          ),
        ),
        el(
          "div",
          { class: "rd-row rd-toolbar" },
          tool(
            "hand",
            t("rd.hand"),
            I(
              '<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12"/><path d="M11 11.5v-8a1.5 1.5 0 0 1 3 0V12"/><path d="M14 11.5V5a1.5 1.5 0 0 1 3 0v8"/><path d="M17 9.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-1.5a6 6 0 0 1-4.6-2.2L4.5 14.5a1.5 1.5 0 0 1 2.3-1.9L8 14"/>',
            ),
          ),
          tool("pen", t("rd.pen"), I('<path d="M4 20l4-1 11-11-3-3L5 16z"/><path d="M14 6l3 3"/>')),
          tool(
            "highlighter",
            t("rd.highlighter"),
            I('<path d="M5 19h6"/><path d="m9 15-2-2 8-8 4 4-8 8z"/><path d="m7 13-2 4 4-2"/>'),
          ),
          tool("eraser", t("rd.eraser"), I('<path d="m4 15 9-9 7 7-6 6H8z"/><path d="M9 20h11"/>')),
          tool("text", t("rd.text"), I('<path d="M5 6V4h14v2"/><path d="M12 4v16"/><path d="M9 20h6"/>')),
          tool(
            "select",
            t("rd.select"),
            I('<path d="M4 7V4h3M17 4h3v3M20 17v3h-3M7 20H4v-3"/><path d="m10 9 6 3-3 1-1 3z"/>'),
          ),
          el("span", { class: "rd-sep" }),
          this.optionsRow,
          this.colourRow,
          this.customColour,
          this.sizeInput,
          el("span", { class: "rd-sep" }),
          action(
            "rd-duplicate",
            t("rd.duplicate"),
            I(
              '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
            ),
            () => this.duplicateSelection(),
          ),
          action(
            "rd-delete",
            t("rd.deleteSelection"),
            I('<path d="M5 7h14"/><path d="M10 7V5h4v2"/><path d="M7 7l1 13h8l1-13"/>'),
            () => this.deleteSelection(),
          ),
        ),
        el(
          "div",
          { class: "rd-row rd-views" },
          action("rd-penonly", t("rd.penOnly"), I('<path d="M4 20l4-1 11-11-3-3L5 16z"/><path d="M3 3l18 18"/>'), () =>
            this.setPenOnly(!this.penOnly, true),
          ),
          action(
            "rd-hide",
            t("rd.hide"),
            I('<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
            () => this.toggleHidden(),
          ),
          action("rd-find", t("rd.search"), I('<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>'), () =>
            this.toggleSearch(),
          ),
          action(
            "rd-thumbs-btn",
            t("rd.thumbs"),
            I(
              '<rect x="4" y="4" width="6" height="7"/><rect x="14" y="4" width="6" height="7"/><rect x="4" y="14" width="6" height="7"/><rect x="14" y="14" width="6" height="7"/>',
            ),
            () => this.togglePanel(this.thumbsEl),
          ),
          action("rd-annots-btn", t("rd.annots"), I('<path d="M5 5h14v10H9l-4 4z"/><path d="M8 9h8M8 12h5"/>'), () => {
            this.togglePanel(this.annotsEl);
            this.renderAnnots();
          }),
          action(
            "rd-notes-btn",
            t("rd.notes"),
            I('<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/>'),
            () => this.toggleNotes(),
          ),
          el("span", { class: "rd-spacer" }),
          action("rd-zoom-out", t("rd.zoomOut"), I('<path d="M6 12h12"/>'), () => this.setZoom(this.zoom / 1.25)),
          el("span", { class: "rd-zoom-label" }),
          action("rd-zoom-in", t("rd.zoomIn"), I('<path d="M6 12h12M12 6v12"/>'), () => this.setZoom(this.zoom * 1.25)),
        ),
        this.searchBar,
      ),
      el("div", { class: "rd-body" }, this.thumbsEl, this.pagesEl, this.notesEl, this.annotsEl),
      this.toastEl,
    );
    if (!document.querySelector("link[data-reader-css]")) {
      document.head.append(
        el("link", { rel: "stylesheet", href: new URL("reader.css", import.meta.url).href, "data-reader-css": "" }),
      );
    }
    document.body.append(this.root);
    this.root.querySelector(".rd-undo").disabled = this.root.querySelector(".rd-redo").disabled = true;
    this.titleEl.textContent = (this.paper && this.paper.title) || (this.file && this.file.name) || t("rd.untitled");
    this.setTool("pen");
    this.updateZoomLabel();
    this.pagesEl.addEventListener("scroll", () => this.onScroll(), { passive: true });
    this.pagesEl.addEventListener(
      "wheel",
      (e) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        this.setZoom(this.zoom * Math.exp(-e.deltaY * 0.002), e);
      },
      { passive: false },
    );
    this.keyHandler = (e) => this.onKey(e);
    document.addEventListener("keydown", this.keyHandler);
    window.addEventListener("resize", (this.resizeHandler = () => this.layoutPages()));
  },

  close(notify = true) {
    clearTimeout(this.holdTimer);
    clearTimeout(this.renderTimer);
    // the reading list is read again once the last change is in
    this.flush().finally(() => notify && this.onClose && this.onClose());
    document.removeEventListener("keydown", this.keyHandler);
    window.removeEventListener("resize", this.resizeHandler);
    if (this.observer) this.observer.disconnect();
    if (this.loading) this.loading.destroy().catch(() => {}); // frees the worker and the pages
    this.root.remove();
    document.body.classList.remove("reader-open");
  },

  toast(message) {
    this.toastEl.textContent = message;
    this.toastEl.classList.add("on");
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toastEl.classList.remove("on"), 2600);
  },
};
