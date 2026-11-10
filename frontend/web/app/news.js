// News and updates: a newer release on GitHub, what changed in each version, and (follows.js)
// new papers from followed authors and journals.

import { api } from "./api.js";
import { $, el } from "./dom.js";
import { renderFollowNews, updateNewsBadge } from "./follows.js";
import { currentTab, onPage } from "./nav.js";
import { state } from "./state.js";

/** A newer release, announced only with a link to GitHub (the link comes from GitHub's API). */
export const newRelease = (info) =>
  Boolean(info && info.update_available && /^https:\/\/github\.com\//.test(info.latest.url || ""));

/** This version, and whether a newer one exists (shown in Settings, the menu and News). */
export async function checkVersion() {
  let info;
  try {
    info = await api("GET", "/version");
  } catch {
    return;
  }
  state.version = info;
  $("app-version").textContent = `v${info.version}`;
  updateNewsBadge();
  if (newRelease(info)) {
    $("update-state").replaceChildren(
      "· ",
      el("a", {
        href: info.latest.url,
        target: "_blank",
        rel: "noopener",
        text: t("set.newVersion", { version: info.latest.version }),
      }),
    );
  } else {
    $("update-state").textContent = info.latest ? t("set.latest") : "";
  }
  if (currentTab === "news") renderNews();
}

export async function renderNews() {
  renderFollowNews();
  const info = state.version;
  const card = $("update-card");
  card.hidden = !newRelease(info);
  if (!card.hidden) {
    card.href = info.latest.url;
    card.textContent = t("news.update", { version: info.latest.version });
  }
  if (!state.changelog) {
    try {
      state.changelog = await api("GET", "/changelog");
    } catch {
      return;
    }
  }
  const current = info ? info.version : null;
  $("changelog").replaceChildren(
    ...state.changelog.map((release) =>
      el(
        "li",
        { class: "release" },
        el(
          "h3",
          {},
          `v${release.version}`,
          release.version === current ? el("span", { class: "chip", text: t("news.current") }) : null,
          el("small", { text: release.date || "" }),
        ),
        el(
          "ul",
          {},
          (release[LANG] || release.ko).map((line) => el("li", { text: line })),
        ),
      ),
    ),
  );
}
onPage("news", renderNews);
