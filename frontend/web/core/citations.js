// Reading a reference library exported from Zotero (or Mendeley, EndNote, Papers): RIS or
// BibTeX, into plain entries { doi, title, year, authors, venue, tags, note } for
// POST /bookmarks/import, which finds each paper on OpenAlex.

export const MAX_IMPORT = 300;

const DOI = /\b(10\.\d{4,9}\/[^\s"'<>{}]+)/i;
const doiOf = (text) => {
  const match = DOI.exec(String(text || ""));
  return match ? match[1].replace(/[.,;]+$/, "") : null;
};
const clean = (text) => String(text || "").replace(/\s+/g, " ").trim();

/** RIS: "TY  - JOUR" ... "ER  - ", one tag per line. */
export function parseRis(text) {
  const entries = [];
  let entry = null;
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9])  -( (.*))?$/.exec(line);
    if (!match) continue;
    const [, tag, , raw = ""] = match, value = raw.trim();
    if (tag === "TY") { entry = { doi: null, title: "", year: null, authors: [], venue: null, tags: [], note: "", url: null }; continue; }
    if (!entry) continue;
    if (tag === "ER") { entries.push(entry); entry = null; continue; }
    if (["TI", "T1"].includes(tag) && !entry.title) entry.title = clean(value);
    else if (["AU", "A1"].includes(tag) && value) entry.authors.push(clean(value));
    else if (["PY", "Y1", "DA"].includes(tag) && !entry.year) entry.year = Number((/\d{4}/.exec(value) || [])[0]) || null;
    else if (["JO", "JF", "T2"].includes(tag) && !entry.venue) entry.venue = clean(value);
    else if (tag === "DO" && !entry.doi) entry.doi = doiOf(value);
    else if (["UR", "L2"].includes(tag) && !entry.url) entry.url = value;
    else if (tag === "KW" && value) entry.tags.push(clean(value));
    else if (tag === "N1" && value) entry.note = clean(`${entry.note} ${value}`);
  }
  for (const e of entries) e.doi = e.doi || doiOf(e.url);
  return entries;
}

/** The value of a BibTeX field starting at `i` ({...} with nesting, "...", or a bare word), and where it ends. */
function bibValue(text, i) {
  if (text[i] === "{") {
    let depth = 0, j = i;
    for (; j < text.length; j++) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}" && --depth === 0) break;
    }
    return [text.slice(i + 1, j), j + 1];
  }
  if (text[i] === '"') {
    let j = i + 1;
    while (j < text.length && !(text[j] === '"' && text[j - 1] !== "\\")) j++;
    return [text.slice(i + 1, j), j + 1];
  }
  const match = /^[^,}\s]+/.exec(text.slice(i));
  return [match ? match[0] : "", i + (match ? match[0].length : 0)];
}

// TeX in titles and names: escaped symbols kept, accent commands dropped (Veli{\v{c}}kovi{\'c} → Velickovic), braces dropped
const unbrace = (value) => clean(value.replace(/\\([&%$#_])/g, "$1").replace(/\\(["'`^~=.]|[a-zA-Z]+(?=[{\s]))\s*/g, "").replace(/[{}]/g, ""));

/** BibTeX: @article{key, field = {value}, ...}. */
export function parseBibtex(text) {
  const source = String(text), entries = [];
  const start = /@(\w+)\s*\{\s*([^,\s]*)\s*,/g;
  let match;
  while ((match = start.exec(source))) {
    if (["comment", "string", "preamble"].includes(match[1].toLowerCase())) continue;
    const fields = {};
    let i = start.lastIndex;
    while (i < source.length) {
      const field = /^\s*([A-Za-z][\w-]*)\s*=\s*/.exec(source.slice(i));
      if (!field) break;
      const [value, end] = bibValue(source, i + field[0].length);
      fields[field[1].toLowerCase()] = value;
      i = end;
      const rest = /^\s*,?/.exec(source.slice(i));
      i += rest[0].length;
      if (/^\s*\}/.test(source.slice(i))) break;
    }
    start.lastIndex = i;
    entries.push({
      doi: doiOf(fields.doi) || doiOf(fields.url),
      title: unbrace(fields.title || ""),
      year: Number((/\d{4}/.exec(fields.year || fields.date || "") || [])[0]) || null,
      authors: fields.author ? fields.author.split(/\s+and\s+/i).map(unbrace).filter(Boolean) : [],
      venue: unbrace(fields.journal || fields.journaltitle || fields.booktitle || "") || null,
      tags: unbrace(fields.keywords || "").split(/[,;]/).map((t) => t.trim()).filter(Boolean),
      note: unbrace(fields.note || fields.annote || ""),
      url: fields.url || null,
    });
  }
  return entries;
}

/** Entries from a .ris or .bib file, whichever it is; at most MAX_IMPORT. */
export function parseCitations(text) {
  const entries = /^\s*TY  - /m.test(String(text)) ? parseRis(text) : parseBibtex(text);
  return entries.filter((e) => e.doi || e.title).slice(0, MAX_IMPORT);
}
