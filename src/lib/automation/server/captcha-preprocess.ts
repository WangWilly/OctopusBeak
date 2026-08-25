import { PNG } from "pngjs";

export type GrayImage = {
  width: number;
  height: number;
  data: Uint8Array;
};

export const UPSCALE_FACTOR = 3;
export const MIN_REGION_PIXELS = 40;
export const INTERFERENCE_LINE_MIN_COVERAGE = 0.7;

export type CaptchaPreprocessStep =
  | "grayscale"
  | "upscaled"
  | "blurred"
  | "binarized"
  | "lines-removed"
  | "denoised";

export type CaptchaPreprocessOptions = {
  removeInterferenceLines?: boolean;
};

type PixelBand = { start: number; end: number };

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

export function decodeGrayImage(buffer: Buffer): GrayImage {
  const png = PNG.sync.read(buffer);
  const data = new Uint8Array(png.width * png.height);
  for (let i = 0; i < data.length; i += 1) {
    const r = png.data[i * 4]!;
    const g = png.data[i * 4 + 1]!;
    const b = png.data[i * 4 + 2]!;
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

  // Reconnect glyph strokes cut by a removed line. A bridge is restored only
  // when foreground remains on both sides of the entire detected line band.
  const restored = new Uint8Array(data);
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
  const upscaled = upscaleImage(decoded, UPSCALE_FACTOR);
  onStep?.("upscaled", encodeGrayImage(upscaled));
  const blurred = boxBlur(upscaled);
  onStep?.("blurred", encodeGrayImage(blurred));
  const threshold = otsuThreshold(blurred);
  const binary = binarize(blurred, threshold);
  onStep?.("binarized", encodeGrayImage(binary));
  const lineCleaned = options.removeInterferenceLines
    ? removeInterferenceLines(binary)
    : binary;
  if (options.removeInterferenceLines) {
    onStep?.("lines-removed", encodeGrayImage(lineCleaned));
  }
  const denoised = denoise(lineCleaned, MIN_REGION_PIXELS);
  const output = encodeGrayImage(denoised);
  onStep?.("denoised", output);
  return output;
}
