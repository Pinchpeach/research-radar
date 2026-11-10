// Building the reader's page. Text always goes in as textContent, never as HTML.

const SVG = "http://www.w3.org/2000/svg";

export const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
};
export const svgEl = (tag, attrs = {}) => {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) node.setAttribute(k, v);
  return node;
};

/** A deep copy of plain data (a page's items, for undo). */
export const clone = (v) => JSON.parse(JSON.stringify(v));

/** Keep getting this pointer's events, wherever it goes, until it lifts. */
export const capture = (node, e) => {
  try {
    node.setPointerCapture(e.pointerId);
  } catch {
    /* not a live pointer (synthetic events) */
  }
};
