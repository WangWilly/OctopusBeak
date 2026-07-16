import assert from "node:assert/strict";
import {
  spendingChartInitialTransform,
  spendingChartRenderWindow,
} from "./spending-chart-window.ts";

assert.deepEqual(spendingChartInitialTransform(30, 1000), {
  scale: 30 / 18,
  translateX: 1000 - 1000 * (30 / 18),
});
assert.deepEqual(spendingChartInitialTransform(12, 1000), {
  scale: 1,
  translateX: 0,
});

assert.deepEqual(spendingChartRenderWindow(30, {
  startIndex: 12,
  endIndex: 29,
  atStart: false,
  atEnd: true,
}), { startIndex: 10, endIndex: 30 });
assert.deepEqual(spendingChartRenderWindow(30, {
  startIndex: 5,
  endIndex: 14,
  atStart: false,
  atEnd: false,
}), { startIndex: 3, endIndex: 17 });
assert.deepEqual(spendingChartRenderWindow(30, {
  startIndex: 0,
  endIndex: 9,
  atStart: true,
  atEnd: false,
}), { startIndex: 0, endIndex: 12 });
assert.equal(spendingChartRenderWindow(0, null), null);
