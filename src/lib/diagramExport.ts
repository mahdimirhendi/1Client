// A canvas as an SVG or PNG file: the tables on it (hidden tables and columns left out), their
// lines and the notes, in the colors of the current appearance. Drawn from the model, not the
// screen, so the whole canvas is exported whatever is in view.

import type { Canvas } from "../types";
import { CARD_W, HEAD, ROW, linesOf, shortType, shownTables, visibleColumns, type Link, type Schema } from "./diagram";

const PAD = 40;
const NOTE_HEAD = 22;
const NOTE_LINE = 17.4;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function palette() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    bg: v("--bg-canvas"),
    card: v("--bg-card"),
    head: v("--bg-row-alt"),
    ring: v("--separator-strong"),
    line: v("--line-strong"),
    label: v("--label"),
    muted: v("--label-tertiary"),
    pk: v("--pk"),
    fk: v("--fk"),
    rel: v("--relation"),
    noteBg: v("--note-bg"),
    noteRing: v("--note-ring"),
    noteText: v("--note-text"),
    noteLabel: v("--note-label"),
    ui: v("--font-ui"),
    mono: v("--font-mono"),
  };
}

/** Text that fits `max` pixels in `font`, shortened with … when it doesn't. */
function fitter() {
  const ctx = document.createElement("canvas").getContext("2d")!;
  const width = (text: string, font: string) => ((ctx.font = font), ctx.measureText(text).width);
  return {
    width,
    fit(text: string, font: string, max: number) {
      if (width(text, font) <= max) return text;
      let lo = 0;
      let hi = text.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (width(text.slice(0, mid) + "…", font) <= max) lo = mid;
        else hi = mid - 1;
      }
      return text.slice(0, lo) + "…";
    },
  };
}

/** Lines of a note wrapped to its width. */
function wrap(text: string, font: string, max: number, measure: (t: string, f: string) => number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/(\s+)/)) {
      const next = line + word;
      if (line.trim() && measure(next, font) > max) {
        out.push(line.trimEnd());
        line = word.trimStart();
      } else line = next;
    }
    out.push(line);
  }
  return out;
}

export function diagramSvg(canvas: Canvas, schema: Schema, links: Link[], name: (key: string) => string) {
  const c = palette();
  const { fit, width } = fitter();
  const ui = (weight: number, size: number) => `${weight} ${size}px ${c.ui}`;
  const mono = (size: number) => `400 ${size}px ${c.mono}`;
  // Dropped tables are not part of the database any more, so they are left out.
  const keys = shownTables(canvas).filter((k) => schema.has(k));
  const shown = new Set(keys);

  const notes = canvas.notes.map((n) => {
    const lines = n.text.trim() ? wrap(n.text, ui(400, 12), n.w - 20, width) : [];
    return { ...n, lines, h: NOTE_HEAD + Math.max(56, lines.length * NOTE_LINE + 10) };
  });
  const boxes = [
    ...keys.map((k) => {
      const t = schema.get(k)!;
      return { x: canvas.positions[k].x, y: canvas.positions[k].y, w: CARD_W, h: HEAD + visibleColumns(t, canvas.hiddenColumns[k]).length * ROW };
    }),
    ...notes.map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h })),
  ];
  if (!boxes.length) return null;
  const x0 = Math.min(...boxes.map((b) => b.x)) - PAD;
  const y0 = Math.min(...boxes.map((b) => b.y)) - PAD;
  const w = Math.ceil(Math.max(...boxes.map((b) => b.x + b.w)) + PAD - x0);
  const h = Math.ceil(Math.max(...boxes.map((b) => b.y + b.h)) + PAD - y0);

  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${x0} ${y0} ${w} ${h}" font-family="${esc(c.ui)}">`,
    `<rect x="${x0}" y="${y0}" width="${w}" height="${h}" fill="${c.bg}"/>`,
  ];

  const lines = linesOf(canvas, links, shown, schema);
  out.push(`<g fill="none" stroke="${c.rel}" stroke-width="1.3">${lines.map((l) => `<path d="${l.d}"/>`).join("")}</g>`);
  out.push(`<g fill="${c.rel}">${lines.map((l) => `<circle cx="${l.end.x}" cy="${l.end.y}" r="3"/>`).join("")}</g>`);

  keys.forEach((k, i) => {
    const t = schema.get(k)!;
    const { x, y } = canvas.positions[k];
    const cols = visibleColumns(t, canvas.hiddenColumns[k]);
    const ch = HEAD + cols.length * ROW;
    out.push(
      `<clipPath id="card${i}"><rect x="${x}" y="${y}" width="${CARD_W}" height="${ch}" rx="10"/></clipPath>`,
      `<g clip-path="url(#card${i})">`,
      `<rect x="${x}" y="${y}" width="${CARD_W}" height="${ch}" fill="${c.card}"/>`,
      `<rect x="${x}" y="${y}" width="${CARD_W}" height="${HEAD}" fill="${c.head}"/>`,
      `<line x1="${x}" y1="${y + HEAD}" x2="${x + CARD_W}" y2="${y + HEAD}" stroke="${c.line}" stroke-width="0.5"/>`,
      `<text x="${x + 10}" y="${y + 21}" font-size="13" font-weight="600" fill="${c.label}">${esc(fit(name(k), ui(600, 13), CARD_W - 20))}</text>`,
    );
    cols.forEach((col, j) => {
      const ry = y + HEAD + j * ROW + 17;
      const tag = col.primaryKey ? "PK" : col.foreignKey ? "FK" : "·";
      const tagColor = col.primaryKey ? c.pk : col.foreignKey ? c.fk : c.muted;
      const type = fit(shortType(col.dataType), mono(11), CARD_W * 0.4);
      const typeW = width(type, mono(11));
      const nameFont = ui(col.primaryKey ? 600 : 400, 13);
      out.push(
        `<text x="${x + 10}" y="${ry}" font-size="9" font-weight="700" fill="${tagColor}">${tag}</text>`,
        `<text x="${x + 35}" y="${ry}" font-size="13" font-weight="${col.primaryKey ? 600 : 400}" fill="${c.label}">${esc(fit(col.name, nameFont, CARD_W - 55 - typeW))}</text>`,
        `<text x="${x + CARD_W - 10}" y="${ry}" font-size="11" font-family="${esc(c.mono)}" text-anchor="end" fill="${c.muted}">${esc(type)}</text>`,
      );
    });
    out.push(`</g>`, `<rect x="${x}" y="${y}" width="${CARD_W}" height="${ch}" rx="10" fill="none" stroke="${c.ring}" stroke-width="1"/>`);
  });

  for (const n of notes) {
    out.push(
      `<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="8" fill="${c.noteBg}" stroke="${c.noteRing}" stroke-width="1"/>`,
      `<text x="${n.x + 10}" y="${n.y + 15}" font-size="10" font-weight="600" fill="${c.noteLabel}">NOTE</text>`,
      ...n.lines.map(
        (l, i) => `<text x="${n.x + 10}" y="${n.y + NOTE_HEAD + 12 + i * NOTE_LINE}" font-size="12" fill="${c.noteText}" xml:space="preserve">${esc(l)}</text>`,
      ),
    );
  }
  out.push("</svg>");
  return { svg: out.join("\n"), width: w, height: h };
}

/** The SVG drawn at twice its size (less for very big canvases), as base64 PNG data. */
export async function svgToPng(svg: string, w: number, h: number): Promise<string> {
  const scale = Math.min(2, Math.sqrt(40_000_000 / (w * h)), 16_384 / w, 16_384 / h);
  const img = new Image();
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.scale(scale, scale);
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL("image/png").slice("data:image/png;base64,".length);
}
