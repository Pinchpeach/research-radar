// The research map: the papers' topics, citations and lineages drawn as an interactive poster
// (in a sandboxed frame), with a short story of each topic below.

import { api, saveFile } from "./api.js";
import { $, el, setStatus } from "./dom.js";
import { onPage } from "./nav.js";
import { pick, state } from "./state.js";

const LANE_COLORS = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#9085e9"];

async function drawFlow() {
  const source = document.querySelector("input[name=source]:checked").value;
  const useResults = source !== "bookmarks" && state.run;
  if (source === "results" && !state.run) return setStatus("map-status", t("flow.needSearch"), true);
  if (source === "bookmarks" && !state.bookmarks.length) return setStatus("map-status", t("flow.noBookmarks"), true);
  if (!useResults && !state.bookmarks.length) return setStatus("map-status", t("flow.needPapers"), true);

  const request = {
    papers: useResults ? state.run.papers.map(pick) : [],
    query: useResults ? state.run.query : null,
    include_bookmarks: source !== "results",
    include_foundations: $("foundations").checked,
  };
  $("build-map").disabled = true;
  setStatus("map-status", t("flow.running"));
  try {
    state.flow = await api("POST", "/flow", request);
    state.posterTitle = useResults ? state.run.query : null;
    state.flowRun = state.run && state.run.runId;
    await showFlow();
  } catch (e) {
    setStatus("map-status", t("flow.failed", { error: e.message }), true);
  } finally {
    $("build-map").disabled = false;
  }
}

/** Opening the map page draws the latest search (and bookmarks) without another click. */
function autoDrawFlow() {
  if ($("build-map").disabled) return;
  const fresh = state.run && state.flowRun !== state.run.runId;
  if (fresh || (!state.flow && state.bookmarks.length)) drawFlow();
}
onPage("map", autoDrawFlow);

/** The map's fonts, inlined: the map runs in a sandboxed frame with no access to the app, so it
 * cannot load the app's files (and a saved poster keeps its look offline). Loaded once. */
let mapFonts = null;
function mapFontFaces() {
  const face = async ([file, weight]) => {
    const blob = await (await fetch(new URL(`../fonts/NanumSquareRound${file}.woff2`, import.meta.url))).blob();
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(new Blob([blob], { type: "font/woff2" }));
    });
    return `@font-face{font-family:NanumSquareRound;font-weight:${weight};src:url("${data}") format("woff2")}`;
  };
  mapFonts ??= Promise.all(
    [
      ["L", 300],
      ["R", 400],
      ["B", 700],
    ].map(face),
  )
    .then((faces) => faces.join(""))
    .catch(() => ""); // without them the map uses the system font
  return mapFonts;
}

/** Draw the analyzed flow in the current language (again after a language switch). */
export async function showFlow() {
  const flow = state.flow;
  const title = state.posterTitle || t("flow.myBookmarks");
  const poster = await api("POST", "/poster", { flow, title, lang: LANG });
  // on the app's light background the map is light too (and saved the way it is shown)
  const light = !matchMedia("(prefers-color-scheme: dark)").matches;
  const fonts = await mapFontFaces();
  state.poster = (light ? poster.replace("<html ", '<html class="light" ') : poster).replace(
    "<style>",
    () => `<style>${fonts}`,
  );
  $("poster").srcdoc = state.poster;
  $("poster").hidden = false;
  $("save-poster").disabled = false;
  const touch = matchMedia("(pointer: coarse)").matches;
  setStatus(
    "map-status",
    t(touch ? "flow.doneTouch" : "flow.done", {
      nodes: flow.nodes.length,
      edges: flow.edges.length,
      topics: flow.clusters.length,
    }),
  );
  renderStory(flow);
}

/** Each topic's story (how many papers, where it started, its hub, its latest), then the main lineage. */
function renderStory(flow) {
  const nodes = Object.fromEntries(flow.nodes.map((n) => [n.id, n]));
  const label = (id) => (nodes[id] ? `${nodes[id].title} (${nodes[id].year ?? "—"})` : "—");
  const list = (ids) =>
    el(
      "ol",
      {},
      ids.map((id) => el("li", { text: label(id) })),
    );
  const cards = [...flow.clusters]
    .sort((a, b) => a.lane - b.lane)
    .map((c) => {
      const card = el(
        "article",
        { class: "story-card" },
        el("h3", { text: c.label }),
        el(
          "dl",
          {},
          el("dt", { text: t("story.papers") }),
          el("dd", { text: t("story.papersValue", { n: c.size, from: c.year_min ?? "—", to: c.year_max ?? "—" }) }),
          el("dt", { text: t("story.origin") }),
          el("dd", { text: label(c.origin) }),
          el("dt", { text: t("story.hub") }),
          el("dd", { text: label(c.hub) }),
          el("dt", { text: t("story.latest") }),
          el("dd", {}, list(c.frontier)),
        ),
      );
      card.style.setProperty("--lane", LANE_COLORS[c.lane % LANE_COLORS.length]);
      return card;
    });
  if (flow.chain && flow.chain.length)
    cards.push(el("article", { class: "story-card" }, el("h3", { text: t("story.chain") }), list(flow.chain)));
  $("story").replaceChildren(...cards);
}

$("build-map").addEventListener("click", drawFlow);
$("save-poster").addEventListener("click", async () => {
  if (!state.poster) return;
  const name =
    (state.posterTitle || t("flow.myBookmarks"))
      .replace(/[^\w가-힣 -]+/g, "")
      .trim()
      .replace(/\s+/g, "-") || "research-map";
  setStatus("map-status", await saveFile(`${name}.html`, state.poster, "text/html"));
});
