// Judging search results (relevant / partly / not), with Precision@k and nDCG live, saved for
// comparing ranking settings. The metrics are core/evaluation.js, the same as backend/evaluation.py.

import { ndcgAt, precisionAt } from "../core/evaluation.js";
import { api } from "./api.js";
import { $, el, setStatus } from "./dom.js";
import { renderResults } from "./discover.js";
import { state } from "./state.js";

const fmt = (v) => (v == null ? "—" : v.toFixed(2));

/** A result card's judgment buttons, shown while judging; otherwise none. */
export function judgeButtons(judge, paper) {
  if (!state.evalMode) return judge.remove();
  judge.hidden = false;
  const paint = () =>
    judge
      .querySelectorAll("button")
      .forEach((b) => b.classList.toggle("on", state.judgments[paper.id] === b.dataset.j));
  paint();
  judge.addEventListener("click", (event) => {
    const value = event.target.dataset && event.target.dataset.j;
    if (!value) return;
    state.judgments[paper.id] = state.judgments[paper.id] === value ? undefined : value; // click again to clear
    paint();
    updateMetrics();
  });
}

export function updateMetrics() {
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

/** Saved runs, newest first, each with its scores and the weights it was ranked with. */
export async function loadEvaluations() {
  let runs = [];
  try {
    runs = await api("GET", "/evaluations");
  } catch {
    /* shown as empty */
  }
  $("eval-empty").hidden = runs.length > 0;
  $("eval-table").hidden = runs.length === 0;
  $("eval-table")
    .querySelector("tbody")
    .replaceChildren(...runs.map(runRow));
}

function runRow(run) {
  const w = (run.settings && run.settings.weights) || {};
  const weights = ["relevance", "influence", "impact", "recency", "seed"]
    .map((k) => (w[k] ?? 0).toFixed(2))
    .join(" · ");
  const remove = el("button", {
    text: t("eval.delete"),
    title: t("eval.deleteTitle"),
    onclick: async () => {
      if (!confirm(t("eval.deleteConfirm", { query: run.query }))) return;
      await api("DELETE", `/evaluations/${encodeURIComponent(run.run_id)}`);
      loadEvaluations();
    },
  });
  return el(
    "tr",
    {},
    el("td", { text: run.saved_at ? new Date(run.saved_at).toLocaleString() : "—" }),
    el("td", { text: run.query }),
    el("td", { class: "num", text: String(run.judged) }),
    el("td", { class: "num", text: fmt(run["p@10"]) }),
    el("td", { class: "num", text: fmt(run["p@20"]) }),
    el("td", { class: "num", text: fmt(run["ndcg@20"]) }),
    el("td", { class: "num", text: weights }),
    el("td", {}, remove),
  );
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
      run_id: run.runId,
      query: run.query,
      settings: run.settings,
      papers: run.papers.map((p) => ({ id: p.id, title: p.title, score: p.score })),
      judgments,
    });
    setStatus("search-status", t("eval.saved", { n: res.written }));
    $("eval-history").open = true;
    loadEvaluations();
  } catch (e) {
    setStatus("search-status", t("eval.saveFailed", { error: e.message }), true);
  }
});
