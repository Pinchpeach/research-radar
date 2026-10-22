// 0.9.0: free full text, starting from a paper, new papers on recent topics, reading record.

import fs from "node:fs";
import { expect, go, QUERY, search, test } from "./fixtures.mjs";

const FIXTURE = JSON.parse(fs.readFileSync(new URL("../fixtures/openalex_graph_neural_networks.json", import.meta.url), "utf8"));
const GNN_MODEL = "W2116341502"; // "The Graph Neural Network Model", first for the recorded search
const PDF = "https://repository.example.org/gnn-model.pdf";
const work = (id) => Object.values(FIXTURE.responses).flatMap((r) => r.body.results || []).find((w) => w.id.endsWith(`/${id}`));
const JSON_HEADERS = { "access-control-allow-origin": "*" };

test.describe("free full text", () => {
  test.use({ tamper: { edit: (url, body) => ({ ...body, results: (body.results || []).map((w) =>
    (w.id.endsWith(`/${GNN_MODEL}`) ? { ...w, best_oa_location: { pdf_url: PDF }, open_access: { oa_url: "https://example.org/landing" } } : w)) }) } });

  test("open-access papers get a free-reading link, the PDF first", async ({ page }) => {
    await search(page);
    const card = page.locator("#results .paper", { hasText: "The Graph Neural Network Model" }).first();
    await expect(card.locator(".free")).toBeVisible();
    await expect(card.locator(".free")).toHaveAttribute("href", PDF);
    const others = page.locator("#results .paper .free:not([hidden])");
    await expect(others).toHaveCount(1);
  });
});

test("start a new search from a paper", async ({ page }) => {
  // the seed's own record, and nobody citing it in the recording
  await page.route(/api\.openalex\.org\/works\/W\d+/, (route) =>
    route.fulfill({ headers: JSON_HEADERS, contentType: "application/json", body: JSON.stringify(work(GNN_MODEL)) }));
  await page.route(/api\.openalex\.org\/works\?.*cites/, (route) =>
    route.fulfill({ headers: JSON_HEADERS, contentType: "application/json", body: JSON.stringify({ results: [] }) }));
  await search(page);
  const card = page.locator("#results .paper", { hasText: "The Graph Neural Network Model" }).first();
  await card.locator(".from-here").click();
  await expect(page.locator("#seeds")).toHaveValue(GNN_MODEL);
  await expect(page.locator("#query")).toHaveValue(QUERY);
  await expect(page.locator("#search-status")).toContainText("시드: The Graph Neural Network Model", { timeout: 60_000 });
  await expect(page.locator("#results .paper").first()).toBeVisible();
});

test("recent topics show papers published since they were last searched", async ({ page }) => {
  await page.addInitScript(() => {
    if (window !== window.top) return; // not in the (sandboxed) map frame
    if (!localStorage.getItem("radar.history")) {
      localStorage.setItem("radar.history", JSON.stringify([{ query: "graph neural networks", searched_at: "2026-10-01T09:00:00+00:00" }]));
    }
  });
  const asked = [];
  await page.route(/api\.openalex\.org\/works\?.*select=id/, (route) => {
    asked.push(new URL(route.request().url()).searchParams.get("filter"));
    return route.fulfill({ headers: JSON_HEADERS, contentType: "application/json", body: JSON.stringify({ meta: { count: 12 }, results: [] }) });
  });
  await page.goto("./");
  await expect(page.locator("#recent-topics .topic .new")).toHaveText("새 논문 12편");
  expect(asked).toEqual(["from_publication_date:2026-10-02"]);
  await page.locator("#menu-button").click();
  await page.locator(".drawer .tab[data-tab=home]").click();
  await expect(page.locator("#recent-topics .topic .new")).toHaveText("새 논문 12편");
  expect(asked.length, "counted once, then reused").toBe(1);
});

test("reading record: statuses, this month's thermometer and the goal", async ({ page }) => {
  await search(page);
  for (const i of [0, 1, 2]) await page.locator("#results .paper .star").nth(i).click();
  await expect(page.locator("#bm-count")).toHaveText("(3)");
  await go(page, "bookmarks");
  const cards = page.locator("#bookmarks .paper");
  await expect(cards.first().locator(".status-control button.on")).toHaveText("읽을 것");
  await cards.nth(0).locator(".status-control button[data-status=read]").click();
  await expect(cards.nth(0).locator(".status-control button.on")).toHaveText("읽음");
  await cards.nth(1).locator(".status-control button[data-status=read]").click();
  await expect(cards.nth(1).locator(".status-control button.on")).toHaveText("읽음");
  await cards.nth(2).locator(".status-control button[data-status=reading]").click();
  await expect(cards.nth(2).locator(".status-control button.on")).toHaveText("읽는 중");
  await page.locator("#status-filter").selectOption("read");
  await expect(cards).toHaveCount(2);

  await go(page, "reading");
  await expect(page.locator("#reading-count")).toHaveText("2");
  await expect(page.locator("#reading-cheer")).toHaveText("이만큼 읽었어요!");
  await expect(page.locator("#read-list .read-row")).toHaveCount(2);
  await expect(page.locator("#reading-list .read-row")).toHaveCount(1);
  const level = () => page.locator("#mercury").evaluate((m) => m.getBoundingClientRect().height / m.parentElement.getBoundingClientRect().height);
  await expect.poll(level).toBeGreaterThan(0.17); // 2 of the default goal of 10
  expect(await level()).toBeLessThan(0.23);

  await page.locator("#reading-goal").fill("2");
  await page.locator("#goal-form button[type=submit]").click();
  await expect(page.locator("#reading-cheer")).toHaveText("목표 달성! 이만큼 읽었어요!");
  await expect(page.locator("#thermo")).toHaveClass(/done/);
  await expect.poll(level).toBeGreaterThan(0.95);

  // moving a paper back to "reading" takes it off this month's count
  await page.locator("#read-list .read-row").first().locator("button[data-status=reading]").click();
  await expect(page.locator("#reading-count")).toHaveText("1");
  await page.reload();
  await go(page, "reading");
  await expect(page.locator("#reading-count")).toHaveText("1");
  await expect(page.locator("#reading-goal")).toHaveValue("2");
  await expect(page.locator("#reading-list .read-row")).toHaveCount(2);
});
