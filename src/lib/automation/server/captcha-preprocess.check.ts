import assert from "node:assert/strict";
import test from "node:test";
import { PNG } from "pngjs";
import {
  binarize,
  boxBlur,
  decodeGrayImage,
  denoise,
  encodeGrayImage,
  otsuThreshold,
  preprocessCaptchaImage,
  removeInterferenceLines,
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
