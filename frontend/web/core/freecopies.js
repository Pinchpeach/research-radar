// Port of backend/services/freecopies.py: every free copy of a paper the app can find, best
// first: Unpaywall, OpenAlex's locations, Europe PMC, arXiv. A source that fails is skipped.

import { unpaywallLinks } from "./library.js";
import { OPENALEX_URL, webUrl } from "./openalex.js";

const EUROPE_PMC_URL = "https://www.ebi.ac.uk/europepmc/webservices/rest/search";
const ARXIV_DOI = /^10\.48550\/arxiv\.(.+)$/i;
const ARXIV_PAGE = /^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/([^?#]+?)(?:\.pdf)?$/i;

export const arxivPdf = (id) => `https://arxiv.org/pdf/${id}`;

/** PDFs among a raw OpenAlex work's locations, and arXiv's PDF for an arXiv landing page. */
export function openalexLinks(work) {
  const links = [];
  for (const location of [work.best_oa_location, ...(work.locations || [])]) {
    const loc = location || {};
    let url = webUrl(loc.pdf_url);
    const page = ARXIV_PAGE.exec(loc.landing_page_url || "");
    if (!url && page) url = arxivPdf(page[1]);
    if (url && !links.includes(url)) links.push(url);
  }
  return links;
}

export async function europePmcLinks(fetch, doi) {
  const url = new URL(EUROPE_PMC_URL);
  for (const [name, value] of Object.entries({ query: `DOI:"${doi}"`, resultType: "core", format: "json", pageSize: 1 })) url.searchParams.set(name, value);
  const response = await fetch(url.toString());
  if (!response.ok) throw new Error(`Europe PMC ${response.status}`);
  const results = ((await response.json()).resultList || {}).result || [];
  if (!results.length) return [];
  const record = results[0], links = [];
  for (const entry of (record.fullTextUrlList || {}).fullTextUrl || []) {
    const link = webUrl(entry.url);
    if (link && entry.documentStyle === "pdf" && ["OA", "F"].includes(entry.availabilityCode) && !links.includes(link)) links.push(link);
  }
  if (record.pmcid && record.isOpenAccess === "Y") links.push(`https://europepmc.org/articles/${encodeURIComponent(record.pmcid)}?pdf=render`);
  return links;
}

/** Free PDF addresses for a DOI from every source, best first. */
export async function freePdfLinks({ fetch, openalex, doi, email }) {
  const found = [];
  const add = (links) => { for (const link of links) if (!found.includes(link)) found.push(link); };
  if (email) { try { add(await unpaywallLinks(fetch, doi, email)); } catch { /* skipped */ } }
  try { add(openalexLinks(await openalex.get(`${OPENALEX_URL}/doi:${encodeURIComponent(doi).replace(/%2F/gi, "/")}`, {}))); } catch { /* skipped */ }
  try { add(await europePmcLinks(fetch, doi)); } catch { /* skipped */ }
  const arxiv = ARXIV_DOI.exec(doi);
  if (arxiv) add([arxivPdf(arxiv[1])]);
  return found;
}
