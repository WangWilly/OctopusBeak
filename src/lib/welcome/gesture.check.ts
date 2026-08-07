import assert from "node:assert/strict";
import test from "node:test";

import { classifyHorizontalSwipe } from "./gesture.ts";

test("classifies a leftward horizontal swipe as forward", () => {
  assert.equal(classifyHorizontalSwipe({ x: 320, y: 240 }, { x: 240, y: 248 }), "forward");
});

test("classifies a rightward horizontal swipe as backward", () => {
  assert.equal(classifyHorizontalSwipe({ x: 240, y: 240 }, { x: 320, y: 248 }), "backward");
});

test("ignores horizontal movement below the swipe threshold", () => {
  assert.equal(classifyHorizontalSwipe({ x: 320, y: 240 }, { x: 257, y: 248 }), null);
});

test("ignores vertical movement even when the distance is large", () => {
  assert.equal(classifyHorizontalSwipe({ x: 320, y: 240 }, { x: 300, y: 340 }), null);
});

test("requires horizontal movement to dominate diagonal movement", () => {
  assert.equal(classifyHorizontalSwipe({ x: 320, y: 240 }, { x: 240, y: 321 }), null);
});
