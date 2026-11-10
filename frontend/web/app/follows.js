// Following authors and journals (backend/follows.py): the card's 팔로우 menu, and on News what
// they published since the person last looked.

import { api } from "./api.js";
import { paperCard } from "./cards.js";
import { $, el } from "./dom.js";
import { newRelease } from "./news.js";
import { state } from "./state.js";

const isFollowed = (kind, id) => state.follows.some((f) => f.kind === kind && f.id === id);

export async function loadFollows() {
  try {
    state.follows = await api("GET", "/follows");
  } catch {
    state.follows = [];
  }
}

/** The paper card's 팔로우 menu: its authors (up to 5) and its journal, each followed with a tap. */
export function followMenu(details, paper) {
  const ids = paper.author_ids || [];
  const options = (paper.authors || [])
    .slice(0, 5)
    .map((name, i) => ({ kind: "author", id: ids[i], name }))
    .concat(paper.venue_id && paper.venue ? [{ kind: "source", id: paper.venue_id, name: paper.venue }] : [])
    .filter((o) => o.id);
  if (!options.length) return details.remove();
  details.hidden = false;
  const menu = details.querySelector(".follow-menu");
  const paint = () => menu.replaceChildren(...options.map(followButton));
  const followButton = (o) => {
    const on = isFollowed(o.kind, o.id);
    const button = el("button", {
      type: "button",
      class: on ? "on" : "",
      text: `${on ? "✓ " : "+ "}${o.name}`,
      title: t(o.kind === "author" ? "follow.author" : "follow.source"),
    });
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        if (isFollowed(o.kind, o.id)) await api("DELETE", `/follows/${o.kind}/${o.id}`);
        else await api("PUT", "/follows", { kind: o.kind, id: o.id, name: o.name });
        await loadFollows();
        updateNewsBadge();
      } catch (e) {
        alert(t("follow.failed", { error: e.message }));
      }
      paint();
    });
    return button;
  };
  details.addEventListener("toggle", () => details.open && paint());
}

/** News: what the followed authors and journals published since the person last looked. */
export async function renderFollowNews() {
  let items = [];
  try {
    items = await api("GET", "/follows/new");
  } catch {
    /* offline: shown as empty */
  }
  $("follow-empty").hidden = items.length > 0;
  $("follow-news").replaceChildren(...items.map(followNews));
}

function followNews(item) {
  const after = async (change) => {
    await change;
    await loadFollows();
    renderFollowNews();
    updateNewsBadge();
  };
  const seen = el("button", {
    type: "button",
    class: "small-button",
    text: t("follow.seen"),
    onclick: () => after(api("POST", `/follows/${item.kind}/${item.id}/seen`)),
  });
  const stop = el("button", {
    type: "button",
    class: "link-button small",
    text: t("follow.stop"),
    onclick: () => after(api("DELETE", `/follows/${item.kind}/${item.id}`)),
  });
  const count =
    item.count == null
      ? t("follow.offline")
      : item.count
        ? t("follow.count", { n: item.count, since: item.since })
        : t("follow.none", { since: item.since });
  return el(
    "div",
    { class: "follow-item" },
    el(
      "h3",
      {},
      el("span", { class: "chip", text: t(item.kind === "author" ? "follow.authorChip" : "follow.sourceChip") }),
      ` ${item.name} `,
      el("small", { text: count }),
      item.count ? seen : null,
      stop,
    ),
    item.papers.length ? el("ol", { class: "papers" }, ...item.papers.map((p) => paperCard(p))) : null,
  );
}

/** The menu's News badge: a new version, or new papers from followed authors and journals. */
export async function updateNewsBadge() {
  let papers = 0;
  if (state.follows.length) {
    try {
      papers = (await api("GET", "/follows/new")).reduce((n, f) => n + (f.count || 0), 0);
    } catch {
      /* offline */
    }
  }
  const update = newRelease(state.version);
  $("menu-dot").hidden = !update && !papers;
  $("news-badge").hidden = !update && !papers;
  $("news-badge").textContent = update ? t("news.new") : String(papers > 99 ? "99+" : papers);
}
