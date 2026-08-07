export type RasterPoint = { x: number; y: number };

export type AlphaRaster = {
  width: number;
  height: number;
  data: ArrayLike<number>;
};

export type RasterizeTextOptions = {
  width: number;
  height: number;
  font: string;
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

export function resolveTextParticleBudget(width: number, devicePixelRatio = 1) {
  const normalizedWidth = Math.max(0, Number.isFinite(width) ? width : 0);
  const normalizedRatio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
    ? devicePixelRatio
    : 1;
  return Math.min(520, Math.max(220, Math.round(normalizedWidth * 0.72 * normalizedRatio)));
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
 * Samples opaque pixels in scan order with deterministic, evenly distributed
 * positions. The public seam accepts an alpha raster so its cap and stability
 * can be verified without a browser canvas.
 */
export function sampleAlphaRaster(
  raster: AlphaRaster,
  options: { maxPoints: number; seed?: number; alphaThreshold?: number },
): RasterPoint[] {
  const maxPoints = Math.max(0, Math.floor(options.maxPoints));
  if (!maxPoints || raster.width <= 0 || raster.height <= 0) return [];
  const threshold = options.alphaThreshold ?? 32;
  const candidates: RasterPoint[] = [];
  for (let y = 0; y < raster.height; y += 1) {
    for (let x = 0; x < raster.width; x += 1) {
      if ((raster.data[(y * raster.width + x) * 4 + 3] ?? 0) >= threshold) {
        candidates.push({ x, y });
      }
    }
  }
  if (candidates.length <= maxPoints) return candidates;

  const seed = (options.seed ?? 0x6f63746f) >>> 0;
  if (maxPoints === 1) return [candidates[seed % candidates.length]];
  const bucket = Math.ceil(candidates.length / maxPoints);
  const start = Math.min(candidates.length - maxPoints, seed % bucket + 1);
  const end = Math.max(start + maxPoints - 1, candidates.length - 1 - ((seed >>> 3) % bucket));
  return Array.from({ length: maxPoints }, (_, index) => {
    const position = Math.round(start + index * (end - start) / (maxPoints - 1));
    return candidates[position];
  });
}

export function rasterizeText(text: string, options: RasterizeTextOptions): TextParticle[] {
  if (typeof document === "undefined") return [];
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(options.width));
  canvas.height = Math.max(1, Math.floor(options.height));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return [];

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#000";
  context.font = options.font;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(text, canvas.width / 2, canvas.height / 2);
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const targets = sampleAlphaRaster(image, {
    maxPoints: Math.min(520, options.maxPoints ?? 520),
    seed: options.seed,
    alphaThreshold: options.alphaThreshold,
  });
  const seed = options.seed ?? 0x6f63746f;
  return targets.map((target, index) => {
    const start = createExteriorParticleStart(index, canvas.width, canvas.height, seed);
    return {
      x: start.x,
      y: start.y,
      targetX: target.x,
      targetY: target.y,
    };
  });
}

function seededUnit(seed: number) {
  let value = seed >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return (value >>> 0) / 0x1_0000_0000;
}
