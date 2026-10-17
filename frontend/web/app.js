"use strict";

const $ = (id) => document.getElementById(id);
const PAPER_FIELDS = ["id", "title", "abstract", "year", "doi", "url", "venue", "authors", "citations",
  "referenced_works", "keywords", "topic"];
const MAX_SEEDS = 10;
const KEY_PAPER = 0.5;  // flow-importance score from which a paper is badged as a key paper

const state = { run: null, bookmarks: [], flow: null, poster: null, posterTitle: "", evalMode: false, judgments: {} };

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
const pick = (paper) => Object.fromEntries(PAPER_FIELDS.map((k) => [k, paper[k] ?? null]));

function authorLine(authors) {
  if (!authors || !authors.length) return t("paper.noAuthors");
  return authors.slice(0, 5).join(", ") + (authors.length > 5 ? t("paper.etAl") : "");
}

function metaLine(paper) {
  return [paper.year || "—", paper.venue, t("paper.citations", { n: Number(paper.citations || 0).toLocaleString() })]
    .filter(Boolean).join(" · ");
}

/** Save text to a file: native dialog in the desktop app, download in a browser. */
async function saveFile(name, content, mime) {
  if (window.radarSaveFile) return window.radarSaveFile(name, content, mime);
  if (window.pywebview && window.pywebview.api && window.pywebview.api.save_file) {
    const saved = await window.pywebview.api.save_file(name, content);
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

// ───────────── tabs ─────────────

function showTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".panel").forEach((p) => (p.hidden = p.id !== `tab-${name}`));
  if (name === "bookmarks") renderBookmarks();
}
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab)));
$("key-pill").addEventListener("click", () => showTab("settings"));

function showPane(name) {
  document.querySelectorAll(".subtab").forEach((t) => t.classList.toggle("active", t.dataset.pane === name));
  document.querySelectorAll(".pane").forEach((p) => (p.hidden = p.dataset.pane !== name));
}
document.querySelectorAll(".subtab").forEach((t) => t.addEventListener("click", () => showPane(t.dataset.pane)));
$("banner-go").addEventListener("click", () => showTab("settings"));

// ───────────── paper cards ─────────────

function paperCard(paper, { rank, query, extra } = {}) {
  const node = $("paper-template").content.firstElementChild.cloneNode(true);
  applyStaticText(node);
  node.querySelector(".rank").textContent = rank ? `#${rank} · ${paper.score}` : "";
  const title = node.querySelector(".title");
  title.textContent = paper.title || t("paper.noTitle");
  const link = paper.url || paper.doi;
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
    state.run = { ...body, query, runId: new Date().toISOString(), settings: { ...runSettings, semantic: body.semantic } };
    state.judgments = {};
    renderResults();
  } catch (e) {
    setStatus("search-status", t("search.failed", { error: e.message }), true);
  }
});

function renderResults() {
  const run = state.run;
  let message = t("search.summary", { count: run.count, candidates: run.candidates, mode: t(run.semantic ? "search.semantic" : "search.lexical") });
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
}

function renderBookmarks() {
  const select = $("tag-filter");
  const current = select.value;
  const tags = [...new Set(state.bookmarks.flatMap((b) => b.tags))].sort();
  select.replaceChildren(el("option", { value: "", text: t("bm.all") }), ...tags.map((t) => el("option", { value: t, text: t })));
  select.value = tags.includes(current) ? current : "";

  const shown = state.bookmarks.filter((b) => !select.value || b.tags.includes(select.value));
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
    if (b.query) card.querySelector(".meta").append(el("span", { class: "found-via", text: t("bm.foundVia", { query: b.query }) }));
    return card;
  }));
}
$("tag-filter").addEventListener("change", renderBookmarks);

$("export-bib").addEventListener("click", async () => {
  const tag = $("tag-filter").value;
  try {
    const bib = await api("GET", `/bookmarks/export.bib${tag ? `?tag=${encodeURIComponent(tag)}` : ""}`);
    if (!bib.trim()) return alert(t("bm.nothing"));
    alert(await saveFile("research-radar.bib", bib, "application/x-bibtex"));
  } catch (e) { alert(t("bm.exportFailed", { error: e.message })); }
});

// ───────────── research map ─────────────

$("build-map").addEventListener("click", async () => {
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
    Object.assign(state, { flow, posterTitle: useResults ? state.run.query : null });
    await showFlow();
  } catch (e) {
    setStatus("map-status", t("flow.failed", { error: e.message }), true);
  } finally {
    $("build-map").disabled = false;
  }
});

/** Draw the analyzed flow in the current language (again after a language switch). */
async function showFlow() {
  const flow = state.flow;
  const title = state.posterTitle || t("flow.myBookmarks");
  state.poster = await api("POST", "/poster", { flow, title, lang: LANG });
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
  const key = s.openalex_api_key;
  $("openalex-key-state").textContent = key.set
    ? t("set.keySaved", { hint: key.hint, env: key.source === "environment" ? t("set.keyEnv") : "" })
    : t("set.noKey");
  $("openai-key-state").textContent = s.openai_api_key.set ? t("set.openaiSaved", { hint: s.openai_api_key.hint }) : t("set.unused");
  // only keys saved in the app can be removed here; environment variables stay as they are
  $("clear-openalex-key").hidden = key.source !== "settings";
  $("clear-openai-key").hidden = s.openai_api_key.source !== "settings";
  $("openalex-email").value = s.openalex_email.value || "";
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
}

document.querySelectorAll("input[name=language]").forEach((radio) => radio.addEventListener("change", async () => {
  if (!setLanguage(radio.value)) return;
  let error = null;
  try { await api("PUT", "/settings", { language: LANG }); } catch (e) { error = e; }
  refreshText();
  if (error) setStatus("language-status", t("set.saveFailed", { error: error.message }), true);
  else setStatus("language-status", t("set.languageSaved"));
}));

for (const [button, field, label] of [["clear-openalex-key", "openalex_api_key", "OpenAlex"], ["clear-openai-key", "openai_api_key", "OpenAI"]]) {
  $(button).addEventListener("click", async () => {
    if (!confirm(t("set.clearConfirm", { label }))) return;
    await api("PUT", "/settings", { [field]: "" });
    setStatus("settings-status", t("set.cleared", { label }));
    await loadSettings();
  });
}

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
  const update = { openalex_email: $("openalex-email").value.trim() };
  if ($("openalex-key").value.trim()) update.openalex_api_key = $("openalex-key").value.trim();
  if ($("openai-key").value.trim()) update.openai_api_key = $("openai-key").value.trim();
  try {
    await api("PUT", "/settings", update);
    $("openalex-key").value = "";
    $("openai-key").value = "";
    setStatus("settings-status", t("set.saved"));
    await loadSettings();
  } catch (e) {
    setStatus("settings-status", t("set.saveFailed", { error: e.message }), true);
  }
});

// ───────────── version & updates ─────────────

async function checkVersion() {
  let info;
  try { info = await api("GET", "/version"); } catch { return; }
  $("app-version").textContent = `v${info.version}`;
  if (info.update_available) {
    const pill = $("update-pill");
    pill.textContent = t("update.pill", { version: info.latest.version });
    pill.title = t("update.title");
    pill.href = info.latest.url;
    pill.hidden = false;
    $("update-state").replaceChildren("· ", el("a", { href: info.latest.url, target: "_blank", rel: "noopener", text: t("set.newVersion", { version: info.latest.version }) }));
  } else {
    $("update-state").textContent = info.latest ? t("set.latest") : "";
  }
}

// ───────────── start ─────────────

applyStaticText();

loadSettings({ applyLanguage: true });
loadBookmarks();
checkVersion();
loadEvaluations();
