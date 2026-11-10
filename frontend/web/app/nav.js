// The ☰ drawer and the pages. Each page module says what to do when its page opens (onPage).

import { $ } from "./dom.js";

const PAGE_TITLES = {
  home: "",
  discover: "tab.discover",
  bookmarks: "tab.bookmarks",
  reading: "tab.reading",
  map: "tab.flow",
  news: "tab.news",
  settings: "tab.settings",
};
const opened = {};

export let currentTab = "home";

/** Run `render` each time the page `name` opens. */
export function onPage(name, render) {
  (opened[name] ||= []).push(render);
}

export function showTab(name) {
  currentTab = name;
  setDrawer(false);
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === name));
  document.querySelectorAll(".panel").forEach((panel) => (panel.hidden = panel.id !== `tab-${name}`));
  document.body.dataset.page = name;
  showTitle();
  window.scrollTo(0, 0);
  for (const render of opened[name] || []) render();
}

export function showTitle() {
  $("page-title").textContent = PAGE_TITLES[currentTab] ? t(PAGE_TITLES[currentTab]) : "";
}

function setDrawer(open) {
  const drawer = $("drawer");
  drawer.classList.toggle("open", open);
  drawer.toggleAttribute("inert", !open);
  drawer.setAttribute("aria-hidden", String(!open));
  $("drawer-backdrop").hidden = !open;
  $("menu-button").setAttribute("aria-expanded", String(open));
  if (open) drawer.querySelector(`.tab[data-tab=${currentTab}]`)?.focus();
}

function showPane(name) {
  document.querySelectorAll(".subtab").forEach((tab) => tab.classList.toggle("active", tab.dataset.pane === name));
  document.querySelectorAll(".pane").forEach((pane) => (pane.hidden = pane.dataset.pane !== name));
}

document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => showTab(tab.dataset.tab)));
document.querySelectorAll(".subtab").forEach((tab) => tab.addEventListener("click", () => showPane(tab.dataset.pane)));
$("menu-button").addEventListener("click", () => setDrawer(!$("drawer").classList.contains("open")));
$("drawer-backdrop").addEventListener("click", () => setDrawer(false));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && $("drawer").classList.contains("open")) setDrawer(false);
});
$("home-logo").addEventListener("click", () => showTab("home"));
$("key-pill").addEventListener("click", () => showTab("settings"));
$("banner-go").addEventListener("click", () => showTab("settings"));
