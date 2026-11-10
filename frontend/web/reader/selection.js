// The lasso's selection (move, resize, recolour, duplicate, delete) and text boxes.

import { el, svgEl } from "./dom.js";
import { bbox, moved, newId, safeColour, TEXT_LINE } from "./ink.js";

export const selection = {
  select(selection) {
    this.selection = selection && selection.ids.size ? selection : null;
    this.root.classList.toggle("has-selection", !!this.selection);
    for (const s of this.surfaces.values()) s.svg.querySelectorAll(".rd-selbox, .rd-handle").forEach((n) => n.remove());
    this.drawSelection();
  },

  selectionBox(dx = 0, dy = 0) {
    const items = this.itemsOf(this.selection.key).filter((i) => this.selection.ids.has(i.id));
    if (!items.length) return null;
    const boxes = items.map(bbox);
    return [
      Math.min(...boxes.map((b) => b[0])) + dx,
      Math.min(...boxes.map((b) => b[1])) + dy,
      Math.max(...boxes.map((b) => b[2])) + dx,
      Math.max(...boxes.map((b) => b[3])) + dy,
    ];
  },

  insideSelection([x, y]) {
    const b = this.selectionBox();
    return b && x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];
  },

  drawSelection(dx = 0, dy = 0) {
    if (!this.selection) return;
    const s = this.surfaces.get(this.selection.key),
      b = this.selectionBox(dx, dy);
    if (!s || !b) return;
    s.svg.querySelectorAll(".rd-selbox, .rd-handle").forEach((n) => n.remove());
    const pad = 3 * this.unitsPerPx(s);
    s.svg.append(
      svgEl("rect", {
        class: "rd-selbox",
        x: b[0] - pad,
        y: b[1] - pad,
        width: b[2] - b[0] + 2 * pad,
        height: b[3] - b[1] + 2 * pad,
      }),
    );
    const r = 6 * this.unitsPerPx(s); // drag the corner to resize
    s.svg.append(svgEl("rect", { class: "rd-handle", x: b[2] - r, y: b[3] - r, width: 2 * r, height: 2 * r }));
  },

  deleteSelection() {
    if (!this.selection) return;
    const { key, ids } = this.selection;
    this.record(key, () =>
      this.setItems(
        key,
        this.itemsOf(key).filter((i) => !ids.has(i.id)),
      ),
    );
    this.select(null);
    this.drawSurface(this.surfaces.get(key));
  },

  restyleSelection(change) {
    const { key, ids } = this.selection;
    this.record(key, () =>
      this.setItems(
        key,
        this.itemsOf(key).map((i) => (ids.has(i.id) ? { ...i, ...change } : i)),
      ),
    );
    this.drawSurface(this.surfaces.get(key));
  },

  /** Copies of the selection, a little down and to the right, selected instead (the note apps' Duplicate). */
  duplicateSelection() {
    if (!this.selection) return;
    const { key, ids } = this.selection,
      s = this.surfaces.get(key),
      shift = 12 * (s ? this.unitsPerPx(s) : 1);
    const copies = this.itemsOf(key)
      .filter((i) => ids.has(i.id))
      .map((i) => ({ ...moved(i, shift, shift), id: newId() }));
    this.record(key, () => this.itemsOf(key).push(...copies));
    if (s) this.drawSurface(s);
    this.select({ key, ids: new Set(copies.map((i) => i.id)) });
  },

  newText(s, [x, y]) {
    const size = this.sizes.text;
    const item = {
      id: newId(),
      type: "text",
      color: this.colours.text,
      size,
      x: Math.round(x),
      y: Math.round(y - size / 2),
      w: Math.round(Math.min(s.width - x - 4, Math.max(120, s.width * 0.35))),
      text: "",
    };
    this.editText(s, item, true);
  },

  editText(s, item, isNew = false) {
    this.finishEditing();
    const scale = 1 / this.unitsPerPx(s);
    const area = el("textarea", { class: "rd-editor", spellcheck: "false", "aria-label": t("rd.text") });
    area.value = item.text;
    Object.assign(area.style, {
      left: `${item.x * scale}px`,
      top: `${item.y * scale}px`,
      width: `${item.w * scale}px`,
      fontSize: `${item.size * scale}px`,
      lineHeight: String(TEXT_LINE),
      color: safeColour(item.color),
    });
    const fit = () => {
      area.style.height = "auto";
      area.style.height = `${area.scrollHeight + 2}px`;
    };
    area.addEventListener("input", fit);
    area.addEventListener("blur", () => this.finishEditing());
    s.el.append(area);
    s.itemsG.querySelector(`[data-id="${item.id}"]`)?.setAttribute("visibility", "hidden");
    this.editor = { s, item, isNew, area };
    fit();
    area.focus(); // at once, so typing right after the tap lands in the box
    setTimeout(() => area.focus(), 0); // and again once the tap is over
  },

  finishEditing() {
    const ed = this.editor;
    if (!ed) return;
    this.editor = null;
    const text = ed.area.value.replace(/\s+$/, "");
    ed.area.remove();
    const items = this.itemsOf(ed.s.key);
    if (ed.isNew) {
      if (text) this.record(ed.s.key, () => items.push({ ...ed.item, text }));
    } else if (!text) {
      this.record(ed.s.key, () =>
        this.setItems(
          ed.s.key,
          items.filter((i) => i.id !== ed.item.id),
        ),
      );
    } else if (text !== ed.item.text) {
      this.record(ed.s.key, () =>
        this.setItems(
          ed.s.key,
          items.map((i) => (i.id === ed.item.id ? { ...i, text } : i)),
        ),
      );
    }
    this.drawSurface(ed.s);
  },
};
