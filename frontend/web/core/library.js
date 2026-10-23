// The JavaScript side of backend/library.py and backend/services/unpaywall.py: which school an
// e-mail belongs to, a paper's PDF through the library's proxy, and Unpaywall's free copies.
//
// On Android the person signs in to the proxy in an in-app web view (mobile.js) that shares the
// app's cookie store, and CapacitorHttp's fetch sends those cookies the way a browser would: to
// the proxy's own hosts only. A page that ends up outside the proxy (the school's sign-in page)
// or asks for a password means signing in (again).

import LIBRARIES from "../shared/libraries.json" with { type: "json" };
import { webUrl } from "./openalex.js";

export const DOI = /^10\.\d{4,9}\/\S{1,300}$/;
export const PROXY = /^https?:\/\/[A-Za-z0-9.-]+(:\d+)?(\/\S*)?$/;

export function schoolFor(email) {
  const text = String(email || "");
  const domain = text.includes("@") ? text.split("@").pop().trim().toLowerCase() : "";
  const school = LIBRARIES.schools.find((s) => domain && (domain === s.domain || domain.endsWith("." + s.domain)));
  return school ? { domain: school.domain, name_ko: school.name_ko, name_en: school.name_en, proxy: school.proxy } : null;
}

/** PDF addresses Unpaywall knows for a DOI, best first. */
export async function unpaywallLinks(fetch, doi, email) {
  const response = await fetch(`https://api.unpaywall.org/v2/${encodeURIComponent(doi).replace(/%2F/gi, "/")}?email=${encodeURIComponent(email)}`);
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`Unpaywall ${response.status}`);
  const record = await response.json();
  const links = [];
  for (const location of [record.best_oa_location, ...(record.oa_locations || [])]) {
    const url = webUrl(location && location.url_for_pdf);
    if (url && !links.includes(url)) links.push(url);
  }
  return links;
}

const PASSWORD = /<input\b[^>]*\btype\s*=\s*["']?password/i;
const META_PDF = /<meta\b[^>]*\bname\s*=\s*["']citation_pdf_url["'][^>]*>/gi;
const CONTENT = /\bcontent\s*=\s*["']([^"']+)["']/i;

export class NeedsLogin extends Error {
  constructor(loginUrl) { super("sign in to your library"); this.loginUrl = loginUrl; }
}
export class NoPdf extends Error {
  constructor(pageUrl) { super("no PDF link on the paper's page"); this.pageUrl = pageUrl; }
}

const hostOf = (url) => { try { return new URL(url).hostname.toLowerCase(); } catch { return ""; } };
export function inScope(url, prefix) {
  const host = hostOf(url), base = hostOf(prefix);
  return Boolean(base) && (host === base || host.endsWith("." + base));
}
export const through = (prefix, url) => (inScope(url, prefix) ? url : prefix + url);
export const loginUrl = (prefix, doi) => through(prefix, `https://doi.org/${doi}`);

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescapeHtml = (text) => text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, code) =>
  code[0] === "#" ? String.fromCodePoint(parseInt(code.slice(code[1] === "x" || code[1] === "X" ? 2 : 1), code[1] === "x" || code[1] === "X" ? 16 : 10))
    : ENTITIES[code.toLowerCase()] ?? all);

/** The publisher's PDF address from the page's citation_pdf_url tag. */
export function pdfLink(html, pageUrl) {
  for (const tag of html.match(META_PDF) || []) {
    const found = CONTENT.exec(tag);
    if (found) {
      const text = unescapeHtml(found[1]).trim();
      try { return new URL(text, pageUrl).href; } catch { /* not an address */ }
    }
  }
  return null;
}

const isPdf = (bytes) => new TextDecoder().decode(bytes.slice(0, 1024)).trimStart().startsWith("%PDF");

/** A paper's PDF through the library proxy: the paper's page, then its PDF link. */
export async function libraryPdf(fetch, prefix, doi) {
  const start = loginUrl(prefix, doi);
  let url = start;
  for (let step = 0; step < 2; step++) {
    const response = await fetch(url);
    const final = response.url || url;
    if (!inScope(final, prefix)) throw new NeedsLogin(start);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (isPdf(bytes)) return bytes;
    const html = new TextDecoder().decode(bytes.slice(0, 2_000_000));
    if (PASSWORD.test(html)) throw new NeedsLogin(start);
    const link = pdfLink(html, final);
    if (!link) throw new NoPdf(final);
    url = through(prefix, link);
  }
  throw new NoPdf(url);
}
