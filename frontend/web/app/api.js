// Talking to the backend: the desktop app's local server (backend/), or on Android the
// JavaScript port answering in the page (core/, set up by mobile.js). And saving files.

import { el } from "./dom.js";

export async function api(method, path, body) {
  if (window.radarLocalApi) {
    try {
      return await window.radarLocalApi(method, path, body);
    } catch (e) {
      throw new Error(e.status ? e.message : t("err.server"));
    }
  }
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(t("err.server"));
  }
  if (res.status === 204) return null;
  const type = res.headers.get("content-type") || "";
  const data = type.includes("json") ? await res.json() : await res.text();
  if (!res.ok) {
    const detail = data && data.detail;
    throw new Error(typeof detail === "string" ? detail : t("err.request", { status: res.status }));
  }
  return data;
}

/** Bytes as base64, in chunks (a whole PDF at once would overflow the call stack). */
export function toBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Save text or bytes (a Uint8Array) to a file: native dialog in the desktop app, the share sheet
 * on Android, a download in a browser. Resolves to a message for the person. */
export async function saveFile(name, content, mime) {
  if (window.radarSaveFile) return window.radarSaveFile(name, content, mime);
  const desktop = window.pywebview && window.pywebview.api;
  if (desktop && desktop.save_file) {
    const saved =
      content instanceof Uint8Array
        ? await desktop.save_bytes(name, toBase64(content))
        : await desktop.save_file(name, content);
    return saved ? t("file.saved", { path: saved }) : t("file.cancelled");
  }
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const link = el("a", { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return t("file.downloaded", { name });
}
