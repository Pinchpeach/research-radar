// Saving files: the PDF with the handwriting merged into it, or the note pages on their own.

import { el } from "./dom.js";
import { annotatedPdf, notesPdf } from "./export.js";
import { safeColour, TEXT_LINE, textLines } from "./ink.js";

const PDFLIB = new URL("../vendor/pdf-lib/pdf-lib.esm.min.js", import.meta.url);

export const saving = {
  async rasterize(item) {
    const lines = textLines(item),
      scale = 3;
    const width = item.w,
      height = Math.max(1, lines.length) * item.size * TEXT_LINE;
    const canvas = el("canvas", { width: Math.ceil(width * scale), height: Math.ceil(height * scale) });
    const ctx = canvas.getContext("2d");
    ctx.scale(scale, scale);
    ctx.fillStyle = safeColour(item.color);
    ctx.font = `${item.size}px NanumSquareRound, sans-serif`;
    ctx.textBaseline = "alphabetic";
    lines.forEach((line, i) => ctx.fillText(line, 0, item.size + i * item.size * TEXT_LINE));
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    return { png: new Uint8Array(await blob.arrayBuffer()), width, height };
  },

  fileName(suffix) {
    const base =
      (this.doc.title || "document")
        .replace(/\.pdf$/i, "")
        .replace(/[\\/:*?"<>|]+/g, " ")
        .trim()
        .slice(0, 80) || "document";
    return `${base} ${suffix}.pdf`;
  },

  async savePdf() {
    this.saveMenu.hidden = true;
    if (!this.bytes) return this.toast(t("rd.noPdfToSave"));
    this.finishEditing();
    this.toast(t("rd.saving"));
    try {
      const PDFLib = await import(PDFLIB.href);
      const data = await annotatedPdf(
        PDFLib,
        this.bytes,
        this.doc,
        (n, x, y) => this.viewports.get(n).convertToPdfPoint(x, y),
        (item) => this.rasterize(item),
      );
      this.toast(await this.saveFile(this.fileName(t("rd.suffixAnnotated")), new Uint8Array(data), "application/pdf"));
    } catch (e) {
      this.toast(t("rd.saveFailed", { error: e.message }));
    }
  },

  async saveNotes() {
    this.saveMenu.hidden = true;
    this.finishEditing();
    if (!this.doc.notes.some((items) => items.length)) return this.toast(t("rd.noNotes"));
    try {
      const PDFLib = await import(PDFLIB.href);
      const data = await notesPdf(PDFLib, this.doc, (item) => this.rasterize(item), this.doc.title);
      this.toast(await this.saveFile(this.fileName(t("rd.suffixNotes")), new Uint8Array(data), "application/pdf"));
    } catch (e) {
      this.toast(t("rd.saveFailed", { error: e.message }));
    }
  },
};
