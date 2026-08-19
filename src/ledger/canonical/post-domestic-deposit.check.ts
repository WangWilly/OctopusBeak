import assert from "node:assert/strict";
import {
  POST_DOMESTIC_DEPOSIT_CONTRACT,
  POST_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
  preflightPostDomesticDeposit,
} from "./post-domestic-deposit.ts";

assert.equal(
  POST_DOMESTIC_DEPOSIT_CONTRACT.authority,
  "post/domestic-deposit/preflight-v1",
);
const positive = preflightPostDomesticDeposit(
  POST_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
);
assert.equal(positive.structuralStatus, "observed");
assert.equal(positive.status, "blocked");
assert.ok(
  positive.diagnostics.some(
    (item) => item.code === "posting-semantics-unproven",
  ),
);

// ITEM absence is normalized to [] by the workflow but carries no explicit provider authority.
const empty = preflightPostDomesticDeposit({
  ...POST_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
  records: [],
});
assert.equal(empty.zeroResultEvidence, "unproven");
assert.ok(
  empty.diagnostics.some((item) => item.code === "empty-scope-unproven"),
);

const invalid = preflightPostDomesticDeposit({
  ...POST_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
  records: [{ values: ["2026/01/02"], sourceOccurrenceId: "UNPROVEN" }],
  transport: { reportedCount: -1 },
});
for (const code of ["row-width-invalid", "reported-count-invalid"] as const) {
  assert.ok(
    invalid.diagnostics.some((item) => item.code === code),
    code,
  );
}
