// The app's main paths, on a phone and in a desktop window (see playwright.config.mjs).

import { expect, go, QUERY, search, test, titleOverlaps, VERSION } from "./fixtures.mjs";

test("first start: greeting, example topics and a hint to add a key", async ({ page }) => {
  await page.goto("./");
  await expect(page.locator("#greeting")).not.toBeEmpty();
  await expect(page.locator("#recent-topics .topic")).toHaveCount(3);
  await expect(page.locator("#banner")).toBeVisible();
  await expect(page.locator("#key-pill")).toHaveText("OpenAlex 키 없음");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), "no sideways scroll").toBeLessThanOrEqual(0);
});

test("the ☰ menu: Home first, every page reachable, Escape closes it", async ({ page }) => {
  await page.goto("./");
  await page.locator("#menu-button").click();
  await expect(page.locator(".drawer .tab").first()).toHaveAttribute("data-tab", "home");
  await page.keyboard.press("Escape");
  await expect(page.locator("#drawer")).not.toHaveClass(/open/);
  for (const [tab, title] of [["discover", "연구 탐색"], ["bookmarks", "북마크"], ["map", "연구 흐름"], ["news", "새소식"], ["settings", "설정"]]) {
    await go(page, tab);
    await expect(page.locator("#page-title")).toHaveText(title);
  }
  await page.locator("#home-logo").click();
  await expect(page.locator("#tab-home")).toBeVisible();
});

test("search from home: key papers, then recent work, and the topic is remembered", async ({ page, openalexCalls }) => {
  await search(page);
  await expect(page.locator("#page-title")).toHaveText("연구 탐색");
  expect(await page.locator("#results .paper").count()).toBeGreaterThanOrEqual(20);
  await expect(page.locator(".chip.key").first()).toBeVisible();
  await expect(page.locator(".chip.recent").first()).toBeVisible();
  expect(openalexCalls.every((url) => !url.includes("api_key=")), "no key was set").toBe(true);
  await page.locator("#home-logo").click();
  await expect(page.locator("#recent-topics .topic.recent")).toHaveText([QUERY]);
});

test("bookmarks are kept after a restart", async ({ page }) => {
  await search(page);
  await page.locator("#results .paper .star").nth(0).click();
  await page.locator("#results .paper .star").nth(1).click();
  await expect(page.locator("#bm-count")).toHaveText("(2)");
  await go(page, "bookmarks");
  await expect(page.locator("#bookmarks .paper")).toHaveCount(2);
  await page.reload();
  await expect(page.locator("#bm-count")).toHaveText("(2)");
});

test("research flow: drawn on opening, titled with the topic, titles never overlap", async ({ page }, info) => {
  await search(page);
  await go(page, "map");
  const map = page.frameLocator("#poster");
  await expect(map.locator(".dot").first()).toBeAttached({ timeout: 60_000 });
  expect(await map.locator(".dot").count()).toBeGreaterThan(15);
  await expect(map.locator("#head .t")).toHaveText(QUERY.toUpperCase());
  await expect(map.locator("html")).toHaveClass(/light/);
  const frame = page.frame({ url: /about:srcdoc/ });
  await expect.poll(() => titleOverlaps(frame).then((o) => o.shown)).toBeGreaterThan(0);
  expect((await titleOverlaps(frame)).pairs).toBe(0);
  // the sandboxed map can't load the app's files, so its font comes inlined
  expect(await frame.evaluate(() => document.fonts.ready.then(() => document.fonts.check("700 12px NanumSquareRound")))).toBe(true);
  if (info.project.name === "phone") {
    // a phone opens zoomed on the latest work, with the timeline bar to swipe back
    await expect(map.locator("#track")).toBeVisible();
    const thumb = await map.locator("#thumb").boundingBox(), track = await map.locator("#track").boundingBox();
    expect(thumb.x + thumb.width).toBeGreaterThan(track.x + track.width - 4);
  }
  await map.locator("#zin").click();
  await map.locator("#zin").click();
  expect((await titleOverlaps(frame)).pairs, "still no overlap zoomed in").toBe(0);
});

test.describe("with a newer release out", () => {
  test.use({ latestRelease: "99.0.0" });
  test("news lists this version and announces the new one", async ({ page }) => {
    await page.goto("./");
    await expect(page.locator("#menu-dot")).toBeVisible();
    await go(page, "news");
    await expect(page.locator("#update-card")).toContainText("v99.0.0");
    await expect(page.locator(".release h3").first()).toContainText(`v${VERSION}`);
    await expect(page.locator(".release").first().locator(".chip")).toHaveText("지금 버전");
  });
});

test("English stays chosen after a restart", async ({ page }) => {
  await page.goto("./");
  await go(page, "settings");
  await page.locator(".subtab[data-pane=language]").click();
  await page.locator("#language label", { hasText: "English" }).click();
  await expect(page.locator(".drawer .tab[data-tab=map]")).toHaveText("Research flow");
  await page.reload();
  await expect(page.locator(".drawer .tab[data-tab=map]")).toHaveText("Research flow");
  await expect(page.locator("#page-title")).toHaveText("");
});
