import assert from "node:assert/strict";
import test from "node:test";

import {
  beginViewLoad,
  failViewLoad,
  finishViewLoad,
  viewIndicator,
  type ViewLoadState,
} from "./view-load-state.ts";

test("starting a refresh keeps cached data and exposes an updating indicator", () => {
  const current: ViewLoadState<{ version: number }> = { status: "ready", data: { version: 1 } };

  const next = beginViewLoad(current);

  assert.deepEqual(next, { status: "loading", data: { version: 1 } });
  assert.equal(viewIndicator(next), "spinner");
});

test("a view without data uses a skeleton while it is loading", () => {
  const loading: ViewLoadState<{ version: number }> = { status: "loading" };

  assert.equal(viewIndicator(loading), "skeleton");
});

test("a failed refresh keeps old data and exposes a retryable error", () => {
  const current: ViewLoadState<{ version: number }> = { status: "ready", data: { version: 1 } };

  const failed = failViewLoad(beginViewLoad(current), new Error("temporary failure"));

  assert.deepEqual(failed, {
    status: "error",
    data: { version: 1 },
    message: "temporary failure",
  });
  assert.equal(viewIndicator(failed), "error");
  assert.deepEqual(finishViewLoad({ version: 2 }), { status: "ready", data: { version: 2 } });
});
