import assert from "node:assert/strict";
import test from "node:test";
import { get } from "svelte/store";
import { createBalanceChartZoom } from "./balance-chart-zoom.ts";

test("a history drag needs at least 3% of the currently visible domain", () => {
  let max = 1000;
  const zoom = createBalanceChartZoom({ click: "select-day", defaultDomain: () => [0, max] });
  let released = 0;
  function drag(start: number, end: number) {
    zoom.brush.onBrushEnd({ brush: { active: true, y: [start, end], reset: () => released++ } });
    return get(zoom).range;
  }

  assert.equal(drag(300, 329), null);
  assert.deepEqual(drag(400, 300), [300, 400]);
  assert.deepEqual(drag(330, 332), [300, 400]);
  assert.deepEqual(drag(333, 330), [330, 333]);
  assert.equal(released, 4);
  zoom.reset();
  max = 200;
  assert.deepEqual(drag(20, 26), [20, 26]);
});

test("an inactive or invalid brush preserves a date selection's zoom and clears a reset-on-click chart", () => {
  for (const policy of [{ click: "reset" }, { click: "select-day", defaultDomain: (): [number, number] => [0, 100] }] as const) {
    const zoom = createBalanceChartZoom(policy);
    for (const event of [{ active: false, y: [12, 15] }, { active: true, y: [null, 15] }]) {
      zoom.brush.onBrushEnd({ brush: { active: true, y: [25, 10], reset() {} } });
      zoom.brush.onBrushEnd({ brush: { ...event, reset() { assert.fail("no active numeric brush"); } } });
      assert.deepEqual(get(zoom).range, policy.click === "reset" ? null : [10, 25]);
    }
  }
});
