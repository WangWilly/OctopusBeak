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
