// Port of backend/services/flow.py: topics, citation edges, storylines and the key lineage.

import WORDS from "../shared/words.json" with { type: "json" };
import { dedupe } from "./dedupe.js";
import { kmeans } from "./kmeans.js";
import { paperText, plausibleCitation } from "./ranking.js";
import { byCodePoint, ENGLISH_STOP_WORDS, meanRow, TOPIC_TOKENS, tfidf } from "./text.js";

export const MAX_CLUSTERS = 6;
export const GENERIC_WORDS = new Set(WORDS.generic_words);
export const NAME_FILLER = new Set(WORDS.name_filler);
const TOPIC_WEIGHT = 0.8;
const MAX_NAME_CHARS = 44;
const TRAILING_FILLER = /\s+(?:and\s+)?(?:research|studies|techniques|applications|methods|analysis)$/i;

export const shortId = (id) => String(id).replace(/\/+$/, "").split("/").pop();

/** Count items, keeping first-seen order for ties (Python's Counter.most_common). */
export function mostCommon(items) {
  const counts = new Map();
  for (const item of items) counts.set(item, (counts.get(item) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]);
}

/** Works cited by at least `minCount` papers in the set but not in the set themselves. */
export function outsideReferences(papers, minCount = 2, limit = 10) {
  const inSet = new Set(papers.map((p) => shortId(p.id)));
  const refs = papers.flatMap((p) => [...new Set(p.referenced_works || [])].filter((r) => !inSet.has(r)));
  // ties broken by ID, so the same works are picked every run
  return mostCommon(refs).sort((a, b) => b[1] - a[1] || byCodePoint(a[0], b[0]))
    .filter(([, count]) => count >= minCount).slice(0, limit);
}

/** Keep foundational works still cited by `minCount` papers once impossible citations are dropped. */
export function credibleFoundations(papers, foundations, minCount = 2) {
  const kept = [];
  for (const work of foundations) {
    const wid = shortId(work.id);
    const citers = papers.filter((p) => (p.referenced_works || []).includes(wid) && plausibleCitation(p.year, work.year));
    if (citers.length >= minCount) kept.push({ ...work, cited_by_in_set: citers.length });
  }
  return kept;
}

export const clusterCount = (n) => (n < 4 ? 1 : Math.max(2, Math.min(MAX_CLUSTERS, Math.round(Math.sqrt(n / 2)))));

export function queryWords(query) {
  const words = new Set();
  for (const word of String(query || "").toLowerCase().match(/[a-z][a-z-]+/g) || []) {
    const stem = word.replace(/s+$/, "");
    for (const w of [word, stem, stem + "s"]) if (w) words.add(w);
  }
  return words;
}

const stem = (w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w);
const stems = (phrase) => new Set(phrase.split(/\s+/).filter(Boolean).map(stem));
const isSubset = (a, b) => [...a].every((x) => b.has(x));
const intersects = (a, b) => [...a].some((x) => b.has(x));

/** Top distinct terms; a phrase replaces the single words it contains. */
export function labelTerms(scores, terms, size = 3) {
  const order = Array.from(scores, (_, i) => i).sort((a, b) => scores[b] - scores[a] || b - a).slice(0, 40);
  let picked = [];
  for (const i of order) {
    if (scores[i] <= 0) break;
    const term = terms[i], words = stems(term);
    const covered = picked.filter((p) => isSubset(stems(p), words));
    const others = picked.filter((p) => !covered.includes(p));
    if (others.some((p) => intersects(words, stems(p)))) continue;
    if (covered.length) {
      const at = picked.indexOf(covered[0]);
      picked = picked.filter((p) => !covered.includes(p));
      picked.splice(at, 0, term);
    } else {
      picked.push(term);
    }
  }
  return picked.slice(0, size);
}

const SMALL = new Set(["and", "or", "of", "in", "on", "for", "the", "a", "an", "to", "via", "with"]);
const isUpper = (w) => /\p{Lu}/u.test(w) && !/\p{Ll}/u.test(w);

export function titleCase(phrase) {
  return phrase.split(/\s+/).filter(Boolean).map((w, i) => {
    if ((isUpper(w) && w.length > 1) || /\p{Lu}/u.test(w.slice(1))) return w; // GNN, X-ray, k-NN stay as written
    if (i && SMALL.has(w.toLowerCase())) return w;
    return w.slice(0, 1).toUpperCase() + w.slice(1);
  }).join(" ");
}

const phraseWords = (phrase) => new Set((phrase.toLowerCase().match(/[a-z0-9]+/g) || []).map(stem));

export function tidyPhrase(phrase) {
  phrase = phrase.split(/\s+/).filter(Boolean).join(" ");
  return phrase.replace(TRAILING_FILLER, "") || phrase;
}

/** Readable topic names from OpenAlex keywords and topics (see flow.py name_clusters). */
export function nameClusters(papers, assignment, fallback, query = null) {
  const querySet = phraseWords(query || "");
  const filler = new Set([...NAME_FILLER].map(stem));
  const nTotal = papers.length;
  const k = assignment.length ? Math.max(...assignment) + 1 : 0;
  const sizes = new Array(k).fill(0);
  for (const c of assignment) sizes[c] += 1;
  const display = new Map(), topicKeys = new Set();

  const phrases = (paper) => {
    const out = new Set();
    const raws = [...(paper.keywords || []).map((kw) => [kw, false]), [paper.topic, true]];
    for (const [raw, isTopic] of raws) {
      if (!raw) continue;
      const shown = tidyPhrase(raw), key = shown.toLowerCase();
      if (isSubset(phraseWords(key), new Set([...querySet, ...filler]))) continue;
      if (!display.has(key)) display.set(key, shown);
      if (isTopic) topicKeys.add(key);
      out.add(key);
    }
    return out;
  };

  const perPaper = papers.map(phrases);
  const overall = new Map(mostCommon(perPaper.flatMap((s) => [...s])));
  const perCluster = Array.from({ length: k }, () => []);
  perPaper.forEach((s, i) => perCluster[assignment[i]].push(...s));
  const clusterCounts = perCluster.map(mostCommon);
  const support = (c) => Math.min(sizes[c], Math.max(2, Math.ceil(0.15 * sizes[c])));

  const candidates = [];
  for (let c = 0; c < k; c++) {
    for (const [ph, count] of clusterCounts[c]) {
      if (count < support(c)) continue;
      const lift = count / sizes[c] - overall.get(ph) / nTotal;
      if (lift > 0) candidates.push([(topicKeys.has(ph) ? TOPIC_WEIGHT : 1) * lift * Math.sqrt(count), c, ph]);
    }
  }

  const chosen = Array.from({ length: k }, () => []);
  const used = [];
  const free = (ph) => { const w = phraseWords(ph); return !used.some((u) => isSubset(w, u) || isSubset(u, w)); };
  const take = (c, ph) => { chosen[c].push(ph); used.push(phraseWords(ph)); };

  const ranked = candidates.sort((a, b) => b[0] - a[0] || byCodePoint(a[2], b[2]));
  for (const [, c, ph] of ranked) if (!chosen[c].length && free(ph)) take(c, ph);
  for (const [, c, ph] of ranked) { // optional second keyword
    if (chosen[c].length !== 1 || topicKeys.has(ph) || !free(ph)) continue;
    const first = chosen[c][0];
    if (intersects(phraseWords(ph), phraseWords(first)) || display.get(first).length + 3 + display.get(ph).length > MAX_NAME_CHARS) continue;
    take(c, ph);
  }
  for (let c = 0; c < k; c++) { // fallback: the cluster's most common phrase nobody else uses
    if (chosen[c].length) continue;
    for (const [ph, count] of clusterCounts[c]) {
      if (count >= Math.min(2, sizes[c]) && free(ph)) { take(c, ph); break; }
    }
  }

  return Array.from({ length: k }, (_, c) => {
    if (chosen[c].length) return chosen[c].map((ph) => titleCase(display.get(ph))).join(" & ");
    const label = c < fallback.length ? fallback[c] : `topic ${c + 1}`;
    return titleCase(label.replaceAll(", ", " · "));
  });
}

/** [cluster index per paper, short label per cluster] */
export function clusterPapers(papers, query = null) {
  const texts = papers.map((p) => [paperText(p), ...(p.keywords || [])].join(" "));
  let k = clusterCount(papers.length);
  const stopWords = new Set([...ENGLISH_STOP_WORDS, ...GENERIC_WORDS, ...queryWords(query)]);
  let terms, rows;
  try {
    ({ terms, rows } = tfidf(texts, { tokens: TOPIC_TOKENS, stopWords, maxDf: 0.9 }));
  } catch {
    return [papers.map(() => 0), ["all papers"]];
  }
  k = Math.min(k, rows.length, terms.length);
  const overall = meanRow(rows, terms.length);
  if (k <= 1) return [papers.map(() => 0), [labelTerms(overall, terms).join(", ") || "all papers"]];
  const model = kmeans(rows, k, terms.length);
  // label by what sets a topic apart from the whole map, not just what is frequent in it
  const labels = model.centers.map((center, i) =>
    labelTerms(center.map((v, j) => v - overall[j]), terms).join(", ") || `topic ${i + 1}`);
  return [model.labels, labels];
}

/** Longest citation chain, oldest paper first. Edges go citing -> cited. */
export function longestChain(nodes, edges) {
  const order = Object.keys(nodes).sort((a, b) => (nodes[a].year || 0) - (nodes[b].year || 0) || byCodePoint(a, b));
  const position = new Map(order.map((id, i) => [id, i]));
  const cites = Object.fromEntries(order.map((id) => [id, []]));
  for (const [citing, cited] of edges) if (position.get(cited) < position.get(citing)) cites[citing].push(cited);
  const best = {}, prev = {};
  for (const id of order) {
    best[id] = 1; prev[id] = null;
    for (const cited of cites[id]) if (best[cited] + 1 > best[id]) { best[id] = best[cited] + 1; prev[id] = cited; }
  }
  if (!order.length) return [];
  let end = order[0];
  for (const id of order) {
    if (best[id] > best[end] || (best[id] === best[end] && nodes[id].citations > nodes[end].citations)) end = id;
  }
  const chain = [];
  while (end) { chain.push(end); end = prev[end]; }
  return chain.length > 1 ? chain.reverse() : [];
}

const median = (values) => {
  const v = [...values].sort((a, b) => a - b), m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

export function buildFlow(papers, { bookmarked = new Set(), foundations = [], query = null } = {}) {
  const tagged = [...papers.map((p) => ({ ...p, role: "result" })), ...foundations.map((p) => ({ ...p, role: "foundation" }))];
  const [merged, alias] = dedupe(tagged);
  bookmarked = new Set([...bookmarked].map((b) => alias[b] ?? b));

  const unique = new Map();
  for (const paper of merged) if (!unique.has(shortId(paper.id))) unique.set(shortId(paper.id), paper);
  if (!unique.size) return { nodes: [], edges: [], clusters: [], chain: [] };

  const ids = [...unique.keys()];
  const all = ids.map((id) => unique.get(id));
  const [assignment, wordLabels] = clusterPapers(all, query);
  const labels = nameClusters(all, assignment, wordLabels, query);

  const edges = [];
  for (const id of ids) {
    const paper = unique.get(id);
    for (const ref of new Set(paper.referenced_works || [])) {
      if (unique.has(ref) && ref !== id && plausibleCitation(paper.year, unique.get(ref).year)) edges.push([id, ref]);
    }
  }
  const citedInSet = new Map(mostCommon(edges.map((e) => e[1])));

  const nodes = {};
  ids.forEach((id, i) => {
    const paper = unique.get(id);
    nodes[id] = {
      id,
      title: paper.title || "",
      year: paper.year ?? null,
      citations: paper.citations || 0,
      authors: (paper.authors || []).slice(0, 3),
      url: paper.url || paper.doi || null,
      cluster: assignment[i],
      role: paper.role,
      bookmarked: bookmarked.has(id),
      cited_in_set: citedInSet.get(id) || 0,
      cited_by_in_set: paper.cited_by_in_set ?? (citedInSet.get(id) || 0),
    };
  });

  const clusters = [];
  labels.forEach((label, index) => {
    const members = ids.map((id) => nodes[id]).filter((n) => n.cluster === index);
    if (!members.length) return;
    const datedOnly = members.filter((m) => m.year);
    const dated = datedOnly.length ? datedOnly : members;
    const origin = dated.reduce((a, m) => ((m.year || 9999) < (a.year || 9999) || ((m.year || 9999) === (a.year || 9999) && m.citations > a.citations) ? m : a));
    const hub = members.reduce((a, m) => (m.cited_in_set > a.cited_in_set || (m.cited_in_set === a.cited_in_set && m.citations > a.citations) ? m : a));
    const frontier = [...dated].sort((a, b) => (b.year || 0) - (a.year || 0) || b.citations - a.citations).slice(0, 3);
    const years = members.map((m) => m.year).filter(Boolean);
    clusters.push({
      index,
      label,
      size: members.length,
      year_min: years.length ? Math.min(...years) : null,
      year_max: years.length ? Math.max(...years) : null,
      year_median: years.length ? Math.trunc(median(years)) : null,
      origin: origin.id,
      hub: hub.id,
      frontier: frontier.map((m) => m.id),
    });
  });
  // lanes ordered by when each topic emerged
  clusters.sort((a, b) => (a.year_median || 9999) - (b.year_median || 9999) || a.index - b.index);
  const lane = new Map(clusters.map((c, position) => [c.index, position]));
  for (const node of Object.values(nodes)) node.lane = lane.get(node.cluster);
  for (const c of clusters) c.lane = lane.get(c.index);

  const cross = mostCommon(edges
    .filter(([citing, cited]) => nodes[citing].lane !== nodes[cited].lane)
    .map(([citing, cited]) => `${nodes[citing].lane},${nodes[cited].lane}`));

  return {
    nodes: Object.values(nodes),
    edges: edges.map(([source, target]) => ({ source, target })),
    clusters,
    cluster_links: cross.map(([pair, count]) => {
      const [citingLane, citedLane] = pair.split(",").map(Number);
      return { from_lane: citedLane, to_lane: citingLane, count };
    }),
    chain: longestChain(nodes, edges),
  };
}
