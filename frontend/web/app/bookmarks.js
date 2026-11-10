// Bookmarks: the list with notes, tags and reading status, and moving them in and out of
// Zotero and other reference managers (RIS / BibTeX).

import { api, saveFile } from "./api.js";
import { paperCard } from "./cards.js";
import { $, el, setStatus } from "./dom.js";
import { onPage } from "./nav.js";
import { renderReading } from "./reading.js";
import { shortId, state } from "./state.js";

const STATUSES = ["to_read", "reading", "read"];

export const isBookmarked = (id) => state.bookmarks.some((b) => b.id === shortId(id));
export const bookmarkOf = (paper) => state.bookmarks.find((b) => b.id === shortId(paper.id));

/** Read the bookmarks again, and redraw the pages that show them. */
export async function loadBookmarks() {
  try {
    state.bookmarks = await api("GET", "/bookmarks");
  } catch {
    state.bookmarks = [];
  }
  $("bm-count").textContent = state.bookmarks.length ? `(${state.bookmarks.length})` : "";
  $("bookmark-seeds").disabled = !state.bookmarks.length;
  if (!$("tab-bookmarks").hidden) renderBookmarks();
  if (!$("tab-reading").hidden) renderReading();
}

/** 읽을 것 · 읽는 중 · 읽음 buttons for a bookmark; `done` runs after a change is saved. */
export function statusControl(bookmark, done) {
  const group = el("div", { class: "status-control", role: "group", "aria-label": t("bm.status") });
  const enable = (on) => group.querySelectorAll("button").forEach((b) => (b.disabled = !on));
  for (const status of STATUSES) {
    const button = el("button", {
      type: "button",
      "data-status": status,
      text: t(`status.${status}`),
      class: bookmark.status === status ? "on" : null,
      "aria-pressed": String(bookmark.status === status),
    });
    button.addEventListener("click", async () => {
      if (bookmark.status === status) return;
      enable(false);
      try {
        await api("PATCH", `/bookmarks/${bookmark.id}`, { status });
        await loadBookmarks();
        done();
      } catch (e) {
        alert(t("bm.saveFailed", { error: e.message }));
        enable(true);
      }
    });
    group.append(button);
  }
  return group;
}

export function renderBookmarks() {
  const select = $("tag-filter");
  const current = select.value;
  const tags = [...new Set(state.bookmarks.flatMap((b) => b.tags))].sort();
  select.replaceChildren(
    el("option", { value: "", text: t("bm.all") }),
    ...tags.map((tag) => el("option", { value: tag, text: tag })),
  );
  select.value = tags.includes(current) ? current : "";

  const status = $("status-filter").value;
  const shown = state.bookmarks.filter(
    (b) => (!select.value || b.tags.includes(select.value)) && (!status || b.status === status),
  );
  $("bm-empty").hidden = state.bookmarks.length > 0;
  $("bookmarks").replaceChildren(...shown.map(bookmarkCard));
}

function bookmarkCard(bookmark) {
  const note = el("textarea", { rows: 2, placeholder: t("bm.note") });
  note.value = bookmark.note;
  const tagInput = el("input", { type: "text", placeholder: t("bm.tags") });
  tagInput.value = bookmark.tags.join(", ");
  const save = el("button", { text: t("bm.save") });
  save.addEventListener("click", async () => {
    save.disabled = true;
    try {
      const tags = tagInput.value
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean);
      await api("PATCH", `/bookmarks/${bookmark.id}`, { note: note.value, tags });
      await loadBookmarks();
      renderBookmarks();
    } catch (e) {
      alert(t("bm.saveFailed", { error: e.message }));
    } finally {
      save.disabled = false;
    }
  });
  const remove = el("button", {
    class: "danger",
    text: t("bm.delete"),
    onclick: async () => {
      if (!confirm(t("bm.deleteConfirm", { title: bookmark.paper.title }))) return;
      await api("DELETE", `/bookmarks/${bookmark.id}`);
      await loadBookmarks();
      renderBookmarks();
    },
  });
  const edit = el("div", { class: "bm-edit" }, note, tagInput, el("div", { class: "buttons" }, save, remove));
  const card = paperCard(bookmark.paper, { query: bookmark.query, extra: edit });
  card.querySelector(".paper-actions").prepend(statusControl(bookmark, renderBookmarks));
  if (bookmark.query)
    card
      .querySelector(".meta")
      .append(el("span", { class: "found-via", text: t("bm.foundVia", { query: bookmark.query }) }));
  return card;
}

/** Save the bookmarks (of the chosen tag) as RIS or BibTeX. */
async function exportBookmarks(format, mime) {
  const tag = $("tag-filter").value;
  try {
    const text = await api("GET", `/bookmarks/export.${format}${tag ? `?tag=${encodeURIComponent(tag)}` : ""}`);
    if (!text.trim()) return alert(t("bm.nothing"));
    alert(await saveFile(`research-radar.${format}`, text, mime));
  } catch (e) {
    alert(t("bm.exportFailed", { error: e.message }));
  }
}

/** A Zotero (or Mendeley, EndNote, Papers) export: each reference found on OpenAlex and bookmarked. */
async function importReferences(file) {
  const { parseCitations } = await import("../core/citations.js");
  const entries = parseCitations(await file.text());
  if (!entries.length) return setStatus("bm-status", t("bm.importNone", { name: file.name }), true);
  setStatus("bm-status", t("bm.importing", { n: entries.length }));
  try {
    const done = await api("POST", "/bookmarks/import", { entries });
    await loadBookmarks();
    renderBookmarks();
    const missing = done.not_found.length
      ? t("bm.importMissing", { n: done.not_found.length, titles: done.not_found.slice(0, 3).join("; ") })
      : "";
    setStatus("bm-status", t("bm.imported", { imported: done.imported, existing: done.existing }) + missing);
  } catch (e) {
    setStatus("bm-status", t("bm.importFailed", { error: e.message }), true);
  }
}

onPage("bookmarks", renderBookmarks);
$("tag-filter").addEventListener("change", renderBookmarks);
$("status-filter").addEventListener("change", renderBookmarks);
$("export-ris").addEventListener("click", () => exportBookmarks("ris", "application/x-research-info-systems"));
$("export-bib").addEventListener("click", () => exportBookmarks("bib", "application/x-bibtex"));
$("import-refs").addEventListener("change", (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (file) importReferences(file);
});
