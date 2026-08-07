import assert from "node:assert/strict";
import test from "node:test";

import {
  createExteriorParticleStart,
  resolveTextParticleBudget,
  sampleAlphaRaster,
} from "./rasterize-text.ts";

test("text particle budget responds to device pixel ratio without exceeding its cap", () => {
  assert.equal(resolveTextParticleBudget(260, 1), 220);
  assert.equal(resolveTextParticleBudget(600, 1), 432);
  assert.equal(resolveTextParticleBudget(600, 1.25), 520);
  assert.equal(resolveTextParticleBudget(600, 2), 520);
  assert.equal(resolveTextParticleBudget(2_000, 4), 520);
  assert.equal(resolveTextParticleBudget(600, 0), 432);
});

test("particle starts are deterministic and remain outside the raster", () => {
  const width = 600;
  const height = 180;
  const starts = Array.from(
    { length: 64 },
    (_, index) => createExteriorParticleStart(index, width, height, 42),
  );

  assert.deepEqual(starts, Array.from(
    { length: 64 },
    (_, index) => createExteriorParticleStart(index, width, height, 42),
  ));
  assert.ok(starts.every(({ x, y }) => x < 0 || x > width || y < 0 || y > height));
});

test("text raster sampling is deterministic and bounded", () => {
  const alpha = new Uint8ClampedArray(20 * 12 * 4);
  for (let y = 2; y < 10; y += 1) {
    for (let x = 3; x < 18; x += 1) alpha[(y * 20 + x) * 4 + 3] = 255;
  }

  const first = sampleAlphaRaster({ width: 20, height: 12, data: alpha }, { maxPoints: 17, seed: 42 });
  const second = sampleAlphaRaster({ width: 20, height: 12, data: alpha }, { maxPoints: 17, seed: 42 });

  assert.deepEqual(first, second);
  assert.equal(first.length, 17);
  assert.deepEqual(first[0], { x: 6, y: 2 });
  assert.deepEqual(first.at(-1), { x: 12, y: 9 });
});

test("text raster sampling ignores transparent and nearly transparent pixels", () => {
  const data = new Uint8ClampedArray([
    0, 0, 0, 0,
    0, 0, 0, 31,
    0, 0, 0, 32,
    0, 0, 0, 255,
  ]);

  assert.deepEqual(
    sampleAlphaRaster({ width: 4, height: 1, data }, { maxPoints: 520 }),
    [{ x: 2, y: 0 }, { x: 3, y: 0 }],
  );
});

test("a one-particle cap still returns a valid deterministic target", () => {
  const data = new Uint8ClampedArray(3 * 4);
  data[3] = 255;
  data[7] = 255;
  data[11] = 255;

  assert.deepEqual(
    sampleAlphaRaster({ width: 3, height: 1, data }, { maxPoints: 1, seed: 7 }),
    [{ x: 1, y: 0 }],
  );
});
