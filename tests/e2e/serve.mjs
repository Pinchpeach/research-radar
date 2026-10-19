// Serve the Android app's web content (mobile/www, built by mobile/build.mjs) for the browser tests.
// It is the same frontend/web the desktop app shows, with the JavaScript backend answering in the page.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../mobile/www");
const port = Number(process.env.PORT || 4173);
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".txt": "text/plain" };

http.createServer((req, res) => {
  const name = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const file = path.join(root, name.endsWith("/") ? `${name}index.html` : name);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}).listen(port, "127.0.0.1", () => console.log(`serving ${root} on http://127.0.0.1:${port}`));
