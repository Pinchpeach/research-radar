// A fake fetch that answers OpenAlex requests from a recorded fixture
// (tests/fixtures/record_openalex.py), the same way tests/test_js_core.py does for Python.

import fs from "node:fs";

export function requestKey(url) {
  const u = new URL(url);
  const params = [...u.searchParams].filter(([k]) => k !== "api_key" && k !== "mailto").sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return `${u.origin}${u.pathname}?${params.map(([k, v]) => `${k}=${v}`).join("&")}`;
}

export function replayFetch(fixturePath, log = []) {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  const works = new Map();
  for (const r of Object.values(fixture.responses)) for (const w of r.body.results || [r.body]) if (w.id) works.set(w.id.split("/").pop(), w);
  const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, headers: new Headers(), json: async () => body });
  return async (url) => {
    log.push(url);
    const u = new URL(url), filter = u.searchParams.get("filter") || "";
    const ids = /ids\.openalex:([^,]+)/.exec(filter);
    if (ids) return reply(200, { results: ids[1].split("|").map((id) => works.get(id)).filter(Boolean) });
    const recorded = fixture.responses[requestKey(url)];
    return recorded ? reply(recorded.status, recorded.body) : reply(404, { message: `not recorded: ${requestKey(url)}` });
  };
}
