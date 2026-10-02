// Writes the landing page's security-print textures into site/index.html, between the banknote-patterns markers.
// Inline defs need no fetch, so the textures also render when the page is opened from disk.
// Every stroke is currentColor; the page colours each texture through CSS `color`.
// Run: node scripts/site-banknote-patterns.mjs

import { readFileSync, writeFileSync } from "node:fs";

const PAGE = new URL("../site/index.html", import.meta.url);
const START = "<!-- banknote-patterns:start -->";
const END = "<!-- banknote-patterns:end -->";
const TAU = Math.PI * 2;

const n = (value) => {
  const rounded = Math.round(value * 10) / 10;
  return Object.is(rounded, -0) ? "0" : String(rounded);
};

const sample = (curve, from, to, samples) =>
  Array.from({ length: samples + 1 }, (_, i) => curve(from + ((to - from) * i) / samples));

const path = (points) => `M${points.map(([x, y]) => `${n(x)} ${n(y)}`).join(" ")}`;

const rotations = (id, count, step, from = 1) =>
  Array.from({ length: count - from }, (_, k) => `<use href="#${id}" transform="rotate(${n((k + from) * step)})"/>`).join("");

const epitrochoid = (R, r, d) => (t) => [
  (R + r) * Math.cos(t) - d * Math.cos(((R + r) / r) * t),
  (R + r) * Math.sin(t) - d * Math.sin(((R + r) / r) * t),
];

const hypotrochoid = (R, r, d) => (t) => [
  (R - r) * Math.cos(t) + d * Math.cos(((R - r) / r) * t),
  (R - r) * Math.sin(t) - d * Math.sin(((R - r) / r) * t),
];

// A polar band whose radius beats two frequencies against each other, the classic rose-engine ring.
const band = (radius, a, lobes, b, beat) => (t) => {
  const rho = radius + a * Math.sin(lobes * t) + b * Math.sin(beat * t);
  return [rho * Math.cos(t), rho * Math.sin(t)];
};

// Each curve has `order`-fold rotational symmetry over its `turns`, so only one arc of it is drawn; rotated copies of
// that arc close the ring, and the ring is stamped `copies` times a fraction of a lobe apart for the moiré.
function ring(id, curve, turns, order, samplesPerArc, copies) {
  const arc = sample(curve, 0, (TAU * turns) / order, samplesPerArc);
  const lobe = 360 / order;
  return (
    `<g id="${id}"><path id="${id}0" d="${path(arc)}" vector-effect="non-scaling-stroke"/>${rotations(`${id}0`, order, lobe)}</g>` +
    rotations(id, copies, lobe / copies)
  );
}

function rosette() {
  const rings = [
    ring("ro", epitrochoid(400, 400 / 40, 34), 1, 40, 36, 8),
    ring("rb", band(300, 26, 24, 8, 72), 1, 24, 50, 8),
    ring("rh", hypotrochoid(210, (210 * 3) / 11, 120), 3, 11, 120, 6),
    ring("rc", band(64, 14, 12, 4, 36), 1, 12, 40, 8),
    ring("ri", hypotrochoid(40, (40 * 2) / 9, 22), 2, 9, 40, 6),
  ];
  return `<symbol id="rosette" viewBox="-460 -460 920 920" fill="none" stroke="currentColor" stroke-linecap="round">${rings.join("")}</symbol>`;
}

// Parallel lines riding one sine whose amplitude swells and whose centre drifts, both periodic in the tile width.
// Every line is the same path shifted one gap down and `slant` across, so crests form slanted ribbons for one path's
// bytes. Whole cycles fit the tile, so it repeats without a seam.
const WAVE = { width: 600, height: 300, lines: 32, half: 12, slant: 37.5 };

function waveLine() {
  const { width, height, lines, half } = WAVE;
  const gap = height / lines;
  const amplitude = (x) => gap * 0.34 * (0.55 + 0.45 * Math.sin((TAU * x) / width));
  const centre = (x) => gap * 1.6 * Math.sin((TAU * x) / width + 1);
  // One path spans two tile widths so every shifted copy still covers the tile plus a margin.
  let x = -width;
  let y = Math.round(centre(x) * 10) / 10;
  let d = `M${n(x)} ${n(y)}q`;
  for (let sign = 1; x < width + 2 * half; sign = -sign) {
    const peak = Math.round((centre(x + half / 2) + sign * 2 * amplitude(x + half / 2) - y) * 10) / 10;
    const end = Math.round((centre(x + half) - y) * 10) / 10;
    d += `${n(half / 2)} ${n(peak)} ${n(half)} ${n(end)} `;
    x += half;
    y = Math.round((y + end) * 10) / 10;
  }
  return d.trimEnd();
}

// Lines past both tile edges are drawn too, so drift that crosses an edge is not clipped away.
function waveLines() {
  const { width, height, lines, slant } = WAVE;
  const gap = height / lines;
  const copies = Array.from({ length: lines + 6 }, (_, k) => {
    const i = k - 3;
    const dx = (((i * slant) % width) + width) % width;
    return i === 0 ? "" : `<use href="#wl" transform="translate(${n(dx)} ${n(i * gap)})"/>`;
  });
  return `<g id="w" fill="none" stroke="currentColor"><path id="wl" d="${waveLine()}" transform="translate(0 ${n(gap / 2)})"/>${copies.join("")}</g>`;
}

// One wave tile per ink: pattern content inherits from the pattern element, not from the shape it fills.
const wavePattern = (id) =>
  `<pattern id="${id}" class="${id}" patternUnits="userSpaceOnUse" width="${WAVE.width}" height="${WAVE.height}"><use href="#w"/></pattern>`;

// A horizontally tileable rope border: phase-shifted sines braided between two rules, over a dashed microline.
function microline() {
  const width = 120;
  const height = 14;
  const wavelength = 20;
  const strands = 5;
  const half = wavelength / 2;
  const mid = height / 2;
  const amplitude = 3.5;
  let rope = "";
  for (let s = 0; s < strands; s += 1) {
    let x = -wavelength + (s / strands) * wavelength;
    rope += `M${n(x)} ${n(mid)}q`;
    for (let sign = 1; x < width + wavelength; sign = -sign) {
      rope += `${n(half / 2)} ${n(sign * 2 * amplitude)} ${n(half)} 0 `;
      x += half;
    }
  }
  return (
    `<pattern id="microline" class="microline" patternUnits="userSpaceOnUse" width="${width}" height="${height}">` +
    `<g fill="none" stroke="currentColor"><path d="${rope.trimEnd()}" stroke-width="0.5"/>` +
    `<path d="M0 0.5H${width}M0 ${height - 0.5}H${width}"/>` +
    `<path d="M0 ${mid}H${width}" stroke-dasharray="1 2"/></g></pattern>`
  );
}

const DEFS = [rosette(), waveLines(), wavePattern("waves-teal"), wavePattern("waves-ink"), microline()];

const page = readFileSync(PAGE, "utf8");
const start = page.indexOf(START);
const end = page.indexOf(END);
if (start < 0 || end < start) throw new Error(`site/index.html needs ${START} … ${END} inside its defs svg`);
const indent = page.slice(page.lastIndexOf("\n", start) + 1, start);
const block = `${START}\n${DEFS.map((def) => `${indent}${def}\n`).join("")}${indent}`;
const next = page.slice(0, start) + block + page.slice(end);
if (next !== page) writeFileSync(PAGE, next);
console.log(`banknote patterns ${(Buffer.byteLength(block) / 1024).toFixed(1)} KB${next === page ? ", unchanged" : ""}`);
