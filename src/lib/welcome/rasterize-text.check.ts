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
  const alpha = new Uint8ClampedArray(120 * 120 * 4);
  for (let y = 2; y < 110; y += 1) {
    for (let x = 3; x < 110; x += 1) alpha[(y * 120 + x) * 4 + 3] = 255;
  }

  const first = sampleAlphaRaster({ width: 120, height: 120, data: alpha }, { maxPoints: 17, seed: 42 });
  const second = sampleAlphaRaster({ width: 120, height: 120, data: alpha }, { maxPoints: 17, seed: 42 });

  assert.deepEqual(first, second);
  assert.equal(first.length, 17);
  assert.ok(first.every(({ x, y }) => x % 12 === 0 && y % 12 === 0));
});

test("text raster sampling ignores transparent and nearly transparent pixels", () => {
  const data = new Uint8ClampedArray(24 * 4);
  data[2 * 4 + 3] = 31;
  data[14 * 4 + 3] = 32;

  assert.deepEqual(
    sampleAlphaRaster({ width: 24, height: 1, data }, { maxPoints: 520 }),
    [{ x: 12, y: 0 }],
  );
});

test("a one-particle cap still returns a valid deterministic target", () => {
  const data = new Uint8ClampedArray(3 * 4);
  data[3] = 255;
  data[7] = 255;
  data[11] = 255;

  assert.deepEqual(
    sampleAlphaRaster({ width: 3, height: 1, data }, { maxPoints: 1, seed: 7 }),
    [{ x: 0, y: 0 }],
  );
});

test("text raster targets stay on the deterministic 12px particle grid", () => {
  const alpha = new Uint8ClampedArray(72 * 36 * 4);
  for (let y = 0; y < 36; y += 1) {
    for (let x = 0; x < 72; x += 1) alpha[(y * 72 + x) * 4 + 3] = 255;
  }

  const targets = sampleAlphaRaster(
    { width: 72, height: 36, data: alpha },
    { maxPoints: 40, seed: 42 },
  );

  assert.ok(targets.length > 0);
  assert.ok(targets.every(({ x, y }) => x % 12 === 0 && y % 12 === 0));
  assert.deepEqual(
    targets,
    sampleAlphaRaster(
      { width: 72, height: 36, data: alpha },
      { maxPoints: 40, seed: 42 },
    ),
  );
});
