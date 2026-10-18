// Runs the JavaScript core on the cases tests/test_js_core.py sends (JSON on stdin) and prints
// the results as JSON, so pytest can compare them with the Python backend.

import fs from "node:fs";
import { createApi } from "../../frontend/web/core/api.js";
import { dedupe, titleKey } from "../../frontend/web/core/dedupe.js";
import { buildFlow, labelTerms, longestChain, nameClusters, outsideReferences, queryWords, tidyPhrase, titleCase } from "../../frontend/web/core/flow.js";
import { normalizeWork, workPath, yearFilter } from "../../frontend/web/core/openalex.js";
import { rankPapers } from "../../frontend/web/core/ranking.js";
import { memoryStorage, toBibtex } from "../../frontend/web/core/store.js";
import { layout, renderHtml } from "../../frontend/web/core/techtree.js";
import { ndcgAt, precisionAt } from "../../frontend/web/core/evaluation.js";
import { VERSION } from "../../frontend/web/core/version.js";
import { replayFetch } from "./replay.mjs";

const input = JSON.parse(fs.readFileSync(0, "utf8"));
const template = fs.readFileSync(new URL("../../frontend/web/shared/poster.html", import.meta.url), "utf8");
const out = { version: VERSION };

if (input.fixture) {
  const api = createApi({
    fetch: replayFetch(input.fixture),
    storage: memoryStorage(),
    version: VERSION,
    releasesRepo: "x/y",
    posterTemplate: async () => template,
    today: () => new Date(`${input.today}T12:00:00Z`),
  });
  out.searches = [];
  for (const body of input.searches) out.searches.push(await api("POST", "/search", body));
  out.flow = await api("POST", "/flow", input.flow_request);
}
if (input.rank) out.rank = input.rank.map((c) => rankPapers(c.query, c.papers, { seeds: c.seeds, weights: c.weights, currentYear: c.current_year }));
if (input.layout) out.layout = layout(input.layout);
if (input.poster) out.poster = renderHtml(input.poster.flow, input.poster.title, input.poster.lang, template);
if (input.names) out.names = nameClusters(input.names.papers, input.names.assignment, input.names.fallback, input.names.query);
if (input.labels) out.labels = input.labels.map((c) => labelTerms(c.scores, c.terms));
if (input.flow_papers) out.flow_build = buildFlow(input.flow_papers.papers, { bookmarked: new Set(input.flow_papers.bookmarked), query: input.flow_papers.query });
if (input.chain) out.chain = longestChain(input.chain.nodes, input.chain.edges);
if (input.dedupe) out.dedupe = dedupe(input.dedupe);
if (input.outside) out.outside = outsideReferences(input.outside.papers, input.outside.min_count, input.outside.limit);
if (input.strings) {
  const s = input.strings;
  out.strings = {
    title_key: s.titles.map(titleKey),
    title_case: s.phrases.map(titleCase),
    tidy: s.phrases.map(tidyPhrase),
    query_words: s.queries.map((q) => [...queryWords(q)].sort()),
    work_path: s.identifiers.map(workPath),
    year_filter: s.years.map(([a, b]) => yearFilter(a, b)),
    normalize: s.works.map(normalizeWork),
    bibtex: toBibtex(s.bookmarks),
    metrics: s.judgments.map((j) => [precisionAt(j, 10), precisionAt(j, 20), ndcgAt(j, 20)]),
  };
}
process.stdout.write(JSON.stringify(out));
