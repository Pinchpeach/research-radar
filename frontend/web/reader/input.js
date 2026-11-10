// Pen, finger and mouse on the pages: writing, erasing, selecting and moving handwriting; the
// note apps' gestures (draw and hold, two- and three-finger taps); scrolling and zooming.

import { capture, clone, svgEl } from "./dom.js";
import {
  eraseFrom,
  hits,
  HIGHLIGHT_OPACITY,
  lassoed,
  linePath,
  moved,
  newId,
  polygonPath,
  recognizeShape,
  scaled,
  simplify,
  strokeOutline,
} from "./ink.js";

const HOLD_MS = 500; // draw and hold this still: the stroke snaps to a clean line or shape
const TAP_MS = 300; // two or three fingers down and up this quickly: undo or redo
const MAX_ZOOM = 4;
const MIN_ZOOM = 0.5;

export const input = {
  /** Page units under a pointer event. */
  pointOn(s, e) {
    const r = s.svg.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * s.width, ((e.clientY - r.top) / r.height) * s.height];
  },

  unitsPerPx(s) {
    return s.width / s.svg.getBoundingClientRect().width;
  },

  bindInput(s) {
    const svg = s.svg;
    svg.addEventListener("pointerdown", (e) => this.down(s, e));
    svg.addEventListener("pointermove", (e) => this.move(s, e));
    svg.addEventListener("pointerup", (e) => this.up(s, e));
    svg.addEventListener("pointercancel", (e) => this.up(s, e, true));
    svg.addEventListener("dblclick", (e) => {
      const item = this.itemAt(s, this.pointOn(s, e), (i) => i.type === "text");
      if (item) this.editText(s, item);
    });
  },

  /** Is this pointer for moving around (fingers when only the pen writes, two fingers, the hand tool)? */
  navigates(e) {
    if (this.tool === "hand" || this.root.classList.contains("ink-hidden")) return true;
    if (e.pointerType === "touch") return this.penOnly || this.touches.size > 1;
    return e.pointerType === "mouse" && e.button !== 0;
  },

  down(s, e) {
    if (e.pointerType === "pen" && !this.penOnly && !this.penOnlyChosen) {
      this.setPenOnly(true); // a stylus: fingers now only scroll and zoom (palm rejection)
      this.toast(t("rd.penDetected"));
    }
    if (e.pointerType === "touch") {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      // two or three fingers tapped together: undo or redo (GoodNotes, Notability)
      if (!this.tap || this.touches.size === 1)
        this.tap = { at: Date.now(), fingers: 0, moved: false, starts: new Map() };
      this.tap.fingers = Math.max(this.tap.fingers, this.touches.size);
      this.tap.starts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    // a second finger: it was a pinch or a tap, not writing, so what the first finger began is taken back
    if (e.pointerType === "touch" && this.touches.size > 1 && this.gesture && this.gesture.touch) this.cancelGesture();
    if (this.navigates(e)) {
      this.startNavigation(s, e);
      return;
    }
    if (this.gesture) return; // one stroke at a time
    e.preventDefault();
    capture(s.svg, e);
    const p = this.pointOn(s, e),
      pressure = e.pointerType === "pen" ? e.pressure || 0.5 : 0;
    const begin = (kind, more = {}) =>
      (this.gesture = { kind, s, id: e.pointerId, touch: e.pointerType === "touch", ...more });
    // the stylus's eraser end, or its side button held (S Pen): erase whatever the tool is
    const stylusErases =
      e.pointerType === "pen" && (e.button === 5 || e.button === 2 || e.buttons & 32 || e.buttons & 2);
    if (stylusErases || this.tool === "eraser") {
      begin("erase", { before: clone(this.itemsOf(s.key)), removed: 0 });
      this.eraseAt(s, p);
    } else if (this.tool === "pen" || this.tool === "highlighter") {
      begin("draw", { points: [[...p, pressure]], highlight: this.tool === "highlighter" });
      this.drawLive();
      this.holdAt(e);
    } else if (this.tool === "text") {
      const item = this.itemAt(s, p, (i) => i.type === "text");
      if (item) this.editText(s, item);
      else this.newText(s, p);
    } else if (this.tool === "select") {
      const sel = this.selection;
      const box = sel && sel.key === s.key && this.selectionBox();
      const corner = box && Math.hypot(p[0] - box[2], p[1] - box[3]) <= 12 * this.unitsPerPx(s);
      if (corner) {
        // the resize handle: scale around the selection's top-left corner
        begin("resize", {
          origin: [box[0], box[1]],
          from: Math.max(1, Math.hypot(box[2] - box[0], box[3] - box[1])),
          k: 1,
        });
        return;
      }
      const grabbed = sel && sel.key === s.key && this.insideSelection(p);
      const item = grabbed ? null : this.itemAt(s, p);
      if (item) this.select({ key: s.key, ids: new Set([item.id]) });
      if (grabbed || item) begin("move", { from: p, dx: 0, dy: 0 });
      else {
        this.select(null);
        begin("lasso", { points: [p] });
      }
    }
  },

  move(s, e) {
    if (e.pointerType === "touch" && this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const start = this.tap && this.tap.starts.get(e.pointerId);
      if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) this.tap.moved = true;
    }
    if (this.steers(e)) {
      this.navigate(e);
      return;
    }
    const g = this.gesture;
    if (!g || g.id !== e.pointerId || g.s !== s) return;
    e.preventDefault();
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    if (g.kind === "draw" && g.snapped) {
      // a snapped straight line: its end follows the pen until lifted
      if (g.points.length === 2) {
        g.points[1] = [...this.pointOn(s, e), g.points[1][2]];
        this.drawLive();
      }
    } else if (g.kind === "draw") {
      for (const ev of events.length ? events : [e])
        g.points.push([...this.pointOn(s, ev), e.pointerType === "pen" ? ev.pressure || 0.5 : 0]);
      this.drawLive();
      this.holdAt(e);
    } else if (g.kind === "resize") {
      const p = this.pointOn(s, e),
        box = this.selectionBox();
      g.k = Math.max(0.1, Math.hypot(p[0] - g.origin[0], p[1] - g.origin[1]) / g.from);
      const ids = this.selection.ids;
      s.itemsG.replaceChildren(
        ...this.itemsOf(s.key).map((i) => this.itemNode(ids.has(i.id) ? scaled(i, g.origin[0], g.origin[1], g.k) : i)),
      );
      if (box) this.drawSelection();
    } else if (g.kind === "erase") {
      for (const ev of events.length ? events : [e]) this.eraseAt(s, this.pointOn(s, ev));
    } else if (g.kind === "move") {
      const p = this.pointOn(s, e);
      g.dx = p[0] - g.from[0];
      g.dy = p[1] - g.from[1];
      for (const node of s.itemsG.children)
        if (this.selection.ids.has(node.dataset.id)) node.setAttribute("transform", `translate(${g.dx} ${g.dy})`);
      this.drawSelection(g.dx, g.dy);
    } else if (g.kind === "lasso") {
      g.points.push(this.pointOn(s, e));
      s.liveG.replaceChildren(
        svgEl("polygon", { points: g.points.map((q) => q.join(",")).join(" "), class: "rd-lasso" }),
      );
    }
  },

  up(s, e, cancelled = false) {
    if (e.pointerType === "touch") {
      this.touches.delete(e.pointerId);
      const tap = this.tap;
      if (tap && !this.touches.size) {
        this.tap = null;
        if (!tap.moved && !cancelled && Date.now() - tap.at < TAP_MS && tap.fingers >= 2) {
          this.nav = null;
          if (tap.fingers === 2) this.doUndo();
          else this.doRedo();
          return;
        }
      }
    }
    if (this.steers(e)) {
      if (this.nav.touch && this.touches.size)
        this.startNavigation(s, e); // one finger lifted: go on from the other
      else this.nav = null;
      return;
    }
    const g = this.gesture;
    if (!g || g.id !== e.pointerId) return;
    if (cancelled) return this.cancelGesture();
    clearTimeout(this.holdTimer);
    this.gesture = null;
    s.liveG.replaceChildren();
    if (g.kind === "draw") {
      const highlight = g.highlight;
      let points = g.snapped ? g.points : simplify(g.points, 0.25 * this.unitsPerPx(s));
      if (highlight && this.straightHighlight && points.length > 1) points = [points[0], points[points.length - 1]];
      const item = {
        id: newId(),
        type: highlight ? "highlight" : "ink",
        color: this.colours[highlight ? "highlighter" : "pen"],
        width: Math.round(this.sizes[highlight ? "highlighter" : "pen"] * 10) / 10,
        points: highlight ? points.map(([x, y]) => [x, y]) : points,
      };
      if (!highlight) item.pen = this.penType;
      this.record(s.key, () => this.itemsOf(s.key).push(item));
      this.drawSurface(s);
    } else if (g.kind === "erase") {
      if (g.removed) {
        this.remember({ key: s.key, before: g.before, after: clone(this.itemsOf(s.key)) });
      }
    } else if (g.kind === "move") {
      if (Math.abs(g.dx) + Math.abs(g.dy) > 0.2) {
        const ids = this.selection.ids;
        this.record(s.key, () =>
          this.setItems(
            s.key,
            this.itemsOf(s.key).map((i) => (ids.has(i.id) ? moved(i, g.dx, g.dy) : i)),
          ),
        );
      }
      this.drawSurface(s);
    } else if (g.kind === "resize") {
      if (Math.abs(g.k - 1) > 0.01) {
        const ids = this.selection.ids;
        this.record(s.key, () =>
          this.setItems(
            s.key,
            this.itemsOf(s.key).map((i) => (ids.has(i.id) ? scaled(i, g.origin[0], g.origin[1], g.k) : i)),
          ),
        );
      }
      this.drawSurface(s);
    } else if (g.kind === "lasso") {
      const caught = lassoed(this.itemsOf(s.key), g.points);
      this.select(caught.length ? { key: s.key, ids: new Set(caught.map((i) => i.id)) } : null);
    }
  },

  /** Drop the gesture under way and put the page back as it was before it. */
  cancelGesture() {
    const g = this.gesture;
    if (!g) return;
    clearTimeout(this.holdTimer);
    this.gesture = null;
    g.s.liveG.replaceChildren();
    if (g.kind === "erase" && g.removed) this.setItems(g.s.key, g.before);
    this.drawSurface(g.s);
  },

  drawLive() {
    const g = this.gesture,
      highlight = g.highlight;
    const colour = this.colours[highlight ? "highlighter" : "pen"],
      width = this.sizes[highlight ? "highlighter" : "pen"];
    const points =
      highlight && this.straightHighlight && g.points.length > 1
        ? [g.points[0], g.points[g.points.length - 1]]
        : g.points;
    const node = highlight
      ? svgEl("path", {
          d: linePath(points),
          fill: "none",
          stroke: colour,
          "stroke-width": width,
          "stroke-linecap": "round",
          opacity: HIGHLIGHT_OPACITY,
          class: "rd-hl",
        })
      : svgEl("path", { d: polygonPath(strokeOutline(points, width, this.penType)), fill: colour });
    g.s.liveG.replaceChildren(node);
  },

  /**
   * Draw and hold (GoodNotes, Samsung Notes, Notability): when the pen rests HOLD_MS without
   * moving, the stroke becomes the clean line or shape it was meant to be. A highlighter only
   * straightens.
   */
  holdAt(e) {
    const g = this.gesture;
    if (!g || g.kind !== "draw" || g.snapped) return;
    if (g.rest && Math.hypot(e.clientX - g.rest.x, e.clientY - g.rest.y) < 4) return; // still resting
    g.rest = { x: e.clientX, y: e.clientY };
    clearTimeout(this.holdTimer);
    this.holdTimer = setTimeout(() => {
      if (this.gesture !== g) return;
      const shape = recognizeShape(g.points);
      if (!shape || (g.highlight && shape.length !== 2)) return;
      g.points = shape;
      g.snapped = true;
      this.drawLive();
      if (navigator.vibrate)
        try {
          navigator.vibrate(10);
        } catch {
          /* not allowed */
        }
    }, HOLD_MS);
  },

  itemAt(s, [x, y], filter = () => true) {
    const items = this.itemsOf(s.key),
      tolerance = 6 * this.unitsPerPx(s);
    for (let i = items.length - 1; i >= 0; i--)
      if (filter(items[i]) && hits(items[i], x, y, tolerance)) return items[i];
    return null;
  },

  /** Erase at (x, y): part of a stroke ("area"), whole strokes ("stroke"), or whole highlights only ("highlight"). */
  eraseAt(s, [x, y]) {
    const items = this.itemsOf(s.key),
      tolerance = Math.max(4, this.sizes.pen * 2) * this.unitsPerPx(s);
    let kept,
      changed = false;
    if (this.eraserMode === "area") {
      kept = items.flatMap((i) => {
        const rest = i.type === "text" ? (hits(i, x, y, tolerance) ? [] : null) : eraseFrom(i, x, y, tolerance);
        if (!rest) return [i];
        changed = true;
        return rest;
      });
    } else {
      kept = items.filter(
        (i) => !((this.eraserMode === "stroke" || i.type === "highlight") && hits(i, x, y, tolerance)),
      );
      changed = kept.length !== items.length;
    }
    if (changed) {
      this.gesture.removed += 1;
      this.setItems(s.key, kept);
      this.drawSurface(s);
    }
  },

  /** Where the fingers (or the mouse) that move the page are: their middle, and how far apart two fingers are. */
  grip(e) {
    const pts =
      e.pointerType === "touch" && this.touches.size ? [...this.touches.values()] : [{ x: e.clientX, y: e.clientY }];
    if (pts.length < 2) return { mid: pts[0], dist: 0 };
    return {
      mid: { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 },
      dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
    };
  },

  startNavigation(s, e) {
    const touch = e.pointerType === "touch";
    if (!touch) capture(s.svg, e); // a mouse let go off the page still lets go
    const { mid, dist } = this.grip(e);
    this.nav = { touch, id: e.pointerId, last: mid, dist, zoom: this.zoom };
  },

  /** Is this pointer the one moving the page? A pen writes on while a palm rests on the screen. */
  steers(e) {
    return Boolean(this.nav) && (this.nav.touch ? e.pointerType === "touch" : e.pointerId === this.nav.id);
  },

  navigate(e) {
    const { mid, dist } = this.grip(e);
    const scroller = this.scrollerAt(e);
    scroller.scrollLeft -= mid.x - this.nav.last.x;
    scroller.scrollTop -= mid.y - this.nav.last.y;
    this.nav.last = mid;
    if (dist && this.nav.dist) this.setZoom(this.nav.zoom * (dist / this.nav.dist), { clientX: mid.x, clientY: mid.y });
  },

  scrollerAt(e) {
    return this.notesEl.contains(e.target) ? this.notesEl : this.pagesEl;
  },

  setZoom(z, at = null) {
    z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
    if (Math.abs(z - this.zoom) < 0.001) return;
    const box = this.pagesEl.getBoundingClientRect();
    const ax = at ? at.clientX - box.left : box.width / 2,
      ay = at ? at.clientY - box.top : box.height / 2;
    const fx = (this.pagesEl.scrollLeft + ax) / (this.pagesEl.scrollWidth || 1),
      fy = (this.pagesEl.scrollTop + ay) / (this.pagesEl.scrollHeight || 1);
    this.zoom = z;
    this.layoutPages();
    this.pagesEl.scrollLeft = fx * this.pagesEl.scrollWidth - ax;
    this.pagesEl.scrollTop = fy * this.pagesEl.scrollHeight - ay;
    this.updateZoomLabel();
  },

  updateZoomLabel() {
    this.root.querySelector(".rd-zoom-label").textContent = `${Math.round(this.zoom * 100)}%`;
  },

  scrollToPage(n, smooth = true) {
    const s = this.surfaces.get(`p:${n}`);
    if (s) this.pagesEl.scrollTo({ top: s.el.offsetTop - 8, behavior: smooth ? "smooth" : "auto" });
  },

  currentPage() {
    const middle = this.pagesEl.scrollTop + this.pagesEl.clientHeight / 3;
    let page = 1;
    for (const [key, s] of this.surfaces) if (key.startsWith("p:") && s.el.offsetTop <= middle) page = s.page;
    return page;
  },

  onScroll() {
    if (!this.pdf) return;
    const page = this.currentPage();
    if (page !== this.doc.last_page) {
      this.doc.last_page = page;
      this.changed();
    }
    this.thumbsEl
      .querySelectorAll(".rd-thumb")
      .forEach((b) => b.classList.toggle("on", Number(b.dataset.page) === page));
    // reached the end of the last page: the paper has been read
    const lastPage = this.surfaces.get(`p:${this.pdf.numPages}`);
    if (
      !this.finished &&
      lastPage &&
      this.pagesEl.scrollTop + this.pagesEl.clientHeight >= lastPage.el.offsetTop + lastPage.el.offsetHeight - 40
    ) {
      this.finished = true;
      if (this.onFinished && this.paper)
        this.onFinished(this.paper).then((marked) => marked && this.toast(t("rd.finished")));
    }
  },

  onKey(e) {
    if (this.editor) {
      if (e.key === "Escape") this.finishEditing();
      return;
    }
    if (e.target.closest && e.target.closest("input, textarea")) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) this.doRedo();
      else this.doUndo();
    } else if (mod && e.key.toLowerCase() === "y") {
      e.preventDefault();
      this.doRedo();
    } else if ((e.key === "Delete" || e.key === "Backspace") && this.selection) {
      e.preventDefault();
      this.deleteSelection();
    } else if (e.key === "Escape") {
      if (this.selection) this.select(null);
      else this.close();
    } else if (mod && e.key.toLowerCase() === "f" && this.pdf) {
      e.preventDefault();
      this.toggleSearch(true);
    }
  },
};
