// The app with its outside world replaced: OpenAlex answers from a recorded search
// (tests/fixtures/openalex_graph_neural_networks.json), GitHub from a stub, and the clock is set
// to the recording's day so the app asks for exactly the recorded pages.

import fs from "node:fs";
import { test as base, expect } from "@playwright/test";
import { replayFetch } from "../js/replay.mjs";

const FIXTURE = new URL("../fixtures/openalex_graph_neural_networks.json", import.meta.url);
export const QUERY = "graph neural networks";
export const VERSION = /"([^"]+)"/.exec(fs.readFileSync(new URL("../../frontend/web/core/version.js", import.meta.url), "utf8"))[1];
const TODAY = JSON.parse(fs.readFileSync(FIXTURE, "utf8")).today;
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*" };

export const test = base.extend({
  latestRelease: [VERSION, { option: true }],
  // { edit(url, body) => body }: changes OpenAlex's answers, e.g. to slip in a booby-trapped paper
  // (wrapped in an object: Playwright would take a bare function for a fixture)
  tamper: [null, { option: true }],
  openalexCalls: async ({}, use) => use([]),
  page: async ({ page, latestRelease, openalexCalls, tamper }, use) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("dialog", (d) => d.accept());
    await page.clock.setFixedTime(new Date(`${TODAY}T12:00:00Z`));
    const openalex = replayFetch(FIXTURE, openalexCalls);
    await page.context().route("https://api.openalex.org/**", async (route) => {
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
      const url = route.request().url(), reply = await openalex(url);
      const body = tamper ? tamper.edit(url, await reply.json()) : await reply.json();
      await route.fulfill({ status: reply.status, headers: CORS, contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.context().route("https://api.github.com/**", (route) => route.fulfill({
      headers: CORS, contentType: "application/json",
      body: JSON.stringify({ tag_name: `v${latestRelease}`, html_url: `https://github.com/Pinchpeach/research-radar/releases/tag/v${latestRelease}`, published_at: `${TODAY}T00:00:00Z` }),
    }));
    await use(page);
    expect(errors, "no script errors").toEqual([]);
  },
});
export { expect };

/** Open the ☰ menu and go to a page. */
export async function go(page, tab) {
  await page.locator("#menu-button").click();
  await expect(page.locator("#drawer")).toHaveClass(/open/);
  await page.locator(`.drawer .tab[data-tab=${tab}]`).click();
  await expect(page.locator(`#tab-${tab}`)).toBeVisible();
}

/** Search from the home screen and wait for the results. */
export async function search(page, query = QUERY) {
  await page.goto("./");
  await page.locator("#home-query").fill(query);
  await page.locator("#home-query").press("Enter");
  await expect(page.locator("#results .paper").first()).toBeVisible({ timeout: 60_000 });
}

/** Paper titles on the map that are on screen, and how many pairs of them overlap. */
export function titleOverlaps(frame) {
  return frame.evaluate(() => {
    const boxes = [...document.querySelectorAll("#titles text")].filter((t) => t.style.display !== "none").map((t) => t.getBoundingClientRect());
    let pairs = 0;
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) pairs++;
    }
    return { shown: boxes.length, pairs };
  });
}
