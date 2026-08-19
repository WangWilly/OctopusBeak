import assert from "node:assert/strict";
import {
  FUBON_DOMESTIC_DEPOSIT_CONTRACT,
  FUBON_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
  preflightFubonDomesticDeposit,
} from "./fubon-domestic-deposit.ts";

assert.equal(
  FUBON_DOMESTIC_DEPOSIT_CONTRACT.authority,
  "fubon/domestic-deposit/preflight-v1",
);
const positive = preflightFubonDomesticDeposit(
  FUBON_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
);
assert.equal(positive.status, "blocked");
assert.equal(positive.structuralStatus, "observed");
for (const code of [
  "account-identity-unproven",
  "occurrence-identity-unproven",
  "direction-semantics-unproven",
  "posting-semantics-unproven",
  "effective-time-semantics-unproven",
  "completeness-semantics-unproven",
  "authority-semantics-unproven",
] as const) {
  assert.ok(
    positive.diagnostics.some((item) => item.code === code),
    code,
  );
}

const invalid = preflightFubonDomesticDeposit({
  ...FUBON_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
  accountIdentity: "",
  records: [{ values: ["bad"], sourceOccurrenceId: "UNPROVEN-ID" }],
  transport: { pageNumbers: [1, 3], terminalPageObserved: false },
});
for (const code of [
  "account-identity-missing",
  "row-width-invalid",
  "page-number-gap",
  "pagination-terminal-missing",
] as const) {
  assert.ok(
    invalid.diagnostics.some((item) => item.code === code),
    code,
  );
}
const empty = preflightFubonDomesticDeposit({
  ...FUBON_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
  records: [],
  transport: { pageNumbers: [1], terminalPageObserved: true },
});
assert.equal(empty.zeroResultEvidence, "unproven");
assert.ok(
  empty.diagnostics.some((item) => item.code === "empty-scope-unproven"),
);
