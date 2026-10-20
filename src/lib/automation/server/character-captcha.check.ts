import assert from "node:assert/strict";
import test from "node:test";
import { recognizeRakutenCharacters } from "./character-captcha.ts";
import { decodeGrayImage, encodeGrayImage } from "./captcha-preprocess.ts";

function syntheticImage(width = 152, height = 60, starts = [8, 46, 84, 122]) {
  const data = new Uint8Array(width * height).fill(255);
  for (const start of starts) {
    for (let y = 12; y < Math.min(42, height); y += 1) {
      for (let x = start; x < Math.min(start + 20, width); x += 1) data[y * width + x] = 0;
    }
  }
  return encodeGrayImage({ width, height, data });
}

test("one character strategy cuts four crops, doubles each and adds 10px white borders", async () => {
  const crops: Buffer[] = [];
  const answer = await recognizeRakutenCharacters(syntheticImage(), async (image) => {
    crops.push(image);
    return { answer: "AB29"[crops.length - 1]!, confidence: crops.length / 5 };
  });
  assert.deepEqual(answer, { text: "AB29", confidence: 0.5 });
  assert.equal(crops.length, 4);
  for (const png of crops) {
    const image = decodeGrayImage(png);
    assert.deepEqual([image.width, image.height], [60, 80]);
    assert.equal(image.data.filter((v) => v === 0).length, 2400);
    assert.ok(image.data.slice(0, image.width * 10).every((v) => v === 255));
    assert.equal(image.data[10 * image.width + 10], 0);
  }
});

test("empty, incomplete and unsupported foregrounds fail closed", async () => {
  let calls = 0;
  const recognize = async () => { calls += 1; return { answer: "A", confidence: 1 }; };
  for (const image of [syntheticImage(151), syntheticImage(152, 59), syntheticImage(152, 60, [])]) {
    assert.deepEqual(await recognizeRakutenCharacters(image, recognize), { text: "", confidence: 0 });
  }
  assert.equal(calls, 0);
  assert.deepEqual(await recognizeRakutenCharacters(syntheticImage(152, 60, [8, 46, 84]), recognize), { text: "", confidence: 0 });
});

test("projection cuts keep shifted glyphs intact instead of cutting at fixed slot edges", async () => {
  const crops: Buffer[] = [];
  await recognizeRakutenCharacters(syntheticImage(152, 60, [20, 57, 94, 131]), async (crop) => {
    crops.push(crop);
    return { answer: "A", confidence: 1 };
  });
  assert.equal(crops.length, 4);
  for (const png of crops) {
    const image = decodeGrayImage(png);
    assert.deepEqual([image.width, image.height], [60, 80]);
    assert.equal(image.data.filter((v) => v === 0).length, 2400);
  }
});

test("a blank or multi-character glyph result rejects the entire strategy", async () => {
  for (const invalid of ["", "AB"]) {
    let calls = 0;
    const result = await recognizeRakutenCharacters(syntheticImage(), async () => {
      calls += 1;
      return { answer: calls === 2 ? invalid : "A", confidence: 1 };
    });
    assert.equal(calls, 4);
    assert.deepEqual(result, { text: "", confidence: 0 });
  }
});
