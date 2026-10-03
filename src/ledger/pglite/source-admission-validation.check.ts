import assert from "node:assert/strict";
import test from "node:test";
import {
  validatePGliteCanonicalFinancialFact,
  validatePGliteCanonicalSourceEvidence,
  type PGliteCanonicalSourceEvidence,
} from "./source-admission-validation.ts";

const token = (letter: string): string => `sha256:${letter.repeat(64)}`;

function investmentFact(currency: string, postingRuleVersion: string) {
  return {
    sourceOccurrenceKey: `sha256:${"a".repeat(64)}`,
    sourceSequence: "trade-1",
    amount: { coefficient: "1250", scale: 2 },
    currency,
    direction: "outflow" as const,
    postingStatus: "posted" as const,
    postingOrigin: "provider_booked_history",
    postingBasis: "statement-posted-history",
    postingRuleVersion,
    description: "trade",
    economicStatus: "normal" as const,
    administrativeState: "active" as const,
    semanticRuleVersion: postingRuleVersion,
    effectiveOn: "2026-09-22",
    transactionDateTimeLocal: "2026-09-22T00:00:00",
    timeZone: "Asia/Taipei" as const,
    timePrecision: "date" as const,
    timeOrigin: "defaulted_local_midnight" as const,
    effectiveTimeBasis: "source-reported" as const,
    effectiveTimeRuleVersion: postingRuleVersion,
    utcInstantUtcUs: Date.parse("2026-09-21T16:00:00.000Z") * 1000,
  };
}

test("MAX USDT trade cash is admitted under its controlled investment route", () => {
  assert.doesNotThrow(() => validatePGliteCanonicalFinancialFact(
    investmentFact("USDT", "maicoin/investment/canonical-v1"),
    "maicoin/investment/canonical-v1",
    "maicoin/investment/canonical-v1",
  ));
  assert.throws(() => validatePGliteCanonicalFinancialFact(
    investmentFact("USDT", "yuanta-fund/investment/canonical-v1"),
    "yuanta-fund/investment/canonical-v1",
    "yuanta-fund/investment/canonical-v1",
  ));
  assert.throws(() => validatePGliteCanonicalFinancialFact(
    investmentFact("USDT", "maicoin/investment/canonical-v1"),
    "yuanta-fund/investment/canonical-v1",
    "maicoin/investment/canonical-v1",
  ));
  assert.throws(() => validatePGliteCanonicalFinancialFact(
    {
      ...investmentFact("TWD", "maicoin/investment/canonical-v1"),
      semanticRuleVersion: "yuanta-fund/investment/canonical-v1",
    },
    "maicoin/investment/canonical-v1",
    "maicoin/investment/canonical-v1",
  ), /rule combination is not admitted/u);
});

function sourceEvidence(overrides: Partial<PGliteCanonicalSourceEvidence> = {}): PGliteCanonicalSourceEvidence {
  const routeKey = "cathay/domestic-deposit/v1";
  return {
    captureId: "occurrence-group-validation",
    integrationNamespace: "cathay",
    sourceConnectionKey: token("a"),
    identityEpoch: token("b"),
    stream: "domestic-deposit",
    recordKind: "source-record",
    routeKey,
    contractVersion: "v1",
    subjectDigest: token("c"),
    observedAt: "2026-09-30T00:00:00.000Z",
    scope: {
      startDate: "20260101",
      endDate: "20260131",
      kind: "bounded-range",
      completeness: "complete-range",
      completenessBasis: "full-bounded-range",
      ruleVersion: "cathay/domestic-deposit/v1",
      sourceAccountKey: "source-account",
    },
    pages: [{ pageOrdinal: 0, responseCode: "200", rowCount: 0, terminal: true, metadata: {} }],
    records: [],
    ...overrides,
  };
}

test("occurrence group coverage follows the registered source route mode", () => {
  assert.doesNotThrow(() => validatePGliteCanonicalSourceEvidence(sourceEvidence()));
  assert.throws(
    () => validatePGliteCanonicalSourceEvidence(sourceEvidence({
      routeKey: "esun/credit-card/human-attested-v3",
      integrationNamespace: "esun",
      stream: "credit-card",
      contractVersion: "esun/credit-card/human-attested-v3",
    })),
    /not registered/u,
  );

  const required = sourceEvidence({
    integrationNamespace: "fubon",
    routeKey: "fubon/domestic-deposit/human-attested-v1",
    contractVersion: "human-attested-v1",
    stream: "domestic-deposit",
    scope: {
      ...sourceEvidence().scope,
      ruleVersion: "fubon/domestic-deposit/human-attested-v1",
    },
  });
  assert.throws(
    () => validatePGliteCanonicalSourceEvidence(required),
    /requires complete occurrence group coverage/u,
  );

  const coveredRequired = {
    ...required,
    occurrenceGroupCoverage: [{
      scopeKey: token("d"),
      startDate: "2026-01-01",
      endDate: "2026-01-31",
      contractVersion: "human-attested-v1",
    }],
  };
  assert.doesNotThrow(() => validatePGliteCanonicalSourceEvidence(coveredRequired));

  const unsupported = sourceEvidence({
    occurrenceGroupCoverage: coveredRequired.occurrenceGroupCoverage,
  });
  assert.throws(
    () => validatePGliteCanonicalSourceEvidence(unsupported),
    /does not admit occurrence group evidence/u,
  );
});

test("investment transaction routes require history groups but admit balance-only snapshots", () => {
  const yuantaFund = sourceEvidence({
    integrationNamespace: "yuanta-fund",
    routeKey: "yuanta-fund/investment/canonical-v1",
    contractVersion: "yuanta-fund/investment/canonical-v1",
    stream: "investment",
    recordKind: "investment-transactions",
    scope: {
      ...sourceEvidence().scope,
      ruleVersion: "yuanta-fund/investment/canonical-v1",
    },
  });
  assert.throws(
    () => validatePGliteCanonicalSourceEvidence(yuantaFund),
    /requires complete occurrence group coverage/u,
  );

  const holdingSnapshot = {
    ...yuantaFund,
    scope: {
      ...yuantaFund.scope,
      startDate: "20260110",
      endDate: "20260110",
      kind: "point-in-time" as const,
      completeness: "single-page" as const,
    },
  };
  assert.doesNotThrow(() => validatePGliteCanonicalSourceEvidence(holdingSnapshot));

  assert.throws(
    () => validatePGliteCanonicalSourceEvidence({
      ...holdingSnapshot,
      occurrenceGroupCoverage: [{
        scopeKey: token("d"),
        startDate: "2026-01-10",
        endDate: "2026-01-10",
        contractVersion: "yuanta-fund/investment/canonical-v1",
      }],
    }),
    /requires a complete bounded source range/u,
  );
});

test("grouped source records require exact complete coverage and contiguous slots", () => {
  const scopeKey = token("d");
  const fingerprint = token("e");
  const validRecord = (ordinal: number, key: string) => ({
    occurrenceKey: token(key),
    collisionKey: token(key.toUpperCase()),
    providerKey: token("f"),
    contentHash: token("g"),
    compact: { amount: { coefficient: "100", scale: 0 } },
    occurrenceGroup: {
      scopeKey,
      fingerprint,
      partitionDate: "2026-01-10",
      ordinal,
    },
  });
  const base = sourceEvidence({
    integrationNamespace: "fubon",
    routeKey: "fubon/domestic-deposit/human-attested-v1",
    contractVersion: "human-attested-v1",
    scope: {
      ...sourceEvidence().scope,
      ruleVersion: "fubon/domestic-deposit/human-attested-v1",
    },
    occurrenceGroupCoverage: [{
      scopeKey,
      startDate: "2026-01-01",
      endDate: "2026-01-31",
      contractVersion: "human-attested-v1",
    }],
    pages: [{ pageOrdinal: 0, responseCode: "200", rowCount: 2, terminal: true, metadata: {} }],
    records: [validRecord(1, "h"), validRecord(2, "i")],
  });
  assert.doesNotThrow(() => validatePGliteCanonicalSourceEvidence(base));
  assert.throws(
    () => validatePGliteCanonicalSourceEvidence({
      ...base,
      records: [validRecord(1, "h"), validRecord(3, "i")],
    }),
    /contiguous from one/u,
  );
  assert.throws(
    () => validatePGliteCanonicalSourceEvidence({
      ...base,
      occurrenceGroupCoverage: [{
        scopeKey,
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        contractVersion: "other-contract",
      }],
    }),
    /must match the source contract/u,
  );
});

test("card queried-bucket routes require one unique complete inventory per scope", () => {
  const scopeKey = token("d");
  const routeKey = "fubon/credit-card/human-attested-v2";
  const base = sourceEvidence({
    integrationNamespace: "fubon",
    stream: "credit-card",
    recordKind: "fubon-credit-card-transaction",
    routeKey,
    contractVersion: routeKey,
    scope: {
      ...sourceEvidence().scope,
      startDate: "20260101",
      endDate: "20261231",
    },
  });
  const coverage = {
    scopeKey,
    startDate: "2026-01-01",
    endDate: "2026-01-31",
    contractVersion: routeKey,
    bucketKeys: ["statement:2026/01", "unbilled"],
  };
  assert.doesNotThrow(() => validatePGliteCanonicalSourceEvidence({
    ...base,
    occurrenceGroupCoverage: [coverage],
  }));
  assert.throws(
    () => validatePGliteCanonicalSourceEvidence({
      ...base,
      occurrenceGroupCoverage: [{
        scopeKey,
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        contractVersion: routeKey,
      }],
    }),
    /complete queried-bucket inventory/u,
  );
  assert.throws(
    () => validatePGliteCanonicalSourceEvidence({
      ...base,
      occurrenceGroupCoverage: [coverage, {
        ...coverage,
        startDate: "2026-02-01",
        endDate: "2026-02-28",
      }],
    }),
    /one complete inventory per scope/u,
  );
  assert.throws(
    () => validatePGliteCanonicalSourceEvidence({
      ...base,
      occurrenceGroupCoverage: [{
        ...coverage,
        bucketKeys: ["unbilled", "unbilled"],
      }],
    }),
    /duplicate keys/u,
  );
});


test("required-group routes admit point-in-time observations but reject orphan bucket provenance", () => {
  const record = {
    occurrenceKey: token("h"), collisionKey: token("i"), providerKey: token("j"),
    contentHash: token("k"), compact: { description: "synthetic observation" },
  };
  const base = sourceEvidence({
    integrationNamespace: "fubon",
    routeKey: "fubon/domestic-deposit/human-attested-v1",
    contractVersion: "human-attested-v1",
    scope: {
      ...sourceEvidence().scope,
      startDate: "20260110",
      endDate: "20260110",
      kind: "point-in-time",
      completeness: "single-page",
      ruleVersion: "fubon/domestic-deposit/human-attested-v1",
    },
    pages: [{ pageOrdinal: 0, responseCode: "200", rowCount: 1, terminal: true, metadata: {} }],
    records: [record],
  });
  assert.doesNotThrow(() => validatePGliteCanonicalSourceEvidence(base));
  assert.throws(() => validatePGliteCanonicalSourceEvidence({
    ...base,
    records: [{ ...record, occurrenceGroupBucketKey: "unbilled" }],
  }), /Occurrence group records require complete coverage evidence/u);
  assert.throws(() => validatePGliteCanonicalSourceEvidence({
    ...base,
    occurrenceGroupCoverage: [{
      scopeKey: token("d"), startDate: "2026-01-01", endDate: "2026-01-31", contractVersion: "human-attested-v1",
    }],
  }), /Occurrence group coverage requires a complete bounded source range/u);
});
