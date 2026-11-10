// Home: the search box, recent searches (with how many papers came out since), and opening a
// paper from a DOI or a link.

import { api } from "./api.js";
import { $, el, setStatus } from "./dom.js";
import { onPage, showTab } from "./nav.js";
import { shortId } from "./state.js";

const GREETINGS = 8;
const EXAMPLE_TOPICS = [
  "graph neural networks",
  "CRISPR gene editing",
  "optical observations of isolated neutron stars",
  "microplastics in freshwater",
  "protein structure prediction",
];
const greeting = Math.floor(Math.random() * GREETINGS); // one per app start, so it doesn't change under you

export async function renderHome() {
  $("greeting").textContent = t(`greet.${greeting}`);
  let recent = [];
  try {
    recent = (await api("GET", "/history?limit=5")).map((e) => e.query);
  } catch {
    /* shown as suggestions */
  }
  const topics = recent.length ? recent : EXAMPLE_TOPICS.slice(0, 3);
  $("recent-label").textContent = t(recent.length ? "home.recent" : "home.try");
  $("recent-topics").replaceChildren(
    ...topics.map((query, i) => {
      const chip = el("button", {
        type: "button",
        class: recent.length ? "topic recent" : "topic",
        text: query,
        title: query,
        onclick: () => searchFor(query),
      });
      chip.style.setProperty("--i", i);
      return el("li", {}, chip);
    }),
  );
  if (recent.length) markNewPapers();
}
onPage("home", renderHome);

/** "새 논문 N편" on recent topics with papers published since they were last searched. */
async function markNewPapers() {
  let counts = [];
  try {
    counts = await api("GET", "/history/new?limit=3");
  } catch {
    return;
  }
  const chips = [...$("recent-topics").querySelectorAll(".topic")];
  for (const { query, since, new_papers: n } of counts) {
    const chip = chips.find((c) => c.title === query);
    if (!chip || !n || chip.querySelector(".new")) continue;
    chip.append(
      el("span", {
        class: "new",
        text: t("home.new", { n: n > 99 ? "99+" : n }),
        title: t("home.newTitle", { since }),
      }),
    );
  }
}

/** Open Discover and search for `query` there. */
export function searchFor(query) {
  $("query").value = query;
  showTab("discover");
  $("search-form").requestSubmit();
}

/** Search again with `paper` as the seed: what it cites, what cites it, and what is close to it. */
export function startFrom(paper, query) {
  $("seeds").value = shortId(paper.id);
  $("query").value = (query || paper.title || "").slice(0, 300);
  showTab("discover");
  $("search-form").requestSubmit();
}

/**
 * The paper a piece of text points at, as OpenAlex takes it: a DOI (bare, doi.org, or inside a
 * publisher's or a shared link), an arXiv page (arXiv's own DOI), or an OpenAlex work. Null if none.
 */
export function paperIdentifier(text) {
  let value = String(text || "").trim();
  try {
    value = decodeURIComponent(value);
  } catch {
    /* not encoded */
  }
  const openalex = /(?:openalex\.org\/(?:works\/)?|^)(W\d{3,})(?![\w])/i.exec(value);
  if (openalex) return openalex[1].toUpperCase();
  const arxiv = /arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?/i.exec(value);
  if (arxiv) return `10.48550/arXiv.${arxiv[1]}`;
  const doi = /\b(10\.\d{4,9}\/[^\s"'<>]+)/i.exec(value);
  if (!doi) return null;
  let found = doi[1].replace(/[.,;:]+$/, "");
  while (found.endsWith(")") && (found.match(/\(/g) || []).length < (found.match(/\)/g) || []).length)
    found = found.slice(0, -1);
  return found.replace(/\/(?:full|abstract|pdf|epdf)$/i, "");
}

/**
 * Open the paper a DOI or link points at: look it up, then search from it. Resolves to whether
 * the text held such a link.
 */
export async function openLink(text) {
  const id = paperIdentifier(text);
  if (!id) return false;
  showTab("discover");
  setStatus("search-status", t("link.finding", { id }));
  try {
    startFrom(await api("GET", `/works/lookup?id=${encodeURIComponent(id)}`));
  } catch (e) {
    setStatus("search-status", t("link.notFound", { id, error: e.message }), true);
  }
  return true;
}

// Android: a DOI or link shared to the app from another app (mobile.js), or other shared text
window.radarOpenLink = openLink;
window.radarSearchFor = searchFor;

$("home-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const query = $("home-query").value.trim();
  if (query.length < 2) return;
  $("home-query").value = "";
  if (paperIdentifier(query)) openLink(query);
  else searchFor(query);
});
