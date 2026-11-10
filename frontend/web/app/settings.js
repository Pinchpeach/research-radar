// Settings: the OpenAlex key and e-mail, the university library, the language, and clearing
// the search history.

import { api } from "./api.js";
import { renderBookmarks } from "./bookmarks.js";
import { renderResults } from "./discover.js";
import { $, setStatus } from "./dom.js";
import { loadEvaluations } from "./evaluation.js";
import { renderHome } from "./home.js";
import { showFlow } from "./map.js";
import { currentTab, onPage, showTitle } from "./nav.js";
import { checkVersion, renderNews } from "./news.js";
import { renderReading } from "./reading.js";
import { state } from "./state.js";

/** Read the settings and show them. With applyLanguage, the saved language replaces this device's. */
export async function loadSettings({ applyLanguage = false } = {}) {
  let s;
  try {
    s = await api("GET", "/settings");
  } catch {
    return;
  }
  state.readingGoal = Number(s.reading_goal && s.reading_goal.value) || null;
  if (!$("tab-reading").hidden) renderReading();
  showKey(s.openalex_api_key);
  $("openalex-email").value = s.openalex_email.value || "";
  showLibrary(s);
  if (window.radarLocalApi)
    $("data-hint").textContent = t("set.dataDirMobile"); // no data folder on a phone
  else $("data-dir").textContent = s.data_dir;
  // the saved language wins over this computer's last choice (e.g. after reinstalling)
  if (applyLanguage && s.language && s.language.value && setLanguage(s.language.value)) refreshText();
  document.querySelectorAll("input[name=language]").forEach((r) => (r.checked = r.value === LANG));
  return s;
}
onPage("settings", loadSettings); // e.g. signed in to the library since

function showKey(key) {
  $("openalex-key-state").textContent = key.set
    ? t("set.keySaved", { hint: key.hint, env: key.source === "environment" ? t("set.keyEnv") : "" })
    : t("set.noKey");
  // only keys saved in the app can be removed here; environment variables stay as they are
  $("clear-openalex-key").hidden = key.source !== "settings";
  $("key-pill").textContent = key.set ? t("pill.ok") : t("pill.missing");
  $("key-pill").className = `pill ${key.set ? "ok" : "warn"}`;
  $("banner").hidden = key.set;
}

function showLibrary(s) {
  const proxy = (s.library_proxy && s.library_proxy.value) || "";
  $("library-proxy").value = proxy;
  $("school-state").textContent = "";
  state.librarySignInUrl = s.library_sign_in_url || null;
  $("library-state").textContent = !proxy
    ? ""
    : t(s.library_signed_in ? "set.librarySignedIn" : "set.libraryNotSignedIn") +
      (window.radarLocalApi && s.library_signed_in ? " " + t("set.libraryMobile") : "");
  const canSignIn =
    window.radarLibrarySignIn || (window.pywebview && window.pywebview.api && window.pywebview.api.library_sign_in);
  $("library-sign-in").hidden = !state.librarySignInUrl || !canSignIn;
  $("library-sign-out").hidden = !s.library_signed_in;
}

/** Re-render everything that was built with t() after the language changes. */
function refreshText() {
  if (state.run) renderResults();
  renderBookmarks();
  loadEvaluations();
  loadSettings();
  checkVersion();
  $("toggle-key").textContent = t($("toggle-key").dataset.i18n);
  if (state.flow) showFlow().catch(() => {});
  showTitle();
  if (currentTab === "home") renderHome();
  if (currentTab === "news") renderNews();
}

document.querySelectorAll("input[name=language]").forEach((radio) =>
  radio.addEventListener("change", async () => {
    if (!setLanguage(radio.value)) return;
    let error = null;
    try {
      await api("PUT", "/settings", { language: LANG });
    } catch (e) {
      error = e;
    }
    refreshText();
    if (error) setStatus("language-status", t("set.saveFailed", { error: error.message }), true);
    else setStatus("language-status", t("set.languageSaved"));
  }),
);

$("clear-openalex-key").addEventListener("click", async () => {
  if (!confirm(t("set.clearConfirm", { label: "OpenAlex" }))) return;
  await api("PUT", "/settings", { openalex_api_key: "" });
  setStatus("settings-status", t("set.cleared", { label: "OpenAlex" }));
  await loadSettings();
});

$("clear-history").addEventListener("click", async () => {
  if (!confirm(t("set.historyConfirm"))) return;
  try {
    await api("DELETE", "/history");
    setStatus("history-status", t("set.historyCleared"));
  } catch (e) {
    setStatus("history-status", t("set.saveFailed", { error: e.message }), true);
  }
});

$("toggle-key").addEventListener("click", () => {
  const input = $("openalex-key");
  input.type = input.type === "password" ? "text" : "password";
  $("toggle-key").dataset.i18n = input.type === "password" ? "set.show" : "set.hide";
  $("toggle-key").textContent = t($("toggle-key").dataset.i18n);
});

$("test-key").addEventListener("click", async () => {
  const result = $("test-result");
  result.className = "test-result";
  result.textContent = t("set.testing");
  try {
    const r = await api("POST", "/settings/test-openalex", { api_key: $("openalex-key").value.trim() || null });
    const budget =
      r.remaining_usd != null && r.limit_usd
        ? t("set.budget", { remaining: r.remaining_usd.toFixed(3), limit: r.limit_usd })
        : "";
    const message = r.code ? t(`key.${r.code}`, { status: r.status ?? "" }) : r.message;
    result.textContent = (r.ok ? "✓ " : "✗ ") + message + budget;
    result.classList.add(r.ok ? "ok" : "bad");
  } catch (e) {
    result.textContent = `✗ ${e.message}`;
    result.classList.add("bad");
  }
});

$("settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const key = $("openalex-key").value.trim();
  try {
    await api("PUT", "/settings", key ? { openalex_api_key: key } : {});
    $("openalex-key").value = "";
    setStatus("settings-status", t("set.saved"));
    await loadSettings();
  } catch (e) {
    setStatus("settings-status", t("set.saveFailed", { error: e.message }), true);
  }
});

// the school e-mail fills in the library's address when the app knows the school
$("openalex-email").addEventListener("change", async () => {
  let school = null;
  const email = $("openalex-email").value.trim();
  if (email.includes("@"))
    try {
      school = await api("GET", `/library/school?email=${encodeURIComponent(email)}`);
    } catch {
      /* offline: type it */
    }
  if (school && !$("library-proxy").value.trim()) $("library-proxy").value = school.proxy;
  $("school-state").textContent = !email.includes("@")
    ? ""
    : school
      ? t("set.school", { name: LANG === "ko" ? school.name_ko : school.name_en })
      : t("set.schoolUnknown");
});

$("library-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("PUT", "/settings", {
      openalex_email: $("openalex-email").value.trim(),
      library_proxy: $("library-proxy").value.trim(),
    });
    setStatus("library-status", t("set.saved"));
    await loadSettings();
  } catch (e) {
    setStatus("library-status", t("set.saveFailed", { error: e.message }), true);
  }
});

// sign in to the library once, here, instead of for each paper
$("library-sign-in").addEventListener("click", async () => {
  setStatus("library-status", t("set.librarySigningIn"));
  let ok = false;
  try {
    // Android: a web view inside the app (mobile.js); the desktop app: a window of its own
    ok = window.radarLibrarySignIn ? await window.radarLibrarySignIn() : await window.pywebview.api.library_sign_in();
  } catch {
    /* the window failed to open */
  }
  setStatus("library-status", t(ok ? "set.librarySignInDone" : "set.librarySignInClosed"), !ok);
  await loadSettings();
});

$("library-sign-out").addEventListener("click", async () => {
  await api("DELETE", "/library/session");
  setStatus("library-status", t("set.librarySignedOut"));
  await loadSettings();
});
