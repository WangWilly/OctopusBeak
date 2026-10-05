import assert from "node:assert/strict";
import test from "node:test";
import { squarify } from "./treemap-layout.ts";

const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} ≈ ${expected}`);

test("each tile's area is proportional to its value and the tiles fill the box without overlap", () => {
  const values = [36.9, 23.3, 20.1, 10.2, 9.5];
  const rects = squarify(values, 100, 60);
  assert.equal(rects.length, values.length);
  const total = values.reduce((sum, value) => sum + value, 0);
  rects.forEach((rect, index) => close(rect.width * rect.height, (values[index]! / total) * 6000));
  for (const rect of rects) {
    assert.ok(rect.x >= -1e-9 && rect.y >= -1e-9 && rect.x + rect.width <= 100 + 1e-6 && rect.y + rect.height <= 60 + 1e-6);
  }
  for (let left = 0; left < rects.length; left += 1) {
    for (let right = left + 1; right < rects.length; right += 1) {
      const a = rects[left]!;
      const b = rects[right]!;
      const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      assert.ok(overlapX <= 1e-6 || overlapY <= 1e-6, `tiles ${left} and ${right} overlap`);
    }
  }
});

test("tiles stay close to square instead of slicing into strips", () => {
  const rects = squarify([1, 1, 1, 1], 100, 100);
  for (const rect of rects) close(rect.width / rect.height, 1);
});

test("nothing to lay out yields no tiles", () => {
  assert.deepEqual(squarify([], 100, 100), []);
  assert.deepEqual(squarify([1], 0, 100), []);
});
