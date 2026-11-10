// Opening PDFs and notes in the reader (reader/reader.js, loaded when first used), and the
// list of them on the Reading page. What the reader does to the reading record is here too.

import { api, saveFile } from "./api.js";
import { bookmarkOf, loadBookmarks } from "./bookmarks.js";
import { $, el, localDate } from "./dom.js";
import { currentTab, onPage } from "./nav.js";
import { pick, webUrl } from "./state.js";

let reader = null;
async function openReader(options) {
  reader ??= await import("../reader/reader.js");
  return reader.openReader({
    api,
    saveFile,
    onOpened: readingStarted,
    onFinished: readingFinished,
    onAttachNote: attachToNote,
    onClose: () => {
      loadBookmarks();
      if (currentTab === "reading") renderDocs();
    },
    ...options,
  });
}

/**
 * Open a paper. The reader takes it from there (reader.js start): the note kept for it if there
 * is one, else a free copy, else the person's library, else it asks for the file.
 */
export const readPaper = (paper) => openReader({ paper: pick(paper), url: webUrl(paper.open_access_url) });

// Android: a PDF opened with the app (mobile.js), on the paper it was fetched for, if any.
window.radarOpenFile = (file, paper) => openReader({ paper: paper ? pick(paper) : null, file });

/** The paper's bookmark, made first if there is none. */
const bookmarkFor = async (paper) => bookmarkOf(paper) || api("PUT", "/bookmarks", { paper: pick(paper) });

/** Opening a bookmarked paper that was still "to read" moves it to "reading". */
async function readingStarted(paper) {
  const bookmark = bookmarkOf(paper);
  if (!bookmark || bookmark.status !== "to_read") return;
  try {
    await api("PATCH", `/bookmarks/${bookmark.id}`, { status: "reading" });
    await loadBookmarks();
  } catch {
    /* not important */
  }
}

/** Reaching the end of the PDF marks the paper read (bookmarking it first). Resolves to whether it changed. */
async function readingFinished(paper) {
  try {
    const bookmark = await bookmarkFor(paper);
    if (bookmark.status === "read") return false;
    await api("PATCH", `/bookmarks/${bookmark.id}`, { status: "read" });
    await loadBookmarks();
    return true;
  } catch {
    return false;
  }
}

/** Add the reader's annotation list to the paper's bookmark note. Resolves to a message. */
async function attachToNote(paper, text) {
  try {
    const bookmark = await bookmarkFor(paper);
    const note = [bookmark.note, text].filter((s) => s && s.trim()).join("\n\n");
    await api("PATCH", `/bookmarks/${bookmark.id}`, { note });
    await loadBookmarks();
    return t("rd.attached");
  } catch (e) {
    return t("bm.saveFailed", { error: e.message });
  }
}

/** PDFs and notes with something in them, most recently changed first. */
async function renderDocs() {
  let docs = [];
  try {
    docs = await api("GET", "/annotations");
  } catch {
    /* shown as empty */
  }
  $("docs-empty").hidden = docs.length > 0;
  $("doc-list").replaceChildren(...docs.map(docRow));
}
onPage("reading", renderDocs);

function docRow(doc) {
  const open = el("button", {
    type: "button",
    class: "title link-like",
    text: doc.title || doc.id,
    onclick: () => {
      const paper = doc.paper_id
        ? (bookmarkOf({ id: doc.paper_id }) || {}).paper || {
            id: `https://openalex.org/${doc.paper_id}`,
            title: doc.title,
          }
        : null;
      // a kept PDF opens as it is (reader.js keptPdf); else the paper is looked for again, or the file asked for
      if (paper) openReader({ paper, url: webUrl(doc.source) || null });
      else openReader({ docId: doc.id });
    },
  });
  const remove = el("button", {
    type: "button",
    class: "danger small-button",
    text: t("bm.delete"),
    onclick: async () => {
      if (!confirm(t("read.deleteDoc", { title: doc.title || doc.id }))) return;
      await api("DELETE", `/annotations/${encodeURIComponent(doc.id)}`);
      renderDocs();
    },
  });
  const date = doc.updated_at ? localDate(doc.updated_at) : "";
  const meta = t("read.docMeta", { items: doc.items, notes: doc.note_pages, date });
  return el("li", { class: "read-row" }, open, el("span", { class: "meta", text: meta }), remove);
}

$("open-pdf").addEventListener("change", (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (file) openReader({ file });
});
$("new-notes").addEventListener("click", () => openReader({}));
