import assert from "node:assert/strict";
import { createViewStores, type ViewState } from "./view-stores.ts";

type Summary = { amount: number };

let starts = 0;
let stops = 0;
let push: ((value: Summary) => void) | undefined;
const stores = createViewStores({
  async subscribe(_view, _params, onValue) {
    starts += 1;
    push = onValue as (value: Summary) => void;
    onValue({ amount: 10 });
    return async () => { stops += 1; };
  },
});

const first = stores.get<Summary>("spending.summary", { month: "2026-09" });
const second = stores.get<Summary>("spending.summary", { month: "2026-09" });
assert.equal(first, second);

const firstValues: ViewState<Summary>[] = [];
const secondValues: ViewState<Summary>[] = [];
const stopFirst = first.subscribe((value) => firstValues.push(value));
const stopSecond = second.subscribe((value) => secondValues.push(value));
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(starts, 1);
assert.deepEqual(firstValues.at(-1), { status: "ready", data: { amount: 10 } });
assert.deepEqual(secondValues.at(-1), { status: "ready", data: { amount: 10 } });

push?.({ amount: 20 });
assert.deepEqual(firstValues.at(-1), { status: "ready", data: { amount: 20 } });
assert.deepEqual(secondValues.at(-1), { status: "ready", data: { amount: 20 } });

stopFirst();
assert.equal(stops, 0);
stopSecond();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(stops, 1);

const failing = createViewStores({
  async subscribe() { throw new Error("transport unavailable"); },
});
const failures: ViewState<Summary>[] = [];
const stopFailing = failing.get<Summary>("spending.summary", { month: "2026-10" })
  .subscribe((value) => failures.push(value));
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(failures.at(-1), { status: "error", code: "subscription-failed" });
stopFailing();

let delayedStarts = 0;
const delayedStopResolvers: Array<() => void> = [];
async function resolveDelayedStop(): Promise<void> {
  for (let attempt = 0; attempt < 20 && delayedStopResolvers.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const resolve = delayedStopResolvers.shift();
  assert.ok(resolve, "the transport stop must be requested before it is resolved");
  resolve();
}
const delayed = createViewStores({
  async subscribe(_view, _params, onValue) {
    delayedStarts += 1;
    onValue({ amount: delayedStarts });
    return () => new Promise<void>((resolve) => delayedStopResolvers.push(resolve));
  },
});
const delayedFirst = delayed.get<Summary>("spending.summary", { month: "2026-11" });
const delayedUnsubscribe = delayedFirst.subscribe(() => {});
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(delayedStarts, 1);
delayedUnsubscribe();
const delayedSecond = delayed.get<Summary>("spending.summary", { month: "2026-11" });
assert.equal(delayedSecond, delayedFirst, "a key remains shared while its prior transport stops");
const delayedSecondValues: ViewState<Summary>[] = [];
const delayedSecondUnsubscribe = delayedSecond.subscribe((value) => delayedSecondValues.push(value));
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(delayedStarts, 1, "resubscribe must wait for the prior stop");
assert.deepEqual(delayedSecondValues.at(-1), { status: "loading" }, "resubscribe resets loading while waiting");
await resolveDelayedStop();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(delayedStarts, 2);
delayedSecondUnsubscribe();
await resolveDelayedStop();
await new Promise((resolve) => setTimeout(resolve, 0));

const delayedThird = delayed.get<Summary>("spending.summary", { month: "2026-11" });
assert.equal(delayedThird, delayedFirst, "canonical store identity survives completed teardown");
const delayedThirdValues: ViewState<Summary>[] = [];
const delayedThirdUnsubscribe = delayedThird.subscribe((value) => delayedThirdValues.push(value));
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(delayedStarts, 3, "a stale store reference must reuse the keyed transport");
assert.deepEqual(delayedThirdValues.at(-1), { status: "ready", data: { amount: 3 } });
delayedThirdUnsubscribe();
await resolveDelayedStop();
await new Promise((resolve) => setTimeout(resolve, 0));

// restart re-reads a key that other consumers keep subscribed: without it the
// store would only replay its cached value.
let restartStarts = 0;
let restartStops = 0;
const restartPushes: Array<(value: Summary) => void> = [];
const restartable = createViewStores({
  async subscribe(_view, _params, onValue) {
    restartStarts += 1;
    const push = onValue as (value: Summary) => void;
    restartPushes.push(push);
    push({ amount: restartStarts * 100 });
    return async () => { restartStops += 1; };
  },
});
const holder = restartable.get<Summary>("financial.overview.current", {});
const holderValues: ViewState<Summary>[] = [];
const stopHolder = holder.subscribe((value) => holderValues.push(value));
await new Promise((resolve) => setTimeout(resolve, 0));
const readerValues: ViewState<Summary>[] = [];
const stopReader = holder.subscribe((value) => readerValues.push(value));
assert.deepEqual(readerValues, [{ status: "ready", data: { amount: 100 } }], "a second consumer replays the cached value");
restartable.restart("financial.overview.current", {});
assert.deepEqual(readerValues.at(-1), { status: "loading" }, "restart exposes loading synchronously");
assert.deepEqual(holderValues.at(-1), { status: "loading" });
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(restartStarts, 2, "restart subscribes the transport again while consumers remain");
assert.equal(restartStops, 1, "restart stops the previous transport subscription");
assert.deepEqual(readerValues.at(-1), { status: "ready", data: { amount: 200 } });
assert.deepEqual(holderValues.at(-1), { status: "ready", data: { amount: 200 } });
restartPushes[0]?.({ amount: -1 });
assert.deepEqual(readerValues.at(-1), { status: "ready", data: { amount: 200 } }, "the replaced generation's late value is dropped");
stopReader();
stopHolder();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(restartStops, 2);
restartable.restart("financial.overview.current", {});
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(restartStarts, 2, "restart without subscribers starts nothing");
