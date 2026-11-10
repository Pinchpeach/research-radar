// Small helpers for building the page. Text always goes in as textContent, never as HTML.

export const $ = (id) => document.getElementById(id);

/** Build DOM safely: text always goes in as textContent. */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) if (child != null) node.append(child);
  return node;
}

export function setStatus(id, message, isError = false) {
  $(id).textContent = message;
  $(id).classList.toggle("error", isError);
}

/** A date in the app's language: "11월 10일" / "Nov 10", or with other `options`. */
export const localDate = (iso, options = { month: "short", day: "numeric" }) =>
  new Date(iso).toLocaleDateString(LANG === "ko" ? "ko-KR" : "en-US", options);
