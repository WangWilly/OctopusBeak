import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { assignOccurrenceSlots } from "./occurrence-groups.ts";

const token = (value: string): string =>
  `sha256:${createHash("sha256").update(value).digest("base64url")}`;
const groupToken = token("same-financial-fingerprint");
const accountBucket = token("account-product-source-bucket");

const assign = (rows: readonly { id: string; date: string; fingerprint: string; scope: string }[]) =>
  assignOccurrenceSlots({
    rows,
    complete: true,
    scopeKey: (row) => row.scope,
    fingerprint: (row) => row.fingerprint,
    partitionDate: (row) => row.date,
  });

const original = assign([
  { id: "repeat-1", date: "2026-09-01", fingerprint: groupToken, scope: accountBucket },
  { id: "repeat-2", date: "2026-09-01", fingerprint: groupToken, scope: accountBucket },
]);
const shifted = assign([
  { id: "unrelated", date: "2026-09-01", fingerprint: token("different"), scope: accountBucket },
  { id: "repeat-1", date: "2026-09-01", fingerprint: groupToken, scope: accountBucket },
  { id: "repeat-2", date: "2026-09-01", fingerprint: groupToken, scope: accountBucket },
]);
assert.deepEqual(original.map(({ group }) => group.ordinal), [1, 2]);
assert.deepEqual(
  shifted.slice(1).map(({ occurrenceKey, group }) => [occurrenceKey, group.ordinal]),
  original.map(({ occurrenceKey, group }) => [occurrenceKey, group.ordinal]),
  "unrelated rows do not renumber an identical transaction group",
);
assert.notEqual(
  assign([{ id: "other-day", date: "2026-09-02", fingerprint: groupToken, scope: accountBucket }])[0]?.occurrenceKey,
  original[0]?.occurrenceKey,
  "the default occurrence key includes the transaction date",
);
assert.notEqual(
  assign([{ id: "other-bucket", date: "2026-09-01", fingerprint: groupToken, scope: token("another-bucket") }])[0]?.occurrenceKey,
  original[0]?.occurrenceKey,
  "the default occurrence key includes its stable source bucket",
);

const customized = assignOccurrenceSlots({
  rows: [{ id: "row" }],
  complete: true,
  scopeKey: () => accountBucket,
  fingerprint: () => groupToken,
  partitionDate: () => "2026-09-01",
  key: (_row, ordinal) => token(`provider-contract:${ordinal}`),
  collisionKey: () => token("stable-financial-collision-fence"),
});
assert.equal(customized[0]?.group.ordinal, 1);
assert.equal(customized[0]?.occurrenceKey, token("provider-contract:1"));
assert.equal(customized[0]?.collisionKey, token("stable-financial-collision-fence"));

assert.throws(
  () => assignOccurrenceSlots({
    rows: [{ id: "row" }],
    complete: false,
    scopeKey: () => accountBucket,
    fingerprint: () => groupToken,
    partitionDate: () => "2026-09-01",
  }),
  /complete source capture/u,
);
assert.throws(
  () => assignOccurrenceSlots({
    rows: [{ id: "row" }],
    complete: true,
    scopeKey: () => accountBucket,
    fingerprint: () => "raw-fingerprint",
    partitionDate: () => "2026-09-01",
  }),
  /opaque source token/u,
);
assert.throws(
  () => assignOccurrenceSlots({
    rows: [{ id: "row" }],
    complete: true,
    scopeKey: () => accountBucket,
    fingerprint: () => groupToken,
    partitionDate: () => "2026-02-30",
  }),
  /valid YYYY-MM-DD/u,
);
