// Port of backend/services/context.py: citation context, how closely each candidate is tied
// through references to the papers that best match the query. See that file for the reasoning.

import { pyRound } from "./text.js";

export const TOP_K = 20;
export const ROUNDS = 2;

const short = (id) => String(id).replace(/\/+$/, "").split("/").pop();
const scale = (v) => {
  const top = v.length ? Math.max(...v) : 0;
  return top > 0 ? v.map((x) => x / top) : v;
};
const substantive = (p) => Boolean(p.abstract) || (p.referenced_works || []).length >= 5;

function round(papers, ids, refs, scores) {
  // rounded so near-ties order the same as in Python; ties go to the earlier paper
  const keyed = scores.map((s) => pyRound(s, 9));
  const order = papers.map((_, i) => i).sort((a, b) => keyed[b] - keyed[a] || a - b);
  const top = order.filter((i) => keyed[i] > 0 && substantive(papers[i])).slice(0, TOP_K);
  const inTop = new Set(top), topIds = new Set(top.map((i) => ids[i]));
  const shared = new Map();
  for (const i of top) for (const ref of refs[i]) shared.set(ref, (shared.get(ref) || 0) + 1);
  return papers.map((_, i) => {
    const own = refs[i];
    let coupling = 0, links = 0;
    // a set paper's own references are not shared with anyone
    for (const ref of own) coupling += (shared.get(ref) || 0) - (inTop.has(i) ? 1 : 0);
    if (own.size) coupling /= Math.sqrt(own.size);
    for (const ref of own) if (topIds.has(ref)) links += 1;
    for (const j of top) if (j !== i && refs[j].has(ids[i])) links += 1;
    return Math.log1p(coupling + links);
  });
}

/** Context score per paper (>= 0; all 0 when no candidate has references). */
export function citationContext(papers, relevance) {
  const ids = papers.map((p) => short(p.id));
  const refs = papers.map((p, i) => { const s = new Set(p.referenced_works || []); s.delete(ids[i]); return s; });
  const text = scale(Array.from(relevance, (x) => Math.max(0, x)));
  let scores = text, context = papers.map(() => 0);
  for (let r = 0; r < ROUNDS; r += 1) {
    context = round(papers, ids, refs, scores);
    const c = scale(context);
    scores = text.map((t, i) => 0.5 * t + 0.5 * c[i]);
  }
  return context;
}
