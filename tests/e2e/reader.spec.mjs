// The PDF reader: writing, editing, note pages, finding things, saving, and the reading record.

import { expect, go, search, test } from "./fixtures.mjs";
import { PDFLib, samplePdf } from "./sample-pdf.mjs";

const page1 = (page) => page.locator(".rd-page[data-page='1'] .rd-ink");
const items = (page, n = 1) => page.locator(`.rd-page[data-page='${n}'] .rd-items > *`);

async function openSample(page, name = "sample.pdf") {
  await page.goto("./");
  await go(page, "reading");
  await page.locator("#open-pdf").setInputFiles({ name, mimeType: "application/pdf", buffer: await samplePdf() });
  await expect(page.locator(".rd-page canvas.rd-canvas[width]").first()).toBeAttached({ timeout: 30_000 });
  await expect(page.locator(".rd-page")).toHaveCount(3);
}

/** A stroke with the mouse, in CSS pixels from the page's top-left. */
async function stroke(page, target, points) {
  const box = await target.boundingBox();
  await page.mouse.move(box.x + points[0][0], box.y + points[0][1]);
  await page.mouse.down();
  for (const [x, y] of points.slice(1)) await page.mouse.move(box.x + x, box.y + y, { steps: 3 });
  await page.mouse.up();
}

/** Pointer events as a stylus or a finger would send them. */
async function synthetic(target, pointerType, points, pressure = 0.7) {
  await target.evaluate((svg, { pointerType, points, pressure }) => {
    const r = svg.getBoundingClientRect(), id = pointerType === "pen" ? 7 : 8;
    const fire = (type, [x, y]) => svg.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: id, pointerType,
      clientX: r.left + x, clientY: r.top + y, pressure, button: 0, buttons: type === "pointerup" ? 0 : 1, isPrimary: true }));
    fire("pointerdown", points[0]);
    for (const p of points.slice(1)) fire("pointermove", p);
    fire("pointerup", points[points.length - 1]);
  }, { pointerType, points, pressure });
}

const wave = Array.from({ length: 12 }, (_, i) => [60 + i * 14, 300 + Math.sin(i / 2) * 12]);

test("pen, colours, highlighter and text boxes", async ({ page }) => {
  await openSample(page);
  await stroke(page, page1(page), wave);
  await expect(items(page)).toHaveCount(1);
  await page.locator(".rd-colour[data-colour='#e5484d']").click();
  await stroke(page, page1(page), wave.map(([x, y]) => [x, y + 60]));
  await expect(items(page).nth(1)).toHaveAttribute("fill", "#e5484d");

  await page.locator(".rd-tool[data-tool=highlighter]").click();
  await stroke(page, page1(page), [[60, 400], [300, 402]]);
  await expect(items(page).nth(2)).toHaveAttribute("stroke", "#ffd400");
  await expect(items(page).nth(2)).toHaveAttribute("opacity", "0.35");

  await page.locator(".rd-tool[data-tool=text]").click();
  const box = await page1(page).boundingBox();
  await page.mouse.click(box.x + 80, box.y + 500);
  await expect(page.locator(".rd-editor")).toBeFocused();
  await page.keyboard.type("핵심 정리: message passing");
  await page.locator(".rd-tool[data-tool=pen]").click();
  await expect(items(page).nth(3)).toContainText("핵심 정리: message passing");
});

test("a stylus writes with pressure; fingers then only scroll (palm rejection)", async ({ page }) => {
  await openSample(page);
  await synthetic(page1(page), "pen", wave, 0.9);
  await expect(items(page)).toHaveCount(1);
  await expect(page.locator(".rd-penonly")).toHaveClass(/on/);
  await synthetic(page1(page), "pen", wave.map(([x, y]) => [x, y + 80]), 0.1);
  const widths = await items(page).evaluateAll((nodes) => nodes.map((n) => n.getBBox().height));
  expect(widths[0], "a firm stroke is thicker than a light one").toBeGreaterThan(widths[1]);
  const before = await page.locator(".rd-pages").evaluate((e) => e.scrollTop);
  await synthetic(page1(page), "touch", [[200, 600], [200, 450], [200, 300]]);
  await expect(items(page)).toHaveCount(2); // the finger drew nothing
  expect(await page.locator(".rd-pages").evaluate((e) => e.scrollTop)).toBeGreaterThan(before);
});

test("select, lasso, move, delete, erase, undo and redo", async ({ page }) => {
  await openSample(page);
  await stroke(page, page1(page), wave);
  await stroke(page, page1(page), wave.map(([x, y]) => [x, y + 50]));
  await expect(items(page)).toHaveCount(2);
  const pathOf = (i) => items(page).nth(i).getAttribute("d");
  const first = await pathOf(0);

  await page.locator(".rd-tool[data-tool=select]").click();
  await stroke(page, page1(page), [[40, 270], [260, 270], [260, 390], [40, 390], [40, 272]]); // lasso both
  await expect(page.locator(".rd-selbox")).toHaveCount(1);
  await expect(page.locator(".rd-delete")).toBeVisible();
  await stroke(page, page1(page), [[120, 300], [180, 360], [220, 420]]); // drag the selection
  expect(await pathOf(0)).not.toBe(first);
  await page.locator(".rd-undo").click();
  expect(await pathOf(0)).toBe(first);
  await page.locator(".rd-redo").click();
  expect(await pathOf(0)).not.toBe(first);

  // undo and redo drop the selection: lasso the (moved) strokes again, then delete them
  await stroke(page, page1(page), [[20, 250], [400, 250], [400, 560], [20, 560], [20, 252]]);
  await page.locator(".rd-delete").click();
  await expect(items(page)).toHaveCount(0);
  await page.keyboard.press("Control+z");
  await expect(items(page)).toHaveCount(2);

  await page.locator(".rd-tool[data-tool=eraser]").click();
  const at = await page.locator(".rd-page[data-page='1'] .rd-items > *").first().boundingBox();
  const pageBox = await page1(page).boundingBox();
  await stroke(page, page1(page), [[at.x - pageBox.x + at.width / 2, at.y - pageBox.y - 10], [at.x - pageBox.x + at.width / 2, at.y - pageBox.y + at.height + 10]]);
  await expect(items(page)).toHaveCount(1);
});

test("note pages beside the PDF, hiding handwriting, search and page list", async ({ page }) => {
  await openSample(page);
  await stroke(page, page1(page), wave);
  await page.locator(".rd-notes-btn").click();
  const note = page.locator(".rd-note .rd-ink").first();
  await expect(note).toBeVisible();
  await stroke(page, note, [[40, 80], [120, 90], [200, 70]]);
  await expect(page.locator(".rd-note .rd-items > *")).toHaveCount(1);
  await page.locator(".rd-add-note").click();
  await expect(page.locator(".rd-note")).toHaveCount(2);
  await page.locator(".rd-notes-btn").click();

  await page.locator(".rd-hide").click();
  await expect(page.locator(".rd-page[data-page='1'] .rd-items")).toBeHidden();
  await page.locator(".rd-hide").click();
  await expect(page.locator(".rd-page[data-page='1'] .rd-items")).toBeVisible();

  await page.locator(".rd-find").click();
  await page.locator(".rd-search-input").fill("laplacian");
  await page.locator(".rd-search-input").press("Enter");
  await expect(page.locator(".rd-search-count")).toHaveText("1 / 1");
  await expect(page.locator(".rd-page[data-page='2'] .rd-hit.on")).toHaveCount(1);

  await page.locator(".rd-thumbs-btn").click();
  await expect(page.locator(".rd-thumb")).toHaveCount(3);
  await page.locator(".rd-thumb[data-page='3']").click();
  await expect(page.locator(".rd-thumb[data-page='3']")).toHaveClass(/on/, { timeout: 5000 });
});

test("handwriting comes back when the same file is opened again", async ({ page }) => {
  await openSample(page);
  await stroke(page, page1(page), wave);
  await expect(items(page)).toHaveCount(1);
  await page.waitForTimeout(1000); // autosave
  await page.locator(".rd-close").click();
  await expect(page.locator("#doc-list .read-row")).toHaveCount(1);
  await page.reload();
  await openSample(page, "renamed copy.pdf"); // recognised by its contents, not its name
  await expect(items(page)).toHaveCount(1);
});

test("saving: the PDF with handwriting merged, and the note pages on their own", async ({ page }) => {
  // in English: headless Chromium names downloads with non-ASCII names just "download"
  await page.addInitScript(() => { if (window === window.top) localStorage.setItem("radar-lang", "en"); });
  await openSample(page);
  await stroke(page, page1(page), wave);
  await page.locator(".rd-tool[data-tool=text]").click();
  const box = await page1(page).boundingBox();
  await page.mouse.click(box.x + 80, box.y + 500);
  await expect(page.locator(".rd-editor")).toBeFocused();
  await page.keyboard.type("한글 메모"); // Hangul survives: text boxes go into the PDF as images
  await page.locator(".rd-tool[data-tool=pen]").click();
  await page.locator(".rd-notes-btn").click();
  await stroke(page, page.locator(".rd-note .rd-ink").first(), [[40, 80], [200, 90]]);

  await page.locator(".rd-save").click();
  const [merged] = await Promise.all([page.waitForEvent("download"), page.locator(".rd-save-pdf").click()]);
  expect(merged.suggestedFilename()).toBe("sample (annotated).pdf");
  const doc = await PDFLib.PDFDocument.load(await readAll(merged));
  expect(doc.getPageCount()).toBe(3);
  const original = await PDFLib.PDFDocument.load(await samplePdf());
  expect(contentLength(doc.getPage(0))).toBeGreaterThan(contentLength(original.getPage(0)) + 100); // the ink and the text box
  expect(contentLength(doc.getPage(1))).toBe(contentLength(original.getPage(1))); // nothing written on page 2

  await page.locator(".rd-save").click();
  const [notes] = await Promise.all([page.waitForEvent("download"), page.locator(".rd-save-notes").click()]);
  expect(notes.suggestedFilename()).toBe("sample (notes).pdf");
  expect((await PDFLib.PDFDocument.load(await readAll(notes))).getPageCount()).toBe(1);
});

test.describe("reading a paper's free PDF", () => {
  const PDF_URL = "https://repository.example.org/gnn-model.pdf";
  test.use({ tamper: { edit: (url, body) => ({ ...body, results: (body.results || []).map((w) =>
    (w.id.endsWith("/W2116341502") ? { ...w, best_oa_location: { pdf_url: PDF_URL } } : w)) }) } });

  test("opens from the card, marks the paper read at the end, collects highlights into the note", async ({ page }) => {
    await page.route(PDF_URL, async (route) => route.fulfill({ headers: { "access-control-allow-origin": "*" },
      contentType: "application/pdf", body: await samplePdf(3) }));
    await search(page);
    const card = page.locator("#results .paper", { hasText: "The Graph Neural Network Model" }).first();
    await card.locator(".read-pdf").click();
    await expect(page.locator(".rd-title")).toHaveText("The Graph Neural Network Model");
    await expect(page.locator(".rd-page")).toHaveCount(3, { timeout: 30_000 });

    // highlight the sentence on page 1, then collect it
    await page.locator(".rd-tool[data-tool=highlighter]").click();
    const box = await page1(page).boundingBox(), scale = box.width / 595;
    const y = (842 - 720 - 5) * scale; // the sentence's baseline is 720pt up from the bottom
    await stroke(page, page1(page), [[55 * scale, y], [380 * scale, y]]);
    await page.locator(".rd-annots-btn").click();
    await expect(page.locator(".rd-annot")).toContainText("Graph neural networks pass messages along edges.");
    await page.locator(".rd-to-note").click();
    await expect(page.locator(".rd-toast")).toHaveText("북마크 메모에 붙였어요.");

    // scroll to the end of the last page: read
    await page.locator(".rd-pages").evaluate((e) => e.scrollTo(0, e.scrollHeight));
    await expect(page.locator(".rd-toast")).toHaveText("끝까지 읽었어요! 독서 기록에 '읽음'으로 남겼어요.");
    await page.locator(".rd-close").click();
    await go(page, "reading");
    await expect(page.locator("#reading-count")).toHaveText("1");
    await go(page, "bookmarks");
    await expect(page.locator("#bookmarks textarea").first()).toHaveValue(/Graph neural networks pass messages along edges\./);
  });

  test("a site that won't hand over the PDF: open it in the browser or pick the file", async ({ page }) => {
    await page.route(PDF_URL, (route) => route.fulfill({ status: 403, headers: { "access-control-allow-origin": "*" }, body: "no" }));
    await search(page);
    await page.locator("#results .paper", { hasText: "The Graph Neural Network Model" }).first().locator(".read-pdf").click();
    await expect(page.locator(".rd-unavailable")).toBeVisible();
    await expect(page.locator(".rd-unavailable a")).toHaveAttribute("href", PDF_URL);
    await page.locator(".rd-unavailable input[type=file]").setInputFiles({ name: "downloaded.pdf", mimeType: "application/pdf", buffer: await samplePdf() });
    await expect(page.locator(".rd-page")).toHaveCount(3, { timeout: 30_000 });
  });
});

test.describe("no free copy on OpenAlex", () => {
  const DOI = "10.1109/TNN.2008.2005605", PDF_URL = "https://authors.example.org/gnn-preprint.pdf";
  test.use({ tamper: { edit: (url, body) => ({ ...body, results: (body.results || []).map((w) =>
    (w.id.endsWith("/W2116341502") ? { ...w, doi: `https://doi.org/${DOI}`, best_oa_location: null, open_access: { oa_url: null } } : w)) }) } });

  test("the school e-mail finds the library; Unpaywall's copy opens", async ({ page }) => {
    let asked = null;
    await page.context().route("https://api.unpaywall.org/**", (route) => {
      asked = route.request().url();
      return route.fulfill({ headers: { "access-control-allow-origin": "*" }, contentType: "application/json",
        body: JSON.stringify({ best_oa_location: { url_for_pdf: PDF_URL }, oa_locations: [] }) });
    });
    await page.route(PDF_URL, async (route) => route.fulfill({ headers: { "access-control-allow-origin": "*" },
      contentType: "application/pdf", body: await samplePdf(3) }));

    await page.goto("./");
    await go(page, "settings");
    await page.locator(".subtab[data-pane=library]").click();
    await page.locator("#openalex-email").fill("student@yonsei.ac.kr");
    await page.locator("#openalex-email").blur();
    await expect(page.locator("#school-state")).toContainText("연세대학교");
    await expect(page.locator("#library-proxy")).toHaveValue("https://access.yonsei.ac.kr/link.n2s?url=");
    await page.locator("#library-form button[type=submit]").click();
    await expect(page.locator("#library-status")).not.toBeEmpty();

    await search(page);
    await page.locator("#results .paper", { hasText: "The Graph Neural Network Model" }).first().locator(".read-pdf").click();
    await expect(page.locator(".rd-page")).toHaveCount(3, { timeout: 30_000 });
    expect(asked).toBe(`https://api.unpaywall.org/v2/${DOI}?email=student%40yonsei.ac.kr`);
  });

  test("nowhere to get it: says how to add the library, or pick the file", async ({ page }) => {
    await search(page);
    await page.locator("#results .paper", { hasText: "The Graph Neural Network Model" }).first().locator(".read-pdf").click();
    await expect(page.locator(".rd-unavailable h3")).toHaveText("무료로 받을 수 있는 PDF를 찾지 못했어요");
    await expect(page.locator(".rd-unavailable")).toContainText("설정 › 도서관");
    await page.locator(".rd-unavailable input[type=file]").setInputFiles({ name: "mine.pdf", mimeType: "application/pdf", buffer: await samplePdf() });
    await expect(page.locator(".rd-page")).toHaveCount(3, { timeout: 30_000 });
  });
});

test.describe("through the university library (the Android app's in-app sign-in)", () => {
  const DOI = "10.1109/TNN.2008.2005605", KR = "https://libproxy.uni.example/_Lib_Proxy_Url/";
  const PAGE = `${KR}https://doi.org/${DOI}`, PDF = `${KR}https://ieeexplore.example/stamp/gnn.pdf`;
  test.use({ tamper: { edit: (url, body) => ({ ...body, results: (body.results || []).map((w) =>
    (w.id.endsWith("/W2116341502") ? { ...w, doi: `https://doi.org/${DOI}`, best_oa_location: null, open_access: { oa_url: null } } : w)) }) } });

  test("signing in once in the web view, then the paper opens", async ({ page }) => {
    let signedIn = false;
    const opened = [];
    await page.exposeFunction("signInAtLibrary", (url) => { opened.push(url); signedIn = true; });
    // a stand-in for @capacitor/inappbrowser: "signing in" happens when the web view opens
    await page.addInitScript(() => {
      if (window !== window.top) return;
      const listeners = {};
      const fire = (name) => (listeners[name] || []).forEach((f) => f({}));
      window.Capacitor = { Plugins: { InAppBrowser: {
        addListener: async (name, f) => { (listeners[name] ||= []).push(f); return { remove: () => { listeners[name] = listeners[name].filter((g) => g !== f); } }; },
        openInWebView: async ({ url, options }) => {
          window.webViewOptions = options;
          await window.signInAtLibrary(url);
          setTimeout(() => fire("browserPageLoaded"), 10);
        },
        close: async () => fire("browserClosed"),
      } } };
      // like CapacitorHttp, which follows redirects natively and reports where it ended up
      // (a fulfilled cross-origin redirect fails in the test browser)
      const original = window.fetch;
      window.fetch = async (...args) => {
        const response = await original(...args), final = response.headers.get("x-final-url");
        if (final) Object.defineProperty(response, "url", { value: final });
        return response;
      };
    });
    await page.context().route((url) => url.href.startsWith(KR), async (route) => {
      const url = route.request().url(), cors = { "access-control-allow-origin": "*" };
      if (!signedIn) { // off to the school's sign-in page
        return route.fulfill({ headers: { ...cors, "access-control-expose-headers": "x-final-url", "x-final-url": "https://sso.uni.example/login" },
          contentType: "text/html", body: "<form>sign in</form>" });
      }
      if (url === PAGE) return route.fulfill({ headers: cors, contentType: "text/html", body: `<meta name="citation_pdf_url" content="https://ieeexplore.example/stamp/gnn.pdf">` });
      if (url === PDF) return route.fulfill({ headers: cors, contentType: "application/pdf", body: await samplePdf(3) });
      return route.fulfill({ status: 404, headers: cors });
    });

    await page.goto("./");
    await go(page, "settings");
    await page.locator(".subtab[data-pane=library]").click();
    await page.locator("#library-proxy").fill(KR);
    await page.locator("#library-form button[type=submit]").click();
    await expect(page.locator("#library-state")).toContainText("아직 로그인하지 않았어요");

    await search(page);
    await page.locator("#results .paper", { hasText: "The Graph Neural Network Model" }).first().locator(".read-pdf").click();
    await expect(page.locator(".rd-unavailable .rd-error")).toHaveText("학교 도서관 로그인이 필요해요");
    await page.locator(".rd-login").click();
    await expect(page.locator(".rd-page")).toHaveCount(3, { timeout: 30_000 });
    expect(opened).toEqual([PAGE]);
    const options = await page.evaluate(() => window.webViewOptions);
    expect([options.clearCache, options.clearSessionCache, options.android.isIsolated]).toEqual([false, false, false]); // keeps the cookies

    await page.locator(".rd-close").click();
    await go(page, "settings");
    await page.locator(".subtab[data-pane=library]").click();
    await expect(page.locator("#library-state")).toContainText("로그인되어 있어요");
  });
});

async function readAll(download) {
  const chunks = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function contentLength(pdfPage) {
  const contents = pdfPage.node.Contents();
  const streams = contents instanceof PDFLib.PDFArray ? contents.asArray().map((r) => pdfPage.doc.context.lookup(r)) : [contents];
  return streams.reduce((n, s) => n + (s.getContents ? s.getContents().length : 0), 0);
}
