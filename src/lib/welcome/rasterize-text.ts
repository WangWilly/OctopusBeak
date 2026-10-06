export type RasterPoint = { x: number; y: number };

export type AlphaRaster = {
  width: number;
  height: number;
  data: ArrayLike<number>;
};

export type RasterizeTextOptions = {
  width: number;
  height: number;
  fontFamily: string;
  fontWeight: number;
  maxPoints?: number;
  seed?: number;
  alphaThreshold?: number;
};

export type TextParticle = RasterPoint & {
  targetX: number;
  targetY: number;
  vx?: number;
  vy?: number;
};

/** Keep raster targets on a stable lattice so font anti-aliasing cannot move them by a pixel. */
export const MIN_PARTICLE_GRID_SPACING = 3;
const MAX_PARTICLE_GRID_SPACING = 16;

/** Dense CJK glyphs need a 3px lattice, roughly this many points, before their strokes read as text. */
export const MAX_TEXT_PARTICLES = 6000;

export type RasterizedText = {
  spacing: number;
  particles: TextParticle[];
};

export type TextLattice = {
  spacing: number;
  points: RasterPoint[];
};

export function resolveTextParticleBudget(width: number, devicePixelRatio = 1) {
  const normalizedWidth = Math.max(0, Number.isFinite(width) ? width : 0);
  const normalizedRatio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
    ? devicePixelRatio
    : 1;
  return Math.min(
    MAX_TEXT_PARTICLES,
    Math.max(2400, Math.round(normalizedWidth * 6 * normalizedRatio)),
  );
}

export function createExteriorParticleStart(
  index: number,
  width: number,
  height: number,
  seed = 0x6f63746f,
  padding = 28,
): RasterPoint {
  const angle = seededUnit(seed + index * 2_654_435_761) * Math.PI * 2;
  const directionX = Math.cos(angle);
  const directionY = Math.sin(angle);
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const horizontalScale = Math.abs(directionX) < 0.0001
    ? Number.POSITIVE_INFINITY
    : halfWidth / Math.abs(directionX);
  const verticalScale = Math.abs(directionY) < 0.0001
    ? Number.POSITIVE_INFINITY
    : halfHeight / Math.abs(directionY);
  const boundaryScale = Math.min(horizontalScale, verticalScale) + padding;
  return {
    x: halfWidth + directionX * boundaryScale,
    y: halfHeight + directionY * boundaryScale,
  };
}

/**
 * Samples opaque pixels onto the finest uniform lattice that fits the budget.
 * Dropping cells from a fine lattice punches holes through strokes, so the
 * lattice widens instead; only the coarsest lattice is ever thinned. The
 * public seam accepts an alpha raster so it can be verified without a canvas.
 */
export function sampleAlphaRaster(
  raster: AlphaRaster,
  options: { maxPoints: number; seed?: number; alphaThreshold?: number },
): TextLattice {
  const maxPoints = Math.max(0, Math.floor(options.maxPoints));
  if (!maxPoints || raster.width <= 0 || raster.height <= 0) {
    return { spacing: MIN_PARTICLE_GRID_SPACING, points: [] };
  }
  const threshold = options.alphaThreshold ?? 32;
  let spacing = MIN_PARTICLE_GRID_SPACING;
  let candidates = latticeCells(raster, spacing, threshold);
  while (candidates.length > maxPoints && spacing < MAX_PARTICLE_GRID_SPACING) {
    spacing += 1;
    candidates = latticeCells(raster, spacing, threshold);
  }
  if (candidates.length <= maxPoints) return { spacing, points: candidates };

  const seed = (options.seed ?? 0x6f63746f) >>> 0;
  if (maxPoints === 1) return { spacing, points: [candidates[seed % candidates.length]] };
  const bucket = Math.ceil(candidates.length / maxPoints);
  const start = Math.min(candidates.length - maxPoints, seed % bucket + 1);
  const end = Math.max(start + maxPoints - 1, candidates.length - 1 - ((seed >>> 3) % bucket));
  return {
    spacing,
    points: Array.from({ length: maxPoints }, (_, index) => {
      const position = Math.round(start + index * (end - start) / (maxPoints - 1));
      return candidates[position];
    }),
  };
}

function latticeCells(raster: AlphaRaster, spacing: number, threshold: number): RasterPoint[] {
  const cells: RasterPoint[] = [];
  const occupiedCells = new Set<string>();
  for (let y = 0; y < raster.height; y += 1) {
    for (let x = 0; x < raster.width; x += 1) {
      if ((raster.data[(y * raster.width + x) * 4 + 3] ?? 0) >= threshold) {
        const gridX = Math.floor(x / spacing) * spacing;
        const gridY = Math.floor(y / spacing) * spacing;
        const cell = `${gridX}:${gridY}`;
        if (!occupiedCells.has(cell)) {
          occupiedCells.add(cell);
          cells.push({ x: gridX, y: gridY });
        }
      }
    }
  }
  return cells;
}

export function rasterizeText(
  text: string,
  options: RasterizeTextOptions,
): RasterizedText {
  const empty = { spacing: MIN_PARTICLE_GRID_SPACING, particles: [] };
  if (typeof document === "undefined") return empty;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(options.width));
  canvas.height = Math.max(1, Math.floor(options.height));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return empty;

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#000";
  const fontAt = (size: number) => `${options.fontWeight} ${size}px ${options.fontFamily}`;
  context.font = fontAt(100);
  const widthPerPixel = context.measureText(text).width / 100;
  const fontSize = Math.floor(Math.min(
    canvas.height * 0.82,
    widthPerPixel > 0 ? canvas.width * 0.94 / widthPerPixel : Number.POSITIVE_INFINITY,
  ));
  context.font = fontAt(fontSize);
  context.textAlign = "center";
  // Centre the measured ink box; the em-box "middle" baseline sits CJK glyphs off-centre.
  context.textBaseline = "alphabetic";
  const metrics = context.measureText(text);
  const baseline = canvas.height / 2
    + (metrics.actualBoundingBoxAscent - metrics.actualBoundingBoxDescent) / 2;
  context.fillText(text, canvas.width / 2, baseline);
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const lattice = sampleAlphaRaster(image, {
    maxPoints: Math.min(MAX_TEXT_PARTICLES, options.maxPoints ?? MAX_TEXT_PARTICLES),
    seed: options.seed,
    alphaThreshold: options.alphaThreshold,
  });
  const seed = options.seed ?? 0x6f63746f;
  return {
    spacing: lattice.spacing,
    particles: lattice.points.map((target, index) => {
      const start = createExteriorParticleStart(index, canvas.width, canvas.height, seed);
      return {
        x: start.x,
        y: start.y,
        targetX: target.x,
        targetY: target.y,
      };
    }),
  };
}

function seededUnit(seed: number) {
  let value = seed >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return (value >>> 0) / 0x1_0000_0000;
}
