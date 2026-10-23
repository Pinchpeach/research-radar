// The JavaScript side of backend/library.py and backend/services/unpaywall.py: which school an
// e-mail belongs to, and Unpaywall's free copies. (Signing in through a library proxy is the
// desktop app's for now: it needs a window of its own to sign in.)

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
