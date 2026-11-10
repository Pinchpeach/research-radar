// A paper's card: title, authors, why it is shown (chips), and what can be done with it.

import { api } from "./api.js";
import { isBookmarked, loadBookmarks } from "./bookmarks.js";
import { $, el } from "./dom.js";
import { judgeButtons } from "./evaluation.js";
import { followMenu } from "./follows.js";
import { startFrom } from "./home.js";
import { readPaper } from "./documents.js";
import { pick, shortId, webUrl } from "./state.js";

const KEY_PAPER = 0.5; // flow-importance score from which a paper is badged as a key paper
const PERSONAL_CHIP = 0.7; // closeness to the person's bookmarks from which a paper says so

/** `rank` and `query` for search results; `extra` is added at the bottom (a bookmark's note). */
export function paperCard(paper, { rank, query, extra } = {}) {
  const node = $("paper-template").content.firstElementChild.cloneNode(true);
  applyStaticText(node);
  node.querySelector(".rank").textContent = rank ? `#${rank} · ${paper.score}` : "";
  const title = node.querySelector(".title");
  title.textContent = paper.title || t("paper.noTitle");
  const link = webUrl(paper.url) || webUrl(paper.doi);
  if (link) title.href = link;
  else title.removeAttribute("href");
  node.querySelector(".authors").textContent = authorLine(paper.authors);
  node.querySelector(".meta").textContent = metaLine(paper);
  node.querySelector(".chips").append(...chips(paper));

  followMenu(node.querySelector(".follow"), paper);
  node.querySelector(".from-here").addEventListener("click", () => startFrom(paper, query));
  node.querySelector(".read-pdf").addEventListener("click", () => readPaper(paper));

  const abstract = node.querySelector(".abstract");
  if (paper.abstract) abstract.querySelector("p").textContent = paper.abstract;
  else abstract.remove();

  bookmarkStar(node.querySelector(".star"), paper, query);
  const judge = node.querySelector(".judge");
  if (rank) judgeButtons(judge, paper);
  else judge.remove();
  if (extra) node.append(extra);
  return node;
}

function authorLine(authors) {
  if (!authors || !authors.length) return t("paper.noAuthors");
  return authors.slice(0, 5).join(", ") + (authors.length > 5 ? t("paper.etAl") : "");
}

function metaLine(paper) {
  return [paper.year || "—", paper.venue, t("paper.citations", { n: Number(paper.citations || 0).toLocaleString() })]
    .filter(Boolean)
    .join(" · ");
}

/** Why the paper is shown: a key paper, recent work, a classic the results cite, close to the seeds or bookmarks. */
function chips(paper) {
  const scores = paper.scores || {};
  const out = [];
  if (scores.influence >= KEY_PAPER) {
    const why = paper.cited_by_results ? t("chip.keyCitedBy", { n: paper.cited_by_results }) : t("chip.keyGeneric");
    out.push(
      el("span", {
        class: "chip key",
        text: t("chip.key"),
        title: t("chip.keyTitle", { score: scores.influence.toFixed(2), why }),
      }),
    );
  }
  if (paper.group === "recent") {
    const links = paper.builds_on_key_papers ? t("chip.recentLinks", { n: paper.builds_on_key_papers }) : "";
    out.push(
      el("span", {
        class: "chip recent",
        text: t("chip.recent") + links,
        title: t("chip.recentTitle", { score: (scores.frontier || 0).toFixed(2) }),
      }),
    );
  }
  if (paper.core_reference)
    out.push(el("span", { class: "chip", text: t("chip.coreRef"), title: t("chip.coreRefTitle") }));
  if (paper.seed_link) out.push(el("span", { class: "chip seed", text: t("chip.seed") }));
  if (scores.personal >= PERSONAL_CHIP) {
    out.push(
      el("span", {
        class: "chip personal",
        text: t("chip.personal"),
        title: t("chip.personalTitle", { score: scores.personal.toFixed(2) }),
      }),
    );
  }
  for (const keyword of (paper.keywords || []).slice(0, 4)) out.push(el("span", { class: "chip", text: keyword }));
  return out;
}

/** ☆ / ★: bookmark the paper, or remove the bookmark. */
function bookmarkStar(star, paper, query) {
  const paint = () => {
    const on = isBookmarked(paper.id);
    star.textContent = on ? "★" : "☆";
    star.classList.toggle("on", on);
    star.title = on ? t("paper.unbookmark") : t("paper.bookmark");
  };
  paint();
  star.addEventListener("click", async () => {
    star.disabled = true;
    try {
      if (isBookmarked(paper.id)) await api("DELETE", `/bookmarks/${shortId(paper.id)}`);
      else await api("PUT", "/bookmarks", { paper: pick(paper), query });
      await loadBookmarks();
      paint();
    } catch (e) {
      alert(t("paper.bookmarkFailed", { error: e.message }));
    } finally {
      star.disabled = false;
    }
  });
}
