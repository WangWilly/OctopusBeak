import assert from "node:assert/strict";
import { get } from "svelte/store";
import { createFinancialPageLiveStores } from "./page-live-stores.ts";

let stopCount = 0;
let emit!: (rows: unknown[]) => void;
const stores = createFinancialPageLiveStores({
  async subscribe(_view, _params, onRows) {
    emit = onRows;
    onRows([{ availability: "empty", accounts: [] }]);
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
emit([{ availability: "available", accounts: [{ id: "account-1" }] }]);
assert.deepEqual(get(store), {
  status: "ready",
  data: { availability: "available", accounts: [{ id: "account-1" }] },
});
stop();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(stopCount, 1);

const malformed = createFinancialPageLiveStores({
  async subscribe(_view, _params, onRows) {
    onRows([]);
    return async () => {};
  },
});
const malformedValues: unknown[] = [];
const stopMalformed = malformed.spending().subscribe((value) => malformedValues.push(value));
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(malformedValues.at(-1), { status: "error", code: "subscription-failed" });
stopMalformed();
