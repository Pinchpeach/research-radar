// The app's screens. index.html loads i18n.js (t(), LANG), then this module; on Android,
// mobile.js sets up the in-page backend first and then imports it.
//
// Each page has a module of its own; importing it wires its buttons, and nav.js shows its page.
//   home.js       the search box, recent searches, opening a DOI or link
//   discover.js   search and results            evaluation.js  judging results
//   cards.js      a paper's card                follows.js     following authors and journals
//   bookmarks.js  bookmarks, Zotero in and out  documents.js   PDFs and notes in the reader
//   reading.js    this month's reading          map.js         the research map
//   news.js       updates and what's new        settings.js    settings and language

import { toBase64 } from "./api.js";
import { loadBookmarks } from "./bookmarks.js";
import "./discover.js";
import "./documents.js";
import { loadEvaluations } from "./evaluation.js";
import { loadFollows, updateNewsBadge } from "./follows.js";
import "./home.js";
import "./map.js";
import { showTab } from "./nav.js";
import { checkVersion } from "./news.js";
import "./reading.js";
import { loadSettings } from "./settings.js";

window.radarBase64 = toBase64; // mobile.js saves files with it

applyStaticText();
showTab("home");
loadSettings({ applyLanguage: true });
loadBookmarks();
loadFollows().then(updateNewsBadge);
checkVersion();
loadEvaluations();
