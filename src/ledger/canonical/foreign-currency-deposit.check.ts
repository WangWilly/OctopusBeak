import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  FOREIGN_CURRENCY_DEPOSIT_CONTRACT_FIXTURES,
  admitForeignCurrencyDepositCapture,
  commitForeignCurrencyDepositCapture,
  commitForeignCurrencyDepositCaptureBatch,
  createForeignCurrencyDepositCapture,
  queryForeignCurrencyDepositCurrent,
  queryForeignCurrencyDepositHistorical,
  queryForeignCurrencyDepositLineage,
} from "./foreign-currency-deposit.ts";
import { FOREIGN_CURRENCY_DEPOSIT_FIXTURE_V1 } from "./foreign-currency-deposit.fixtures.ts";
import { createCanonicalSourceStore } from "./canonical-source-store.ts";

for (const fixture of FOREIGN_CURRENCY_DEPOSIT_CONTRACT_FIXTURES) {
  assert.equal(fixture.fixtureEvidence, "canonical-versioned-synthetic");
  assert.equal(fixture.accountBoundary, "source-proven-account");
  assert.equal(fixture.currencyScope, "row-or-typed-scope");
  assert.equal(fixture.amountDirection, "source-proven-debit-credit");
  assert.equal(fixture.timePrecision, "source-preserved-date-minute-second");
  assert.equal(fixture.completeness, "terminal-complete-range");
}
for (const fixture of FOREIGN_CURRENCY_DEPOSIT_FIXTURE_V1) {
  const admitted = admitForeignCurrencyDepositCapture(fixture);
  assert.equal(admitted.scope.completeness, "complete-range");
  assert.equal(admitted.records[0]!.direction, "inflow");
  assert.equal(admitted.records[0]!.sourceTime.precision, "minute");
}

const base = {
  accountNo: "SOURCE-ACCOUNT-133",
  accountType: "depository",
  sourceConnectionKey: "login-session-133",
  identityEpochKey: "identity-epoch-133",
  captureOccurrenceId: "capture-observation-133-a",
  observedAt: "2026-08-24T12:00:00+08:00",
  startDate: "2026-08-01",
  endDate: "2026-08-24",
  completeness: "complete-range" as const,
  captureCurrencyScope: { kind: "multi-currency" as const },
};

const usdScopedCapture = createForeignCurrencyDepositCapture({
  ...base,
  source: "sinopac",
  captureCurrencyScope: { kind: "currency", currency: "USD" },
  records: [{
    sourceKey: "scope-usd-row",
    amount: "1",
    direction: "inflow",
    currencyEvidence: { kind: "scope", currency: "USD" },
    balanceAfter: "1",
    sourceTime: { localDate: "2026-08-02" },
  }],
});
const jpyScopedCapture = createForeignCurrencyDepositCapture({
  ...base,
  source: "sinopac",
  captureCurrencyScope: { kind: "currency", currency: "JPY" },
  records: [{
    sourceKey: "scope-jpy-row",
    amount: "1",
    direction: "inflow",
    currencyEvidence: { kind: "scope", currency: "JPY" },
    balanceAfter: "1",
    sourceTime: { localDate: "2026-08-02" },
  }],
});
assert.notEqual(usdScopedCapture.captureId, jpyScopedCapture.captureId);

const usd = createForeignCurrencyDepositCapture({
  ...base,
  source: "yuanta",
  records: [
    {
      sourceKey: "YUANTA-ROW-USD-1",
      sequence: "1",
      amount: "315.00",
      direction: "inflow",
      currencyEvidence: { kind: "row", currency: "TWD" },
      balanceAfter: "1315.00",
      sourceTime: { localDate: "2026-08-02" },
      originalAmount: { amount: "10", currency: "USD" },
      sourceReportedRate: {
        rate: "31.50",
        baseCurrency: "USD",
        quoteCurrency: "TWD",
        observedOn: "2026-08-02",
      },
      description: "foreign deposit",
    },
  ],
});
const admittedUsd = admitForeignCurrencyDepositCapture(usd);
assert.deepEqual(admittedUsd.records[0]!.amount, {
  coefficient: "315",
  scale: 0,
});
assert.equal(admittedUsd.records[0]!.sourceTime.precision, "date");
assert.equal(
  admittedUsd.records[0]!.sourceTime.timeOrigin,
  "defaulted_local_midnight",
);
assert.equal(admittedUsd.records[0]!.conversionEvidence?.comparison, "consistent");

const correctedDirection = createForeignCurrencyDepositCapture({
  ...base,
  source: "yuanta",
  captureOccurrenceId: "capture-observation-133-direction-correction",
  records: [
    {
      sourceKey: "YUANTA-ROW-USD-1",
      sequence: "1",
      amount: "315.00",
      direction: "outflow",
      currencyEvidence: { kind: "row", currency: "TWD" },
      balanceAfter: "1315.00",
      sourceTime: { localDate: "2026-08-02" },
      originalAmount: { amount: "10", currency: "USD" },
      sourceReportedRate: {
        rate: "31.50",
        baseCurrency: "USD",
        quoteCurrency: "TWD",
        observedOn: "2026-08-02",
      },
      description: "foreign deposit",
    },
  ],
});
assert.notEqual(
  correctedDirection.records[0]!.contentHash,
  usd.records[0]!.contentHash,
);
const conflicted = createForeignCurrencyDepositCapture({
  ...base,
  source: "cathay",
  captureId: "cathay-foreign-conflict-133",
  records: [
    {
      sourceKey: "CATHAY-ROW-CONFLICT-1",
      amount: "315.00",
      direction: "inflow",
      currencyEvidence: { kind: "row", currency: "TWD" },
      balanceAfter: "1315.00",
      sourceTime: { localDate: "2026-08-02", localTime: "09:10:11" },
      originalAmount: { amount: "10", currency: "USD" },
      sourceReportedRate: {
        rate: "30",
        baseCurrency: "USD",
        quoteCurrency: "TWD",
      },
    },
  ],
});
assert.equal(
  admitForeignCurrencyDepositCapture(conflicted).records[0]!.conversionEvidence
    ?.comparison,
  "conflicted",
);
assert.deepEqual(
  conflicted.records[0]!.amount,
  { coefficient: "315", scale: 0 },
);

const wholeNumberImpliedRate = createForeignCurrencyDepositCapture({
  ...base,
  source: "cathay",
  captureId: "cathay-foreign-whole-rate-133",
  records: [
    {
      sourceKey: "CATHAY-WHOLE-RATE-1",
      amount: "100",
      direction: "inflow",
      currencyEvidence: { kind: "row", currency: "TWD" },
      balanceAfter: "1415",
      sourceTime: { localDate: "2026-08-02" },
      originalAmount: { amount: "10", currency: "USD" },
    },
  ],
});
assert.deepEqual(
  wholeNumberImpliedRate.records[0]!.conversionEvidence?.impliedRate?.amount,
  { coefficient: "10", scale: 0 },
);

const jpy = createForeignCurrencyDepositCapture({
  ...base,
  source: "yuanta",
  captureId: "yuanta-foreign-jpy-133",
  records: [
    {
      sourceKey: "YUANTA-ROW-JPY-1",
      amount: "2000",
      direction: "outflow",
      currencyEvidence: { kind: "row", currency: "JPY" },
      balanceAfter: "8000",
      sourceTime: {
        localDate: "2026-08-03",
        localTime: "09:10",
        precision: "minute",
      },
      originalAmount: { amount: "2000", currency: "JPY" },
    },
  ],
});
const admittedJpy = admitForeignCurrencyDepositCapture(jpy);
assert.equal(admittedJpy.records[0]!.currency, "JPY");
assert.equal(admittedJpy.records[0]!.sourceTime.precision, "minute");
assert.throws(
  () =>
    createForeignCurrencyDepositCapture({
      ...base,
      source: "linebank",
      records: [
        {
          ...jpy.records[0],
          sourceKey: "missing-balance",
          balanceAfter: "",
        } as never,
      ],
    }),
  /balance|decimal|currency evidence|kind/i,
);

const directory = await mkdtemp(join(tmpdir(), "foreign-currency-deposit-133-"));
try {
  const store = createCanonicalSourceStore(join(directory, "canonical.sqlite"));
  const firstCommit = await commitForeignCurrencyDepositCapture(store, admittedUsd);
  await commitForeignCurrencyDepositCapture(store, admittedJpy);
  const accountRows = store.db
    .prepare(
      `SELECT COUNT(*) AS count, MIN(currency) AS currency
       FROM financial_accounts WHERE stream = 'foreign-currency-deposit'`,
    )
    .get() as { count?: number; currency?: string };
  assert.equal(accountRows.count, 1);
  assert.equal(accountRows.currency, null);
  const repeatedObservation = createForeignCurrencyDepositCapture({
    ...base,
    captureOccurrenceId: "capture-observation-133-b",
    source: "yuanta",
    records: [
      {
        sourceKey: "YUANTA-ROW-USD-1",
        sequence: "1",
        amount: "315.00",
        direction: "inflow",
        currencyEvidence: { kind: "row", currency: "TWD" },
        balanceAfter: "1315.00",
        sourceTime: { localDate: "2026-08-02" },
        originalAmount: { amount: "10", currency: "USD" },
        sourceReportedRate: {
          rate: "31.50",
          baseCurrency: "USD",
          quoteCurrency: "TWD",
          observedOn: "2026-08-02",
        },
        description: "foreign deposit",
      },
    ],
  });
  assert.notEqual(repeatedObservation.captureId, usd.captureId);
  assert.equal(
    repeatedObservation.records[0]!.contentHash,
    usd.records[0]!.contentHash,
  );
  await commitForeignCurrencyDepositCapture(
    store,
    admitForeignCurrencyDepositCapture(repeatedObservation),
  );
  assert.equal(
    Number(
      (
        store.db
          .prepare("SELECT COUNT(*) AS count FROM source_captures")
          .get() as { count?: number }
      ).count ?? 0,
    ),
    3,
  );
  const current = queryForeignCurrencyDepositCurrent(store, {
    accountNo: base.accountNo,
  });
  assert.equal(current.transactions.length, 2);
  assert.equal(current.provenanceCount, 3);
  assert.deepEqual(
    current.transactions.map((transaction) => transaction.currency),
    ["TWD", "JPY"],
  );
  assert.equal(current.transactions[0]!.originalCurrency, "USD");
  assert.equal(current.transactions[0]!.conversion?.comparison, "consistent");
  assert.deepEqual(current.transactions[0]!.conversion?.sourceReportedRate?.amount, {
    coefficient: "315",
    scale: 1,
  });
  assert.equal(current.transactions[0]!.timePrecision, "date");
  assert.equal(current.transactions[1]!.timePrecision, "minute");
  assert.equal(
    current.transactions[0]!.conversion?.bookedAmount.coefficient,
    "315",
  );
  assert.equal(current.transactions[0]!.conversion?.bookedAmount.scale, 0);
  assert.equal(current.transactions[0]!.assertion?.origin, "source");
  assert.equal(Boolean(current.transactions[0]!.sourceRecord?.payloadJson), true);
  assert.equal(current.transactions[0]!.lifecycleEvents?.[0]!.kind, "observed");

  const historical = queryForeignCurrencyDepositHistorical(store, {
    knowledgeAt: firstCommit.commitSequence,
  });
  assert.equal(historical.transactions.length, 1);
  assert.equal(historical.transactions[0]!.currency, "TWD");
  const lineage = queryForeignCurrencyDepositLineage(store, {
    occurrenceKey: admittedUsd.records[0]!.occurrenceKey,
  });
  assert.equal(lineage.transactions.length, 1);
  assert.equal(lineage.provenanceCount, 2);
  assert.equal(Boolean(lineage.transactions[0]!.assertion?.revisionId), true);
  assert.equal(lineage.transactions[0]!.sourceRecord?.scopeProof?.completeness, "complete-range");
  assert.deepEqual(
    lineage.transactions[0]!.lifecycleEvents?.map((event) => event.kind),
    ["observed"],
  );
  store.close();
} finally {
  await rm(directory, { recursive: true, force: true });
}

const revisionDirectory = await mkdtemp(join(tmpdir(), "foreign-currency-revision-133-"));
try {
  const revisionStore = createCanonicalSourceStore(
    join(revisionDirectory, "canonical.sqlite"),
  );
  await commitForeignCurrencyDepositCapture(revisionStore, admittedUsd);
  await commitForeignCurrencyDepositCapture(
    revisionStore,
    admitForeignCurrencyDepositCapture(correctedDirection),
  );
  const current = queryForeignCurrencyDepositCurrent(revisionStore, {
    accountNo: base.accountNo,
  });
  assert.equal(current.transactions.length, 1);
  assert.equal(current.transactions[0]!.direction, "outflow");
  const lineage = queryForeignCurrencyDepositLineage(revisionStore, {
    occurrenceKey: admittedUsd.records[0]!.occurrenceKey,
  });
  assert.deepEqual(
    lineage.transactions.map((transaction) => transaction.direction),
    ["inflow", "outflow"],
  );
  revisionStore.close();
} finally {
  await rm(revisionDirectory, { recursive: true, force: true });
}

const atomicDirectory = await mkdtemp(join(tmpdir(), "foreign-currency-atomic-133-"));
try {
  const atomicStore = createCanonicalSourceStore(
    join(atomicDirectory, "canonical.sqlite"),
  );
  await assert.rejects(
    () =>
      commitForeignCurrencyDepositCaptureBatch(atomicStore, [
        admittedUsd,
        admittedUsd,
      ]),
    /overwrite|capture/i,
  );
  assert.equal(
    Number(
      (
        atomicStore.db
          .prepare("SELECT COUNT(*) AS count FROM source_captures")
          .get() as { count?: number }
      ).count ?? 0,
    ),
    0,
  );
  atomicStore.close();
} finally {
  await rm(atomicDirectory, { recursive: true, force: true });
}

assert.throws(
  () =>
    createForeignCurrencyDepositCapture({
      ...base,
      source: "yuanta",
      records: [
        {
          sourceKey: "row-denomination-check-133",
          amount: "1.00",
          direction: "inflow",
          currencyEvidence: { kind: "row", currency: "ZZZ" },
          balanceAfter: "2.00",
          sourceTime: { localDate: "2026-08-02" },
        },
      ],
    }),
  /ISO 4217/i,
);
assert.throws(
  () =>
    createForeignCurrencyDepositCapture({
      ...base,
      identityEpochKey: "",
      source: "yuanta",
      records: [],
    }),
  /identity epoch/i,
);
assert.throws(
  () =>
    createForeignCurrencyDepositCapture({
      ...base,
      captureOccurrenceId: "",
      source: "yuanta",
      records: [],
    }),
  /capture occurrence identity/i,
);

for (const mutate of [
  (capture: ReturnType<typeof createForeignCurrencyDepositCapture>) => {
    capture.records[0]!.amount.coefficient = "not-decimal";
  },
  (capture: ReturnType<typeof createForeignCurrencyDepositCapture>) => {
    capture.records[0]!.amount.scale = -1;
  },
  (capture: ReturnType<typeof createForeignCurrencyDepositCapture>) => {
    capture.records[0]!.currency = "ZZZ";
  },
  (capture: ReturnType<typeof createForeignCurrencyDepositCapture>) => {
    capture.records[0]!.direction = "sideways";
  },
  (capture: ReturnType<typeof createForeignCurrencyDepositCapture>) => {
    capture.records[0]!.direction = "outflow";
  },
  (capture: ReturnType<typeof createForeignCurrencyDepositCapture>) => {
    capture.records[0]!.sourceTime.localDate = "2026-02-30";
  },
  (capture: ReturnType<typeof createForeignCurrencyDepositCapture>) => {
    capture.identity.accountType = "credit";
  },
]) {
  const malformed = structuredClone(usd);
  mutate(malformed);
  assert.throws(
    () => admitForeignCurrencyDepositCapture(malformed),
    /amount|scale|currency|direction|date|account type|depository|payload|financial facts/i,
  );
}

const defensiveDirectory = await mkdtemp(join(tmpdir(), "foreign-currency-defensive-133-"));
try {
  const defensiveStore = createCanonicalSourceStore(
    join(defensiveDirectory, "canonical.sqlite"),
  );
  const admittedThenCorrupted = admitForeignCurrencyDepositCapture(
    structuredClone(correctedDirection),
  );
  admittedThenCorrupted.records[0]!.conversionEvidence!.bookedAmount.coefficient =
    "not-decimal";
  await assert.rejects(
    () =>
      commitForeignCurrencyDepositCapture(
        defensiveStore,
        admittedThenCorrupted,
      ),
    /exact|amount|decimal/i,
  );
  assert.equal(
    Number(
      (
        defensiveStore.db
          .prepare("SELECT COUNT(*) AS count FROM source_captures")
          .get() as { count?: number }
      ).count ?? 0,
    ),
    0,
  );
  defensiveStore.close();
} finally {
  await rm(defensiveDirectory, { recursive: true, force: true });
}
