import assert from "node:assert/strict";
import {
  integratedTitleBarOptions,
  trafficLightPositionForScale,
} from "./window-options.ts";

const macOptions = integratedTitleBarOptions("darwin");

assert.deepEqual(macOptions, {
  titleBarStyle: "hiddenInset",
  trafficLightPosition: { x: 14, y: 23 },
});
assert.equal(Object.hasOwn(macOptions, "frame"), false);

assert.deepEqual(integratedTitleBarOptions("win32"), {});
assert.deepEqual(integratedTitleBarOptions("linux"), {});

assert.deepEqual(trafficLightPositionForScale(75), { x: 14, y: 16 });
assert.deepEqual(trafficLightPositionForScale(100), { x: 14, y: 23 });
assert.deepEqual(trafficLightPositionForScale(150), { x: 14, y: 38 });
