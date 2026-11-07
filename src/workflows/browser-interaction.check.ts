import assert from "node:assert/strict";
import {
  activateControlWithoutPointer,
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
