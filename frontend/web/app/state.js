// What the screens share: the last search, the bookmarks, the map, and so on.

export const state = {
  run: null, // the last search, with its settings
  bookmarks: [],
  follows: [],
  flow: null, // the research map
  flowRun: null, // the search the map was drawn from
  poster: null,
  posterTitle: "",
  evalMode: false,
  judgments: {},
  version: null,
  changelog: null,
  readingGoal: null,
  librarySignInUrl: null,
};

const PAPER_FIELDS = [
  "id",
  "title",
  "abstract",
  "year",
  "doi",
  "url",
  "open_access_url",
  "venue",
  "venue_id",
  "authors",
  "author_ids",
  "citations",
  "referenced_works",
  "keywords",
  "topic",
];

/** A paper with only the fields the backend keeps. */
export const pick = (paper) => Object.fromEntries(PAPER_FIELDS.map((k) => [k, paper[k] ?? null]));

/** "W2116341502" from "https://openalex.org/W2116341502". */
export const shortId = (id) => id.replace(/\/+$/, "").split("/").pop();

/** Only http(s) links are followed: paper links come from publishers, and saved bookmarks may
 * predate the backends' own check. */
export const webUrl = (url) => (typeof url === "string" && /^https?:\/\//i.test(url.trim()) ? url.trim() : null);
