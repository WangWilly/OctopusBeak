import assert from "node:assert/strict";
import test from "node:test";
import { stableFinancialErrorCode } from "./financial-error.ts";

test("financial error classification never exposes an error payload", () => {
  const sensitive = new Error(
    "SQL /Users/example/ledger.sqlite identity=acct-123 payload=secret",
  );
  assert.equal(stableFinancialErrorCode(sensitive), "unknown");
  assert.equal(
    JSON.stringify({ code: stableFinancialErrorCode(sensitive) }).includes("ledger.sqlite"),
    false,
  );
  assert.equal(
    stableFinancialErrorCode({ code: "spending-pair-stale", message: "private" }),
    "spending-pair-stale",
  );
  assert.equal(stableFinancialErrorCode(new Error("idempotency-key-conflict")), "idempotency-key-conflict");
  assert.equal(stableFinancialErrorCode(new Error("financial-section-knowledge-point-mismatch")), "financial-section-knowledge-point-mismatch");
});

