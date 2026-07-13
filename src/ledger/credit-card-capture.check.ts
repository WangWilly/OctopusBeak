import assert from "node:assert/strict";
import {
  assignOccurrenceIndexes,
  captureCardRowCounts,
  fullCreditCardCaptureMetadataSchema,
} from "./credit-card-capture.ts";

const rows = [
  { cardKey: "8397", contentKey: "coffee", sourceRowIndex: 4 },
  { cardKey: "8397", contentKey: "coffee", sourceRowIndex: 9 },
];

assert.deepEqual(
  assignOccurrenceIndexes(rows).map((row) => row.occurrenceIndex),
  [0, 1],
);
assert.deepEqual(captureCardRowCounts(["8397", "9170"], rows), {
  "8397": 2,
  "9170": 0,
});
assert.equal(
  fullCreditCardCaptureMetadataSchema.parse({
    snapshotMode: "full",
    captureId: "9d000000-0000-4000-8000-000000000001",
    capturedAt: "2026-07-13T01:02:03.000Z",
    captureKinds: ["billed", "unbilled"],
    cardRowCounts: { "8397": 0 },
    completenessEvidence: { bank: "esun" },
  }).snapshotMode,
  "full",
);
