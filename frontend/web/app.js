"use strict";

const $ = (id) => document.getElementById(id);
const PAPER_FIELDS = ["id", "title", "abstract", "year", "doi", "url", "open_access_url", "venue", "authors", "citations",
  "referenced_works", "keywords", "topic"];
const MAX_SEEDS = 10;
const KEY_PAPER = 0.5;  // flow-importance score from which a paper is badged as a key paper

const state = { run: null, bookmarks: [], flow: null, flowRun: null, poster: null, posterTitle: "", evalMode: false, judgments: {},
  version: null, changelog: null };

// ───────────── helpers ─────────────

async function api(method, path, body) {
  // The Android app answers API calls in the page (frontend/web/core) instead of a local server.
  if (window.radarLocalApi) {
    try {
      return await window.radarLocalApi(method, path, body);
    } catch (e) {
      throw new Error(e.status ? e.message : t("err.server"));
    }
  }
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(t("err.server"));
  }
  if (res.status === 204) return null;
  const type = res.headers.get("content-type") || "";
  const data = type.includes("json") ? await res.json() : await res.text();
  if (!res.ok) {
    const detail = data && data.detail;
    throw new Error(typeof detail === "string" ? detail : t("err.request", { status: res.status }));
  }
  return data;
}

/** Build DOM safely: text always goes in as textContent. */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) if (child != null) node.append(child);
  return node;
}

function setStatus(id, message, isError = false) {
  $(id).textContent = message;
  $(id).classList.toggle("error", isError);
}

const shortId = (id) => id.replace(/\/+$/, "").split("/").pop();
/** Only http(s) links are followed: paper links come from publishers, and saved bookmarks may
 * predate the backends' own check. */
const webUrl = (url) => (typeof url === "string" && /^https?:\/\//i.test(url.trim()) ? url.trim() : null);
const pick = (paper) => Object.fromEntries(PAPER_FIELDS.map((k) => [k, paper[k] ?? null]));

function authorLine(authors) {
  if (!authors || !authors.length) return t("paper.noAuthors");
  return authors.slice(0, 5).join(", ") + (authors.length > 5 ? t("paper.etAl") : "");
}

function metaLine(paper) {
  return [paper.year || "—", paper.venue, t("paper.citations", { n: Number(paper.citations || 0).toLocaleString() })]
    .filter(Boolean).join(" · ");
}

/** Bytes as base64, in chunks (a whole PDF at once would overflow the call stack). */
function toBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Save text or bytes (a Uint8Array) to a file: native dialog in the desktop app, the share sheet
 * on Android, a download in a browser. */
window.radarBase64 = toBase64;
async function saveFile(name, content, mime) {
  if (window.radarSaveFile) return window.radarSaveFile(name, content, mime);
  const desktop = window.pywebview && window.pywebview.api;
  if (desktop && desktop.save_file) {
    const saved = content instanceof Uint8Array
      ? await desktop.save_bytes(name, toBase64(content))
      : await desktop.save_file(name, content);
    return saved ? t("file.saved", { path: saved }) : t("file.cancelled");
  }
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const link = el("a", { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return t("file.downloaded", { name });
}

// ───────────── navigation: the ☰ drawer and pages ─────────────

const PAGE_TITLES = { home: "", discover: "tab.discover", bookmarks: "tab.bookmarks", reading: "tab.reading", map: "tab.flow", news: "tab.news", settings: "tab.settings" };
let currentTab = "home";

function setDrawer(open) {
  const drawer = $("drawer");
  drawer.classList.toggle("open", open);
  drawer.toggleAttribute("inert", !open);
  drawer.setAttribute("aria-hidden", String(!open));
  $("drawer-backdrop").hidden = !open;
  $("menu-button").setAttribute("aria-expanded", String(open));
  if (open) drawer.querySelector(`.tab[data-tab=${currentTab}]`)?.focus();
}

function showTab(name) {
  currentTab = name;
  setDrawer(false);
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".panel").forEach((p) => (p.hidden = p.id !== `tab-${name}`));
  document.body.dataset.page = name;
  $("page-title").textContent = PAGE_TITLES[name] ? t(PAGE_TITLES[name]) : "";
  window.scrollTo(0, 0);
  if (name === "home") renderHome();
  if (name === "bookmarks") renderBookmarks();
  if (name === "map") autoDrawFlow();
  if (name === "news") renderNews();
  if (name === "reading") { renderReading(); renderDocs(); }
}
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab)));
$("menu-button").addEventListener("click", () => setDrawer(!$("drawer").classList.contains("open")));
$("drawer-backdrop").addEventListener("click", () => setDrawer(false));
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $("drawer").classList.contains("open")) setDrawer(false); });
$("home-logo").addEventListener("click", () => showTab("home"));
$("key-pill").addEventListener("click", () => showTab("settings"));

function showPane(name) {
  document.querySelectorAll(".subtab").forEach((t) => t.classList.toggle("active", t.dataset.pane === name));
  document.querySelectorAll(".pane").forEach((p) => (p.hidden = p.dataset.pane !== name));
}
document.querySelectorAll(".subtab").forEach((t) => t.addEventListener("click", () => showPane(t.dataset.pane)));
$("banner-go").addEventListener("click", () => showTab("settings"));

// ───────────── home ─────────────

const GREETINGS = 8;
const EXAMPLE_TOPICS = ["graph neural networks", "CRISPR gene editing", "optical observations of isolated neutron stars",
  "microplastics in freshwater", "protein structure prediction"];
const greeting = Math.floor(Math.random() * GREETINGS); // one per app start, so it doesn't change under you

async function renderHome() {
  $("greeting").textContent = t(`greet.${greeting}`);
  let recent = [];
  try { recent = (await api("GET", "/history?limit=5")).map((e) => e.query); } catch { /* shown as suggestions */ }
  const topics = recent.length ? recent : EXAMPLE_TOPICS.slice(0, 3);
  $("recent-label").textContent = t(recent.length ? "home.recent" : "home.try");
  $("recent-topics").replaceChildren(...topics.map((query, i) => {
    const chip = el("button", { type: "button", class: recent.length ? "topic recent" : "topic", text: query, title: query });
    chip.style.setProperty("--i", i);
    chip.addEventListener("click", () => searchFor(query));
    return el("li", {}, chip);
  }));
  if (recent.length) markNewPapers();
}

/** "새 논문 N편" on recent topics with papers published since they were last searched. */
async function markNewPapers() {
  let counts = [];
  try { counts = await api("GET", "/history/new?limit=3"); } catch { return; }
  const chips = [...$("recent-topics").querySelectorAll(".topic")];
  for (const { query, since, new_papers: n } of counts) {
    const chip = chips.find((c) => c.title === query);
    if (!chip || !n || chip.querySelector(".new")) continue;
    chip.append(el("span", { class: "new", text: t("home.new", { n: n > 99 ? "99+" : n }), title: t("home.newTitle", { since }) }));
  }
}

/** Search again with `paper` as the seed: what it cites, what cites it, and what is close to it. */
function startFrom(paper, query) {
  $("seeds").value = shortId(paper.id);
  $("query").value = (query || paper.title || "").slice(0, 300);
  showTab("discover");
  $("search-form").requestSubmit();
}

/** Open Discover and search for `query` there. */
function searchFor(query) {
  $("query").value = query;
  showTab("discover");
  $("search-form").requestSubmit();
}

$("home-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const query = $("home-query").value.trim();
  if (query.length < 2) return;
  $("home-query").value = "";
  searchFor(query);
});

// ───────────── paper cards ─────────────

function paperCard(paper, { rank, query, extra } = {}) {
  const node = $("paper-template").content.firstElementChild.cloneNode(true);
  applyStaticText(node);
  node.querySelector(".rank").textContent = rank ? `#${rank} · ${paper.score}` : "";
  const title = node.querySelector(".title");
  title.textContent = paper.title || t("paper.noTitle");
  const link = webUrl(paper.url) || webUrl(paper.doi);
  if (link) title.href = link; else title.removeAttribute("href");
  node.querySelector(".authors").textContent = authorLine(paper.authors);
  node.querySelector(".meta").textContent = metaLine(paper);

  const chips = node.querySelector(".chips");
  const influence = paper.scores && paper.scores.influence;
  if (influence >= KEY_PAPER) {
    const why = paper.cited_by_results ? t("chip.keyCitedBy", { n: paper.cited_by_results }) : t("chip.keyGeneric");
    chips.append(el("span", { class: "chip key", text: t("chip.key"), title: t("chip.keyTitle", { score: influence.toFixed(2), why }) }));
  }
  if (paper.group === "recent") {
    const links = paper.builds_on_key_papers ? t("chip.recentLinks", { n: paper.builds_on_key_papers }) : "";
    chips.append(el("span", { class: "chip recent", text: t("chip.recent") + links, title: t("chip.recentTitle", { score: (paper.scores.frontier || 0).toFixed(2) }) }));
  }
  if (paper.core_reference) {
    chips.append(el("span", { class: "chip", text: t("chip.coreRef"), title: t("chip.coreRefTitle") }));
  }
  if (paper.seed_link) chips.append(el("span", { class: "chip seed", text: t("chip.seed") }));
  for (const kw of (paper.keywords || []).slice(0, 4)) chips.append(el("span", { class: "chip", text: kw }));

  const free = node.querySelector(".free"), freeUrl = webUrl(paper.open_access_url);
  if (freeUrl) { free.href = freeUrl; free.hidden = false; }
  node.querySelector(".from-here").addEventListener("click", () => startFrom(paper, query));
  node.querySelector(".read-pdf").addEventListener("click", () => readPaper(paper));

  const abstract = node.querySelector(".abstract");
  if (paper.abstract) abstract.querySelector("p").textContent = paper.abstract;
  else abstract.remove();

  const star = node.querySelector(".star");
  const refreshStar = () => {
    const on = isBookmarked(paper.id);
    star.textContent = on ? "★" : "☆";
    star.classList.toggle("on", on);
    star.title = on ? t("paper.unbookmark") : t("paper.bookmark");
  };
  refreshStar();
  star.addEventListener("click", async () => {
    star.disabled = true;
    try {
      if (isBookmarked(paper.id)) await api("DELETE", `/bookmarks/${shortId(paper.id)}`);
      else await api("PUT", "/bookmarks", { paper: pick(paper), query });
      await loadBookmarks();
      refreshStar();
    } catch (e) {
      alert(t("paper.bookmarkFailed", { error: e.message }));
    } finally {
      star.disabled = false;
    }
  });
  const judge = node.querySelector(".judge");
  if (rank && state.evalMode) {
    judge.hidden = false;
    const paint = () => judge.querySelectorAll("button").forEach((b) => b.classList.toggle("on", state.judgments[paper.id] === b.dataset.j));
    paint();
    judge.addEventListener("click", (event) => {
      const value = event.target.dataset && event.target.dataset.j;
      if (!value) return;
      state.judgments[paper.id] = state.judgments[paper.id] === value ? undefined : value;  // click again to clear
      paint();
      updateMetrics();
    });
  } else {
    judge.remove();
  }
  if (extra) node.append(extra);
  return node;
}

// ───────────── discover ─────────────

document.querySelectorAll("[data-weight]").forEach((range) => {
  const out = range.nextElementSibling;
  range.addEventListener("input", () => (out.value = Number(range.value).toFixed(2)));
});
$("recent-share").addEventListener("input", (e) => ($("recent-share-out").value = `${Math.round(e.target.value * 100)}%`));
$("reset-weights").addEventListener("click", () => {
  document.querySelectorAll("[data-weight]").forEach((range) => {
    range.value = range.defaultValue;
    range.nextElementSibling.value = Number(range.value).toFixed(2);
  });
});

$("search-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = $("query").value.trim();
  if (query.length < 2) return;
  let seeds = $("seeds").value.split("\n").map((s) => s.trim()).filter(Boolean);
  if ($("bookmark-seeds").checked) seeds = [...seeds, ...state.bookmarks.map((b) => b.id).filter((id) => !seeds.includes(id))];
  const weights = Object.fromEntries([...document.querySelectorAll("[data-weight]")].map((r) => [r.dataset.weight, Number(r.value)]));
  const yearFrom = Number($("year-from").value) || null;
  const yearTo = Number($("year-to").value) || null;
  const payload = {
    query, limit: Number($("limit").value), year_from: yearFrom, year_to: yearTo,
    seed_ids: seeds.slice(0, MAX_SEEDS), require_abstract: $("require-abstract").checked, weights,
    recent_share: Number($("recent-share").value), recent_years: Number($("recent-years").value),
  };
  setStatus("search-status", t("search.running"));
  $("results").replaceChildren();
  try {
    const body = await api("POST", "/search", payload);
    const { query: _q, ...runSettings } = payload;
    state.run = { ...body, query, runId: new Date().toISOString(), settings: runSettings };
    state.judgments = {};
    renderResults();
  } catch (e) {
    setStatus("search-status", t("search.failed", { error: e.message }), true);
  }
});

function renderResults() {
  const run = state.run;
  let message = t("search.summary", { count: run.count, candidates: run.candidates });
  if (run.seeds.length) message += t("search.seeds", { seeds: run.seeds.map((s) => s.title).join("; ") });
  if (run.unresolved_seeds.length) message += t("search.unresolved", { seeds: run.unresolved_seeds.join(", ") });
  setStatus("search-status", message);
  const core = run.papers.filter((p) => p.group !== "recent");
  const recent = run.papers.filter((p) => p.group === "recent");
  const cards = run.papers.map((p, i) => paperCard(p, { rank: i + 1, query: run.query }));
  const items = [];
  if (recent.length) {
    items.push(el("li", { class: "group-head" }, t("group.core"), el("small", { text: t("group.coreHint", { n: core.length }) })));
  }
  items.push(...cards.slice(0, core.length));
  if (recent.length) {
    const years = run.settings.recent_years;
    items.push(el("li", { class: "group-head" }, t("group.recent"), el("small", { text: t("group.recentHint", { n: recent.length, years }) })));
    items.push(...cards.slice(core.length));
  }
  $("results").replaceChildren(...items);
  $("eval-bar").hidden = false;
  updateMetrics();
}

// ───────────── ranking evaluation ─────────────
// Same definitions as backend/evaluation.py, computed here for live feedback.

const GAIN = { relevant: 2, partial: 1, not_relevant: 0 };

function precisionAt(labels, k) {
  const judged = labels.slice(0, k).filter(Boolean);
  return judged.length ? judged.filter((j) => GAIN[j] > 0).length / judged.length : null;
}

function ndcgAt(labels, k) {
  const top = labels.slice(0, k);
  if (!top.some(Boolean)) return null;
  const dcg = top.reduce((sum, j, i) => sum + (j ? GAIN[j] : 0) / Math.log2(i + 2), 0);
  const ideal = labels.filter(Boolean).map((j) => GAIN[j]).sort((a, b) => b - a).slice(0, k);
  const idcg = ideal.reduce((sum, g, i) => sum + g / Math.log2(i + 2), 0);
  return idcg ? dcg / idcg : 0;
}

const fmt = (v) => (v == null ? "—" : v.toFixed(2));

function updateMetrics() {
  $("eval-metrics").hidden = !state.evalMode;
  if (!state.run) return;
  const labels = state.run.papers.map((p) => state.judgments[p.id]);
  const judged = labels.filter(Boolean).length;
  $("m-judged").textContent = `${judged} / ${labels.length}`;
  $("m-p10").textContent = fmt(precisionAt(labels, 10));
  $("m-p20").textContent = fmt(precisionAt(labels, 20));
  $("m-ndcg").textContent = fmt(ndcgAt(labels, 20));
  $("eval-save").disabled = judged === 0;
}

$("eval-mode").addEventListener("change", (event) => {
  state.evalMode = event.target.checked;
  if (state.run) renderResults();
});

$("eval-save").addEventListener("click", async () => {
  const run = state.run;
  const judgments = Object.fromEntries(Object.entries(state.judgments).filter(([, v]) => v));
  try {
    const res = await api("POST", "/evaluations", {
      run_id: run.runId, query: run.query, settings: run.settings,
      papers: run.papers.map((p) => ({ id: p.id, title: p.title, score: p.score })), judgments,
    });
    setStatus("search-status", t("eval.saved", { n: res.written }));
    $("eval-history").open = true;
    loadEvaluations();
  } catch (e) {
    setStatus("search-status", t("eval.saveFailed", { error: e.message }), true);
  }
});

async function loadEvaluations() {
  let runs = [];
  try { runs = await api("GET", "/evaluations"); } catch { /* shown as empty */ }
  $("eval-empty").hidden = runs.length > 0;
  $("eval-table").hidden = runs.length === 0;
  $("eval-table").querySelector("tbody").replaceChildren(...runs.map((r) => {
    const w = (r.settings && r.settings.weights) || {};
    const weights = ["relevance", "influence", "impact", "recency", "seed"].map((k) => (w[k] ?? 0).toFixed(2)).join(" · ");
    const when = r.saved_at ? new Date(r.saved_at).toLocaleString() : "—";
    const remove = el("button", { text: t("eval.delete"), title: t("eval.deleteTitle") });
    remove.addEventListener("click", async () => {
      if (!confirm(t("eval.deleteConfirm", { query: r.query }))) return;
      await api("DELETE", `/evaluations/${encodeURIComponent(r.run_id)}`);
      loadEvaluations();
    });
    return el("tr", {},
      el("td", { text: when }), el("td", { text: r.query }), el("td", { class: "num", text: String(r.judged) }),
      el("td", { class: "num", text: fmt(r["p@10"]) }), el("td", { class: "num", text: fmt(r["p@20"]) }),
      el("td", { class: "num", text: fmt(r["ndcg@20"]) }), el("td", { class: "num", text: weights }), el("td", {}, remove));
  }));
}

// ───────────── bookmarks ─────────────

const isBookmarked = (id) => state.bookmarks.some((b) => b.id === shortId(id));

async function loadBookmarks() {
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

const STATUSES = ["to_read", "reading", "read"];

/** 읽을 것 · 읽는 중 · 읽음 buttons for a bookmark; `done` runs after a change is saved. */
function statusControl(bookmark, done) {
  const group = el("div", { class: "status-control", role: "group", "aria-label": t("bm.status") });
  for (const status of STATUSES) {
    const button = el("button", { type: "button", "data-status": status, text: t(`status.${status}`),
      class: bookmark.status === status ? "on" : null, "aria-pressed": String(bookmark.status === status) });
    button.addEventListener("click", async () => {
      if (bookmark.status === status) return;
      group.querySelectorAll("button").forEach((b) => (b.disabled = true));
      try {
        await api("PATCH", `/bookmarks/${bookmark.id}`, { status });
        await loadBookmarks();
        done();
      } catch (e) {
        alert(t("bm.saveFailed", { error: e.message }));
        group.querySelectorAll("button").forEach((b) => (b.disabled = false));
      }
    });
    group.append(button);
  }
  return group;
}

function renderBookmarks() {
  const select = $("tag-filter");
  const current = select.value;
  const tags = [...new Set(state.bookmarks.flatMap((b) => b.tags))].sort();
  select.replaceChildren(el("option", { value: "", text: t("bm.all") }), ...tags.map((t) => el("option", { value: t, text: t })));
  select.value = tags.includes(current) ? current : "";

  const status = $("status-filter").value;
  const shown = state.bookmarks.filter((b) => (!select.value || b.tags.includes(select.value)) && (!status || b.status === status));
  $("bm-empty").hidden = state.bookmarks.length > 0;
  $("bookmarks").replaceChildren(...shown.map((b) => {
    const note = el("textarea", { rows: 2, placeholder: t("bm.note") });
    note.value = b.note;
    const tagInput = el("input", { type: "text", placeholder: t("bm.tags") });
    tagInput.value = b.tags.join(", ");
    const save = el("button", { text: t("bm.save") });
    const remove = el("button", { class: "danger", text: t("bm.delete") });
    save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        await api("PATCH", `/bookmarks/${b.id}`, { note: note.value, tags: tagInput.value.split(",").map((t) => t.trim()).filter(Boolean) });
        await loadBookmarks();
        renderBookmarks();
      } catch (e) { alert(t("bm.saveFailed", { error: e.message })); } finally { save.disabled = false; }
    });
    remove.addEventListener("click", async () => {
      if (!confirm(t("bm.deleteConfirm", { title: b.paper.title }))) return;
      await api("DELETE", `/bookmarks/${b.id}`);
      await loadBookmarks();
      renderBookmarks();
    });
    const edit = el("div", { class: "bm-edit" }, note, tagInput, el("div", { class: "buttons" }, save, remove));
    const card = paperCard(b.paper, { query: b.query, extra: edit });
    card.querySelector(".paper-actions").prepend(statusControl(b, renderBookmarks));
    if (b.query) card.querySelector(".meta").append(el("span", { class: "found-via", text: t("bm.foundVia", { query: b.query }) }));
    return card;
  }));
}
$("tag-filter").addEventListener("change", renderBookmarks);
$("status-filter").addEventListener("change", renderBookmarks);

// ───────────── the PDF reader (frontend/web/reader, loaded when first used) ─────────────

let readerModule = null;
async function openReader(options) {
  readerModule ??= await import(new URL("reader/reader.js", document.querySelector("link[rel=stylesheet]").href).href);
  return readerModule.openReader({ api, saveFile, onOpened: readingStarted, onFinished: readingFinished,
    onAttachNote: attachToNote, onClose: () => { loadBookmarks(); if (currentTab === "reading") renderDocs(); }, ...options });
}

/** Ask for a PDF file; resolves to the File, or null if the person cancels. */
function pickPdf() {
  const input = $("pick-pdf");
  input.value = "";
  return new Promise((resolve) => {
    input.onchange = () => resolve(input.files[0] || null);
    input.click();
  });
}

/** Read a paper: its free PDF when there is one, else a PDF file the person picks. */
async function readPaper(paper, { askFile = false } = {}) {
  const url = webUrl(paper.open_access_url);
  // the reader also asks Unpaywall and the person's library (reader.js findPdf)
  if ((url || paper.doi) && !askFile) return openReader({ paper: pick(paper), url });
  const file = await pickPdf();
  if (file) openReader({ paper: pick(paper), file });
}

const bookmarkOf = (paper) => state.bookmarks.find((b) => b.id === shortId(paper.id));

/** Opening a bookmarked paper that was still "to read" moves it to "reading". */
async function readingStarted(paper) {
  const b = bookmarkOf(paper);
  if (b && b.status === "to_read") {
    try { await api("PATCH", `/bookmarks/${b.id}`, { status: "reading" }); await loadBookmarks(); } catch { /* not important */ }
  }
}

/** Reaching the end of the PDF marks the paper read (bookmarking it first). Resolves to whether it changed. */
async function readingFinished(paper) {
  try {
    let b = bookmarkOf(paper);
    if (!b) b = await api("PUT", "/bookmarks", { paper: pick(paper) });
    if (b.status === "read") return false;
    await api("PATCH", `/bookmarks/${b.id}`, { status: "read" });
    await loadBookmarks();
    return true;
  } catch {
    return false;
  }
}

/** Add the reader's annotation list to the paper's bookmark note. Resolves to a message. */
async function attachToNote(paper, text) {
  try {
    let b = bookmarkOf(paper);
    if (!b) b = await api("PUT", "/bookmarks", { paper: pick(paper) });
    const note = [b.note, text].filter((s) => s && s.trim()).join("\n\n");
    await api("PATCH", `/bookmarks/${b.id}`, { note });
    await loadBookmarks();
    return t("rd.attached");
  } catch (e) {
    return t("bm.saveFailed", { error: e.message });
  }
}

async function renderDocs() {
  let docs = [];
  try { docs = await api("GET", "/annotations"); } catch { /* shown as empty */ }
  $("docs-empty").hidden = docs.length > 0;
  const when = (iso) => (iso ? new Date(iso).toLocaleDateString(LANG === "ko" ? "ko-KR" : "en-US", { month: "short", day: "numeric" }) : "");
  $("doc-list").replaceChildren(...docs.map((d) => {
    const open = el("button", { type: "button", class: "title link-like", text: d.title || d.id });
    open.addEventListener("click", async () => {
      const paper = d.paper_id ? (bookmarkOf({ id: d.paper_id }) || {}).paper || { id: `https://openalex.org/${d.paper_id}`, title: d.title } : null;
      if (d.id.startsWith("notes-")) return openReader({ paper, docId: d.id });
      if (d.source && webUrl(d.source)) return openReader({ paper, url: d.source });
      alert(t("read.pickAgain", { title: d.title }));
      const file = await pickPdf();
      if (file) openReader({ paper, file });
    });
    const remove = el("button", { type: "button", class: "danger small-button", text: t("bm.delete") });
    remove.addEventListener("click", async () => {
      if (!confirm(t("read.deleteDoc", { title: d.title || d.id }))) return;
      await api("DELETE", `/annotations/${encodeURIComponent(d.id)}`);
      renderDocs();
    });
    const meta = t("read.docMeta", { items: d.items, notes: d.note_pages, date: when(d.updated_at) });
    return el("li", { class: "read-row" }, open, el("span", { class: "meta", text: meta }), remove);
  }));
}

$("open-pdf").addEventListener("change", (e) => { const file = e.target.files[0]; e.target.value = ""; if (file) openReader({ file }); });
$("new-notes").addEventListener("click", () => openReader({}));

// ───────────── reading: this month's papers as a thermometer ─────────────

const DEFAULT_GOAL = 10;

function readThisMonth(now = new Date()) {
  return state.bookmarks
    .filter((b) => b.status === "read" && b.read_at)
    .filter((b) => { const d = new Date(b.read_at); return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth(); })
    .sort((a, b) => (a.read_at < b.read_at ? 1 : -1));
}

function readRow(bookmark, when) {
  const link = webUrl(bookmark.paper.url) || webUrl(bookmark.paper.doi);
  const title = el(link ? "a" : "span", { class: "title", href: link, target: link ? "_blank" : null, rel: link ? "noopener" : null,
    text: bookmark.paper.title || t("paper.noTitle") });
  return el("li", { class: "read-row" }, title,
    el("span", { class: "meta", text: when }), statusControl(bookmark, renderReading));
}

function renderReading() {
  const now = new Date(), goal = state.readingGoal || DEFAULT_GOAL;
  const reads = readThisMonth(now), n = reads.length, full = Math.min(1, n / goal);
  $("reading-month").textContent = now.toLocaleDateString(LANG === "ko" ? "ko-KR" : "en-US", { year: "numeric", month: "long" });
  $("reading-cheer").textContent = t(n === 0 ? "read.cheerZero" : n >= goal ? "read.cheerGoal" : "read.cheer");
  $("reading-count").textContent = String(n);
  $("reading-of").textContent = t("read.of", { goal });
  $("thermo").setAttribute("aria-label", t("read.aria", { n, goal }));
  $("thermo").classList.toggle("done", n >= goal);
  $("mercury").style.height = "0%";
  requestAnimationFrame(() => requestAnimationFrame(() => ($("mercury").style.height = `${(full * 100).toFixed(1)}%`)));
  $("ticks").replaceChildren(...[goal, Math.round(goal / 2), 0].map((v) =>
    el("span", { style: `bottom:${((v / goal) * 100).toFixed(1)}%`, text: String(v) })));
  if (document.activeElement !== $("reading-goal")) $("reading-goal").value = String(goal);
  const date = (iso) => new Date(iso).toLocaleDateString(LANG === "ko" ? "ko-KR" : "en-US", { month: "short", day: "numeric" });
  $("read-empty").hidden = n > 0;
  $("read-list").replaceChildren(...reads.map((b) => readRow(b, t("read.readOn", { date: date(b.read_at) }))));
  const reading = state.bookmarks.filter((b) => b.status === "reading");
  $("reading-empty").hidden = reading.length > 0;
  $("reading-list").replaceChildren(...reading.map((b) => readRow(b, b.query ? t("bm.foundVia", { query: b.query }).replace(/^\s*·\s*/, "") : "")));
}

$("goal-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const goal = Math.round(Number($("reading-goal").value));
  if (!(goal >= 1 && goal <= 999)) return setStatus("goal-status", t("read.goalRange"), true);
  try {
    await api("PUT", "/settings", { reading_goal: String(goal) });
    state.readingGoal = goal;
    setStatus("goal-status", t("read.goalSaved"));
    renderReading();
  } catch (e) {
    setStatus("goal-status", t("set.saveFailed", { error: e.message }), true);
  }
});

$("export-bib").addEventListener("click", async () => {
  const tag = $("tag-filter").value;
  try {
    const bib = await api("GET", `/bookmarks/export.bib${tag ? `?tag=${encodeURIComponent(tag)}` : ""}`);
    if (!bib.trim()) return alert(t("bm.nothing"));
    alert(await saveFile("research-radar.bib", bib, "application/x-bibtex"));
  } catch (e) { alert(t("bm.exportFailed", { error: e.message })); }
});

// ───────────── research map ─────────────

async function drawFlow() {
  const source = document.querySelector("input[name=source]:checked").value;
  const useResults = source !== "bookmarks" && state.run;
  if (source === "results" && !state.run) return setStatus("map-status", t("flow.needSearch"), true);
  if (source === "bookmarks" && !state.bookmarks.length) return setStatus("map-status", t("flow.noBookmarks"), true);
  if (!useResults && !state.bookmarks.length) return setStatus("map-status", t("flow.needPapers"), true);

  const payload = {
    papers: useResults ? state.run.papers.map(pick) : [],
    query: useResults ? state.run.query : null,
    include_bookmarks: source !== "results",
    include_foundations: $("foundations").checked,
  };
  $("build-map").disabled = true;
  setStatus("map-status", t("flow.running"));
  try {
    const flow = await api("POST", "/flow", payload);
    Object.assign(state, { flow, posterTitle: useResults ? state.run.query : null, flowRun: state.run && state.run.runId });
    await showFlow();
  } catch (e) {
    setStatus("map-status", t("flow.failed", { error: e.message }), true);
  } finally {
    $("build-map").disabled = false;
  }
}
$("build-map").addEventListener("click", drawFlow);

/** Opening the flow page draws the latest search (and bookmarks) without another click. */
function autoDrawFlow() {
  if ($("build-map").disabled) return;
  const fresh = state.run && state.flowRun !== state.run.runId;
  if (fresh || (!state.flow && state.bookmarks.length)) drawFlow();
}

/** The map's fonts, inlined: the map runs in a sandboxed frame with no access to the app, so it
 * cannot load the app's files (and a saved poster keeps its look offline). Loaded once. */
let mapFonts = null;
function mapFontFaces() {
  mapFonts ??= Promise.all([["L", 300], ["R", 400], ["B", 700]].map(async ([file, weight]) => {
    const url = new URL(`fonts/NanumSquareRound${file}.woff2`, document.querySelector("link[rel=stylesheet]").href);
    const blob = await (await fetch(url)).blob();
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(new Blob([blob], { type: "font/woff2" }));
    });
    return `@font-face{font-family:NanumSquareRound;font-weight:${weight};src:url("${data}") format("woff2")}`;
  })).then((faces) => faces.join("")).catch(() => ""); // without them the map uses the system font
  return mapFonts;
}

/** Draw the analyzed flow in the current language (again after a language switch). */
async function showFlow() {
  const flow = state.flow;
  const title = state.posterTitle || t("flow.myBookmarks");
  const poster = await api("POST", "/poster", { flow, title, lang: LANG });
  // on the app's light background the map is light too (and saved the way it is shown)
  const light = !matchMedia("(prefers-color-scheme: dark)").matches;
  const fonts = await mapFontFaces();
  state.poster = (light ? poster.replace("<html ", '<html class="light" ') : poster).replace("<style>", () => `<style>${fonts}`);
  $("poster").srcdoc = state.poster;
  $("poster").hidden = false;
  $("save-poster").disabled = false;
  const touch = matchMedia("(pointer: coarse)").matches;
  setStatus("map-status", t(touch ? "flow.doneTouch" : "flow.done", { nodes: flow.nodes.length, edges: flow.edges.length, topics: flow.clusters.length }));
  renderStory(flow);
}

$("save-poster").addEventListener("click", async () => {
  if (!state.poster) return;
  const safe = (state.posterTitle || t("flow.myBookmarks")).replace(/[^\w가-힣 -]+/g, "").trim().replace(/\s+/g, "-") || "research-map";
  setStatus("map-status", await saveFile(`${safe}.html`, state.poster, "text/html"));
});

const LANE_COLORS = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#9085e9"];

function renderStory(flow) {
  const nodes = Object.fromEntries(flow.nodes.map((n) => [n.id, n]));
  const label = (id) => (nodes[id] ? `${nodes[id].title} (${nodes[id].year ?? "—"})` : "—");
  const lanes = [...flow.clusters].sort((a, b) => a.lane - b.lane);
  const cards = lanes.map((c) => {
    const card = el("article", { class: "story-card" },
      el("h3", { text: c.label }),
      el("dl", {},
        el("dt", { text: t("story.papers") }), el("dd", { text: t("story.papersValue", { n: c.size, from: c.year_min ?? "—", to: c.year_max ?? "—" }) }),
        el("dt", { text: t("story.origin") }), el("dd", { text: label(c.origin) }),
        el("dt", { text: t("story.hub") }), el("dd", { text: label(c.hub) }),
        el("dt", { text: t("story.latest") }), el("dd", {}, el("ol", {}, c.frontier.map((id) => el("li", { text: label(id) })))),
      ));
    card.style.setProperty("--lane", LANE_COLORS[c.lane % LANE_COLORS.length]);
    return card;
  });
  if (flow.chain && flow.chain.length) {
    cards.push(el("article", { class: "story-card" },
      el("h3", { text: t("story.chain") }),
      el("ol", {}, flow.chain.map((id) => el("li", { text: label(id) })))));
  }
  $("story").replaceChildren(...cards);
}

// ───────────── settings ─────────────

async function loadSettings({ applyLanguage = false } = {}) {
  let s;
  try { s = await api("GET", "/settings"); } catch { return; }
  state.readingGoal = Number(s.reading_goal && s.reading_goal.value) || null;
  if (!$("tab-reading").hidden) renderReading();
  const key = s.openalex_api_key;
  $("openalex-key-state").textContent = key.set
    ? t("set.keySaved", { hint: key.hint, env: key.source === "environment" ? t("set.keyEnv") : "" })
    : t("set.noKey");
  // only keys saved in the app can be removed here; environment variables stay as they are
  $("clear-openalex-key").hidden = key.source !== "settings";
  $("openalex-email").value = s.openalex_email.value || "";
  $("library-proxy").value = (s.library_proxy && s.library_proxy.value) || "";
  $("school-state").textContent = "";
  $("library-state").textContent = window.radarLocalApi ? t("set.libraryMobile")
    : s.library_proxy && s.library_proxy.value ? t(s.library_signed_in ? "set.librarySignedIn" : "set.libraryNotSignedIn") : "";
  $("library-sign-out").hidden = !s.library_signed_in;
  if (window.radarLocalApi) $("data-hint").textContent = t("set.dataDirMobile"); // no data folder on a phone
  else $("data-dir").textContent = s.data_dir;
  $("key-pill").textContent = key.set ? t("pill.ok") : t("pill.missing");
  $("key-pill").className = `pill ${key.set ? "ok" : "warn"}`;
  $("banner").hidden = key.set;
  // the saved language wins over this computer's last choice (e.g. after reinstalling)
  if (applyLanguage && s.language && s.language.value && setLanguage(s.language.value)) refreshText();
  document.querySelectorAll("input[name=language]").forEach((r) => (r.checked = r.value === LANG));
  return s;
}

// ───────────── language ─────────────

/** Re-render everything that was built with t() after the language changes. */
function refreshText() {
  if (state.run) renderResults();
  renderBookmarks();
  loadEvaluations();
  loadSettings();
  checkVersion();
  const toggle = $("toggle-key");
  toggle.textContent = t(toggle.dataset.i18n);
  if (state.flow) showFlow().catch(() => {});
  $("page-title").textContent = PAGE_TITLES[currentTab] ? t(PAGE_TITLES[currentTab]) : "";
  if (currentTab === "home") renderHome();
  if (currentTab === "news") renderNews();
}

document.querySelectorAll("input[name=language]").forEach((radio) => radio.addEventListener("change", async () => {
  if (!setLanguage(radio.value)) return;
  let error = null;
  try { await api("PUT", "/settings", { language: LANG }); } catch (e) { error = e; }
  refreshText();
  if (error) setStatus("language-status", t("set.saveFailed", { error: error.message }), true);
  else setStatus("language-status", t("set.languageSaved"));
}));

for (const [button, field, label] of [["clear-openalex-key", "openalex_api_key", "OpenAlex"]]) {
  $(button).addEventListener("click", async () => {
    if (!confirm(t("set.clearConfirm", { label }))) return;
    await api("PUT", "/settings", { [field]: "" });
    setStatus("settings-status", t("set.cleared", { label }));
    await loadSettings();
  });
}

$("clear-history").addEventListener("click", async () => {
  if (!confirm(t("set.historyConfirm"))) return;
  try {
    await api("DELETE", "/history");
    setStatus("history-status", t("set.historyCleared"));
  } catch (e) {
    setStatus("history-status", t("set.saveFailed", { error: e.message }), true);
  }
});

$("toggle-key").addEventListener("click", () => {
  const input = $("openalex-key");
  input.type = input.type === "password" ? "text" : "password";
  $("toggle-key").dataset.i18n = input.type === "password" ? "set.show" : "set.hide";
  $("toggle-key").textContent = t($("toggle-key").dataset.i18n);
});

$("test-key").addEventListener("click", async () => {
  const result = $("test-result");
  result.className = "test-result";
  result.textContent = t("set.testing");
  try {
    const r = await api("POST", "/settings/test-openalex", { api_key: $("openalex-key").value.trim() || null });
    const budget = r.remaining_usd != null && r.limit_usd ? t("set.budget", { remaining: r.remaining_usd.toFixed(3), limit: r.limit_usd }) : "";
    const message = r.code ? t(`key.${r.code}`, { status: r.status ?? "" }) : r.message;
    result.textContent = (r.ok ? "✓ " : "✗ ") + message + budget;
    result.classList.add(r.ok ? "ok" : "bad");
  } catch (e) {
    result.textContent = `✗ ${e.message}`;
    result.classList.add("bad");
  }
});

$("settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const update = {};
  if ($("openalex-key").value.trim()) update.openalex_api_key = $("openalex-key").value.trim();
  try {
    await api("PUT", "/settings", update);
    $("openalex-key").value = "";
    setStatus("settings-status", t("set.saved"));
    await loadSettings();
  } catch (e) {
    setStatus("settings-status", t("set.saveFailed", { error: e.message }), true);
  }
});

// the school e-mail fills in the library's address when the app knows the school
$("openalex-email").addEventListener("change", async () => {
  let school = null;
  const email = $("openalex-email").value.trim();
  if (email.includes("@")) try { school = await api("GET", `/library/school?email=${encodeURIComponent(email)}`); } catch { /* offline: type it */ }
  if (school && !$("library-proxy").value.trim()) $("library-proxy").value = school.proxy;
  $("school-state").textContent = !email.includes("@") ? "" : school ? t("set.school", { name: LANG === "ko" ? school.name_ko : school.name_en }) : t("set.schoolUnknown");
});

$("library-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("PUT", "/settings", { openalex_email: $("openalex-email").value.trim(), library_proxy: $("library-proxy").value.trim() });
    setStatus("library-status", t("set.saved"));
    await loadSettings();
  } catch (e) {
    setStatus("library-status", t("set.saveFailed", { error: e.message }), true);
  }
});

$("library-sign-out").addEventListener("click", async () => {
  await api("DELETE", "/library/session");
  setStatus("library-status", t("set.librarySignedOut"));
  await loadSettings();
});

// ───────────── version & updates ─────────────

/** A newer release, announced only with a link to GitHub (the link comes from GitHub's API). */
const newRelease = (info) => Boolean(info && info.update_available && /^https:\/\/github\.com\//.test(info.latest.url || ""));

async function checkVersion() {
  let info;
  try { info = await api("GET", "/version"); } catch { return; }
  state.version = info;
  $("app-version").textContent = `v${info.version}`;
  const update = newRelease(info);
  $("menu-dot").hidden = !update;
  $("news-badge").hidden = !update;
  $("news-badge").textContent = t("news.new");
  if (update) {
    $("update-state").replaceChildren("· ", el("a", { href: info.latest.url, target: "_blank", rel: "noopener", text: t("set.newVersion", { version: info.latest.version }) }));
  } else {
    $("update-state").textContent = info.latest ? t("set.latest") : "";
  }
  if (currentTab === "news") renderNews();
}

// ───────────── news ─────────────

async function renderNews() {
  const info = state.version;
  const card = $("update-card");
  card.hidden = !newRelease(info);
  if (!card.hidden) {
    card.href = info.latest.url;
    card.textContent = t("news.update", { version: info.latest.version });
  }
  if (!state.changelog) {
    try { state.changelog = await api("GET", "/changelog"); } catch { return; }
  }
  const current = info ? info.version : null;
  $("changelog").replaceChildren(...state.changelog.map((release) => el("li", { class: "release" },
    el("h3", {}, `v${release.version}`, release.version === current ? el("span", { class: "chip", text: t("news.current") }) : null,
      el("small", { text: release.date || "" })),
    el("ul", {}, (release[LANG] || release.ko).map((line) => el("li", { text: line }))))));
}

// ───────────── start ─────────────

applyStaticText();
showTab("home");

loadSettings({ applyLanguage: true });
loadBookmarks();
checkVersion();
loadEvaluations();
