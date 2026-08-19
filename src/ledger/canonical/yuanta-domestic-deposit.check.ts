import assert from "node:assert/strict";
import {
  YUANTA_DOMESTIC_DEPOSIT_CONTRACT,
  YUANTA_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
  preflightYuantaDomesticDeposit,
} from "./yuanta-domestic-deposit.ts";

assert.equal(
  YUANTA_DOMESTIC_DEPOSIT_CONTRACT.authority,
  "yuanta/domestic-deposit/preflight-v1",
);
const positive = preflightYuantaDomesticDeposit(
  YUANTA_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
);
assert.equal(positive.structuralStatus, "observed");
assert.equal(positive.status, "blocked");
assert.ok(
  positive.diagnostics.some(
    (item) => item.code === "occurrence-identity-unproven",
  ),
);

// Repeated downloads and backfills cannot be merged without a source occurrence key.
const repeated = preflightYuantaDomesticDeposit({
  ...YUANTA_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
  records: [
    ...YUANTA_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1.records,
    ...YUANTA_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1.records,
  ],
});
assert.equal(repeated.status, "blocked");
assert.ok(
  repeated.diagnostics.some(
    (item) => item.code === "occurrence-identity-unproven",
  ),
);

const invalid = preflightYuantaDomesticDeposit({
  ...YUANTA_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
  scope: { startDate: "2026/04/01", endDate: "2026/03/01" },
  records: [{ values: Array(11).fill(""), sourceDirection: "credit" }],
});
for (const code of [
  "scope-invalid",
  "date-evidence-missing",
  "amount-evidence-missing",
  "unsupported-source-semantics",
] as const) {
  assert.ok(
    invalid.diagnostics.some((item) => item.code === code),
    code,
  );
}
assert.equal(
  preflightYuantaDomesticDeposit({
    ...YUANTA_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
    records: [],
  }).zeroResultEvidence,
  "unproven",
);
