// Side panels: finding text in the PDF, page thumbnails, and the list of highlights and notes.

import { el, svgEl } from "./dom.js";
import { bbox, safeColour } from "./ink.js";
import { pdfjsLib } from "./opening.js";

export const panels = {
  toggleSearch(show = this.searchBar.hidden) {
    if (!this.pdf) return;
    this.searchBar.hidden = !show;
    this.root.querySelector(".rd-find").classList.toggle("on", show);
    if (show) this.searchInput.focus();
    else for (const s of this.surfaces.values()) s.foundG.replaceChildren();
  },

  /** Text items of a page with their boxes in page units. */
  async pageText(n) {
    if (!this.textCache.has(n)) {
      const page = await this.pdf.getPage(n),
        vp = this.viewports.get(n);
      const content = await page.getTextContent();
      this.textCache.set(
        n,
        content.items
          .filter((i) => i.str && i.str.trim())
          .map((i) => {
            const tx = pdfjsLib.Util.transform(vp.transform, i.transform),
              h = Math.hypot(tx[2], tx[3]);
            return { str: i.str, box: [tx[4], tx[5] - h, tx[4] + i.width * vp.scale, tx[5]] };
          }),
      );
    }
    return this.textCache.get(n);
  },

  async search(query, direction) {
    query = query.trim().toLowerCase();
    if (!query) return;
    if (this.searchQuery !== query) {
      this.searchQuery = query;
      this.hits = [];
      this.hitAt = -1;
      for (let n = 1; n <= this.pdf.numPages; n++) {
        for (const item of await this.pageText(n))
          if (item.str.toLowerCase().includes(query)) this.hits.push({ page: n, box: item.box });
      }
    }
    for (const s of this.surfaces.values()) s.foundG.replaceChildren();
    if (!this.hits.length) {
      this.searchCount.textContent = t("rd.noMatches");
      return;
    }
    this.hitAt = (this.hitAt + direction + this.hits.length) % this.hits.length;
    const hit = this.hits[this.hitAt],
      s = this.surfaces.get(`p:${hit.page}`);
    this.searchCount.textContent = `${this.hitAt + 1} / ${this.hits.length}`;
    for (const h of this.hits.filter((x) => x.page === hit.page)) {
      s.foundG.append(
        svgEl("rect", {
          class: h === hit ? "rd-hit on" : "rd-hit",
          x: h.box[0] - 1,
          y: h.box[1] - 1,
          width: h.box[2] - h.box[0] + 2,
          height: h.box[3] - h.box[1] + 2,
        }),
      );
    }
    const scale = s.el.offsetWidth / s.width;
    this.pagesEl.scrollTo({
      top: s.el.offsetTop + hit.box[1] * scale - this.pagesEl.clientHeight / 3,
      behavior: "smooth",
    });
  },

  buildThumbnails() {
    const buttons = [...this.viewports.keys()].map((n) =>
      el(
        "button",
        {
          type: "button",
          class: "rd-thumb",
          "data-page": n,
          "aria-label": t("rd.goToPage", { n }),
          onclick: () => this.scrollToPage(n),
        },
        el("canvas"),
        el("span", { text: String(n) }),
      ),
    );
    this.thumbsEl.replaceChildren(...buttons);
    const observer = new IntersectionObserver(
      async (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting || entry.target.dataset.done) continue;
          entry.target.dataset.done = "1";
          const n = Number(entry.target.dataset.page),
            page = await this.pdf.getPage(n);
          const viewport = page.getViewport({ scale: 96 / this.viewports.get(n).width });
          const canvas = entry.target.querySelector("canvas");
          Object.assign(canvas, { width: Math.floor(viewport.width), height: Math.floor(viewport.height) });
          page.render({ canvas, canvasContext: canvas.getContext("2d"), viewport });
        }
      },
      { root: this.thumbsEl, rootMargin: "300px" },
    );
    buttons.forEach((b) => observer.observe(b));
  },

  /** Highlights (with the text under them), text boxes and note pages, in page order. */
  async annotationList() {
    const out = [];
    const pages = Object.keys(this.doc.pages)
      .map(Number)
      .sort((a, b) => a - b);
    for (const n of pages) {
      const text = this.pdf ? await this.pageText(n) : [];
      for (const item of this.doc.pages[n]) {
        if (item.type === "text") out.push({ page: n, kind: "text", text: item.text });
        else if (item.type === "highlight") {
          const [x0, y0, x1, y1] = bbox(item);
          const under = text
            .filter(({ box }) => box[0] < x1 && box[2] > x0 && box[1] < y1 && box[3] > y0)
            .map((i) => i.str)
            .join(" ")
            .trim();
          out.push({ page: n, kind: "highlight", text: under || t("rd.highlightNoText"), colour: item.color });
        }
      }
    }
    this.doc.notes.forEach((items, i) =>
      items.filter((x) => x.type === "text").forEach((x) => out.push({ note: i + 1, kind: "text", text: x.text })),
    );
    return out;
  },

  async renderAnnots() {
    if (this.annotsEl.hidden) return;
    const list = await this.annotationList();
    const lines = list.map(
      (a) =>
        `${a.page ? `p.${a.page}` : t("rd.notePage", { n: a.note })} ${a.kind === "highlight" ? "▍" : "✎"} ${a.text}`,
    );
    const copy = el("button", {
      type: "button",
      class: "rd-btn rd-to-note",
      text: t("rd.toBookmarkNote"),
      onclick: async () => {
        if (this.onAttachNote && this.paper) this.toast(await this.onAttachNote(this.paper, lines.join("\n")));
      },
    });
    copy.hidden = !this.paper || !list.length;
    this.annotsEl.replaceChildren(
      el("h3", { text: t("rd.annots") }),
      list.length ? null : el("p", { class: "rd-empty", text: t("rd.annotsEmpty") }),
      el(
        "ol",
        {},
        list.map((a, i) =>
          el(
            "li",
            { class: `rd-annot ${a.kind}` },
            el(
              "button",
              { type: "button", onclick: () => (a.page ? this.scrollToPage(a.page) : null) },
              el("b", { text: a.page ? `p.${a.page}` : t("rd.notePage", { n: a.note }) }),
              el("span", { class: "rd-swatch", style: a.colour ? `--c:${safeColour(a.colour)}` : null }),
              el("span", { text: a.text }),
            ),
          ),
        ),
      ),
      copy,
    );
  },
};
