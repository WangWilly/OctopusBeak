import assert from "node:assert/strict";
import { get } from "svelte/store";
import { createFinancialPageLiveStores } from "./page-live-stores.ts";

let stopCount = 0;
let emit!: (value: unknown) => void;
const stores = createFinancialPageLiveStores({
  async subscribe(_view, _params, onValue) {
    emit = onValue;
    onValue({ availability: "empty", accounts: [] });
    return async () => { stopCount += 1; };
  },
});
const store = stores.overview();
const values: unknown[] = [];
const stop = store.subscribe((value) => values.push(value));
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(get(store), {
  status: "ready",
  data: { availability: "empty", accounts: [] },
});
emit({ availability: "available", accounts: [{ id: "account-1" }] });
assert.deepEqual(get(store), {
  status: "ready",
  data: { availability: "available", accounts: [{ id: "account-1" }] },
});
stop();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(stopCount, 1);

let restartReads = 0;
const restartable = createFinancialPageLiveStores({
  async subscribe(_view, _params, onValue) {
    restartReads += 1;
    onValue({ availability: "available", read: restartReads });
    return async () => {};
  },
});
const restartValues: unknown[] = [];
const stopRestartable = restartable.liabilities().subscribe((value) => restartValues.push(value));
await new Promise((resolve) => setTimeout(resolve, 0));
restartable.restart.liabilities();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(restartReads, 2);
assert.deepEqual(restartValues.slice(-2), [
  { status: "loading" },
  { status: "ready", data: { availability: "available", read: 2 } },
]);
stopRestartable();
