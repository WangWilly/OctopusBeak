import assert from "node:assert/strict";
import test from "node:test";
import {
  ADVERTISED_LOAN_SOURCE_IDS,
  ADVERTISED_LOAN_READINESS,
  LOAN_CONTRACT_FIXTURES,
  admitCanonicalLoanCapture,
  evaluateAdvertisedLoanReadiness,
  isAdvertisedLoanEntryReleaseReady,
} from "./advertised-loan-readiness.ts";

test("advertised loan contracts cover exactly Fubon and Yuanta", () => {
  assert.deepEqual(ADVERTISED_LOAN_SOURCE_IDS, ["fubon", "yuanta"]);

  for (const sourceId of ADVERTISED_LOAN_SOURCE_IDS) {
    const fixture = LOAN_CONTRACT_FIXTURES[sourceId];
    const admitted = admitCanonicalLoanCapture(fixture);

    assert.match(admitted.contractVersion, /^loan\/canonical\/v[12]\./);
    assert.equal(admitted.identity.accountType, "loan");
    assert.equal(admitted.scope.completeness, "complete-range");
    assert.equal(admitted.semantics.status, "posted");
    assert.deepEqual(
      admitted.records.map((record) => record.direction),
      ["outflow", "inflow"],
    );
    assert.deepEqual(admitted.records[0]?.amount, {
      coefficient: "100000",
      scale: 2,
    });
    assert.deepEqual(admitted.records[1]?.amount, {
      coefficient: "12500",
      scale: 2,
    });
    assert.equal(admitted.balanceObservations.length, 1);
    assert.equal(
      admitted.balanceObservations[0]?.effectiveTimeBasis,
      "source-reported",
    );
    assert.notEqual(
      admitted.balanceObservations[0]?.effectiveAt,
      admitted.observedAt,
    );
  }

  const readiness = evaluateAdvertisedLoanReadiness();
  assert.equal(readiness.advertisedSourceCount, 2);
  assert.deepEqual(readiness.unreadySourceIds, []);
  assert.equal(readiness.entries.every((entry) => entry.contractComplete), true);
  assert.equal(
    readiness.entries.find((entry) => entry.sourceId === "fubon")?.liveValidation,
    "complete",
  );
  assert.equal(
    readiness.entries.find((entry) => entry.sourceId === "yuanta")?.liveValidation,
    "pending",
  );
});

test("loan admission fails closed when balance effective time is substituted", () => {
  const fixture = LOAN_CONTRACT_FIXTURES.fubon;
  assert.throws(
    () =>
      admitCanonicalLoanCapture({
        ...fixture,
        balanceObservations: fixture.balanceObservations.map((observation) => ({
          ...observation,
          effectiveAt: fixture.observedAt,
        })),
      }),
    /effective time|source-reported|collection/i,
  );
});

test("readiness stays blocked while either live attestation is pending", () => {
  const pendingEntries = ADVERTISED_LOAN_READINESS.map((entry) => ({
    ...entry,
    fixtureEvidence: "canonical-versioned-synthetic" as const,
    liveValidation: "pending" as const,
    blockers: ["live-validation-pending"] as const,
  }));
  const readiness = evaluateAdvertisedLoanReadiness(pendingEntries);
  assert.equal(readiness.status, "blocked");
  assert.deepEqual(readiness.pendingLiveValidationSourceIds, ["fubon", "yuanta"]);
});

test("pending live validation cannot pass readiness without an explicit blocker", () => {
  const pendingEntries = ADVERTISED_LOAN_READINESS.map((entry) => ({
    ...entry,
    liveValidation: "pending" as const,
    blockers: [] as const,
  }));
  assert.equal(isAdvertisedLoanEntryReleaseReady(pendingEntries[0]!), false);
  const readiness = evaluateAdvertisedLoanReadiness(pendingEntries);
  assert.equal(readiness.status, "blocked");
  assert.equal(readiness.releaseReady, false);
  assert.deepEqual(readiness.pendingLiveValidationSourceIds, ["fubon", "yuanta"]);
});

test("an empty advertised loan inventory cannot pass the release gate", () => {
  const readiness = evaluateAdvertisedLoanReadiness([]);
  assert.equal(readiness.status, "blocked");
  assert.equal(readiness.releaseReady, false);
  assert.equal(readiness.advertisedSourceCount, 0);
});

test("loan admission fails closed for inferred direction, incomplete range, and unsupported facts", () => {
  const fixture = structuredClone(LOAN_CONTRACT_FIXTURES.yuanta);
  assert.throws(
    () =>
      admitCanonicalLoanCapture({
        ...fixture,
        records: fixture.records.map((record, index) =>
          index === 0 ? { ...record, direction: "inflow" } : record,
        ),
      }),
    /direction/i,
  );
  assert.throws(
    () =>
      admitCanonicalLoanCapture({
        ...fixture,
        scope: { ...fixture.scope, pageCount: 2 },
      }),
    /page count|completeness/i,
  );
  assert.throws(
    () =>
      admitCanonicalLoanCapture({
        ...fixture,
        pages: fixture.pages.map((page) => ({ ...page, terminal: false })),
      }),
    /terminal page|completeness/i,
  );
  assert.throws(
    () =>
      admitCanonicalLoanCapture({
        ...fixture,
        records: fixture.records.map((record, index) =>
          index === 1
            ? { ...record, interest: { coefficient: "1", scale: 2 } }
            : record,
        ),
      }),
    /component evidence|explicit source/i,
  );
  assert.throws(
    () =>
      admitCanonicalLoanCapture({
        ...fixture,
        relations: fixture.relations.map((relation) => ({
          ...relation,
          evidence: { ...relation.evidence, kind: "arithmetic-match" },
        }) as unknown as (typeof fixture.relations)[number]),
      }),
    /explicit source linkage/i,
  );
  assert.throws(
    () =>
      admitCanonicalLoanCapture({
        ...fixture,
        relations: fixture.relations.map((relation) => ({
          ...relation,
          toSourceRecordKey: "sha256:missing-counterpart",
        })),
      }),
    /connect.*loan.*persisted|counterpart/i,
  );
  assert.throws(
    () =>
      admitCanonicalLoanCapture({
        ...fixture,
        records: fixture.records.map((record, index) =>
          index === 0
            ? {
                ...record,
                eventEvidence: {
                  ...record.eventEvidence,
                  sourceCode: "LOAN-PAYMENT",
                },
              }
            : record,
        ),
      }),
    /source code.*event kind.*direction|source contract/i,
  );
  assert.throws(
    () =>
      admitCanonicalLoanCapture({
        ...fixture,
        balanceObservations: fixture.balanceObservations.map((observation) => ({
          ...observation,
          effectiveAt: "2026-01-30T23:59:59+08:00",
        })),
      }),
    /source field evidence/i,
  );
});
