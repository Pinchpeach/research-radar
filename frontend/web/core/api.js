// The desktop backend's HTTP API (backend/main.py), answered inside the app. app.js calls
// api(method, path, body) either way; the Android app routes it here instead of to FastAPI.

import { dedupe } from "./dedupe.js";
import { buildFlow, credibleFoundations, outsideReferences } from "./flow.js";
import { MAX_PER_PAGE, OpenAlex, RateLimited, RequestError } from "./openalex.js";
import { DEFAULT_WEIGHTS, rankPapers, recentSince, selectResults } from "./ranking.js";
import CHANGELOG from "../shared/changelog.json" with { type: "json" };
import { Bookmarks, History, Judgments, READING_STATUSES, Settings, toBibtex } from "./store.js";
import { renderHtml } from "./techtree.js";

const CITING_PER_SEED = 25, CORE_REFERENCES = 25, CORE_MIN_CITERS = 3, RECENT_FETCH_MIN = 20;
const FRESH_YEARS = 2, CORE_MIN_SHARE = 0.05, REFERENCES_PER_SEED = 50, UPDATE_CACHE_MS = 6 * 3600 * 1000;

export class ApiError extends Error {
  constructor(status, detail) {
    super(typeof detail === "string" ? detail : `Request failed (${status})`);
    this.status = status;
    this.detail = detail;
  }
}

const invalid = (message) => new ApiError(422, message);
const number = (value, name, { min = -Infinity, max = Infinity, integer = false, fallback } = {}) => {
  if (value == null) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) throw invalid(`${name} is out of range`);
  return n;
};

/** Fill in PaperData defaults like the pydantic model does. */
export function paperData(raw) {
  if (!raw || typeof raw.id !== "string") throw invalid("paper.id is required");
  return {
    id: raw.id, title: raw.title || "", abstract: raw.abstract || "", year: raw.year ?? null, doi: raw.doi ?? null,
    url: raw.url ?? null, open_access_url: raw.open_access_url ?? null, venue: raw.venue ?? null, authors: raw.authors || [], citations: raw.citations || 0,
    referenced_works: raw.referenced_works || [], keywords: raw.keywords || [], topic: raw.topic ?? null,
  };
}

export function searchRequest(body) {
  const query = String(body.query || "");
  if (query.length < 2) throw invalid("query must have at least 2 characters");
  const request = {
    query,
    limit: number(body.limit, "limit", { min: 1, max: 100, integer: true, fallback: 20 }),
    year_from: number(body.year_from, "year_from", { min: 1800, max: 2100, integer: true, fallback: null }),
    year_to: number(body.year_to, "year_to", { min: 1800, max: 2100, integer: true, fallback: null }),
    seed_ids: body.seed_ids || [],
    require_abstract: Boolean(body.require_abstract),
    weights: { ...DEFAULT_WEIGHTS },
    recent_share: number(body.recent_share, "recent_share", { min: 0, max: 0.8, fallback: 0.3 }),
    recent_years: number(body.recent_years, "recent_years", { min: 1, max: 30, integer: true, fallback: 5 }),
  };
  if (request.seed_ids.length > 10) throw invalid("at most 10 seed papers");
  for (const [name, value] of Object.entries(body.weights || {})) {
    if (name in request.weights) request.weights[name] = number(value, `weights.${name}`, { min: 0 });
  }
  if (request.year_from && request.year_to && request.year_from > request.year_to) throw invalid("year_from must not be after year_to");
  return request;
}

export function createApi({ fetch, storage, version, releasesRepo, posterTemplate, dataDir = "this device", today = () => new Date() }) {
  const settings = new Settings(storage), bookmarks = new Bookmarks(storage), judgments = new Judgments(storage);
  const history = new History(storage);
  const openalex = new OpenAlex({ fetch, setting: (name) => settings.get(name) });
  const updateCache = { at: 0, latest: null };

  const rateLimitDetail = (error) => {
    const hours = error.retryAfter ? ` Try again in about ${Math.floor(error.retryAfter / 3600) + 1} h.` : "";
    if (settings.get("openalex_api_key")) return `OpenAlex rate limit reached for your API key.${hours}`;
    return `OpenAlex's shared free budget for this network is used up. Add your free OpenAlex API key in Settings to use your own budget.${hours}`;
  };

  function mergeCandidates(papers, exclude) {
    const unique = new Map();
    for (const p of papers) if (p.id && !exclude.has(p.id) && !unique.has(p.id)) unique.set(p.id, p);
    return dedupe([...unique.values()])[0];
  }

  async function coreReferences(candidates, years) {
    const minCount = Math.max(CORE_MIN_CITERS, Math.ceil(CORE_MIN_SHARE * candidates.length));
    const wanted = outsideReferences(candidates, minCount, CORE_REFERENCES);
    if (!wanted.length) return [];
    let fetched;
    try {
      fetched = await openalex.byIds(wanted.map(([ref]) => ref), years.year_from, years.year_to);
    } catch (error) {
      if (!(error instanceof RequestError)) throw error;
      return []; // like the desktop app: search on without them
    }
    const known = new Set(candidates.map((p) => p.id));
    return credibleFoundations(candidates, fetched, minCount).filter((p) => !known.has(p.id)).map((p) => ({ ...p, core_reference: true }));
  }

  async function recentCandidates(request) {
    if (!request.recent_share) return [];
    const since = Math.max(request.year_from || 0, recentSince(today().getFullYear(), Math.min(request.recent_years, FRESH_YEARS)));
    if (request.year_to && request.year_to < since) return [];
    const size = Math.max(RECENT_FETCH_MIN, Math.ceil(request.limit * request.recent_share * 3));
    return openalex.search(request.query, Math.min(size, MAX_PER_PAGE), since, request.year_to);
  }

  async function gatherCandidates(request, seeds) {
    const years = { year_from: request.year_from, year_to: request.year_to };
    const candidates = await openalex.search(request.query, Math.min(MAX_PER_PAGE, Math.max(50, request.limit * 3)), years.year_from, years.year_to);
    for (const seed of seeds) {
      try {
        candidates.push(...await openalex.citing(seed.id, CITING_PER_SEED, years.year_from, years.year_to));
        const refs = (seed.referenced_works || []).slice(0, REFERENCES_PER_SEED);
        if (refs.length) candidates.push(...await openalex.byIds(refs, years.year_from, years.year_to));
      } catch (error) {
        if (!(error instanceof RequestError)) throw error; // otherwise skip this seed
      }
    }
    const seedIds = new Set(seeds.map((s) => s.id));
    let papers = mergeCandidates(candidates, seedIds);
    // core references come from the main search alone, so recent work doesn't change what counts as core
    papers = [...papers, ...await coreReferences(papers, years)];
    papers = mergeCandidates([...papers, ...await recentCandidates(request)], seedIds);
    if (request.require_abstract) papers = papers.filter((p) => p.abstract);
    return papers;
  }

  async function search(body) {
    const request = searchRequest(body);
    let seeds = [], unresolved = [], candidates;
    try {
      for (const identifier of request.seed_ids) {
        const seed = await openalex.getWork(identifier);
        if (seed) seeds.push(seed); else unresolved.push(identifier);
      }
      candidates = await gatherCandidates(request, seeds);
    } catch (error) {
      if (error instanceof RateLimited) throw new ApiError(429, rateLimitDetail(error));
      if (error instanceof RequestError) throw new ApiError(502, "OpenAlex request failed");
      throw error;
    }
    const currentYear = today().getFullYear();
    const ranked = rankPapers(request.query, candidates, { seeds, weights: request.weights, currentYear, recentYears: request.recent_years });
    const papers = selectResults(ranked, request.limit, request.recent_share, recentSince(currentYear, request.recent_years));
    history.record(request.query);
    return {
      query: request.query,
      count: papers.length,
      candidates: candidates.length,
      seeds: seeds.map((s) => ({ id: s.id, title: s.title, year: s.year })),
      unresolved_seeds: unresolved,
      papers: papers.map((p) => ({ core_reference: false, ...p })),
    };
  }

  async function flow(body) {
    const papers = (body.papers || []).map(paperData);
    if (papers.length > 300) throw invalid("at most 300 papers");
    if (body.include_bookmarks) papers.push(...bookmarks.all().map((b) => b.paper));
    if (!papers.length) throw new ApiError(400, "No papers to map. Search or bookmark papers first.");
    let foundations = [];
    const max = number(body.max_foundations, "max_foundations", { min: 0, max: 30, integer: true, fallback: 10 });
    if (body.include_foundations !== false && max) {
      const wanted = outsideReferences(papers, 2, max);
      if (wanted.length) {
        try {
          // drops works "cited" by papers older than themselves (bad citation data)
          foundations = credibleFoundations(papers, await openalex.byIds(wanted.map(([ref]) => ref)));
        } catch { /* the map works without them */ }
      }
    }
    return buildFlow(papers, { bookmarked: bookmarks.ids(), foundations, query: body.query ?? null });
  }

  async function latestRelease() {
    if (Date.now() - updateCache.at < UPDATE_CACHE_MS) return updateCache.latest;
    let latest = null;
    try {
      const response = await fetch(`https://api.github.com/repos/${releasesRepo}/releases/latest`, { headers: { Accept: "application/vnd.github+json" } });
      if (response.status === 200) {
        const data = await response.json();
        latest = { version: String(data.tag_name || "").replace(/^v/, ""), url: data.html_url, published_at: data.published_at };
      }
    } catch { /* offline: no update notice */ }
    Object.assign(updateCache, { at: Date.now(), latest });
    return latest;
  }

  const parseVersion = (text) => { const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(text || "").trim()); return m ? m.slice(1).map(Number) : null; };
  const newer = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]; return false; };

  const settingsUpdate = (body) => {
    const limits = { openalex_api_key: 200, openalex_email: 200 };
    const update = {};
    for (const [name, value] of Object.entries(body || {})) {
      if (name === "language") {
        if (value != null && !["ko", "en", ""].includes(value)) throw invalid("language must be ko or en");
      } else if (name === "reading_goal") {
        if (value != null && !/^([1-9][0-9]{0,2})?$/.test(String(value))) throw invalid("reading_goal must be 1-999");
      } else if (!(name in limits)) {
        continue;
      } else if (value != null && String(value).length > limits[name]) {
        throw invalid(`${name} is too long`);
      }
      update[name] = value;
    }
    return update;
  };

  // like backend/main.py new_papers: papers published since the day after each recent search
  const NEW_PAPERS_TTL_MS = 3600 * 1000, newPapersCache = new Map();
  const isoDay = (d) => d.toISOString().slice(0, 10);
  async function newPapers(limit) {
    const todayIso = isoDay(today()), out = [];
    for (const entry of history.load().slice(0, limit)) {
      const next = new Date(`${entry.searched_at.slice(0, 10)}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      const since = isoDay(next);
      let count = 0;
      if (since <= todayIso) {
        const key = `${entry.query}\u0000${since}`, cached = newPapersCache.get(key);
        if (cached && Date.now() - cached.at < NEW_PAPERS_TTL_MS) count = cached.count;
        else {
          try {
            count = await openalex.countSince(entry.query, since);
            newPapersCache.set(key, { at: Date.now(), count });
          } catch {
            count = null; // offline or rate-limited: the home screen just shows no count
          }
        }
      }
      out.push({ ...entry, since, new_papers: count });
    }
    return out;
  }

  const routes = [
    ["GET", /^\/health$/, () => ({ status: "ok", version })],
    ["POST", /^\/search$/, (_, body) => search(body)],
    ["GET", /^\/bookmarks$/, (_, __, q) => bookmarks.all(q.get("tag"))],
    ["PUT", /^\/bookmarks$/, (_, body) => bookmarks.save(paperData(body.paper), body.note || "", body.tags ?? null, body.query ?? null)],
    ["GET", /^\/bookmarks\/export\.bib$/, (_, __, q) => toBibtex(bookmarks.all(q.get("tag")))],
    ["PATCH", /^\/bookmarks\/([^/]+)$/, ([id], body) => {
      if (body.status != null && !READING_STATUSES.includes(body.status)) throw invalid("status must be to_read, reading or read");
      const updated = bookmarks.update(decodeURIComponent(id), body.note ?? null, body.tags ?? null, body.status ?? null);
      if (!updated) throw new ApiError(404, "Bookmark not found");
      return updated;
    }],
    ["DELETE", /^\/bookmarks\/([^/]+)$/, ([id]) => {
      if (!bookmarks.delete(decodeURIComponent(id))) throw new ApiError(404, "Bookmark not found");
      return null;
    }],
    ["POST", /^\/flow$/, (_, body) => flow(body)],
    ["POST", /^\/poster$/, async (_, body) => {
      const lang = body.lang ?? "ko";
      if (!["ko", "en"].includes(lang)) throw invalid("lang must be ko or en");
      return renderHtml(body.flow, String(body.title ?? "My Research").slice(0, 300), lang, await posterTemplate());
    }],
    ["GET", /^\/settings$/, () => settings.publicView(dataDir)],
    ["PUT", /^\/settings$/, (_, body) => { settings.save(settingsUpdate(body)); return settings.publicView(dataDir); }],
    ["POST", /^\/settings\/test-openalex$/, (_, body) => openalex.checkKey((body && body.api_key) || null)],
    ["POST", /^\/evaluations$/, (_, body) => {
      if (!body.judgments || !Object.values(body.judgments).some(Boolean)) throw new ApiError(400, "No judgments to save.");
      return { written: judgments.saveRun(body, body.judgments) };
    }],
    ["GET", /^\/evaluations$/, () => judgments.summarize()],
    ["DELETE", /^\/evaluations\/([^/]+)$/, ([id]) => {
      if (!judgments.deleteRun(decodeURIComponent(id))) throw new ApiError(404, "Evaluation run not found");
      return null;
    }],
    ["GET", /^\/history$/, (_, __, q) => history.load().slice(0, Math.max(0, Number(q.get("limit") ?? 5) || 0))],
    ["GET", /^\/history\/new$/, (_, __, q) => newPapers(Math.max(0, Number(q.get("limit") ?? 3) || 0))],
    ["DELETE", /^\/history$/, () => { history.clear(); return null; }],
    ["GET", /^\/changelog$/, () => CHANGELOG],
    ["GET", /^\/version$/, async () => {
      const latest = await latestRelease(), current = parseVersion(version);
      return { version, latest, update_available: Boolean(latest && current && newer(parseVersion(latest.version) || [0, 0, 0], current)) };
    }],
  ];

  /** Answer one API call like the FastAPI backend: the response body, or throw ApiError. */
  return async function api(method, path, body = {}) {
    const url = new URL(path, "http://app.local");
    for (const [verb, pattern, handler] of routes) {
      const match = verb === method && pattern.exec(url.pathname);
      if (match) return handler(match.slice(1), body || {}, url.searchParams);
    }
    throw new ApiError(404, "Not Found");
  };
}
