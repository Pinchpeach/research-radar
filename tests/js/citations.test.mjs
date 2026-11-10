// Reading Zotero (and other) exports: RIS and BibTeX (frontend/web/core/citations.js).

import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_IMPORT, parseCitations } from "../../frontend/web/core/citations.js";

test("BibTeX: nested braces, quotes, bare numbers, accents and DOIs from links", () => {
  const bib = String.raw`@comment{ignore me}
@article{lovelace1843,
  title = {Notes on the {Analytical} Engine},
  author = {Lovelace, Ada and Babbage, Charles},
  year = {1843},
  journal = "Scientific Memoirs",
  doi = {https://doi.org/10.1000/xyz123},
  keywords = {history, computing}
}
@inproceedings{k2, title={Graph Attention Networks}, author={Veli{\v{c}}kovi{\'c}, Petar}, booktitle={ICLR}, year=2018,
  url={https://doi.org/10.48550/arXiv.1710.10903}}`;
  const [a, b] = parseCitations(bib);
  assert.deepEqual(a, {
    doi: "10.1000/xyz123",
    title: "Notes on the Analytical Engine",
    year: 1843,
    authors: ["Lovelace, Ada", "Babbage, Charles"],
    venue: "Scientific Memoirs",
    tags: ["history", "computing"],
    note: "",
    url: null,
  });
  assert.equal(b.title, "Graph Attention Networks");
  assert.deepEqual(b.authors, ["Velickovic, Petar"]);
  assert.equal(b.year, 2018);
  assert.equal(b.venue, "ICLR");
  assert.equal(b.doi, "10.48550/arXiv.1710.10903");
});

test("RIS: tags, dates, a DOI given as a link, and entries without one", () => {
  const ris = [
    "TY  - JOUR",
    "TI  - Attention is all you need",
    "AU  - Vaswani, Ashish",
    "AU  - Shazeer, Noam",
    "PY  - 2017/12/06",
    "T2  - NeurIPS",
    "DO  - https://doi.org/10.48550/arXiv.1706.03762",
    "KW  - transformers",
    "N1  - must read",
    "ER  - ",
    "",
    "TY  - BOOK",
    "TI  - No doi here",
    "PY  - 2001",
    "ER  - ",
  ].join("\r\n");
  const [a, b] = parseCitations(ris);
  assert.deepEqual(a, {
    doi: "10.48550/arXiv.1706.03762",
    title: "Attention is all you need",
    year: 2017,
    authors: ["Vaswani, Ashish", "Shazeer, Noam"],
    venue: "NeurIPS",
    tags: ["transformers"],
    note: "must read",
    url: null,
  });
  assert.deepEqual([b.title, b.doi, b.year], ["No doi here", null, 2001]);
});

test("nothing usable is dropped, and imports are capped", () => {
  assert.deepEqual(parseCitations("not a library"), []);
  assert.deepEqual(parseCitations("@misc{x, note = {only a note}}"), []);
  const many = Array.from({ length: MAX_IMPORT + 5 }, (_, i) => `@article{k${i}, title = {Paper ${i}}}`).join("\n");
  assert.equal(parseCitations(many).length, MAX_IMPORT);
});
