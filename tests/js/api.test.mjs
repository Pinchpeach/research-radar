// Unit tests for the JavaScript backend the Android app uses:  node --test tests/js
// (tests/test_js_core.py checks it against the Python backend.)

import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { ApiError, createApi } from "../../frontend/web/core/api.js";
import { memoryStorage } from "../../frontend/web/core/store.js";
import { tfidf, TOPIC_TOKENS } from "../../frontend/web/core/text.js";
import { kmeans } from "../../frontend/web/core/kmeans.js";
import { buildFlow } from "../../frontend/web/core/flow.js";
import { citationContext } from "../../frontend/web/core/context.js";
import { VERSION } from "../../frontend/web/core/version.js";

const template = fs.readFileSync(new URL("../../frontend/web/shared/poster.html", import.meta.url), "utf8");
const reply = (status, body, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: new Headers(headers), json: async () => body });

function work(id, title, { year = 2020, cites = 0, refs = [], abstract = "" } = {}) {
  const inverted = {};
  abstract.split(" ").filter(Boolean).forEach((w, i) => (inverted[w] ??= []).push(i));
  return { id: `https://openalex.org/${id}`, title, publication_year: year, cited_by_count: cites,
    referenced_works: refs.map((r) => `https://openalex.org/${r}`), abstract_inverted_index: inverted,
    authorships: [{ author: { display_name: "Ada Lovelace" } }], primary_location: { source: { display_name: "ApJ" } } };
}

const WORKS = [
  work("W1", "Optical counterpart of isolated neutron star", { year: 1998, cites: 300, abstract: "optical photometry isolated neutron star" }),
  work("W2", "Deep optical imaging of neutron stars", { year: 2005, cites: 120, refs: ["W1"], abstract: "optical imaging isolated neutron star" }),
  work("W3", "Gravitational wave detector design", { year: 2000, cites: 500, abstract: "gravitational wave interferometer detector" }),
  work("W4", "Gravitational waves from binary mergers", { year: 2025, cites: 9, refs: ["W3", "W1"], abstract: "gravitational wave binary merger neutron star" }),
];

function setup({ handler } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push(url);
    if (handler) return handler(url, init);
    const u = new URL(url);
    if (u.hostname === "api.github.com") return reply(200, { tag_name: "v9.0.0", html_url: "https://example.org/r", published_at: "x" });
    const ids = /ids\.openalex:([^,]+)/.exec(u.searchParams.get("filter") || "");
    if (ids) return reply(200, { results: WORKS.filter((w) => ids[1].split("|").includes(w.id.split("/").pop())) });
    return reply(200, { results: WORKS }, { "x-ratelimit-remaining-usd": "0.5", "x-ratelimit-limit-usd": "1" });
  };
  const api = createApi({ fetch, storage: memoryStorage(), version: "0.5.0", releasesRepo: "o/r", posterTemplate: async () => template,
    today: () => new Date("2026-06-01T00:00:00Z") });
  return { api, calls };
}

test("search ranks candidates and fills in the response like FastAPI", async () => {
  const { api, calls } = setup();
  const res = await api("POST", "/search", { query: "neutron star optical", limit: 2 });
  assert.equal(res.query, "neutron star optical");
  assert.equal(res.candidates, 4);
  assert.equal(res.papers[0].group, "core");
  assert.ok(res.papers.some((p) => p.group === "recent" && p.id.endsWith("W4")), "a recent paper is added on top");
  assert.equal(res.papers[0].core_reference, false);
  assert.ok(res.papers[0].scores.relevance > 0);
  assert.ok(calls.some((u) => u.includes("from_publication_date%3A2025-01-01")), "recent-only search for the last two years");
});

test("the API key travels in the query string and the e-mail as mailto", async () => {
  const { api, calls } = setup();
  await api("PUT", "/settings", { openalex_api_key: "secret-key-1234", openalex_email: "me@uni.edu" });
  await api("POST", "/search", { query: "neutron star" });
  const url = new URL(calls[0]);
  assert.equal(url.searchParams.get("api_key"), "secret-key-1234");
  assert.equal(url.searchParams.get("mailto"), "me@uni.edu");
});

test("validation errors are 422, like pydantic", async () => {
  const { api } = setup();
  for (const body of [{ query: "x" }, { query: "ok", limit: 0 }, { query: "ok", year_from: 2010, year_to: 2000 }, { query: "ok", recent_share: 0.9 }]) {
    await assert.rejects(api("POST", "/search", body), (e) => e instanceof ApiError && e.status === 422);
  }
  await assert.rejects(api("PUT", "/settings", { language: "fr" }), (e) => e.status === 422);
  await assert.rejects(api("POST", "/poster", { flow: { nodes: [] }, lang: "de" }), (e) => e.status === 422);
});

test("rate limits become 429 with guidance and other failures 502", async () => {
  let { api } = setup({ handler: () => reply(429, { message: "Insufficient budget." }, { "retry-after": "7200" }) });
  await assert.rejects(api("POST", "/search", { query: "neutron star" }), (e) => e.status === 429 && /Settings/.test(e.message) && /3 h/.test(e.message));
  ({ api } = setup({ handler: async () => { throw new TypeError("Failed to fetch"); } }));
  await assert.rejects(api("POST", "/search", { query: "neutron star" }), (e) => e.status === 502);
});

test("settings never return a full key and can be cleared", async () => {
  const { api } = setup();
  const view = await api("PUT", "/settings", { openalex_api_key: "0123456789abcdefWXYZ", language: "en" });
  assert.deepEqual(view.openalex_api_key, { set: true, source: "settings", hint: "••••••WXYZ" });
  assert.equal(view.language.value, "en");
  assert.ok(!JSON.stringify(view).includes("0123456789abcdef"));
  const cleared = await api("PUT", "/settings", { openalex_api_key: "" });
  assert.equal(cleared.openalex_api_key.set, false);
  assert.equal(cleared.language.value, "en", "fields left out stay");
});

test("key check reports the budget", async () => {
  const { api } = setup();
  const res = await api("POST", "/settings/test-openalex", { api_key: "k" });
  assert.deepEqual(res, { ok: true, code: "ok", message: "The key works.", remaining_usd: 0.5, limit_usd: 1 });
  const bad = setup({ handler: () => reply(401, {}) });
  assert.equal((await bad.api("POST", "/settings/test-openalex", {})).code, "rejected");
});

test("bookmarks: save, keep note on re-save, update, filter, export, delete", async () => {
  const { api } = setup();
  const paper = { id: "https://openalex.org/W2", title: "Deep optical imaging", year: 2005, authors: ["Ada Lovelace"], doi: "https://doi.org/10.1/W2" };
  const saved = await api("PUT", "/bookmarks", { paper, note: "classic", tags: ["Optics", "optics", " key "], query: "q" });
  assert.equal(saved.id, "W2");
  assert.deepEqual(saved.tags, ["optics", "key"]);
  const resaved = await api("PUT", "/bookmarks", { paper: { ...paper, citations: 5 } });
  assert.equal(resaved.note, "classic");
  assert.equal(resaved.paper.citations, 5);
  await api("PATCH", "/bookmarks/W2", { tags: ["x"] });
  assert.equal((await api("GET", "/bookmarks?tag=x")).length, 1);
  assert.equal((await api("GET", "/bookmarks?tag=optics")).length, 0);
  const bib = await api("GET", "/bookmarks/export.bib");
  assert.ok(bib.startsWith("@article{lovelace2005W2,") && bib.includes("doi = {10.1/W2}"));
  assert.equal(await api("DELETE", "/bookmarks/W2"), null);
  await assert.rejects(api("DELETE", "/bookmarks/W2"), (e) => e.status === 404);
});

test("flow includes bookmarks and foundations, poster renders", async () => {
  const { api } = setup();
  await api("PUT", "/bookmarks", { paper: { id: "https://openalex.org/W9", title: "Bookmarked paper about neutron star optics", year: 2010, referenced_works: ["W1"] } });
  await assert.rejects(api("POST", "/flow", { papers: [] }), (e) => e.status === 400);
  const papers = [
    { id: "https://openalex.org/W2", title: "Deep optical imaging of neutron stars", year: 2005, referenced_works: ["W1"] },
    { id: "https://openalex.org/W5", title: "Neutron star optics", year: 2012, referenced_works: ["W1", "W2"] },
  ];
  const flow = await api("POST", "/flow", { papers, include_bookmarks: true });
  const ids = flow.nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, ["W1", "W2", "W5", "W9"]);
  assert.equal(flow.nodes.find((n) => n.id === "W1").role, "foundation");
  assert.equal(flow.nodes.find((n) => n.id === "W9").bookmarked, true);
  const page = await api("POST", "/poster", { flow, title: "Stars", lang: "en" });
  assert.ok(page.startsWith("<!doctype html>") && page.includes(">STARS</text>"));
});

test("evaluations are saved, summarized and deleted", async () => {
  const { api } = setup();
  await assert.rejects(api("POST", "/evaluations", { run_id: "r", query: "q", papers: [], judgments: {} }), (e) => e.status === 400);
  const res = await api("POST", "/evaluations", { run_id: "r1", query: "q", papers: [{ id: "a", title: "A" }, { id: "b", title: "B" }], judgments: { a: "relevant", b: "not_relevant" } });
  assert.equal(res.written, 2);
  const [run] = await api("GET", "/evaluations");
  assert.equal(run.judged, 2);
  assert.equal(run["p@10"], 0.5);
  assert.equal(await api("DELETE", "/evaluations/r1"), null);
  assert.deepEqual(await api("GET", "/evaluations"), []);
});

test("version reports a newer release and survives being offline", async () => {
  const { api } = setup();
  const info = await api("GET", "/version");
  assert.equal(info.update_available, true);
  assert.equal(info.latest.version, "9.0.0");
  const offline = setup({ handler: async () => { throw new TypeError("offline"); } });
  assert.deepEqual(await offline.api("GET", "/version"), { version: "0.5.0", latest: null, update_available: false });
});

test("k-means separates two clear topics and is the same every run", () => {
  const docs = ["optical neutron star photometry", "optical neutron star imaging", "neutron star optical spectrum",
    "gravitational wave detector", "gravitational wave interferometer", "binary merger gravitational wave"];
  const { terms, rows } = tfidf(docs, { tokens: TOPIC_TOKENS });
  const a = kmeans(rows, 2, terms.length), b = kmeans(rows, 2, terms.length);
  assert.deepEqual(a.labels, b.labels);
  assert.equal(new Set(a.labels.slice(0, 3)).size, 1);
  assert.equal(new Set(a.labels.slice(3)).size, 1);
  assert.notEqual(a.labels[0], a.labels[3]);
});

test("citation context lifts papers sharing references with the best text matches", () => {
  const refs = ["R0", "R1", "R2", "R3", "R4", "R5"];
  const papers = [
    { id: "W1", abstract: "a", referenced_works: refs },
    { id: "W2", abstract: "a", referenced_works: refs.slice(1) },
    { id: "W3", abstract: "a", referenced_works: refs.slice(0, 5) },
    { id: "W4", abstract: "" },
    { id: "W5", abstract: "a", referenced_works: ["Q1", "Q2", "Q3", "Q4", "Q5"] },
  ];
  const context = citationContext(papers, [1, 0.9, 0, 0.95, 0.3]);
  assert.ok(context[2] > context[4] && context[3] === 0);
  assert.deepEqual(citationContext([{ id: "W1" }, { id: "W2" }], [1, 0.5]), [0, 0]);
});

test("flow of an empty or one-paper set", () => {
  assert.deepEqual(buildFlow([]), { nodes: [], edges: [], clusters: [], chain: [] });
  const one = buildFlow([{ id: "W1", title: "Alone", year: 2000 }]);
  assert.equal(one.nodes.length, 1);
  assert.deepEqual(one.chain, []);
});

test("searches are remembered newest first, like backend/history.py", async () => {
  const { api } = setup();
  for (const query of ["neutron star", "gravitational waves", "Neutron  Star"]) await api("POST", "/search", { query });
  assert.deepEqual((await api("GET", "/history")).map((e) => e.query), ["Neutron Star", "gravitational waves"]);
  assert.equal((await api("GET", "/history?limit=1")).length, 1);
  assert.equal(await api("DELETE", "/history"), null);
  assert.deepEqual(await api("GET", "/history"), []);
  assert.equal((await api("GET", "/changelog"))[0].version, VERSION);
});

test("only web links survive from OpenAlex", async () => {
  const { normalizeWork, webUrl } = await import("../../frontend/web/core/openalex.js");
  const paper = normalizeWork({ id: "https://openalex.org/W1", doi: "javascript:alert(1)", primary_location: { landing_page_url: " JavaScript:fetch('//evil')" } });
  assert.equal(paper.doi, null);
  assert.equal(paper.url, "https://openalex.org/W1");
  assert.equal(webUrl("data:text/html,<script>1</script>"), null);
});

test("reading status stamps and clears read_at, like backend/storage.py", async () => {
  const { api } = setup();
  await api("PUT", "/bookmarks", { paper: { id: "https://openalex.org/W1", title: "A" } });
  assert.equal((await api("GET", "/bookmarks"))[0].status, "to_read");
  const read = await api("PATCH", "/bookmarks/W1", { status: "read" });
  assert.ok(read.read_at);
  assert.equal((await api("PATCH", "/bookmarks/W1", { note: "n" })).read_at, read.read_at);
  assert.equal((await api("PUT", "/bookmarks", { paper: { id: "https://openalex.org/W1", title: "A2" } })).status, "read");
  assert.equal((await api("PATCH", "/bookmarks/W1", { status: "reading" })).read_at, null);
  await assert.rejects(api("PATCH", "/bookmarks/W1", { status: "done" }), (e) => e.status === 422);
});

test("reading goal is 1-999", async () => {
  const { api } = setup();
  assert.equal((await api("PUT", "/settings", { reading_goal: "15" })).reading_goal.value, "15");
  for (const bad of ["0", "1000", "abc"]) await assert.rejects(api("PUT", "/settings", { reading_goal: bad }), (e) => e.status === 422);
});

test("new papers since the day after each search, asked once", async () => {
  const asked = [];
  const { api } = setup({ handler: (url) => {
    const u = new URL(url);
    if (u.searchParams.get("select") === "id") { asked.push(u.searchParams.get("filter")); return reply(200, { meta: { count: 7 }, results: [] }); }
    return reply(200, { results: WORKS });
  } });
  await api("POST", "/search", { query: "neutron star" }); // recorded at the fixed today: nothing to ask
  assert.equal((await api("GET", "/history/new"))[0].new_papers, 0);
  const storage = memoryStorage();
  storage.setItem("radar.history", JSON.stringify([{ query: "neutron star", searched_at: "2026-05-01T00:00:00+00:00" }]));
  const later = createApi({ fetch: async (url, init) => {
    const u = new URL(url); asked.push(u.searchParams.get("filter")); return reply(200, { meta: { count: 7 }, results: [] });
  }, storage, version: "0.5.0", releasesRepo: "o/r", posterTemplate: async () => template, today: () => new Date("2026-06-01T00:00:00Z") });
  const [entry] = await later("GET", "/history/new");
  assert.deepEqual([entry.since, entry.new_papers], ["2026-05-02", 7]);
  await later("GET", "/history/new");
  assert.deepEqual(asked, ["from_publication_date:2026-05-02"]);
});

test("free full text prefers the PDF", async () => {
  const { normalizeWork } = await import("../../frontend/web/core/openalex.js");
  const work = { id: "https://openalex.org/W1", best_oa_location: { pdf_url: "https://r.example/p.pdf" }, open_access: { oa_url: "https://r.example/l" } };
  assert.equal(normalizeWork(work).open_access_url, "https://r.example/p.pdf");
  assert.equal(normalizeWork({ ...work, best_oa_location: null }).open_access_url, "https://r.example/l");
  assert.equal(normalizeWork({ id: "W2", open_access: { oa_url: "javascript:x" } }).open_access_url, null);
});

test("unknown routes are 404", async () => {
  const { api } = setup();
  await assert.rejects(api("GET", "/nope"), (e) => e.status === 404);
});
