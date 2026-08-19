import assert from "node:assert/strict";
import {
  CTBC_DOMESTIC_DEPOSIT_CONTRACT,
  CTBC_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
  preflightCtbcDomesticDeposit,
} from "./ctbc-domestic-deposit.ts";

assert.equal(
  CTBC_DOMESTIC_DEPOSIT_CONTRACT.authority,
  "ctbc/domestic-deposit/preflight-v1",
);
const positive = preflightCtbcDomesticDeposit(
  CTBC_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
);
assert.equal(positive.structuralStatus, "observed");
assert.equal(positive.status, "blocked");

const zero = preflightCtbcDomesticDeposit({
  ...CTBC_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
  records: [],
  transport: {
    noDataCode: "9201",
    pageNumbers: [1],
    terminalPageObserved: true,
  },
});
assert.equal(zero.zeroResultEvidence, "provider-explicit");
assert.ok(
  zero.diagnostics.some(
    (item) => item.code === "completeness-semantics-unproven",
  ),
);

const invalid = preflightCtbcDomesticDeposit({
  ...CTBC_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
  accountIdentity: "",
  records: [{ values: Array(8).fill(""), sourceDirection: "deposit" }],
  transport: {
    reportedCount: 2,
    pageNumbers: [2, 2],
    terminalPageObserved: false,
  },
});
for (const code of [
  "account-identity-missing",
  "date-evidence-missing",
  "amount-evidence-missing",
  "reported-count-mismatch",
  "page-number-duplicate",
  "page-number-gap",
  "pagination-terminal-missing",
  "unsupported-source-semantics",
] as const) {
  assert.ok(
    invalid.diagnostics.some((item) => item.code === code),
    code,
  );
}
