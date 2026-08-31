import assert from "node:assert/strict";
import test from "node:test";
import {
  ADVERTISED_LOAN_SOURCE_IDS,
  LOAN_CONTRACT_FIXTURES,
  admitCanonicalLoanCapture,
  evaluateAdvertisedLoanReadiness,
} from "./advertised-loan-readiness.ts";

test("advertised loan contracts cover exactly Fubon and Yuanta", () => {
  assert.deepEqual(ADVERTISED_LOAN_SOURCE_IDS, ["fubon", "yuanta"]);

  for (const sourceId of ADVERTISED_LOAN_SOURCE_IDS) {
    const fixture = LOAN_CONTRACT_FIXTURES[sourceId];
    const admitted = admitCanonicalLoanCapture(fixture);

    assert.match(admitted.contractVersion, /^loan\/canonical\/v1\./);
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
});
