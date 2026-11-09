// 0.13: opening a paper from a DOI, following authors, Zotero import, ranking by bookmarks, more free copies.

import fs from "node:fs";
import { expect, go, search, test } from "./fixtures.mjs";
import { samplePdf } from "./sample-pdf.mjs";

const CORS = { "access-control-allow-origin": "*" };
const FIXTURE = JSON.parse(
  fs.readFileSync(new URL("../fixtures/openalex_graph_neural_networks.json", import.meta.url), "utf8"),
);
const RAW = new Map();
for (const r of Object.values(FIXTURE.responses))
  for (const w of r.body.results || []) RAW.set(w.id.split("/").pop(), w);
const GNN = RAW.get("W2116341502"); // "The Graph Neural Network Model"
const json = (body) => ({ headers: CORS, contentType: "application/json", body: JSON.stringify(body) });

test("a DOI typed on Home opens that paper and searches from it", async ({ page }) => {
  await page
    .context()
    .route("https://api.openalex.org/works/doi:**", (route) =>
      route.fulfill(json({ ...GNN, title: "graph neural networks" })),
    );
  await page.goto("./");
  await page.locator("#home-query").fill("https://doi.org/10.1109/TNN.2008.2005605");
  await page.locator("#home-query").press("Enter");
  await expect(page.locator("#tab-discover")).toBeVisible();
  await expect(page.locator("#seeds")).toHaveValue("W2116341502");
  await expect(page.locator("#query")).toHaveValue("graph neural networks");
  await expect(page.locator("#results .paper").first()).toBeVisible({ timeout: 60_000 });
});

test("a link that names no paper says so", async ({ page }) => {
  await page
    .context()
    .route("https://api.openalex.org/works/doi:**", (route) =>
      route.fulfill({ status: 404, ...json({ message: "nope" }) }),
    );
  await page.goto("./");
  await go(page, "discover");
  await page.locator("#query").fill("10.9999/does-not-exist");
  await page.locator("#query").press("Enter");
  await expect(page.locator("#search-status")).toContainText("10.9999/does-not-exist 논문을 찾지 못했어요");
});

test.describe("with OpenAlex author ids (the recording keeps names only)", () => {
  test.use({
    tamper: {
      edit: (url, body) => ({
        ...body,
        results: (body.results || []).map((w) => ({
          ...w,
          authorships: (w.authorships || []).map((a, i) => ({
            author: { ...a.author, id: `https://openalex.org/A${1000 + i}` },
          })),
        })),
      }),
    },
  });

  test("follow an author from a paper card; their new papers show in News", async ({ page }) => {
    let asked = null;
    await page.context().route(
      (url) =>
        url.href.startsWith("https://api.openalex.org/works?") &&
        url.searchParams.get("filter")?.startsWith("authorships.author.id:"),
      (route) => {
        asked = new URL(route.request().url()).searchParams.get("filter");
        return route.fulfill(json({ meta: { count: 2 }, results: [GNN] }));
      },
    );
    await search(page);
    const card = page.locator("#results .paper", { hasText: "The Graph Neural Network Model" }).first();
    await card.locator(".follow summary").click();
    const first = card.locator(".follow-menu button").first();
    await expect(first).toHaveText(/^\+ /);
    await first.click();
    await expect(first).toHaveText(/^✓ /);
    await expect(page.locator("#news-badge")).toHaveText("2");
    await go(page, "news");
    const item = page.locator(".follow-item").first();
    await expect(item).toContainText("새 논문 2편");
    await expect(item.locator(".paper")).toHaveCount(1);
    expect(asked).toMatch(/^authorships\.author\.id:A\d+,from_publication_date:\d{4}-\d\d-\d\d$/);
    await item.locator("button", { hasText: "팔로우 해제" }).click();
    await expect(page.locator(".follow-item")).toHaveCount(0);
    await expect(page.locator("#follow-empty")).toBeVisible();
  });
});

test("a Zotero RIS export becomes bookmarks; papers like them are marked", async ({ page }) => {
  const dois = [];
  await page.context().route(
    (url) =>
      url.href.startsWith("https://api.openalex.org/works?") && url.searchParams.get("filter")?.startsWith("doi:"),
    (route) => {
      dois.push(new URL(route.request().url()).searchParams.get("filter"));
      return route.fulfill(json({ results: [GNN, RAW.get("W2919115771") || GNN] }));
    },
  );
  await page.goto("./");
  await go(page, "bookmarks");
  const ris = [
    "TY  - JOUR",
    "TI  - The Graph Neural Network Model",
    "DO  - 10.1109/TNN.2008.2005605",
    "KW  - from-zotero",
    "ER  - ",
    "",
    "TY  - JOUR",
    "TI  - Something OpenAlex doesn't have",
    "ER  - ",
  ].join("\n");
  await page
    .locator("#import-refs")
    .setInputFiles({ name: "zotero.ris", mimeType: "application/x-research-info-systems", buffer: Buffer.from(ris) });
  await expect(page.locator("#bm-status")).toContainText("북마크했어요");
  await expect(page.locator("#bm-status")).toContainText("찾지 못한 1편");
  await expect(page.locator("#bookmarks .paper").first()).toContainText("The Graph Neural Network Model");
  expect(dois[0]).toBe("doi:10.1109/tnn.2008.2005605");

  // with two bookmarks, results close to them say so
  await search(page);
  await page.locator("#results .paper .star").nth(2).click();
  await expect(page.locator("#bm-count")).not.toHaveText("(1)");
  await page.locator("#search-form button[type=submit]").click();
  await expect(page.locator("#results .chip.personal").first()).toBeVisible({ timeout: 60_000 });
});

test.describe("a paper with no copy on OpenAlex or Unpaywall", () => {
  test.use({
    tamper: {
      edit: (url, body) => ({
        ...body,
        results: (body.results || []).map((w) =>
          w.id.endsWith("/W2116341502") ? { ...w, best_oa_location: null, open_access: { oa_url: null } } : w,
        ),
      }),
    },
  });

  test("Europe PMC's free PDF opens in the reader", async ({ page }) => {
    await page.context().route("https://www.ebi.ac.uk/europepmc/**", (route) =>
      route.fulfill(
        json({
          resultList: {
            result: [
              {
                fullTextUrlList: {
                  fullTextUrl: [
                    { url: "https://europepmc.org/free.pdf", documentStyle: "pdf", availabilityCode: "OA" },
                  ],
                },
              },
            ],
          },
        }),
      ),
    );
    await page
      .context()
      .route("https://europepmc.org/free.pdf", async (route) =>
        route.fulfill({ headers: CORS, contentType: "application/pdf", body: await samplePdf(3) }),
      );
    await search(page);
    await page
      .locator("#results .paper", { hasText: "The Graph Neural Network Model" })
      .first()
      .locator(".read-pdf")
      .click();
    await expect(page.locator(".rd-page")).toHaveCount(3, { timeout: 30_000 });
  });
});
