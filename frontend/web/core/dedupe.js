// Port of backend/services/dedupe.py: merge preprint / conference / journal records of one paper.

export const YEAR_WINDOW = 2;
const short = (id) => String(id).replace(/\/+$/, "").split("/").pop();

export function titleKey(title) {
  // NFKD, then keep ASCII only (drops accents), lowercase, collapse everything else to spaces
  const ascii = String(title || "").normalize("NFKD").replace(/[^\x00-\x7f]/g, "").toLowerCase();
  return ascii.replace(/[^a-z0-9]+/g, " ").trim();
}

/** Which record of a duplicate group to keep: most cited, then most complete. */
function strength(p) {
  return [p.citations || 0, (p.referenced_works || []).length, (p.abstract || "").length, p.doi ? 1 : 0];
}

function stronger(a, b) {
  const x = strength(a), y = strength(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false; // like Python's max: the first of equals wins
}

const unique = (items) => [...new Set(items)];

/** [unique papers in original order, {duplicate short id: kept short id}] */
export function dedupe(papers) {
  const groups = [], byKey = new Map();
  for (const paper of papers) {
    const key = titleKey(paper.title || "");
    if (key.length < 12) { // too short to identify a paper ("Introduction", "Erratum")
      groups.push([paper]);
      continue;
    }
    if (!byKey.has(key)) byKey.set(key, []);
    let placed = false;
    for (const group of byKey.get(key)) {
      const years = group.map((p) => p.year).filter(Boolean);
      const year = paper.year;
      if (!year || !years.length || Math.min(...years.map((y) => Math.abs(year - y))) <= YEAR_WINDOW) {
        group.push(paper);
        placed = true;
        break;
      }
    }
    if (!placed) {
      const group = [paper];
      byKey.get(key).push(group);
      groups.push(group);
    }
  }

  let out = [];
  const alias = {};
  for (const group of groups) {
    let keep = group.reduce((best, p) => (stronger(p, best) ? p : best), group[0]);
    if (group.length > 1) {
      const original = keep;
      keep = { ...keep, referenced_works: unique(group.flatMap((p) => p.referenced_works || [])) };
      for (const field of ["abstract", "doi", "venue", "url"]) {
        if (!keep[field]) keep[field] = (group.find((p) => p[field]) || {})[field] ?? keep[field] ?? null;
      }
      if (!keep.year) {
        const years = group.map((p) => p.year).filter(Boolean);
        keep.year = years.length ? Math.min(...years) : null;
      }
      for (const p of group) if (p !== original && p.id !== keep.id) alias[short(p.id)] = short(keep.id);
    }
    out.push(keep);
  }

  if (Object.keys(alias).length) {
    // citations of a duplicate now point at the kept record
    out = out.map((paper) => {
      const own = short(paper.id);
      const refs = (paper.referenced_works || []).map((r) => alias[r] ?? r).filter((r) => r !== own);
      return { ...paper, referenced_works: unique(refs) };
    });
  }
  return [out, alias];
}
