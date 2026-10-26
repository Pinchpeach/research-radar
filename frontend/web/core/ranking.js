// Port of backend/services/ranking.py. See that file for the reasoning behind each score.

import { byCodePoint, cosine, cosineDense, DEFAULT_TOKENS, meanRow, pyRound, tfidf } from "./text.js";
import { citationContext } from "./context.js";

export const RECENCY_HALF_LIFE_YEARS = 5;
export const DEFAULT_WEIGHTS = { relevance: 0.35, influence: 0.45, seed: 0.2, recency: 0.05, impact: 0.15 };

export const paperText = (paper) => `${paper.title || ""} ${paper.abstract || ""}`.trim();

// ---------- matching the query to papers (relevance): see ranking.py ----------

const ACRONYM = /((?:[A-Za-z][A-Za-z0-9-]*\s+){1,7}[A-Za-z][A-Za-z0-9-]*)\s*\(\s*([A-Z][A-Za-z0-9]{1,9})\s*\)/g;
export const FEEDBACK_DOCS = 10, FEEDBACK_SHARE = 0.2;

export const matchText = (paper) => [paperText(paper), ...(paper.keywords || [])].join(" ").trim();

/** Fold a plural: networks -> network, studies -> study, classes -> class. */
export function singular(word) {
  if (word.length > 4 && word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (word.length > 4 && ["sses", "xes", "ches", "shes"].some((e) => word.endsWith(e))) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !["ss", "us", "is"].some((e) => word.endsWith(e))) return word.slice(0, -1);
  return word;
}

/** Acronyms the texts define ("gnn"), each with its most common spelled-out term. */
export function acronyms(texts) {
  const seen = new Map();
  for (const text of texts) {
    for (const [, long, short] of String(text).matchAll(ACRONYM)) {
      const letters = [...short].filter((c) => /[A-Z0-9]/.test(c));
      let words = long.split(/[\s-]+/).filter(Boolean);
      if (letters.length < 2 || words.length < letters.length) continue;
      words = words.slice(-letters.length);
      if (words.every((w, i) => w[0].toLowerCase() === letters[i].toLowerCase())) {
        const key = JSON.stringify([letters.join("").toLowerCase(), words.map((w) => singular(w.toLowerCase())).join(" ")]);
        seen.set(key, (seen.get(key) || 0) + 1);
      }
    }
  }
  const pairs = [...seen].map(([key, count]) => [...JSON.parse(key), count])
    .sort((a, b) => byCodePoint(a[0], b[0]) || byCodePoint(a[1], b[1]));
  const best = new Map();
  for (const [short, long, count] of pairs) if (!best.has(short) || count > best.get(short)[0]) best.set(short, [count, long]);
  return new Map([...best].map(([short, [, long]]) => [short, long]));
}

/** The query with its acronyms spelled out, and its spelled-out terms abbreviated. */
export function expandQuery(query, texts) {
  const words = (String(query).toLowerCase().match(DEFAULT_TOKENS) || []).map(singular);
  const plain = words.join(" "), extra = [];
  for (const [short, long] of acronyms(texts)) {
    if (words.includes(short) && !plain.includes(long)) extra.push(long);
    else if (` ${plain} `.includes(` ${long} `) && !words.includes(short)) extra.push(short);
  }
  return [query, ...extra].join(" ");
}
const short = (id) => String(id).replace(/\/+$/, "").split("/").pop();

export function scaleToMax(values) {
  const v = Array.from(values, (x) => Math.max(0, x));
  const top = v.length ? Math.max(...v) : 0;
  return top > 0 ? v.map((x) => x / top) : v;
}

export function recencyScore(year, currentYear) {
  if (!year) return 0;
  return 0.5 ** (Math.max(0, currentYear - year) / RECENCY_HALF_LIFE_YEARS);
}

/** Citations per year since publication, log-damped. */
export function impactValues(papers, currentYear) {
  return papers.map((p) => {
    const age = Math.max(1, currentYear - (p.year || currentYear) + 1);
    return Math.log1p((p.citations || 0) / age);
  });
}

/** A paper can't cite one published later (a year of slack for preprints vs. journals). */
export const plausibleCitation = (citingYear, citedYear) => !citingYear || !citedYear || citedYear <= citingYear + 1;

const indexOf = (papers) => new Map(papers.map((p, i) => [short(p.id), i]));

export function citationCountsWithin(papers) {
  const index = indexOf(papers), counts = new Array(papers.length).fill(0);
  for (const paper of papers) {
    const own = short(paper.id);
    for (const ref of new Set(paper.referenced_works || [])) {
      const j = index.get(ref);
      if (j !== undefined && ref !== own && plausibleCitation(paper.year, papers[j].year)) counts[j] += 1;
    }
  }
  return counts;
}

/** Personalized PageRank over the citation graph; returns only the mass that arrives along citations. */
export function citationInfluence(papers, start, damping = 0.85, iterations = 60) {
  const n = papers.length;
  if (!n) return [];
  const index = indexOf(papers);
  const out = papers.map((paper, i) => {
    const refs = new Set();
    for (const r of paper.referenced_works || []) if (index.has(r)) refs.add(index.get(r));
    return [...refs].filter((j) => j !== i && plausibleCitation(paper.year, papers[j].year));
  });
  const teleport = Array.from(start, (x) => Math.max(0, x) + 1e-9);
  const total = teleport.reduce((a, b) => a + b, 0);
  for (let i = 0; i < n; i++) teleport[i] /= total;
  let rank = [...teleport], via = new Array(n).fill(0);
  for (let it = 0; it < iterations; it++) {
    via = new Array(n).fill(0);
    let dangling = 0;
    out.forEach((targets, i) => {
      if (targets.length) for (const j of targets) via[j] += (damping * rank[i]) / targets.length;
      else dangling += damping * rank[i];
    });
    rank = via.map((v, i) => v + (1 - damping + dangling) * teleport[i]);
  }
  return via;
}

export const recentSince = (currentYear, recentYears) => currentYear - recentYears + 1;

export function frontierScores(papers, relevance, influence, currentYear, since) {
  const n = papers.length, index = indexOf(papers);
  const buildsOn = new Array(n).fill(0), keyCited = new Array(n).fill(0);
  papers.forEach((paper, i) => {
    for (const ref of new Set(paper.referenced_works || [])) {
      const j = index.get(ref);
      if (j === undefined || j === i || !plausibleCitation(paper.year, papers[j].year)) continue;
      buildsOn[i] += influence[j];
      if (influence[j] >= 0.5) keyCited[i] += 1;
    }
  });
  const recent = papers.map((p) => (p.year || 0) >= since);
  if (!recent.some(Boolean)) return [new Array(n).fill(0), keyCited];
  const pick = (values) => values.filter((_, i) => recent[i]);
  const spread = (scaled) => { const out = new Array(n).fill(0); let k = 0; recent.forEach((r, i) => { if (r) out[i] = scaled[k++]; }); return out; };
  const momentum = spread(scaleToMax(impactValues(pick(papers), currentYear)));
  const builds = spread(scaleToMax(pick(buildsOn).map(Math.sqrt)));
  const window = Math.max(1, currentYear - since + 1);
  const frontier = papers.map((p, i) => {
    if (!recent[i]) return 0;
    const fresh = Math.min(1, Math.max(0, ((p.year || since) - since + 1) / window));
    return 0.4 * relevance[i] + 0.25 * builds[i] + 0.2 * fresh + 0.15 * momentum[i];
  });
  return [frontier, keyCited];
}

/** Skip stub records with neither an abstract nor a real reference list. */
export const substantive = (paper) => Boolean(paper.abstract) || (paper.referenced_works || []).length >= 5;

/** The best `limit` results (core), then recent_share × limit recent papers not already shown. */
export function selectResults(ranked, limit, recentShare, since) {
  const core = ranked.slice(0, limit);
  const taken = new Set(core.map((p) => p.id));
  const needed = pyRound(limit * recentShare);
  const pool = ranked
    .filter((p) => (p.year || 0) >= since && !taken.has(p.id) && substantive(p))
    .sort((a, b) => b.scores.frontier - a.scores.frontier || b.score - a.score);
  return [...core.map((p) => ({ ...p, group: "core" })), ...pool.slice(0, needed).map((p) => ({ ...p, group: "recent" }))];
}

export function rankPapers(query, papers, { seeds = [], weights = {}, currentYear, recentYears = 5 } = {}) {
  if (!papers.length) return [];
  weights = { ...DEFAULT_WEIGHTS, ...weights };
  if (!seeds.length) weights.seed = 0;
  currentYear = currentYear || new Date().getFullYear();

  const texts = papers.map(matchText);
  const docs = [expandQuery(query, texts), ...texts, ...seeds.map(matchText)];
  let rows, terms = [];
  try {
    ({ rows, terms } = tfidf(docs, { fold: singular }));
  } catch {
    rows = docs.map(() => new Map());
  }
  const queryVec = rows[0], paperVecs = rows.slice(1, 1 + papers.length), seedVecs = rows.slice(1 + papers.length);

  const tfidfScores = paperVecs.map((v) => cosine(queryVec, v));
  let relevance = scaleToMax(tfidfScores);
  // pseudo-relevance feedback: likeness to the best text matches, as a share of relevance
  const top = papers.map((_, i) => i).sort((a, b) => tfidfScores[b] - tfidfScores[a] || a - b)
    .slice(0, FEEDBACK_DOCS).filter((i) => tfidfScores[i] > 0);
  if (top.length >= 3) {
    const centroid = meanRow(top.map((i) => paperVecs[i]), terms.length);
    const feedback = scaleToMax(paperVecs.map((v) => cosineDense(centroid, v)));
    relevance = relevance.map((r, i) => (1 - FEEDBACK_SHARE) * r + FEEDBACK_SHARE * feedback[i]);
  }
  const context = citationContext(papers, relevance);
  if (Math.max(...context) > 0) {
    const c = scaleToMax(context);
    relevance = relevance.map((r, i) => 0.5 * r + 0.5 * c[i]);
  }

  let seedScores = new Array(papers.length).fill(0);
  const links = new Array(papers.length).fill(false);
  if (seeds.length) {
    const seedIds = new Set(seeds.map((s) => s.id.split("/").pop()));
    const citedBySeeds = new Set(seeds.flatMap((s) => s.referenced_works || []));
    seedScores = scaleToMax(paperVecs.map((v) => Math.max(...seedVecs.map((s) => cosine(v, s)))));
    papers.forEach((paper, i) => {
      const pid = paper.id.split("/").pop();
      if (citedBySeeds.has(pid) || (paper.referenced_works || []).some((r) => seedIds.has(r))) {
        links[i] = true;
        seedScores[i] = 1;
      }
    });
  }

  const recency = papers.map((p) => recencyScore(p.year, currentYear));
  const impact = scaleToMax(impactValues(papers, currentYear));
  let influence = scaleToMax(citationInfluence(papers, relevance)).map((v, i) => Math.sqrt(v) * (0.3 + 0.7 * relevance[i]));
  influence = scaleToMax(influence);
  const citedWithin = citationCountsWithin(papers);
  const [frontier, keyCited] = frontierScores(papers, relevance, influence, currentYear, recentSince(currentYear, recentYears));

  const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0) || 1;
  const ranked = papers.map((paper, i) => {
    const combined = (weights.relevance * relevance[i] + weights.seed * seedScores[i] + weights.influence * influence[i]
      + weights.recency * recency[i] + weights.impact * impact[i]) / totalWeight;
    return {
      ...paper,
      score: pyRound(combined * 100, 1),
      relevance_score: pyRound(tfidfScores[i] * 100, 1),
      seed_link: links[i],
      cited_by_results: citedWithin[i],
      builds_on_key_papers: keyCited[i],
      scores: {
        relevance: pyRound(relevance[i], 3),
        influence: pyRound(influence[i], 3),
        seed: pyRound(seedScores[i], 3),
        recency: pyRound(recency[i], 3),
        impact: pyRound(impact[i], 3),
        frontier: pyRound(frontier[i], 3),
      },
    };
  });
  return ranked.sort((a, b) => b.score - a.score || b.relevance_score - a.relevance_score);
}
