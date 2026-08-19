import assert from "node:assert/strict";
import {
  SINOPAC_DOMESTIC_DEPOSIT_CONTRACT,
  SINOPAC_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
  preflightSinopacDomesticDeposit,
} from "./sinopac-domestic-deposit.ts";

assert.equal(
  SINOPAC_DOMESTIC_DEPOSIT_CONTRACT.authority,
  "sinopac/domestic-deposit/preflight-v1",
);
const positive = preflightSinopacDomesticDeposit(
  SINOPAC_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
);
assert.equal(positive.structuralStatus, "observed");
assert.equal(positive.status, "blocked");

const zero = preflightSinopacDomesticDeposit({
  ...SINOPAC_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
  records: [],
  transport: {
    reportedCount: 0,
    noDataStatus: "FAIL",
    noDataMessage: "查無資料",
  },
});
assert.equal(zero.zeroResultEvidence, "provider-explicit");
assert.equal(zero.structuralStatus, "observed");

const invalid = preflightSinopacDomesticDeposit({
  ...SINOPAC_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
  records: [{ values: Array(9).fill(""), sourcePostingStatus: "posted" }],
  transport: { reportedCount: 2 },
});
for (const code of [
  "date-evidence-missing",
  "amount-evidence-missing",
  "reported-count-mismatch",
  "unsupported-source-semantics",
] as const) {
  assert.ok(
    invalid.diagnostics.some((item) => item.code === code),
    code,
  );
}
assert.ok(
  invalid.diagnostics.some(
    (item) => item.code === "occurrence-identity-unproven",
  ),
);
