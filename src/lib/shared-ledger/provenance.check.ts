import assert from "node:assert/strict";
import test from "node:test";
import { accountProvenance, mergeProvenance, NO_PROVENANCE, originProvenance, withOrigin } from "./provenance.ts";

test("an account row's origin is its preview or manual block, and verified data has none", () => {
  assert.deepEqual(accountProvenance({}), NO_PROVENANCE);
  assert.deepEqual(accountProvenance({
    preview: { sourceId: "synthetic", product: "deposit", lastCollectedAt: "2026-10-05T00:00:00Z", balanceTime: null, transactions: [] },
  }), { preview: true, manual: false });
  assert.deepEqual(accountProvenance({
    manual: { assetId: "a", category: "cash", currency: "TWD", endedOn: null, valuations: [], transactions: [], balance: null },
  }), { preview: false, manual: true });
});

test("origins accumulate and merge without losing one", () => {
  assert.deepEqual(withOrigin(NO_PROVENANCE, null), NO_PROVENANCE);
  assert.deepEqual(withOrigin(originProvenance("preview"), "manual"), { preview: true, manual: true });
  assert.deepEqual(mergeProvenance(), NO_PROVENANCE);
  assert.deepEqual(mergeProvenance(originProvenance("manual"), NO_PROVENANCE, originProvenance("preview")), { preview: true, manual: true });
});
