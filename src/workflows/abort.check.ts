import assert from "node:assert/strict";
import test from "node:test";
import { withAbort } from "./abort.ts";

test("an operation settles normally until its run is cancelled, then rejects with the cancel reason", async () => {
  assert.equal(await withAbort(Promise.resolve(1)), 1, "no signal leaves the operation unchanged");
  await assert.rejects(withAbort(Promise.reject(new Error("source failed")), new AbortController().signal), /source failed/u);

  const cancelled = new AbortController();
  const pending = withAbort(new Promise(() => {}), cancelled.signal);
  const reason = new Error("run cancelled");
  cancelled.abort(reason);
  await assert.rejects(pending, (error: unknown) => error === reason);

  await assert.rejects(withAbort(Promise.resolve(2), cancelled.signal), (error: unknown) => error === reason, "an already cancelled run never starts waiting");
});
