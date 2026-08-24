import assert from "node:assert/strict";
import {
  activateControlWithoutPointer,
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
let seenNavigationOptions: {
  waitUntil: "domcontentloaded";
  timeout: number;
} | null = null;
let seenSelector: string | null = null;
const navigationScope = {
  waitForNavigation: (options: {
    waitUntil: "domcontentloaded";
    timeout: number;
  }) => {
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
assert.deepEqual(seenNavigationOptions, {
  waitUntil: "domcontentloaded",
  timeout: 60_000,
});
assert.equal(seenSelector, "#submitbutton");

finishNavigation();
await pendingNavigation;
assert.equal(completed, true);

let evaluateCalled = false;
let dispatchType: string | null = null;
let dispatchOptions: { signal?: AbortSignal; timeout?: number } | null = null;
const dispatchSignal = new AbortController().signal;
await activateControlWithoutPointer(
  {
    evaluate: async () => {
      evaluateCalled = true;
    },
    dispatchEvent: async (
      type: string,
      _eventInit: unknown,
      options: { signal?: AbortSignal; timeout?: number },
    ) => {
      dispatchType = type;
      dispatchOptions = options;
    },
  } as never,
  { signal: dispatchSignal, timeout: 0 },
);
assert.equal(evaluateCalled, false);
assert.equal(dispatchType, "click");
const seenDispatchOptions = dispatchOptions as unknown as {
  signal?: AbortSignal;
  timeout?: number;
};
assert.equal(seenDispatchOptions.signal, dispatchSignal);
assert.equal(seenDispatchOptions.timeout, 0);
