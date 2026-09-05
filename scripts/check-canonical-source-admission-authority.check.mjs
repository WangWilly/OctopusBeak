import assert from "node:assert/strict";
import test from "node:test";
import {
  checkCanonicalSourceAdmissionAuthority,
  sourceAdmissionAuthorityViolations,
} from "./check-canonical-source-admission-authority.mjs";

test("canonical source persistence stays behind Source Capture Admission", async () => {
  await checkCanonicalSourceAdmissionAuthority();
});

test("source admission authority rejects legacy and unauthorized internal callers", () => {
  assert.deepEqual(
    sourceAdmissionAuthorityViolations([
      {
        path: "src/ledger/canonical/provider.ts",
        source: [
          "commitCanonicalSourceEvidence(store, evidence);",
          "withCanonicalSourceCaptureAdmissionTransaction(store, operation);",
          "withCanonicalSourceCaptureAdmissionExistingTransaction(store, operation);",
          "INSERT INTO source_records(source_record_id) VALUES (?);",
        ].join("\n"),
      },
      {
        path: "src/ledger/canonical/provider.check.ts",
        source: "admitCanonicalSourceEvidence(evidence);",
      },
    ]),
    [
      {
        path: "src/ledger/canonical/provider.ts",
        line: 2,
        identifier: "withCanonicalSourceCaptureAdmissionTransaction",
      },
      {
        path: "src/ledger/canonical/provider.ts",
        line: 3,
        identifier: "withCanonicalSourceCaptureAdmissionExistingTransaction",
      },
      {
        path: "src/ledger/canonical/provider.ts",
        line: 4,
        identifier: "source_records-write",
      },
      {
        path: "src/ledger/canonical/provider.check.ts",
        line: 1,
        identifier: "admitCanonicalSourceEvidence",
      },
    ],
  );
});
