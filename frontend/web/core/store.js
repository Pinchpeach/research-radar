// What the desktop app keeps in its data folder (settings.json, radar.db, judgments.jsonl),
// kept here in a key-value store: localStorage in the Android app, a Map in tests.

import { GAIN, ndcgAt, precisionAt } from "./evaluation.js";

const KEYS = { settings: "radar.settings", bookmarks: "radar.bookmarks", judgments: "radar.judgments" };
const short = (id) => String(id).replace(/\/+$/, "").split("/").pop();
const now = () => new Date().toISOString();

/** A Storage-like object (getItem/setItem) backed by a Map. */
export function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
}

function read(storage, key, fallback) {
  try {
    const raw = storage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}
const write = (storage, key, value) => storage.setItem(key, JSON.stringify(value));

// ---------- settings ----------

export const SETTING_FIELDS = ["openalex_api_key", "openalex_email", "language"];
const SECRETS = new Set(["openalex_api_key"]);

export const mask = (secret) => (secret.length > 8 ? "•".repeat(6) + secret.slice(-4) : "•".repeat(secret.length));

export class Settings {
  constructor(storage) { this.storage = storage; }
  all() { return read(this.storage, KEYS.settings, {}); }
  get(name) { return this.all()[name] || null; }
  save(updates) {
    const current = this.all();
    for (const [name, value] of Object.entries(updates)) {
      if (!SETTING_FIELDS.includes(name)) throw new Error(`unknown setting ${name}`);
      const v = String(value ?? "").trim();
      if (v) current[name] = v; else delete current[name];
    }
    write(this.storage, KEYS.settings, current);
  }
  /** What the UI may see: never a full key. */
  publicView(dataDir) {
    const saved = this.all(), view = {};
    for (const name of SETTING_FIELDS) {
      const value = saved[name] || "";
      const entry = { set: Boolean(value), source: value ? "settings" : null };
      if (SECRETS.has(name)) entry.hint = value ? mask(value) : "";
      else entry.value = value;
      view[name] = entry;
    }
    view.data_dir = dataDir;
    return view;
  }
}

// ---------- bookmarks ----------

export function cleanTags(tags) {
  const seen = [];
  for (let tag of tags) {
    tag = String(tag).trim().toLowerCase();
    if (tag && !seen.includes(tag)) seen.push(tag);
  }
  return seen;
}

export class Bookmarks {
  constructor(storage) { this.storage = storage; }
  load() { return read(this.storage, KEYS.bookmarks, []); }
  store(items) { write(this.storage, KEYS.bookmarks, items); }
  all(tag = null) {
    const items = this.load().sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
    return tag ? items.filter((b) => b.tags.includes(tag.toLowerCase())) : items;
  }
  get(id) { return this.load().find((b) => b.id === short(id)) || null; }
  ids() { return new Set(this.load().map((b) => b.id)); }
  /** Insert or replace the stored paper; keeps note/tags/created_at unless new ones are given. */
  save(paper, note = "", tags = null, query = null) {
    const id = short(paper.id), items = this.load(), existing = items.find((b) => b.id === id), stamp = now();
    const item = {
      id,
      paper,
      note: note || (existing ? existing.note : ""),
      tags: tags != null ? cleanTags(tags) : existing ? existing.tags : [],
      query: query != null ? query : existing ? existing.query : null,
      created_at: existing ? existing.created_at : stamp,
      updated_at: stamp,
    };
    this.store([...items.filter((b) => b.id !== id), item]);
    return item;
  }
  update(id, note = null, tags = null) {
    const items = this.load(), existing = items.find((b) => b.id === short(id));
    if (!existing) return null;
    if (note != null) existing.note = note;
    if (tags != null) existing.tags = cleanTags(tags);
    existing.updated_at = now();
    this.store(items);
    return existing;
  }
  delete(id) {
    const items = this.load(), kept = items.filter((b) => b.id !== short(id));
    this.store(kept);
    return kept.length < items.length;
  }
}

export function toBibtex(bookmarks) {
  const entries = bookmarks.map((bookmark) => {
    const paper = bookmark.paper;
    const firstAuthor = ((paper.authors || [])[0] || "unknown").split(/\s+/).filter(Boolean).pop().toLowerCase();
    const key = [...`${firstAuthor}${paper.year || ""}${bookmark.id}`].filter((ch) => /[\p{L}\p{N}]/u.test(ch)).join("");
    const fields = {
      title: paper.title,
      author: (paper.authors || []).join(" and "),
      year: paper.year,
      journal: paper.venue,
      doi: (paper.doi || "").replace("https://doi.org/", "") || null,
      url: paper.url,
      note: bookmark.note || null,
      keywords: (bookmark.tags || []).join(", ") || null,
    };
    const body = Object.entries(fields).filter(([, v]) => v).map(([name, v]) => `  ${name} = {${v}}`).join(",\n");
    return `@article{${key},\n${body}\n}`;
  });
  return entries.join("\n\n") + (entries.length ? "\n" : "");
}

// ---------- ranking evaluation ----------

export class Judgments {
  constructor(storage) { this.storage = storage; }
  rows() { return read(this.storage, KEYS.judgments, []); }
  saveRun(run, judgments) {
    const savedAt = new Date().toISOString().replace(/\.\d+Z$/, "+00:00");
    const rows = run.papers.map((paper, i) => [paper, i + 1]).filter(([paper]) => judgments[paper.id]).map(([paper, rank]) => ({
      run_id: run.run_id, query: run.query, settings: run.settings || {}, saved_at: savedAt,
      rank, paper_id: paper.id, title: paper.title, score: paper.score ?? null, judgment: judgments[paper.id],
    }));
    write(this.storage, KEYS.judgments, [...this.rows(), ...rows]);
    return rows.length;
  }
  deleteRun(runId) {
    const rows = this.rows(), kept = rows.filter((r) => r.run_id !== runId);
    if (kept.length === rows.length) return false;
    write(this.storage, KEYS.judgments, kept);
    return true;
  }
  /** Metrics per run, newest first. */
  summarize() {
    const runs = new Map(), meta = new Map();
    for (const row of this.rows()) {
      if (!runs.has(row.run_id)) runs.set(row.run_id, new Map());
      runs.get(row.run_id).set(row.rank, row.judgment);
      meta.set(row.run_id, { query: row.query, settings: row.settings || {}, saved_at: row.saved_at ?? null });
    }
    const summary = [...runs].map(([runId, byRank]) => {
      const labels = Array.from({ length: Math.max(...byRank.keys()) }, (_, i) => byRank.get(i + 1) ?? null);
      return { run_id: runId, ...meta.get(runId), judged: byRank.size,
        "p@10": precisionAt(labels, 10), "p@20": precisionAt(labels, 20), "ndcg@20": ndcgAt(labels, 20) };
    });
    return summary.sort((a, b) => ((a.saved_at || "") < (b.saved_at || "") ? 1 : (a.saved_at || "") > (b.saved_at || "") ? -1 : 0));
  }
}

export { GAIN };
