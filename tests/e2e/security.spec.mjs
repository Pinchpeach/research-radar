// Third-party paper data trying to run code in the app (docs/security.md).

import { expect, go, search, test } from "./fixtures.mjs";

const TRAP = "window.top.__pwned = 1";
test.use({
  // a paper in the results has a booby-trapped title, author name and links
  tamper: { edit: (url, body) => {
    // "The Graph Neural Network Model", which ranks first for the recorded search
    return { ...body, results: (body.results || []).map((w) => (!w.id.endsWith("/W2116341502") ? w : {
      ...w,
      title: `<img src=x onerror="${TRAP}">The Graph Neural Network Model`,
      doi: `javascript:${TRAP}`,
      primary_location: { ...w.primary_location, landing_page_url: `javascript:${TRAP}` },
      authorships: [{ author: { display_name: `<script>${TRAP}</script>` } }],
    })) };
  } },
});

test("booby-trapped titles, names and links stay plain text", async ({ page }) => {
  await search(page);
  const card = page.locator("#results .paper", { hasText: "<img src=x" });
  await expect(card).toHaveCount(1);
  await expect(card.locator(".title")).not.toHaveAttribute("href", /javascript/i);
  await expect(card.locator(".authors")).toContainText("<script>");
  await card.locator(".title").click();
  await go(page, "map");
  const map = page.frameLocator("#poster");
  await expect(map.locator(".dot").first()).toBeAttached({ timeout: 60_000 });
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
});

test("the map cannot reach into the app", async ({ page }) => {
  await search(page);
  await go(page, "map");
  await expect(page.frameLocator("#poster").locator(".dot").first()).toBeAttached({ timeout: 60_000 });
  const frame = page.frame({ url: /about:srcdoc/ });
  const reach = await frame.evaluate(() => {
    try { return parent.document.title; } catch { return "blocked"; }
  });
  expect(reach).toBe("blocked");
  const storage = await frame.evaluate(() => { try { return localStorage.length; } catch { return "blocked"; } });
  expect(storage).toBe("blocked");
});
