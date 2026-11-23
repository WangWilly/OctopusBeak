import assert from "node:assert/strict";
import test from "node:test";
import { credentialsUnreadable, signInDataGuidance } from "./credentials-unreadable.ts";

test("only a read failure means the stored sign-in details cannot be read", () => {
  assert.equal(credentialsUnreadable(undefined), false);
  assert.equal(credentialsUnreadable({ A: "ready", B: "missing", C: "loading" }), false);
  assert.equal(credentialsUnreadable({ A: "read_failed", B: "read_failed" }), true);
});

test("Settings hints only at undecodable details and warns only when a clear needs a reset", () => {
  assert.deepEqual(signInDataGuidance(null), { unreadableHint: false, resetWarning: false });
  assert.deepEqual(
    signInDataGuidance({ credentials: "readable", clearRequiresFinancialDataDeletion: false }),
    { unreadableHint: false, resetWarning: false },
  );
  assert.deepEqual(
    signInDataGuidance({ credentials: "readable", clearRequiresFinancialDataDeletion: true }),
    { unreadableHint: false, resetWarning: true },
    "readable details without a Card identity secret still cost a reset",
  );
  assert.deepEqual(
    signInDataGuidance({ credentials: "undecodable", clearRequiresFinancialDataDeletion: true }),
    { unreadableHint: true, resetWarning: true },
  );
  assert.deepEqual(
    signInDataGuidance({ credentials: "unreachable", clearRequiresFinancialDataDeletion: false }),
    { unreadableHint: false, resetWarning: false },
    "a clear that will fail is not offered as the recovery",
  );
});
