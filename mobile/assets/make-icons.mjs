// Render assets/icon.svg into the Android launcher icons and splash screens.
//   node assets/make-icons.mjs   (needs Playwright with Chromium)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const here = path.dirname(fileURLToPath(import.meta.url));
const res = path.join(here, "..", "android", "app", "src", "main", "res");
const svg = fs.readFileSync(path.join(here, "icon.svg"), "utf8");
const foreground = svg.replace(/<rect[^>]*\/>/, ""); // the adaptive icon draws the background itself
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await browser.newPage();

async function render(file, width, height, body) {
  await page.setViewportSize({ width, height });
  await page.setContent(`<html><body style="margin:0;background:transparent">${body}</body></html>`);
  await page.screenshot({ path: file, omitBackground: true });
}
const icon = (s, size, round) => `<div style="width:${size}px;height:${size}px;overflow:hidden;${round ? "border-radius:50%" : ""}">${s.replace("<svg ", `<svg width="${size}" height="${size}" `)}</div>`;

const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
for (const [name, k] of Object.entries(densities)) {
  const dir = path.join(res, `mipmap-${name}`);
  // legacy icons: the icon on a rounded square / circle at 48dp; adaptive foreground at 108dp
  await render(path.join(dir, "ic_launcher.png"), 48 * k, 48 * k, `<div style="border-radius:${8 * k}px;overflow:hidden;width:${48 * k}px">${icon(svg, 48 * k)}</div>`);
  await render(path.join(dir, "ic_launcher_round.png"), 48 * k, 48 * k, icon(svg, 48 * k, true));
  await render(path.join(dir, "ic_launcher_foreground.png"), 108 * k, 108 * k, icon(foreground, 108 * k));
}
// splash screens keep their sizes: the icon centred on the app's light background
for (const dir of fs.readdirSync(res).filter((d) => d.startsWith("drawable"))) {
  const file = path.join(res, dir, "splash.png");
  if (!fs.existsSync(file)) continue;
  const png = fs.readFileSync(file);
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20), size = Math.round(Math.min(width, height) * 0.3);
  await render(file, width, height, `<div style="width:${width}px;height:${height}px;background:#f6f6f4;display:flex;align-items:center;justify-content:center"><div style="border-radius:22%;overflow:hidden;width:${size}px;height:${size}px">${icon(svg, size)}</div></div>`);
}
await browser.close();
console.log("icons and splash screens written");
