import assert from "node:assert/strict";
import test from "node:test";
import { placeOnboardingCoach } from "./placement.ts";

const intersects = (
  target: { left: number; top: number; width: number; height: number },
  coach: { left: number; top: number },
  size: { width: number; height: number },
) => !(
  coach.left + size.width <= target.left
  || coach.left >= target.left + target.width
  || coach.top + size.height <= target.top
  || coach.top >= target.top + target.height
);

const inside = (
  coach: { left: number; top: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
) => coach.left >= 24
  && coach.top >= 24
  && coach.left + size.width <= viewport.width - 24
  && coach.top + size.height <= viewport.height - 24;

test("places the credentials coach to the right without covering Save", () => {
  const target = { left: 1417, top: 147, width: 158, height: 86 };
  const size = { width: 360, height: 286 };
  const result = placeOnboardingCoach(target, size, { width: 2048, height: 1152 });
  assert.ok(result);
  assert.equal(result.side, "right");
  assert.equal(intersects(target, result, size), false);
});

test("keeps the credentials coach clear of every modal control", () => {
  const target = { left: 1206, top: 94, width: 112, height: 40 };
  const size = { width: 360, height: 255 };
  const obstacles = [
    { left: 287, top: 239, width: 199, height: 620 },
    { left: 545, top: 256, width: 821, height: 128 },
    { left: 545, top: 408, width: 821, height: 184 },
    target,
  ];
  const result = placeOnboardingCoach(
    target,
    size,
    { width: 1680, height: 907 },
    obstacles,
  );
  assert.ok(result);
  assert.ok(inside(result, size, { width: 1680, height: 907 }));
  assert.equal(obstacles.some((rect) => intersects(rect, result, size)), false);
});

test("falls back to the left and stays inside the viewport", () => {
  const target = { left: 900, top: 80, width: 120, height: 48 };
  const size = { width: 360, height: 286 };
  const result = placeOnboardingCoach(target, size, { width: 1100, height: 760 });
  assert.ok(result);
  assert.equal(result.side, "left");
  assert.ok(result.left >= 24 && result.top >= 24);
  assert.ok(result.left + size.width <= 1076);
  assert.equal(intersects(target, result, size), false);
});

test("keeps clear of a tall statements fieldset", () => {
  const target = { left: 1417, top: 147, width: 158, height: 740 };
  const size = { width: 360, height: 286 };
  const result = placeOnboardingCoach(target, size, { width: 2048, height: 1152 });
  assert.ok(result);
  assert.equal(result.side, "right");
  assert.equal(intersects(target, result, size), false);
});

test("uses below when neither horizontal side fits", () => {
  const target = { left: 400, top: 50, width: 100, height: 50 };
  const size = { width: 360, height: 286 };
  const viewport = { width: 600, height: 760 };
  const result = placeOnboardingCoach(target, size, viewport);
  assert.equal(result?.side, "below");
  assert.ok(result && inside(result, size, viewport));
  assert.equal(result && intersects(target, result, size), false);
});

test("uses above when below and both horizontal sides do not fit", () => {
  const target = { left: 400, top: 600, width: 100, height: 50 };
  const size = { width: 360, height: 286 };
  const viewport = { width: 600, height: 760 };
  const result = placeOnboardingCoach(target, size, viewport);
  assert.equal(result?.side, "above");
  assert.ok(result && inside(result, size, viewport));
  assert.equal(result && intersects(target, result, size), false);
});

test("fits beside a tall statements fieldset in the minimum Electron window", () => {
  const target = { left: 500, top: 80, width: 120, height: 550 };
  const size = { width: 360, height: 652 };
  const viewport = { width: 980, height: 700 };
  const result = placeOnboardingCoach(target, size, viewport);
  assert.equal(result?.side, "left");
  assert.ok(result && inside(result, size, viewport));
  assert.equal(result && intersects(target, result, size), false);
});

test("keeps a compact coach visible when the target fills the viewport", () => {
  const target = { left: 24, top: 24, width: 932, height: 652 };
  const viewport = { width: 980, height: 700 };
  const result = placeOnboardingCoach(target, { width: 360, height: 652 }, viewport);

  assert.ok(result);
  assert.equal(result.compact, true);
  assert.ok(inside(result, result, viewport));
});

test("ignores secondary obstacles before hiding the coach", () => {
  const target = { left: 450, top: 300, width: 200, height: 200 };
  const size = { width: 360, height: 286 };
  const result = placeOnboardingCoach(
    target,
    size,
    { width: 1000, height: 700 },
    [{ left: 0, top: 0, width: 1000, height: 700 }],
  );

  assert.ok(result);
  assert.equal(intersects(target, result, result), false);
});

test("keeps the coach inside the viewport when a large target leaves no free region", () => {
  const viewport = { width: 1280, height: 726 };
  const target = { left: 72.5, top: 20, width: 1120, height: 686 };
  const requestedSize = { width: 360, height: 263.3 };
  const result = placeOnboardingCoach(target, requestedSize, viewport);

  assert.ok(result);
  assert.ok(inside(result, result, viewport));
  assert.equal(result.width, requestedSize.width);
  assert.equal(result.height, requestedSize.height);
});

test("clamps the measured coach at smaller viewport sizes", () => {
  const viewport = { width: 654, height: 467 };
  const target = { left: 30, top: 100, width: 594, height: 280 };
  const size = { width: 360, height: 419 };
  const obstacles = [
    { left: 30, top: 30, width: 100, height: 40 },
    { left: 524, top: 30, width: 100, height: 40 },
  ];
  const result = placeOnboardingCoach(target, size, viewport, obstacles);

  assert.ok(result);
  assert.equal(result.compact, true);
  assert.ok(inside(result, result, viewport));
  assert.ok(result.width <= viewport.width - 48);
  assert.ok(result.height <= viewport.height - 48);
});

test("keeps full coach content size at the supported onboarding window sizes", () => {
  const target = { left: 30, top: 72, width: 920, height: 520 };
  const content = { width: 360, height: 340 };
  for (const viewport of [{ width: 1280, height: 726 }, { width: 1024, height: 640 }]) {
    const result = placeOnboardingCoach(target, content, viewport);
    assert.ok(result);
    assert.equal(result.width, content.width);
    assert.equal(result.height, content.height);
    assert.ok(inside(result, content, viewport));
  }
});
