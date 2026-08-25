import { PNG } from "pngjs";

export type GrayImage = {
  width: number;
  height: number;
  data: Uint8Array;
};

export const UPSCALE_FACTOR = 3;
export const MIN_REGION_PIXELS = 40;

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

export function preprocessCaptchaImage(buffer: Buffer): Buffer {
  const decoded = decodeGrayImage(buffer);
  const upscaled = upscaleImage(decoded, UPSCALE_FACTOR);
  const blurred = boxBlur(upscaled);
  const threshold = otsuThreshold(blurred);
  const binary = binarize(blurred, threshold);
  const denoised = denoise(binary, MIN_REGION_PIXELS);
  return encodeGrayImage(denoised);
}
