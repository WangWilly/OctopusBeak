import assert from "node:assert/strict";
import test from "node:test";
import { PNG } from "pngjs";
import {
  binarize,
  boxBlur,
  decodeGrayImage,
  denoise,
  encodeGrayImage,
  maskBottomInterferenceBand,
  otsuThreshold,
  preprocessCaptchaImage,
  removeInterferenceLines,
  suppressHorizontalInterference,
  upscaleImage,
  type GrayImage,
} from "./captcha-preprocess.ts";

function grayImage(width: number, height: number, values: number[]): GrayImage {
  assert.equal(values.length, width * height);
  return { width, height, data: new Uint8Array(values) };
}

function solidGray(width: number, height: number, value: number): GrayImage {
  return grayImage(width, height, new Array(width * height).fill(value));
}

test("decodeGrayImage converts color pixels to luminance grayscale", () => {
  const png = new PNG({ width: 2, height: 1 });
  png.data.set([255, 0, 0, 255, 0, 255, 0, 255]);
  const buffer = PNG.sync.write(png);
  const image = decodeGrayImage(buffer);
  assert.equal(image.width, 2);
  assert.equal(image.height, 1);
  assert.equal(image.data[0], Math.round(0.299 * 255));
  assert.equal(image.data[1], Math.round(0.587 * 255));
});

test("decodeGrayImage composites transparent pixels against a white background", () => {
  const png = new PNG({ width: 2, height: 1 });
  png.data.set([0, 0, 0, 0, 0, 0, 0, 128]);

  const image = decodeGrayImage(PNG.sync.write(png));

  assert.equal(image.data[0], 255, "fully transparent pixels are background");
  assert.ok(
    image.data[1]! > 120 && image.data[1]! < 140,
    "partially transparent black is blended with the white background",
  );
});

test("upscaleImage enlarges a grayscale image by the given factor", () => {
  const image = grayImage(1, 1, [200]);
  const upscaled = upscaleImage(image, 3);
  assert.equal(upscaled.width, 3);
  assert.equal(upscaled.height, 3);
  assert.ok(upscaled.data.every((value) => value === 200));
});

test("boxBlur smooths a single bright pixel into its neighbourhood", () => {
  const image = grayImage(3, 3, [
    255, 255, 255,
    255, 0, 255,
    255, 255, 255,
  ]);
  const blurred = boxBlur(image);
  assert.ok(blurred.data[4] > 0, "center pixel is no longer isolated black");
  assert.ok(blurred.data[4] < 255, "center pixel did not become fully white");
  assert.ok(blurred.data.every((value) => value > 0), "black spreads to neighbours");
});

test("otsuThreshold plus binarize separates a bimodal image", () => {
  const image = grayImage(200, 1, [
    ...new Array(100).fill(20),
    ...new Array(100).fill(220),
  ]);
  const binary = binarize(image, otsuThreshold(image));
  assert.equal(binary.data[0], 0, "dark half becomes black");
  assert.equal(binary.data[199], 255, "light half becomes white");
});

test("binarize maps pixels to black or white around the threshold", () => {
  const image = grayImage(3, 1, [10, 128, 200]);
  assert.deepEqual(Array.from(binarize(image, 128).data), [0, 0, 255]);
});

test("maskBottomInterferenceBand clears six rows without changing calibrated geometry", () => {
  const image = solidGray(150, 40, 0);
  const masked = maskBottomInterferenceBand(image);
  assert.deepEqual([masked.width, masked.height], [150, 40]);
  assert.equal(masked.data[33 * masked.width], 0);
  assert.ok(
    masked.data.slice(34 * masked.width).every((value) => value === 255),
  );
});

test("suppressHorizontalInterference removes a thin horizontal stroke while keeping a vertical stroke", () => {
  const image = solidGray(150, 40, 255);
  for (let x = 0; x < image.width; x += 1) {
    image.data[20 * image.width + x] = 0;
  }
  for (let y = 0; y < image.height; y += 1) {
    image.data[y * image.width + 50] = 0;
  }
  const suppressed = suppressHorizontalInterference(image);
  assert.equal(suppressed.data[20 * suppressed.width + 80], 255);
  assert.equal(suppressed.data[10 * suppressed.width + 50], 0);
});

test("E-Invoice calibrated preprocessing fails closed for another geometry", () => {
  const image = solidGray(149, 40, 0);
  assert.ok(
    maskBottomInterferenceBand(image).data.every((value) => value === 255),
  );
  assert.ok(
    suppressHorizontalInterference(image).data.every((value) => value === 255),
  );
});

test("denoise removes small isolated dots but keeps a large block", () => {
  const image = grayImage(8, 8, [
    0, 255, 255, 255, 255, 255, 255, 255,
    255, 0, 255, 255, 255, 255, 255, 255,
    255, 255, 255, 255, 255, 255, 255, 255,
    255, 255, 255, 0, 0, 0, 255, 255,
    255, 255, 255, 0, 0, 0, 255, 255,
    255, 255, 255, 0, 0, 0, 255, 255,
    255, 255, 255, 255, 255, 255, 255, 255,
    255, 255, 255, 255, 255, 255, 255, 255,
  ]);
  const denoised = denoise(image, 4);
  assert.equal(denoised.data[0], 255, "isolated dot removed");
  assert.equal(denoised.data[9], 255, "isolated dot removed");
  assert.equal(denoised.data[27], 0, "3x3 block kept");
});

test("removeInterferenceLines removes long grid lines without deleting compact glyphs", () => {
  const image = solidGray(10, 10, 0);
  for (let x = 0; x < image.width; x += 1) image.data[2 * image.width + x] = 255;
  for (let y = 0; y < image.height; y += 1) image.data[y * image.width + 7] = 255;
  for (let y = 5; y <= 7; y += 1) {
    for (let x = 2; x <= 4; x += 1) image.data[y * image.width + x] = 255;
  }

  const cleaned = removeInterferenceLines(image);

  assert.ok(
    Array.from({ length: image.width }, (_, x) => cleaned.data[2 * image.width + x])
      .every((value) => value === 0),
    "horizontal grid line removed",
  );
  assert.ok(
    Array.from({ length: image.height }, (_, y) => cleaned.data[y * image.width + 7])
      .every((value) => value === 0),
    "vertical grid line removed",
  );
  assert.equal(cleaned.data[6 * image.width + 3], 255, "compact glyph retained");
});

test("removeInterferenceLines removes long diagonal lines without deleting compact glyphs", () => {
  const image = solidGray(40, 20, 255);
  for (let x = 0; x < image.width; x += 1) {
    const y = 3 + Math.round(x * 0.3);
    image.data[y * image.width + x] = 0;
    if (y + 1 < image.height) image.data[(y + 1) * image.width + x] = 0;
  }
  for (let y = 7; y <= 12; y += 1) {
    for (let x = 17; x <= 20; x += 1) image.data[y * image.width + x] = 0;
  }

  const cleaned = removeInterferenceLines(image);

  let residual = 0;
  for (let x = 0; x < image.width; x += 1) {
    const y = 3 + Math.round(x * 0.3);
    for (let dy = -1; dy <= 2; dy += 1) {
      const candidate = y + dy;
      if (candidate >= 0 && candidate < image.height && cleaned.data[candidate * image.width + x] === 0) {
        residual += 1;
      }
    }
  }
  assert.ok(residual < image.width * 0.2, "diagonal interference is removed");
  assert.equal(cleaned.data[9 * image.width + 19], 0, "compact glyph retained");
});

test("preprocessCaptchaImage returns a PNG buffer from a PNG buffer", () => {
  const png = new PNG({ width: 6, height: 2 });
  png.data.fill(200);
  const input = PNG.sync.write(png);
  const output = preprocessCaptchaImage(input);
  const roundTripped = decodeGrayImage(output);
  assert.equal(roundTripped.width, 18);
  assert.equal(roundTripped.height, 6);
  assert.ok(roundTripped.data.every((value) => value === 0 || value === 255));
});

test("preprocessCaptchaImage can select the calibrated OCR output stage", () => {
  const png = new PNG({ width: 6, height: 2 });
  png.data.fill(200);
  const input = PNG.sync.write(png);
  assert.deepEqual(
    ["grayscale", "final"].map((outputStage) => {
      const image = decodeGrayImage(preprocessCaptchaImage(input, undefined, { outputStage: outputStage as never }));
      return [image.width, image.height];
    }),
    [[6, 2], [18, 6]],
  );
});

test("encodeGrayImage round-trips a grayscale image through PNG", () => {
  const image = grayImage(2, 2, [0, 255, 255, 0]);
  const decoded = decodeGrayImage(encodeGrayImage(image));
  assert.deepEqual(Array.from(decoded.data), [0, 255, 255, 0]);
});

test("preprocessCaptchaImage reports each step to the observer in order", () => {
  const steps: string[] = [];
  const png = new PNG({ width: 4, height: 2 });
  png.data.fill(150);
  preprocessCaptchaImage(PNG.sync.write(png), (step) => steps.push(step));
  assert.deepEqual(steps, [
    "grayscale",
    "upscaled",
    "blurred",
    "binarized",
    "denoised",
  ]);
});

test("preprocessCaptchaImage reports Yuanta line removal when requested", () => {
  const steps: string[] = [];
  const png = new PNG({ width: 10, height: 10 });
  png.data.fill(0);
  preprocessCaptchaImage(
    PNG.sync.write(png),
    (step) => steps.push(step),
    { removeInterferenceLines: true },
  );
  assert.deepEqual(steps, [
    "grayscale",
    "upscaled",
    "blurred",
    "binarized",
    "lines-removed",
    "denoised",
  ]);
});

test("preprocessCaptchaImage exposes each calibrated E-Invoice strategy", () => {
  const png = new PNG({ width: 150, height: 40 });
  png.data.fill(255);
  const input = PNG.sync.write(png);
  const runs = [
    "mask-bottom-interference-band",
    "suppress-horizontal-interference",
  ] as const;
  assert.deepEqual(
    runs.map((mode) => {
      const steps: string[] = [];
      preprocessCaptchaImage(input, (step) => steps.push(step), {
        imagePreprocessing: [mode],
      });
      return steps;
    }),
    [
      ["grayscale", "interference-band-masked"],
      ["grayscale", "binarized", "horizontal-interference-suppressed"],
    ],
  );
});

test("Fubon foreground strategies preserve their calibrated color semantics", () => {
  const png = new PNG({ width: 158, height: 30 });
  png.data.fill(255);
  const sourceIndex = (15 * png.width + 79) * 4;
  png.data.set([160, 240, 160, 255], sourceIndex);
  const input = PNG.sync.write(png);

  const luminance = decodeGrayImage(preprocessCaptchaImage(input, undefined, {
    imagePreprocessing: ["fubon-luminance-foreground"],
  }));
  const minChannel = decodeGrayImage(preprocessCaptchaImage(input, undefined, {
    imagePreprocessing: ["fubon-min-channel-foreground"],
  }));
  const outputIndex = (15 * 3 + 1) * minChannel.width + (79 * 3 + 1);

  assert.deepEqual([luminance.width, luminance.height], [474, 90]);
  assert.equal(luminance.data[outputIndex], 255);
  assert.equal(minChannel.data[outputIndex], 0);
});

test("Fubon foreground preprocessing fails closed outside 158 by 30", () => {
  const png = new PNG({ width: 157, height: 30 });
  png.data.fill(0);
  const input = PNG.sync.write(png);

  for (const mode of [
    "fubon-luminance-foreground",
    "fubon-min-channel-foreground",
  ] as const) {
    const output = decodeGrayImage(preprocessCaptchaImage(input, undefined, {
      imagePreprocessing: [mode],
    }));
    assert.deepEqual([output.width, output.height], [157, 30]);
    assert.ok(output.data.every((value) => value === 255));
  }
});

test("preprocessCaptchaImage exposes each calibrated Fubon strategy", () => {
  const png = new PNG({ width: 158, height: 30 });
  png.data.fill(255);
  const input = PNG.sync.write(png);

  for (const mode of [
    "fubon-luminance-foreground",
    "fubon-min-channel-foreground",
  ] as const) {
    const steps: string[] = [];
    preprocessCaptchaImage(input, (step) => steps.push(step), {
      imagePreprocessing: [mode],
    });
    assert.deepEqual(steps, ["grayscale", "upscaled", "binarized"]);
  }
});
