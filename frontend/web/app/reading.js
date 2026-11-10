// Reading: this month's papers read as a thermometer filling towards the person's goal, and
// what they are reading now.

import { api } from "./api.js";
import { statusControl } from "./bookmarks.js";
import { $, el, localDate, setStatus } from "./dom.js";
import { onPage } from "./nav.js";
import { state, webUrl } from "./state.js";

const DEFAULT_GOAL = 10;

function readThisMonth(now) {
  return state.bookmarks
    .filter((b) => b.status === "read" && b.read_at)
    .filter((b) => {
      const d = new Date(b.read_at);
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    })
    .sort((a, b) => (a.read_at < b.read_at ? 1 : -1));
}

function readRow(bookmark, when) {
  const link = webUrl(bookmark.paper.url) || webUrl(bookmark.paper.doi);
  const title = el(link ? "a" : "span", {
    class: "title",
    href: link,
    target: link ? "_blank" : null,
    rel: link ? "noopener" : null,
    text: bookmark.paper.title || t("paper.noTitle"),
  });
  return el(
    "li",
    { class: "read-row" },
    title,
    el("span", { class: "meta", text: when }),
    statusControl(bookmark, renderReading),
  );
}

export function renderReading() {
  const now = new Date();
  const goal = state.readingGoal || DEFAULT_GOAL;
  const reads = readThisMonth(now);
  const n = reads.length;
  $("reading-month").textContent = localDate(now, { year: "numeric", month: "long" });
  $("reading-cheer").textContent = t(n === 0 ? "read.cheerZero" : n >= goal ? "read.cheerGoal" : "read.cheer");
  $("reading-count").textContent = String(n);
  $("reading-of").textContent = t("read.of", { goal });
  fillThermometer(n, goal);
  if (document.activeElement !== $("reading-goal")) $("reading-goal").value = String(goal);

  $("read-empty").hidden = n > 0;
  $("read-list").replaceChildren(...reads.map((b) => readRow(b, t("read.readOn", { date: localDate(b.read_at) }))));
  const reading = state.bookmarks.filter((b) => b.status === "reading");
  $("reading-empty").hidden = reading.length > 0;
  $("reading-list").replaceChildren(
    ...reading.map((b) => readRow(b, b.query ? t("bm.foundVia", { query: b.query }).replace(/^\s*·\s*/, "") : "")),
  );
}
onPage("reading", renderReading);

function fillThermometer(n, goal) {
  $("thermo").setAttribute("aria-label", t("read.aria", { n, goal }));
  $("thermo").classList.toggle("done", n >= goal);
  // from empty, so the mercury rises each time the page opens
  $("mercury").style.height = "0%";
  const full = Math.min(1, n / goal);
  requestAnimationFrame(() => requestAnimationFrame(() => ($("mercury").style.height = `${(full * 100).toFixed(1)}%`)));
  $("ticks").replaceChildren(
    ...[goal, Math.round(goal / 2), 0].map((v) =>
      el("span", { style: `bottom:${((v / goal) * 100).toFixed(1)}%`, text: String(v) }),
    ),
  );
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
