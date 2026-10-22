// A small PDF for the reader tests, made with pdf-lib (the version the app bundles in frontend/web/vendor).

import * as PDFLib from "pdf-lib";

export { PDFLib };
const { PDFDocument, StandardFonts } = PDFLib;

export const SAMPLE_TEXT = ["Graph neural networks pass messages along edges.", "Spectral methods use the graph Laplacian.", "Attention weighs each neighbour."];

export async function samplePdf(pages = 3) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const page = pdf.addPage([595, 842]);
    page.drawText(`Page ${i + 1}`, { x: 60, y: 780, size: 20, font });
    page.drawText(SAMPLE_TEXT[i % SAMPLE_TEXT.length], { x: 60, y: 720, size: 14, font });
  }
  return Buffer.from(await pdf.save());
}
