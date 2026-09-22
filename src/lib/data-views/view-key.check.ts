import assert from "node:assert/strict";
import { viewSubscriptionKey } from "./view-key.ts";

assert.equal(
  viewSubscriptionKey("spending.records", { month: "2026-09", filters: { currency: "TWD", account: "A" } }),
  viewSubscriptionKey("spending.records", { filters: { account: "A", currency: "TWD" }, month: "2026-09" }),
);
assert.notEqual(
  viewSubscriptionKey("spending.records", { month: "2026-09" }),
  viewSubscriptionKey("spending.records", { month: "2026-10" }),
);
