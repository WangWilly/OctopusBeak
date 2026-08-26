import { PNG } from "pngjs";
import type {
  CaptchaImagePreprocessingMode,
  CaptchaOcrOutputStage,
} from "../human-assistance.ts";

export type GrayImage = {
  width: number;
  height: number;
  data: Uint8Array;
};

export const UPSCALE_FACTOR = 3;
export const MIN_REGION_PIXELS = 40;
export const INTERFERENCE_LINE_MIN_COVERAGE = 0.7;

const DIAGONAL_LINE_MIN_COVERAGE = 0.45;
const DIAGONAL_LINE_MIN_SPAN = 0.45;
const DIAGONAL_LINE_DETECTION_RADIUS = 2;
const DIAGONAL_LINE_SLOPE_STEP = 0.05;
const MAX_DIAGONAL_LINES = 8;
const CALIBRATED_EINVOICE_WIDTH = 150;
const CALIBRATED_EINVOICE_HEIGHT = 40;
const EINVOICE_BOTTOM_INTERFERENCE_ROWS = 6;
const EINVOICE_DIRECTIONAL_THRESHOLD = 100;
const EINVOICE_DIRECTIONAL_KERNEL = [
  [-1, 4, -1],
  [-1, 2, -1],
  [-1, 4, -1],
] as const;

export type CaptchaPreprocessStep =
  | "grayscale"
  | "upscaled"
  | "blurred"
  | "binarized"
  | "lines-removed"
  | "interference-band-masked"
  | "horizontal-interference-suppressed"
  | "denoised";

export type CaptchaPreprocessOptions = {
  removeInterferenceLines?: boolean;
  imagePreprocessing?: readonly CaptchaImagePreprocessingMode[];
  outputStage?: CaptchaOcrOutputStage;
};

type PixelBand = { start: number; end: number };

type DiagonalLine = {
  slope: number;
  intercept: number;
  coverage: number;
};

function pixelBands(mask: Uint8Array): PixelBand[] {
  const bands: PixelBand[] = [];
  for (let start = 0; start < mask.length; start += 1) {
    if (mask[start] !== 1) continue;
    let end = start;
    while (end + 1 < mask.length && mask[end + 1] === 1) end += 1;
    bands.push({ start, end });
    start = end;
  }
  return bands;
}

function expandLineMask(mask: Uint8Array, radius: number): Uint8Array {
  const expanded = new Uint8Array(mask.length);
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index] !== 1) continue;
    const start = Math.max(0, index - radius);
    const end = Math.min(mask.length - 1, index + radius);
    for (let candidate = start; candidate <= end; candidate += 1) {
      expanded[candidate] = 1;
    }
  }
  return expanded;
}

function findDiagonalLines(
  image: GrayImage,
  foreground: number,
  minCoverage: number,
): DiagonalLine[] {
  const { width, height } = image;
  const candidates: DiagonalLine[] = [];
  const radius = DIAGONAL_LINE_DETECTION_RADIUS;
  const coverageThreshold = Math.max(
    DIAGONAL_LINE_MIN_COVERAGE,
    minCoverage * 0.75,
  );

  // A CAPTCHA interference stroke is long and straight even when it is
  // partial. Scan a bounded set of slopes and count the columns that contain
  // a foreground pixel near each candidate line. Counting columns rather
  // than pixels keeps thick glyphs from dominating the score.
  for (let slope = -1.5; slope <= 1.5; slope += DIAGONAL_LINE_SLOPE_STEP) {
    if (Math.abs(slope) < 0.15) continue;
    const slopeWidth = Math.ceil(Math.abs(slope) * width);
    for (let intercept = -slopeWidth - radius; intercept <= height + radius; intercept += 1) {
      let hits = 0;
      let firstColumn = width;
      let lastColumn = -1;
      for (let x = 0; x < width; x += 1) {
        const y = Math.round(slope * x + intercept);
        if (y < -radius || y >= height + radius) continue;
        if (firstColumn === width) firstColumn = x;
        lastColumn = x;
        let hit = false;
        for (let dy = -radius; dy <= radius; dy += 1) {
          const candidateY = y + dy;
          if (
            candidateY >= 0
            && candidateY < height
            && image.data[candidateY * width + x] === foreground
          ) {
            hit = true;
            break;
          }
        }
        if (hit) hits += 1;
      }
      const span = lastColumn >= firstColumn
        ? (lastColumn - firstColumn + 1) / width
        : 0;
      const coverage = span > 0 ? hits / (lastColumn - firstColumn + 1) : 0;
      if (span >= DIAGONAL_LINE_MIN_SPAN && coverage >= coverageThreshold) {
        candidates.push({ slope, intercept, coverage });
      }
    }
  }

  candidates.sort((left, right) => right.coverage - left.coverage);
  const selected: DiagonalLine[] = [];
  const centerX = width / 2;
  for (const candidate of candidates) {
    if (
      selected.some((other) => (
        Math.abs(candidate.slope - other.slope) < 0.15
        && Math.abs(
          (candidate.slope - other.slope) * centerX
          + candidate.intercept
          - other.intercept,
        ) < radius * 4
      ))
    ) continue;
    selected.push(candidate);
    if (selected.length >= MAX_DIAGONAL_LINES) break;
  }
  return selected;
}

function localForegroundPixels(
  data: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  radius: number,
  foreground: number,
): number {
  let count = 0;
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      const candidateX = x + dx;
      const candidateY = y + dy;
      if (
        candidateX >= 0
        && candidateX < width
        && candidateY >= 0
        && candidateY < height
        && data[candidateY * width + candidateX] === foreground
      ) count += 1;
    }
  }
  return count;
}

function removeDiagonalLines(
  image: GrayImage,
  foreground: number,
  background: number,
  minCoverage: number,
): GrayImage {
  const { width, height } = image;
  const lines = findDiagonalLines(image, foreground, minCoverage);
  if (lines.length === 0) return image;
  const source = new Uint8Array(image.data);
  const data = new Uint8Array(image.data);
  for (const line of lines) {
    for (let x = 0; x < width; x += 1) {
      const y = Math.round(line.slope * x + line.intercept);
      for (let dy = -DIAGONAL_LINE_DETECTION_RADIUS; dy <= DIAGONAL_LINE_DETECTION_RADIUS; dy += 1) {
        const candidateY = y + dy;
        if (
          candidateY < 0
          || candidateY >= height
          || data[candidateY * width + x] !== foreground
        ) continue;
        // Dense neighborhoods are compact glyph strokes, not the thin line
        // being removed. Keeping them avoids erasing a character at a
        // crossing while still clearing isolated interference pixels.
        if (localForegroundPixels(source, width, height, x, candidateY, 2, foreground) >= 22) {
          continue;
        }
        data[candidateY * width + x] = background;
      }
    }
  }
  return { width, height, data };
}

export function decodeGrayImage(buffer: Buffer): GrayImage {
  const png = PNG.sync.read(buffer);
  const data = new Uint8Array(png.width * png.height);
  for (let i = 0; i < data.length; i += 1) {
    // CAPTCHA screenshots can carry transparent pixels (notably when the
    // challenge is captured from a canvas). Blend against the white page
    // background before converting to luminance; treating alpha as opaque
    // turns the transparent background into false foreground glyphs.
    const alpha = png.data[i * 4 + 3]! / 255;
    const r = Math.round(png.data[i * 4]! * alpha + 255 * (1 - alpha));
    const g = Math.round(png.data[i * 4 + 1]! * alpha + 255 * (1 - alpha));
    const b = Math.round(png.data[i * 4 + 2]! * alpha + 255 * (1 - alpha));
    data[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }
  return { width: png.width, height: png.height, data };
}

export function encodeGrayImage(image: GrayImage): Buffer {
  const png = new PNG({ width: image.width, height: image.height });
  for (let i = 0; i < image.data.length; i += 1) {
    const value = image.data[i]!;
    png.data[i * 4] = value;
    png.data[i * 4 + 1] = value;
    png.data[i * 4 + 2] = value;
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

export function upscaleImage(image: GrayImage, factor: number): GrayImage {
  const width = Math.round(image.width * factor);
  const height = Math.round(image.height * factor);
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const sourceY = (y + 0.5) / factor - 0.5;
    const y0 = Math.max(0, Math.floor(sourceY));
    const y1 = Math.min(image.height - 1, y0 + 1);
    const fy = sourceY - y0;
    for (let x = 0; x < width; x += 1) {
      const sourceX = (x + 0.5) / factor - 0.5;
      const x0 = Math.max(0, Math.floor(sourceX));
      const x1 = Math.min(image.width - 1, x0 + 1);
      const fx = sourceX - x0;
      const top = image.data[y0 * image.width + x0]! * (1 - fx) +
        image.data[y0 * image.width + x1]! * fx;
      const bottom = image.data[y1 * image.width + x0]! * (1 - fx) +
        image.data[y1 * image.width + x1]! * fx;
      data[y * width + x] = Math.round(top * (1 - fy) + bottom * fy);
    }
  }
  return { width, height, data };
}

export function boxBlur(image: GrayImage): GrayImage {
  const { width, height } = image;
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      let count = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          sum += image.data[ny * width + nx]!;
          count += 1;
        }
      }
      data[y * width + x] = Math.round(sum / count);
    }
  }
  return { width, height, data };
}

export function otsuThreshold(image: GrayImage): number {
  const histogram = new Float64Array(256);
  for (let i = 0; i < image.data.length; i += 1) {
    histogram[image.data[i]!] += 1;
  }
  const total = image.data.length;
  let sum = 0;
  for (let i = 0; i < 256; i += 1) sum += i * histogram[i]!;

  let weightBackground = 0;
  let sumBackground = 0;
  let maxVariance = -1;
  let threshold = 0;
  for (let t = 0; t < 256; t += 1) {
    weightBackground += histogram[t]!;
    if (weightBackground === 0) continue;
    const weightForeground = total - weightBackground;
    if (weightForeground === 0) break;
    sumBackground += t * histogram[t]!;
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sum - sumBackground) / weightForeground;
    const variance = weightBackground * weightForeground *
      (meanBackground - meanForeground) ** 2;
    if (variance > maxVariance) {
      maxVariance = variance;
      threshold = t;
    }
  }
  return threshold;
}

export function binarize(image: GrayImage, threshold: number): GrayImage {
  const data = new Uint8Array(image.data.length);
  for (let i = 0; i < image.data.length; i += 1) {
    data[i] = image.data[i]! <= threshold ? 0 : 255;
  }
  return { width: image.width, height: image.height, data };
}

function blankImageLike(image: GrayImage): GrayImage {
  const data = new Uint8Array(image.data.length);
  data.fill(255);
  return { width: image.width, height: image.height, data };
}

function isCalibratedEinvoiceGeometry(image: GrayImage): boolean {
  return image.width === CALIBRATED_EINVOICE_WIDTH
    && image.height === CALIBRATED_EINVOICE_HEIGHT;
}

export function maskBottomInterferenceBand(image: GrayImage): GrayImage {
  if (!isCalibratedEinvoiceGeometry(image)) return blankImageLike(image);
  const data = new Uint8Array(image.data);
  for (
    let y = image.height - EINVOICE_BOTTOM_INTERFERENCE_ROWS;
    y < image.height;
    y += 1
  ) {
    data.fill(255, y * image.width, (y + 1) * image.width);
  }
  return { width: image.width, height: image.height, data };
}

export function suppressHorizontalInterference(image: GrayImage): GrayImage {
  if (!isCalibratedEinvoiceGeometry(image)) return blankImageLike(image);
  // CBL's binarize operation treats pixels exactly on the threshold as
  // background. Preserve that exclusive boundary for the calibrated filter
  // without changing the shared inclusive binarize helper.
  const binary = binarize(image, EINVOICE_DIRECTIONAL_THRESHOLD - 1);
  const data = new Uint8Array(binary.data.length);
  const kernelRadius = 1;
  for (let y = 0; y < binary.height; y += 1) {
    for (let x = 0; x < binary.width; x += 1) {
      let value = 0;
      for (let kernelY = 0; kernelY < EINVOICE_DIRECTIONAL_KERNEL.length; kernelY += 1) {
        for (let kernelX = 0; kernelX < EINVOICE_DIRECTIONAL_KERNEL[kernelY]!.length; kernelX += 1) {
          const sampleX = Math.max(
            0,
            Math.min(binary.width - 1, x + kernelX - kernelRadius),
          );
          const sampleY = Math.max(
            0,
            Math.min(binary.height - 1, y + kernelY - kernelRadius),
          );
          value += binary.data[sampleY * binary.width + sampleX]!
            * EINVOICE_DIRECTIONAL_KERNEL[kernelY]![kernelX]!;
        }
      }
      data[y * binary.width + x] = Math.max(0, Math.min(255, value));
    }
  }
  return { width: binary.width, height: binary.height, data };
}

export function denoise(image: GrayImage, minRegionPixels: number): GrayImage {
  const { width, height } = image;
  const data = new Uint8Array(image.data);
  const visited = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i += 1) {
    if (visited[i] || data[i] !== 0) continue;
    const component: number[] = [];
    const stack = [i];
    visited[i] = 1;
    while (stack.length > 0) {
      const index = stack.pop()!;
      component.push(index);
      const x = index % width;
      const y = Math.floor(index / width);
      if (x + 1 < width) {
        const next = index + 1;
        if (!visited[next] && data[next] === 0) {
          visited[next] = 1;
          stack.push(next);
        }
      }
      if (x - 1 >= 0) {
        const next = index - 1;
        if (!visited[next] && data[next] === 0) {
          visited[next] = 1;
          stack.push(next);
        }
      }
      if (y + 1 < height) {
        const next = index + width;
        if (!visited[next] && data[next] === 0) {
          visited[next] = 1;
          stack.push(next);
        }
      }
      if (y - 1 >= 0) {
        const next = index - width;
        if (!visited[next] && data[next] === 0) {
          visited[next] = 1;
          stack.push(next);
        }
      }
    }
    if (component.length < minRegionPixels) {
      for (const index of component) data[index] = 255;
    }
  }
  return { width, height, data };
}

/**
 * Remove axis-aligned grid lines that span most of the CAPTCHA image. The
 * foreground polarity is inferred from the less common binary value so the
 * operation works for both dark-on-light and light-on-dark challenges.
 */
export function removeInterferenceLines(
  image: GrayImage,
  minCoverage = INTERFERENCE_LINE_MIN_COVERAGE,
): GrayImage {
  if (!(minCoverage > 0 && minCoverage <= 1)) {
    throw new Error("Interference-line coverage must be greater than 0 and at most 1.");
  }
  const { width, height } = image;
  let blackPixels = 0;
  let whitePixels = 0;
  for (const value of image.data) {
    if (value === 0) blackPixels += 1;
    if (value === 255) whitePixels += 1;
  }
  const background = blackPixels >= whitePixels ? 0 : 255;
  const foreground = background === 0 ? 255 : 0;
  const horizontalLines = new Uint8Array(height);
  const verticalLines = new Uint8Array(width);
  const horizontalThreshold = Math.ceil(width * minCoverage);
  const verticalThreshold = Math.ceil(height * minCoverage);

  for (let y = 0; y < height; y += 1) {
    let foregroundPixels = 0;
    for (let x = 0; x < width; x += 1) {
      if (image.data[y * width + x] === foreground) foregroundPixels += 1;
    }
    if (foregroundPixels >= horizontalThreshold) horizontalLines[y] = 1;
  }
  for (let x = 0; x < width; x += 1) {
    let foregroundPixels = 0;
    for (let y = 0; y < height; y += 1) {
      if (image.data[y * width + x] === foreground) foregroundPixels += 1;
    }
    if (foregroundPixels >= verticalThreshold) verticalLines[x] = 1;
  }

  const horizontalLineArea = expandLineMask(horizontalLines, 2);
  const verticalLineArea = expandLineMask(verticalLines, 2);

  const data = new Uint8Array(image.data);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (
        data[index] === foreground &&
        (horizontalLineArea[y] === 1 || verticalLineArea[x] === 1)
      ) {
        data[index] = background;
      }
    }
  }

  const diagonalCleaned = removeDiagonalLines(
    { width, height, data },
    foreground,
    background,
    minCoverage,
  );

  // Reconnect glyph strokes cut by a removed line. A bridge is restored only
  // when foreground remains on both sides of the entire detected line band.
  const restored = new Uint8Array(diagonalCleaned.data);
  const bridgeRadius = 2;
  const rowHasForeground = (y: number, x: number) => {
    if (y < 0 || y >= height) return false;
    for (
      let nx = Math.max(0, x - bridgeRadius);
      nx <= Math.min(width - 1, x + bridgeRadius);
      nx += 1
    ) {
      if (data[y * width + nx] === foreground) return true;
    }
    return false;
  };
  const columnHasForeground = (x: number, y: number) => {
    if (x < 0 || x >= width) return false;
    for (
      let ny = Math.max(0, y - bridgeRadius);
      ny <= Math.min(height - 1, y + bridgeRadius);
      ny += 1
    ) {
      if (data[ny * width + x] === foreground) return true;
    }
    return false;
  };

  for (const band of pixelBands(horizontalLineArea)) {
    for (let x = 0; x < width; x += 1) {
      if (
        !rowHasForeground(band.start - 1, x) ||
        !rowHasForeground(band.end + 1, x)
      ) continue;
      for (let y = band.start; y <= band.end; y += 1) {
        restored[y * width + x] = foreground;
      }
    }
  }
  for (const band of pixelBands(verticalLineArea)) {
    for (let y = 0; y < height; y += 1) {
      if (
        !columnHasForeground(band.start - 1, y) ||
        !columnHasForeground(band.end + 1, y)
      ) continue;
      for (let x = band.start; x <= band.end; x += 1) {
        restored[y * width + x] = foreground;
      }
    }
  }
  return { width, height, data: restored };
}

export function preprocessCaptchaImage(
  buffer: Buffer,
  onStep?: (step: CaptchaPreprocessStep, image: Buffer) => void,
  options: CaptchaPreprocessOptions = {},
): Buffer {
  const decoded = decodeGrayImage(buffer);
  onStep?.("grayscale", encodeGrayImage(decoded));
  const imagePreprocessing = options.imagePreprocessing ?? [];
  if (imagePreprocessing.includes("mask-bottom-interference-band")) {
    const masked = maskBottomInterferenceBand(decoded);
    const output = encodeGrayImage(masked);
    onStep?.("interference-band-masked", output);
    return output;
  }
  if (imagePreprocessing.includes("suppress-horizontal-interference")) {
    const suppressed = suppressHorizontalInterference(decoded);
    const binary = binarize(decoded, EINVOICE_DIRECTIONAL_THRESHOLD - 1);
    onStep?.("binarized", encodeGrayImage(binary));
    const output = encodeGrayImage(suppressed);
    onStep?.("horizontal-interference-suppressed", output);
    return output;
  }
  const upscaled = upscaleImage(decoded, UPSCALE_FACTOR);
  onStep?.("upscaled", encodeGrayImage(upscaled));
  const blurred = boxBlur(upscaled);
  onStep?.("blurred", encodeGrayImage(blurred));
  const threshold = otsuThreshold(blurred);
  const binary = binarize(blurred, threshold);
  onStep?.("binarized", encodeGrayImage(binary));
  const shouldRemoveInterferenceLines = options.removeInterferenceLines
    ?? imagePreprocessing.includes("remove-interference-lines");
  const lineCleaned = shouldRemoveInterferenceLines
    ? removeInterferenceLines(binary)
    : binary;
  if (shouldRemoveInterferenceLines) {
    onStep?.("lines-removed", encodeGrayImage(lineCleaned));
  }
  const denoised = denoise(lineCleaned, MIN_REGION_PIXELS);
  const output = encodeGrayImage(denoised);
  onStep?.("denoised", output);
  if (options.outputStage === "grayscale") return encodeGrayImage(decoded);
  return output;
}
