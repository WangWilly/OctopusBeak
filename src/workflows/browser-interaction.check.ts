import assert from "node:assert/strict";
import {
  clickAndWaitForNavigation,
  hasAttachedLocator,
} from "./browser-interaction.ts";

function locatorProbe(
  waitFor: (options: { state: "attached"; timeout: number }) => Promise<void>,
) {
  return {
    first() {
      return { waitFor };
    },
  };
}

let seenOptions: { state: "attached"; timeout: number } | null = null;
assert.equal(
  await hasAttachedLocator(
    locatorProbe(async (options) => {
      seenOptions = options;
    }),
    123,
  ),
  true,
);
assert.deepEqual(seenOptions, { state: "attached", timeout: 123 });

assert.equal(
  await hasAttachedLocator(
    locatorProbe(async () => {
      throw new Error("not attached");
    }),
    1,
  ),
  false,
);

let finishNavigation!: () => void;
const navigation = new Promise<void>((resolve) => {
  finishNavigation = resolve;
});
let clicked = false;
let completed = false;
let seenNavigationOptions: { waitUntil: "domcontentloaded"; timeout: number } | null = null;
let seenSelector: string | null = null;
const navigationScope = {
  waitForNavigation: (options: { waitUntil: "domcontentloaded"; timeout: number }) => {
    seenNavigationOptions = options;
    return navigation;
  },
  locator: (selector: string) => ({
    click: async () => {
      seenSelector = selector;
      clicked = true;
    },
  }),
};

const pendingNavigation = clickAndWaitForNavigation(
  navigationScope,
  "#submitbutton",
).then(() => {
  completed = true;
});
await new Promise<void>((resolve) => setImmediate(resolve));
assert.equal(clicked, true);
assert.equal(completed, false);
assert.deepEqual(seenNavigationOptions, { waitUntil: "domcontentloaded", timeout: 60_000 });
assert.equal(seenSelector, "#submitbutton");

finishNavigation();
await pendingNavigation;
assert.equal(completed, true);
