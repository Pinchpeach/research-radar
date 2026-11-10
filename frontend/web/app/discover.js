// Discover: the search form with its ranking weights, and the results in two groups (the
// field's core papers, then recent work).

import { api } from "./api.js";
import { paperCard } from "./cards.js";
import { $, el, setStatus } from "./dom.js";
import { updateMetrics } from "./evaluation.js";
import { openLink, paperIdentifier } from "./home.js";
import { state } from "./state.js";

const MAX_SEEDS = 10;

/** What the form asks for, as POST /search takes it. */
function searchRequest(query) {
  let seeds = $("seeds")
    .value.split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if ($("bookmark-seeds").checked)
    seeds = [...seeds, ...state.bookmarks.map((b) => b.id).filter((id) => !seeds.includes(id))];
  const weights = Object.fromEntries(
    [...document.querySelectorAll("[data-weight]")].map((r) => [r.dataset.weight, Number(r.value)]),
  );
  return {
    query,
    limit: Number($("limit").value),
    year_from: Number($("year-from").value) || null,
    year_to: Number($("year-to").value) || null,
    seed_ids: seeds.slice(0, MAX_SEEDS),
    require_abstract: $("require-abstract").checked,
    weights,
    recent_share: Number($("recent-share").value),
    recent_years: Number($("recent-years").value),
  };
}

$("search-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = $("query").value.trim();
  if (query.length < 2) return;
  if (paperIdentifier(query)) return openLink(query); // a DOI or a paper's link: start from that paper
  const { query: _, ...settings } = searchRequest(query);
  setStatus("search-status", t("search.running"));
  $("results").replaceChildren();
  try {
    const body = await api("POST", "/search", { query, ...settings });
    state.run = { ...body, query, runId: new Date().toISOString(), settings };
    state.judgments = {};
    renderResults();
  } catch (e) {
    setStatus("search-status", t("search.failed", { error: e.message }), true);
  }
});

export function renderResults() {
  const run = state.run;
  let message = t("search.summary", { count: run.count, candidates: run.candidates });
  if (run.seeds.length) message += t("search.seeds", { seeds: run.seeds.map((s) => s.title).join("; ") });
  if (run.unresolved_seeds.length) message += t("search.unresolved", { seeds: run.unresolved_seeds.join(", ") });
  setStatus("search-status", message);
  const cards = run.papers.map((p, i) => paperCard(p, { rank: i + 1, query: run.query }));
  const core = run.papers.filter((p) => p.group !== "recent").length;
  const recent = run.papers.length - core;
  const head = (label, hint) => el("li", { class: "group-head" }, label, el("small", { text: hint }));
  $("results").replaceChildren(
    ...(recent
      ? [
          head(t("group.core"), t("group.coreHint", { n: core })),
          ...cards.slice(0, core),
          head(t("group.recent"), t("group.recentHint", { n: recent, years: run.settings.recent_years })),
          ...cards.slice(core),
        ]
      : cards),
  );
  $("eval-bar").hidden = false;
  updateMetrics();
}

document.querySelectorAll("[data-weight]").forEach((range) => {
  const out = range.nextElementSibling;
  range.addEventListener("input", () => (out.value = Number(range.value).toFixed(2)));
});
$("recent-share").addEventListener(
  "input",
  (e) => ($("recent-share-out").value = `${Math.round(e.target.value * 100)}%`),
);
$("reset-weights").addEventListener("click", () => {
  document.querySelectorAll("[data-weight]").forEach((range) => {
    range.value = range.defaultValue;
    range.nextElementSibling.value = Number(range.value).toFixed(2);
  });
});
