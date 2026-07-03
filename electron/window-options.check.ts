import assert from "node:assert/strict";
import { integratedTitleBarOptions } from "./window-options.ts";

const macOptions = integratedTitleBarOptions("darwin");

assert.deepEqual(macOptions, {
  titleBarStyle: "hiddenInset",
  trafficLightPosition: { x: 14, y: 14 },
});
assert.equal(Object.hasOwn(macOptions, "frame"), false);

assert.deepEqual(integratedTitleBarOptions("win32"), {});
assert.deepEqual(integratedTitleBarOptions("linux"), {});
