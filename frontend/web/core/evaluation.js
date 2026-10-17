// Ranking-quality metrics (port of backend/evaluation.py; app.js shows the same numbers live).

export const GAIN = { relevant: 2, partial: 1, not_relevant: 0 };

/** Share of the top-k judged results that are relevant or partially relevant. */
export function precisionAt(labels, k) {
  const judged = labels.slice(0, k).filter(Boolean);
  return judged.length ? judged.filter((j) => GAIN[j] > 0).length / judged.length : null;
}

/** nDCG over the top-k with graded gains; unjudged results count as 0. */
export function ndcgAt(labels, k) {
  const top = labels.slice(0, k);
  if (!top.some(Boolean)) return null;
  const dcg = top.reduce((sum, j, i) => sum + (j ? GAIN[j] : 0) / Math.log2(i + 2), 0);
  const ideal = labels.filter(Boolean).map((j) => GAIN[j]).sort((a, b) => b - a).slice(0, k);
  const idcg = ideal.reduce((sum, g, i) => sum + g / Math.log2(i + 2), 0);
  return idcg ? dcg / idcg : 0;
}
