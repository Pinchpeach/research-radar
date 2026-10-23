// Saving handwriting with pdf-lib: into the original PDF (merged), or the note pages on their own.

import { HIGHLIGHT_OPACITY, linePath, polygonPath, safeColour, strokeOutline } from "./ink.js";

export const NOTE_PAGE = [595, 842]; // A4, in points

const rgbOf = (PDFLib, hex) => {
  let h = safeColour(hex).slice(1);
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  return PDFLib.rgb(parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255);
};

/**
 * Draw `items` on a pdf-lib page. `toPdf(x, y)` maps page units (top-left, y down) to the page's
 * PDF coordinates (bottom-left, y up). `rasterize(item)` turns a text box into
 * { png: Uint8Array, width, height } in page units: an image keeps every script (Hangul included)
 * without embedding a font.
 */
async function drawItems(PDFLib, pdf, page, items, toPdf, rasterize) {
  const flipped = (pts) => pts.map(([x, y]) => toPdf(x, y));
  for (const item of items) {
    if (item.type === "ink") {
      const path = polygonPath(flipped(strokeOutline(item.points, item.width)), true);
      page.drawSvgPath(path, { x: 0, y: 0, color: rgbOf(PDFLib, item.color), borderWidth: 0 });
    } else if (item.type === "highlight") {
      page.drawSvgPath(linePath(flipped(item.points), true), {
        x: 0, y: 0, borderColor: rgbOf(PDFLib, item.color), borderWidth: item.width, borderOpacity: HIGHLIGHT_OPACITY,
        borderLineCap: PDFLib.LineCapStyle.Round, blendMode: PDFLib.BlendMode.Multiply,
      });
    } else if (item.type === "text" && String(item.text || "").trim()) {
      const { png, width, height } = await rasterize(item);
      const image = await pdf.embedPng(png);
      const [x, y] = toPdf(item.x, item.y + height);
      page.drawImage(image, { x, y, width, height });
    }
  }
}

/** The original PDF with the handwriting drawn on its pages. `toPdf(pageNumber, x, y)`. */
export async function annotatedPdf(PDFLib, bytes, doc, toPdf, rasterize) {
  const pdf = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
  const pages = pdf.getPages();
  for (const [number, items] of Object.entries(doc.pages || {})) {
    const page = pages[Number(number) - 1];
    if (page && items.length) await drawItems(PDFLib, pdf, page, items, (x, y) => toPdf(Number(number), x, y), rasterize);
  }
  return pdf.save();
}

/** The note pages as a PDF of their own. */
export async function notesPdf(PDFLib, doc, rasterize, title = "Notes") {
  const pdf = await PDFLib.PDFDocument.create();
  pdf.setTitle(title);
  for (const items of doc.notes || []) {
    const page = pdf.addPage(NOTE_PAGE);
    await drawItems(PDFLib, pdf, page, items, (x, y) => [x, NOTE_PAGE[1] - y], rasterize);
  }
  return pdf.save();
}
