// TF-IDF as scikit-learn's TfidfVectorizer computes it, for the settings Research Radar uses:
// lowercase, a token pattern, stop words removed before n-grams, ngram_range (1, n),
// sublinear tf, smooth idf, l2-normalized rows, optional max_df. Same numbers, so the
// Android app ranks like the desktop app.

import WORDS from "../shared/words.json" with { type: "json" };

export const ENGLISH_STOP_WORDS = new Set(WORDS.english_stop_words);

const WORD = "[\\p{L}\\p{N}_]";
// scikit-learn's default (?u)\b\w\w+\b: runs of two or more word characters
export const DEFAULT_TOKENS = new RegExp(`${WORD}{2,}`, "gu");
// (?u)\b[^\W\d_][\w-]+[^\W_]\b: at least 3 characters, starts with a letter, hyphens inside
export const TOPIC_TOKENS = new RegExp(`(?<!${WORD})\\p{L}[\\p{L}\\p{N}_-]+[\\p{L}\\p{N}](?!${WORD})`, "gu");

export function analyze(text, { tokens = DEFAULT_TOKENS, stopWords = ENGLISH_STOP_WORDS, maxN = 2 } = {}) {
  const words = (String(text || "").toLowerCase().match(tokens) || []).filter((w) => !stopWords.has(w));
  const out = [...words];
  for (let n = 2; n <= Math.min(maxN, words.length); n++) {
    for (let i = 0; i + n <= words.length; i++) out.push(words.slice(i, i + n).join(" "));
  }
  return out;
}

/** Python's str sort (by code point). */
export const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Fit and transform `docs`. Returns { terms (sorted), rows } where each row is a Map
 * term index -> weight (l2-normalized). Throws "empty vocabulary" like scikit-learn.
 */
export function tfidf(docs, { tokens, stopWords, maxN = 2, maxDf = 1.0 } = {}) {
  const counts = docs.map((doc) => {
    const c = new Map();
    for (const term of analyze(doc, { tokens, stopWords, maxN })) c.set(term, (c.get(term) || 0) + 1);
    return c;
  });
  const df = new Map();
  for (const c of counts) for (const term of c.keys()) df.set(term, (df.get(term) || 0) + 1);
  if (!df.size) throw new Error("empty vocabulary");
  const limit = maxDf <= 1 ? maxDf * docs.length : maxDf;
  const terms = [...df.keys()].filter((term) => df.get(term) <= limit).sort(byCodePoint);
  if (!terms.length) throw new Error("empty vocabulary");
  const index = new Map(terms.map((term, i) => [term, i]));
  const n = docs.length;
  const idf = terms.map((term) => Math.log((1 + n) / (1 + df.get(term))) + 1);
  const rows = counts.map((c) => {
    const row = new Map();
    let norm = 0;
    for (const [term, count] of c) {
      const i = index.get(term);
      if (i === undefined) continue;
      const w = (1 + Math.log(count)) * idf[i];
      row.set(i, w);
      norm += w * w;
    }
    norm = Math.sqrt(norm);
    if (norm > 0) for (const [i, w] of row) row.set(i, w / norm);
    return row;
  });
  return { terms, rows };
}

export function dot(a, b) {
  if (a.size > b.size) [a, b] = [b, a];
  let sum = 0;
  for (const [i, w] of a) {
    const v = b.get(i);
    if (v !== undefined) sum += w * v;
  }
  return sum;
}

const norm = (row) => Math.sqrt([...row.values()].reduce((s, w) => s + w * w, 0));

/** Cosine similarity of sparse rows (0 when either is empty). */
export function cosine(a, b) {
  const na = norm(a), nb = norm(b);
  return na && nb ? dot(a, b) / (na * nb) : 0;
}

/** Mean of the rows as a dense array. */
export function meanRow(rows, size) {
  const mean = new Float64Array(size);
  for (const row of rows) for (const [i, w] of row) mean[i] += w;
  for (let i = 0; i < size; i++) mean[i] /= rows.length || 1;
  return mean;
}
