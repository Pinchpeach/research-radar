"use strict";

const $ = (id) => document.getElementById(id);
const PAPER_FIELDS = ["id", "title", "abstract", "year", "doi", "url", "venue", "authors", "citations",
  "referenced_works", "keywords", "topic"];
const MAX_SEEDS = 10;

const state = { run: null, bookmarks: [], flow: null, poster: null, posterTitle: "" };

// ───────────── helpers ─────────────

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error("앱의 내부 서버에 연결할 수 없습니다.");
  }
  if (res.status === 204) return null;
  const type = res.headers.get("content-type") || "";
  const data = type.includes("json") ? await res.json() : await res.text();
  if (!res.ok) {
    const detail = data && data.detail;
    throw new Error(typeof detail === "string" ? detail : `요청 실패 (${res.status})`);
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
  if (!authors || !authors.length) return "저자 정보 없음";
  return authors.slice(0, 5).join(", ") + (authors.length > 5 ? " 외" : "");
}

function metaLine(paper) {
  return [paper.year || "—", paper.venue, `인용 ${Number(paper.citations || 0).toLocaleString()}`]
    .filter(Boolean).join(" · ");
}

/** Save text to a file: native dialog in the desktop app, download in a browser. */
async function saveFile(name, content, mime) {
  if (window.pywebview && window.pywebview.api && window.pywebview.api.save_file) {
    const saved = await window.pywebview.api.save_file(name, content);
    return saved ? `저장했습니다: ${saved}` : "저장을 취소했습니다.";
  }
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const link = el("a", { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return `${name} 파일을 내려받았습니다.`;
}

// ───────────── tabs ─────────────

function showTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".panel").forEach((p) => (p.hidden = p.id !== `tab-${name}`));
  if (name === "bookmarks") renderBookmarks();
}
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab)));
$("key-pill").addEventListener("click", () => showTab("settings"));
$("banner-go").addEventListener("click", () => showTab("settings"));

// ───────────── paper cards ─────────────

function paperCard(paper, { rank, query, extra } = {}) {
  const node = $("paper-template").content.firstElementChild.cloneNode(true);
  node.querySelector(".rank").textContent = rank ? `#${rank} · ${paper.score}` : "";
  const title = node.querySelector(".title");
  title.textContent = paper.title || "(제목 없음)";
  const link = paper.url || paper.doi;
  if (link) title.href = link; else title.removeAttribute("href");
  node.querySelector(".authors").textContent = authorLine(paper.authors);
  node.querySelector(".meta").textContent = metaLine(paper);

  const chips = node.querySelector(".chips");
  if (paper.seed_link) chips.append(el("span", { class: "chip seed", text: "🔗 시드와 연결" }));
  for (const kw of (paper.keywords || []).slice(0, 4)) chips.append(el("span", { class: "chip", text: kw }));

  const abstract = node.querySelector(".abstract");
  if (paper.abstract) abstract.querySelector("p").textContent = paper.abstract;
  else abstract.remove();

  const star = node.querySelector(".star");
  const refreshStar = () => {
    const on = isBookmarked(paper.id);
    star.textContent = on ? "★" : "☆";
    star.classList.toggle("on", on);
    star.title = on ? "북마크 해제" : "북마크";
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
      alert(`북마크 실패: ${e.message}`);
    } finally {
      star.disabled = false;
    }
  });
  if (extra) node.append(extra);
  return node;
}

// ───────────── discover ─────────────

document.querySelectorAll("[data-weight]").forEach((range) => {
  const out = range.nextElementSibling;
  range.addEventListener("input", () => (out.value = Number(range.value).toFixed(2)));
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
  };
  setStatus("search-status", "검색 중…");
  $("results").replaceChildren();
  try {
    const body = await api("POST", "/search", payload);
    state.run = { ...body, query };
    renderResults();
  } catch (e) {
    setStatus("search-status", `검색 실패: ${e.message}`, true);
  }
});

function renderResults() {
  const run = state.run;
  let message = `${run.count}편 표시 (후보 ${run.candidates}편) · ${run.semantic ? "의미 기반 정렬" : "단어 기반 정렬"}`;
  if (run.seeds.length) message += ` · 시드: ${run.seeds.map((s) => s.title).join("; ")}`;
  if (run.unresolved_seeds.length) message += ` · 찾지 못한 시드: ${run.unresolved_seeds.join(", ")}`;
  setStatus("search-status", message);
  $("results").replaceChildren(...run.papers.map((p, i) => paperCard(p, { rank: i + 1, query: run.query })));
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
  select.replaceChildren(el("option", { value: "", text: "전체" }), ...tags.map((t) => el("option", { value: t, text: t })));
  select.value = tags.includes(current) ? current : "";

  const shown = state.bookmarks.filter((b) => !select.value || b.tags.includes(select.value));
  $("bm-empty").hidden = state.bookmarks.length > 0;
  $("bookmarks").replaceChildren(...shown.map((b) => {
    const note = el("textarea", { rows: 2, placeholder: "메모" });
    note.value = b.note;
    const tagInput = el("input", { type: "text", placeholder: "태그 (쉼표로 구분)" });
    tagInput.value = b.tags.join(", ");
    const save = el("button", { text: "저장" });
    const remove = el("button", { class: "danger", text: "삭제" });
    save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        await api("PATCH", `/bookmarks/${b.id}`, { note: note.value, tags: tagInput.value.split(",").map((t) => t.trim()).filter(Boolean) });
        await loadBookmarks();
        renderBookmarks();
      } catch (e) { alert(`저장 실패: ${e.message}`); } finally { save.disabled = false; }
    });
    remove.addEventListener("click", async () => {
      if (!confirm(`"${b.paper.title}" 북마크를 삭제할까요?`)) return;
      await api("DELETE", `/bookmarks/${b.id}`);
      await loadBookmarks();
      renderBookmarks();
    });
    const edit = el("div", { class: "bm-edit" }, note, tagInput, el("div", { class: "buttons" }, save, remove));
    const card = paperCard(b.paper, { query: b.query, extra: edit });
    if (b.query) card.querySelector(".meta").append(el("span", { class: "found-via", text: ` · “${b.query}”에서 찾음` }));
    return card;
  }));
}
$("tag-filter").addEventListener("change", renderBookmarks);

$("export-bib").addEventListener("click", async () => {
  const tag = $("tag-filter").value;
  try {
    const bib = await api("GET", `/bookmarks/export.bib${tag ? `?tag=${encodeURIComponent(tag)}` : ""}`);
    if (!bib.trim()) return alert("내보낼 북마크가 없습니다.");
    alert(await saveFile("research-radar.bib", bib, "application/x-bibtex"));
  } catch (e) { alert(`내보내기 실패: ${e.message}`); }
});

// ───────────── research map ─────────────

$("build-map").addEventListener("click", async () => {
  const source = document.querySelector("input[name=source]:checked").value;
  const useResults = source !== "bookmarks" && state.run;
  if (source === "results" && !state.run) return setStatus("map-status", "먼저 탐색 탭에서 검색하세요.", true);
  if (source === "bookmarks" && !state.bookmarks.length) return setStatus("map-status", "북마크가 없습니다.", true);
  if (!useResults && !state.bookmarks.length) return setStatus("map-status", "검색하거나 논문을 북마크한 뒤 지도를 만들 수 있습니다.", true);

  const payload = {
    papers: useResults ? state.run.papers.map(pick) : [],
    query: useResults ? state.run.query : null,
    include_bookmarks: source !== "results",
    include_foundations: $("foundations").checked,
  };
  $("build-map").disabled = true;
  setStatus("map-status", "연구 흐름을 분석하는 중…");
  try {
    const flow = await api("POST", "/flow", payload);
    const title = useResults ? state.run.query : "My Bookmarks";
    const poster = await api("POST", "/poster", { flow, title });
    Object.assign(state, { flow, poster, posterTitle: title });
    $("poster").srcdoc = poster;
    $("poster").hidden = false;
    $("save-poster").disabled = false;
    setStatus("map-status", `${flow.nodes.length}편 · 인용 연결 ${flow.edges.length}개 · 주제 ${flow.clusters.length}개 — 점·레일·곡선에 마우스를 올리거나 클릭해 보세요.`);
    renderStory(flow);
  } catch (e) {
    setStatus("map-status", `지도를 만들 수 없습니다: ${e.message}`, true);
  } finally {
    $("build-map").disabled = false;
  }
});

$("save-poster").addEventListener("click", async () => {
  if (!state.poster) return;
  const safe = state.posterTitle.replace(/[^\w가-힣 -]+/g, "").trim().replace(/\s+/g, "-") || "research-map";
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
        el("dt", { text: "논문" }), el("dd", { text: `${c.size}편 · ${c.year_min ?? "—"}–${c.year_max ?? "—"}` }),
        el("dt", { text: "시작" }), el("dd", { text: label(c.origin) }),
        el("dt", { text: "핵심" }), el("dd", { text: label(c.hub) }),
        el("dt", { text: "최신" }), el("dd", {}, el("ol", {}, c.frontier.map((id) => el("li", { text: label(id) })))),
      ));
    card.style.setProperty("--lane", LANE_COLORS[c.lane % LANE_COLORS.length]);
    return card;
  });
  if (flow.chain && flow.chain.length) {
    cards.push(el("article", { class: "story-card" },
      el("h3", { text: "핵심 계보" }),
      el("ol", {}, flow.chain.map((id) => el("li", { text: label(id) })))));
  }
  $("story").replaceChildren(...cards);
}

// ───────────── settings ─────────────

async function loadSettings() {
  let s;
  try { s = await api("GET", "/settings"); } catch { return; }
  const key = s.openalex_api_key;
  $("openalex-key-state").textContent = key.set
    ? `저장된 키: ${key.hint}${key.source === "environment" ? " (환경변수)" : ""} — 바꾸려면 새 키를 입력하세요.`
    : "저장된 키가 없습니다.";
  $("openai-key-state").textContent = s.openai_api_key.set ? `저장된 키: ${s.openai_api_key.hint}` : "사용 안 함";
  // only keys saved in the app can be removed here; environment variables stay as they are
  $("clear-openalex-key").hidden = key.source !== "settings";
  $("clear-openai-key").hidden = s.openai_api_key.source !== "settings";
  $("openalex-email").value = s.openalex_email.value || "";
  $("data-dir").textContent = s.data_dir;
  $("key-pill").textContent = key.set ? "OpenAlex 키 ✓" : "OpenAlex 키 없음";
  $("key-pill").className = `pill ${key.set ? "ok" : "warn"}`;
  $("banner").hidden = key.set;
}

for (const [button, field, label] of [["clear-openalex-key", "openalex_api_key", "OpenAlex"], ["clear-openai-key", "openai_api_key", "OpenAI"]]) {
  $(button).addEventListener("click", async () => {
    if (!confirm(`저장된 ${label} 키를 삭제할까요?`)) return;
    await api("PUT", "/settings", { [field]: "" });
    setStatus("settings-status", `${label} 키를 삭제했습니다.`);
    await loadSettings();
  });
}

$("toggle-key").addEventListener("click", () => {
  const input = $("openalex-key");
  input.type = input.type === "password" ? "text" : "password";
  $("toggle-key").textContent = input.type === "password" ? "보기" : "숨기기";
});

$("test-key").addEventListener("click", async () => {
  const result = $("test-result");
  result.className = "test-result";
  result.textContent = "확인 중…";
  try {
    const r = await api("POST", "/settings/test-openalex", { api_key: $("openalex-key").value.trim() || null });
    const budget = r.remaining_usd != null && r.limit_usd ? ` 오늘 남은 한도: $${r.remaining_usd.toFixed(3)} / $${r.limit_usd}` : "";
    result.textContent = (r.ok ? "✓ " : "✗ ") + r.message + budget;
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
    setStatus("settings-status", "저장했습니다.");
    await loadSettings();
  } catch (e) {
    setStatus("settings-status", `저장 실패: ${e.message}`, true);
  }
});

// ───────────── start ─────────────

loadSettings();
loadBookmarks();
