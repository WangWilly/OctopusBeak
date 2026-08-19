import assert from "node:assert/strict";
import {
  HNCB_DOMESTIC_DEPOSIT_CONTRACT,
  HNCB_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
  preflightHncbDomesticDeposit,
} from "./hncb-domestic-deposit.ts";

assert.equal(
  HNCB_DOMESTIC_DEPOSIT_CONTRACT.authority,
  "hncb/domestic-deposit/preflight-v1",
);
const positive = preflightHncbDomesticDeposit(
  HNCB_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
);
assert.equal(positive.structuralStatus, "observed");
assert.equal(positive.status, "blocked");

const zero = preflightHncbDomesticDeposit({
  ...HNCB_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
  records: [],
  transport: { noDataMessage: "查無資料" },
});
assert.equal(zero.zeroResultEvidence, "provider-explicit");
assert.equal(zero.structuralStatus, "observed");
assert.ok(
  zero.diagnostics.some((item) => item.code === "authority-semantics-unproven"),
);

const absenceWithoutProviderSignal = preflightHncbDomesticDeposit({
  ...HNCB_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
  records: [],
});
assert.equal(absenceWithoutProviderSignal.zeroResultEvidence, "unproven");
assert.ok(
  absenceWithoutProviderSignal.diagnostics.some(
    (item) => item.code === "empty-scope-unproven",
  ),
);
const invalid = preflightHncbDomesticDeposit({
  ...HNCB_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
  records: [{ values: Array(10).fill(""), sourcePostingStatus: "posted" }],
});
assert.ok(
  invalid.diagnostics.some((item) => item.code === "row-width-invalid"),
);
