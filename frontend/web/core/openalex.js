// OpenAlex client (port of backend/services/openalex.py). `fetch` and `setting` come from the
// host: the Android app passes the native-HTTP fetch and its saved settings.

export const OPENALEX_URL = "https://api.openalex.org/works";
export const MAX_PER_PAGE = 200;
const TIMEOUT_MS = 20000;

export class RequestError extends Error {
  constructor(message, status = null) {
    super(message);
    this.status = status;
  }
}

export class RateLimited extends RequestError {
  constructor(message, retryAfter) {
    super(message, 429);
    this.retryAfter = retryAfter;
  }
}

export function reconstructAbstract(inverted) {
  if (!inverted) return "";
  const words = [];
  for (const [word, positions] of Object.entries(inverted)) for (const at of positions) words.push([at, word]);
  words.sort((a, b) => a[0] - b[0]);
  return words.map((w) => w[1]).join(" ");
}

export const shortId = (id) => String(id).replace(/\/+$/, "").split("/").pop();

/** `value` if it is an http(s) link, else null (see backend/services/openalex.py web_url). */
export function webUrl(value) {
  value = typeof value === "string" ? value.trim() : "";
  return /^https?:\/\//i.test(value) ? value : null;
}

export function normalizeWork(work) {
  const authors = (work.authorships || []).map((a) => a.author && a.author.display_name).filter(Boolean);
  const location = work.primary_location || {};
  const source = location.source || {};
  return {
    id: work.id || "",
    title: work.title || work.display_name || "",
    abstract: reconstructAbstract(work.abstract_inverted_index),
    year: work.publication_year ?? null,
    doi: webUrl(work.doi),
    url: webUrl(location.landing_page_url) || webUrl(work.doi) || webUrl(work.id),
    venue: source.display_name ?? null,
    authors,
    citations: work.cited_by_count || 0,
    referenced_works: (work.referenced_works || []).map(shortId),
    keywords: (work.keywords || []).filter((k) => k.display_name).map((k) => k.display_name),
    topic: (work.primary_topic || {}).display_name ?? null,
  };
}

export function yearFilter(yearFrom, yearTo) {
  const filters = [];
  if (yearFrom) filters.push(`from_publication_date:${yearFrom}-01-01`);
  if (yearTo) filters.push(`to_publication_date:${yearTo}-12-31`);
  return filters;
}

const DOI = /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:)?(10\.\d{4,9}\/\S+)$/i;
const OPENALEX_ID = /^(?:https?:\/\/openalex\.org\/)?(W\d+)$/i;

/** A DOI or OpenAlex work ID/URL as an OpenAlex /works path segment, or null. */
export function workPath(identifier) {
  const id = String(identifier || "").trim();
  let match = OPENALEX_ID.exec(id);
  if (match) return match[1].toUpperCase();
  match = DOI.exec(id);
  return match ? `doi:${match[1]}` : null;
}

export class OpenAlex {
  constructor({ fetch, setting }) {
    this.fetch = fetch;
    this.setting = setting;
  }

  url(path, params, key) {
    const url = new URL(path);
    const email = this.setting("openalex_email");
    if (email) params = { ...params, mailto: email };
    // A key goes in the query string (OpenAlex accepts it there), so a browser needs no preflight.
    key = key ?? this.setting("openalex_api_key");
    if (key) params = { ...params, api_key: key };
    for (const [name, value] of Object.entries(params)) if (value != null) url.searchParams.set(name, value);
    return url.toString();
  }

  async request(path, params = {}, key) {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = controller && setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      return await this.fetch(this.url(path, params, key), { signal: controller && controller.signal });
    } catch (error) {
      throw new RequestError(`OpenAlex request failed: ${error.name || error}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async get(path, params) {
    const response = await this.request(path, params);
    if (response.status === 429) {
      let message = "";
      try { message = (await response.json()).message || ""; } catch { /* not JSON */ }
      const retry = response.headers.get("retry-after");
      throw new RateLimited(message || "OpenAlex rate limit reached.", retry && /^\d+$/.test(retry) ? Number(retry) : null);
    }
    if (!response.ok) throw new RequestError(`OpenAlex answered ${response.status}`, response.status);
    return response.json();
  }

  async list(filters, limit, extra = {}) {
    const params = { "per-page": Math.min(limit, MAX_PER_PAGE), ...extra };
    if (filters.length) params.filter = filters.join(",");
    const data = await this.get(OPENALEX_URL, params);
    return (data.results || []).map(normalizeWork);
  }

  search(query, limit = 20, yearFrom = null, yearTo = null) {
    return this.list(yearFilter(yearFrom, yearTo), limit, { search: query });
  }

  citing(workId, limit = 25, yearFrom = null, yearTo = null) {
    return this.list([`cites:${shortId(workId)}`, ...yearFilter(yearFrom, yearTo)], limit, { sort: "cited_by_count:desc" });
  }

  async byIds(workIds, yearFrom = null, yearTo = null) {
    const ids = workIds.map(shortId), papers = [];
    // OpenAlex accepts up to 100 OR-ed values per filter.
    for (let start = 0; start < ids.length; start += 50) {
      const chunk = ids.slice(start, start + 50);
      papers.push(...await this.list([`ids.openalex:${chunk.join("|")}`, ...yearFilter(yearFrom, yearTo)], chunk.length));
    }
    return papers;
  }

  /** One work by DOI or OpenAlex ID, or null when it is unknown or malformed. */
  async getWork(identifier) {
    const path = workPath(identifier);
    if (!path) return null;
    try {
      return normalizeWork(await this.get(`${OPENALEX_URL}/${path}`, {}));
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  }

  /** Try one tiny request with `key` (or the saved key) and report what OpenAlex says. */
  async checkKey(key) {
    let response;
    try {
      response = await this.request(OPENALEX_URL, { "per-page": 1, select: "id" }, key || undefined);
    } catch (error) {
      return { ok: false, code: "unreachable", message: error.message };
    }
    const remaining = response.headers.get("x-ratelimit-remaining-usd");
    const limit = response.headers.get("x-ratelimit-limit-usd");
    const budget = { remaining_usd: remaining ? Number(remaining) : null, limit_usd: limit ? Number(limit) : null };
    if (response.status === 200) return { ok: true, code: "ok", message: "The key works.", ...budget };
    if (response.status === 401 || response.status === 403) return { ok: false, code: "rejected", message: "OpenAlex rejected this key.", ...budget };
    if (response.status === 429) return { ok: false, code: "exhausted", message: "Today's budget is used up.", ...budget };
    return { ok: false, code: "status", status: response.status, message: `OpenAlex answered ${response.status}`, ...budget };
  }
}
