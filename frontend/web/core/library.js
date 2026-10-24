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

/** The library's sign-in page to visit first, for proxies like Yonsei's (see backend/library.py login_page). */
export function loginPage(prefix) {
  let host = "";
  try { host = new URL(prefix).hostname; } catch { return null; }
  const school = LIBRARIES.schools.find((s) => s.login && new URL(s.proxy).hostname === host);
  return school ? school.login : null;
}

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
const FRAME = /<(?:iframe|embed)\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
const CONTENT = /\bcontent\s*=\s*["']([^"']+)["']/i;

export class NeedsLogin extends Error {
  constructor(loginUrl, loginPage = null) { super("sign in to your library"); this.loginUrl = loginUrl; this.loginPage = loginPage; }
}
export class NoPdf extends Error {
  constructor(pageUrl) { super("no PDF link on the paper's page"); this.pageUrl = pageUrl; }
}

const hostOf = (url) => { try { return new URL(url).hostname.toLowerCase(); } catch { return ""; } };
export function inScope(url, prefix) {
  const host = hostOf(url), base = hostOf(prefix);
  return Boolean(base) && (host === base || host.endsWith("." + base));
}
/** Like Python's urllib.parse.quote: percent-encodes all but letters, digits, "_.-~" and `safe`. */
const quote = (text, safe = "/") => [...String(text)].map((c) =>
  /[A-Za-z0-9_.\-~]/.test(c) || safe.includes(c) ? c : [...new TextEncoder().encode(c)].map((b) => "%" + b.toString(16).toUpperCase().padStart(2, "0")).join("")).join("");

/** The proxy prefix from what the person pasted (see backend/library.py normalize_proxy). */
export function normalizeProxy(text) {
  text = String(text || "").trim();
  const found = /https?(:\/\/|%3A%2F%2F)/i.exec(text.slice(8));
  if (found) text = text.slice(0, 8 + found.index);
  if (/_Lib_Proxy_Url$/i.test(text)) text += "/";
  else if (/[?&](q?url)$/i.test(text)) text += "=";
  return text;
}

/** url through the library: after the prefix as it is, as the libraries' guides show (see backend/library.py). */
export const through = (prefix, url) => (inScope(url, prefix) ? url : prefix + url);

/** The publisher's address inside a proxied one, for resolving the page's relative links. */
export function unwrap(prefix, url) {
  if (!url.startsWith(prefix)) return url;
  let inner = url.slice(prefix.length);
  if (prefix.endsWith("=") && /^https?%3a/i.test(inner)) inner = decodeURIComponent(inner.split("&")[0]);
  return /^https?:\/\//i.test(inner) ? inner : url;
}

export const doiUrl = (doi) => "https://doi.org/" + quote(doi, "/()<>;:-._");

/** Where the DOI points, asked of doi.org without the library (see backend/library.py). */
export async function publisherUrl(fetch, doi) {
  try {
    const record = await (await fetch(`https://doi.org/api/handles/${quote(doi, "/")}?type=URL`)).json();
    const value = (record.values || []).find((v) => v && v.type === "URL");
    const url = value && value.data && value.data.value;
    if (typeof url === "string" && /^https?:\/\//i.test(url)) return url.replace(/^http:\/\//i, "https://"); // see backend/library.py
  } catch { /* offline or unknown: doi.org itself */ }
  return doiUrl(doi);
}

export const SIGN_IN_TARGET = "https://www.nature.com/";

/** A publisher's page through the proxy, past its link and sign-in pages (see backend/library.py on_publisher). */
export function onPublisher(url, prefix) {
  if (!inScope(url, prefix)) return false;
  return hostOf(url) !== hostOf(prefix) || (!prefix.endsWith("=") && url.startsWith(prefix) && /^https?:\/\//i.test(url.slice(prefix.length)));
}
/** Where signing in from Settings starts (see backend/library.py sign_in_url). */
export const signInUrl = (prefix) => (PROXY.test(prefix || "") ? loginPage(prefix) || through(prefix, SIGN_IN_TARGET) : null);

export const loginUrl = async (fetch, prefix, doi) => through(prefix, await publisherUrl(fetch, doi));

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescapeHtml = (text) => text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, code) =>
  code[0] === "#" ? String.fromCodePoint(parseInt(code.slice(code[1] === "x" || code[1] === "X" ? 2 : 1), code[1] === "x" || code[1] === "X" ? 16 : 10))
    : ENTITIES[code.toLowerCase()] ?? all);

/** The publisher's PDF address from the page's citation_pdf_url tag, else a PDF in a frame (IEEE). */
export function pdfLink(html, pageUrl) {
  const resolve = (text) => { try { return new URL(unescapeHtml(text).trim(), pageUrl).href; } catch { return null; } };
  for (const tag of html.match(META_PDF) || []) {
    const found = CONTENT.exec(tag);
    if (found && resolve(found[1])) return resolve(found[1]);
  }
  for (const [, src] of html.matchAll(FRAME)) if (/pdf/i.test(src) && resolve(src)) return resolve(src);
  return null;
}

const isPdf = (bytes) => new TextDecoder().decode(bytes.slice(0, 1024)).trimStart().startsWith("%PDF");

/** A paper's PDF through the library proxy: the paper's page, then its PDF link. */
export async function libraryPdf(fetch, prefix, doi) {
  prefix = normalizeProxy(prefix);
  const start = await loginUrl(fetch, prefix, doi);
  let url = start;
  for (let step = 0; step < 3; step++) { // the paper's page, its PDF link, and a frame around the PDF
    const response = await fetch(url);
    const final = response.url || url;
    if (!inScope(final, prefix)) throw new NeedsLogin(start, loginPage(prefix));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (isPdf(bytes)) return bytes;
    const html = new TextDecoder().decode(bytes.slice(0, 2_000_000));
    if (PASSWORD.test(html)) throw new NeedsLogin(start, loginPage(prefix));
    const link = pdfLink(html, unwrap(prefix, final)); // relative links are the publisher's
    if (!link) {
      // still on the proxy's own link page (see backend/library.py): sign in first
      if (loginPage(prefix) || (prefix.endsWith("=") && hostOf(final) === hostOf(prefix))) throw new NeedsLogin(start, loginPage(prefix));
      throw new NoPdf(final);
    }
    url = through(prefix, link);
  }
  throw new NoPdf(url);
}
