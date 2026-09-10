import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
  commitCathayDomesticDeposit,
  createCanonicalSourceStore,
} from "./canonical-source-store.ts";
import { createCanonicalSourceCaptureAdmission } from "./canonical-source-capture-admission.ts";
import { createCanonicalProjectionRuntime } from "./canonical-projection-runtime.ts";
import {
  admitCurrentDepositBalanceCapture,
  commitCurrentDepositBalanceCapture,
  currentDepositSourceRecord,
  currentDepositSourceRecordContentHash,
  CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS,
  type CurrentDepositBalanceCaptureInput,
  type CurrentDepositBalanceKind,
  type CurrentDepositExactAmount,
  type CurrentDepositTimeEvidence,
} from "./current-deposit-balance-writer.ts";

for (const [routeKey, stream] of [
  ["sinopac/domestic-deposit/current-balance-v1", "domestic-deposit"],
  ["sinopac/foreign-currency/current-balance-v1", "foreign-currency-deposit"],
] as const) {
  const contract = CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS[routeKey];
  assert.ok(contract, `${routeKey} is registered`);
  assert.equal(contract.integrationNamespace, "sinopac");
  assert.equal(contract.stream, stream);
  assert.equal(contract.contractVersion, "sinopac/current-deposit-balance-v1");
  assert.equal(contract.endpointHost, "mma.sinopac.com");
  assert.equal(contract.endpointPath, "/ws/bank/bankbal/ws_bankbal.ashx");
  assert.equal(contract.effectiveTimeBasis, "provider-http-date");
  assert.equal(contract.effectiveTimeSourceField, "HTTP Date");
  assert.deepEqual(contract.requiredCacheTokens, ["no-cache", "no-store"]);
  assert.deepEqual(contract.fields, { ledger: ["AvailBalance"], available: [] });
}

const ctbcRoute = "ctbc/domestic-deposit/current-balance-v1";
const ctbcContract = CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS[ctbcRoute];
assert.ok(ctbcContract, "ctbc current-balance route is registered");
assert.equal(ctbcContract.integrationNamespace, "ctbc");
assert.equal(ctbcContract.stream, "domestic-deposit");
assert.equal(ctbcContract.contractVersion, "ctbc/current-deposit-balance-v1");
assert.equal(ctbcContract.endpointHost, "www.ctbcbank.com");
assert.equal(
  ctbcContract.endpointPath,
  "/IB/api/adapters/IB_Adapter/resource/ebmwResource",
);
assert.equal(ctbcContract.requestResource, "/twrbc-deposit/qu001/010");
assert.equal(ctbcContract.effectiveTimeBasis, "provider-system-time");
assert.equal(ctbcContract.effectiveTimeSourceField, "serverTime");
assert.deepEqual(ctbcContract.requiredCacheTokens, [
  "no-cache",
  "no-store",
  "must-revalidate",
]);
assert.deepEqual(ctbcContract.fields, { ledger: ["balance"], available: [] });

const postRoute = "post/domestic-deposit/current-balance-v1";
const postContract = CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS[postRoute];
assert.ok(postContract, "post current-balance route is registered");
assert.equal(postContract.integrationNamespace, "post");
assert.equal(postContract.stream, "domestic-deposit");
assert.equal(postContract.contractVersion, "post/current-deposit-balance-v1");
assert.equal(postContract.endpointHost, "ipost.post.gov.tw");
assert.equal(postContract.endpointPath, "/pst/EsoafDispatcher");
assert.deepEqual(postContract.requestDiscriminant, {
  txnCode: "EB100103",
  bizCode: "getOverViewById",
  pageCount: 50,
});
assert.equal(postContract.effectiveTimeBasis, "provider-http-date");
assert.equal(postContract.effectiveTimeSourceField, "HTTP Date");
assert.deepEqual(postContract.effectiveTimeAlternates, [
  { effectiveTimeBasis: "provider-system-time", effectiveTimeSourceField: "SERVER_TIMESTAMP" },
]);
assert.deepEqual(postContract.requiredCacheTokens, ["no-store"]);
assert.deepEqual(postContract.fields, { ledger: ["BAL"], available: [] });

const linebankRoute = "linebank/domestic-deposit/current-balance-v1";
const linebankContract = CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS[linebankRoute];
assert.ok(linebankContract, "linebank current-balance route is registered");
assert.equal(linebankContract.integrationNamespace, "linebank");
assert.equal(linebankContract.stream, "domestic-deposit");
assert.equal(linebankContract.contractVersion, "linebank/current-deposit-balance-v1");
assert.equal(linebankContract.endpointHost, "accessibility.linebank.com.tw");
assert.equal(linebankContract.endpointPath, "/v1/account/common/payables");
assert.deepEqual(linebankContract.endpointQuery, { featureTypeCode: "01" });
assert.equal(linebankContract.effectiveTimeBasis, "provider-http-date");
assert.equal(linebankContract.effectiveTimeSourceField, "HTTP Date");
assert.deepEqual(linebankContract.requiredCacheTokens, ["no-cache", "no-store"]);
assert.deepEqual(linebankContract.fields, { ledger: [], available: ["wdrwAvblAmt"] });

const route = "cathay/domestic-deposit/current-balance-v1";
const contractVersion = "cathay/current-deposit-balance-v1";
const endpoint =
  "https://www.cathaybk.com.tw/OnlineBankingApi/ClientBank/Api/ClientBank/B_ACCT_Q_DepositOverview";
const sourceConnectionKey = CATHAY_DOMESTIC_DEPOSIT_FIXTURE.sourceConnectionId;
const identityEpochKey = CATHAY_DOMESTIC_DEPOSIT_FIXTURE.identityEpoch;
const sourceAccountKey = CATHAY_DOMESTIC_DEPOSIT_FIXTURE.accountNo;

const token = (label: string): string =>
  `sha256:${createHash("sha256").update(label).digest("base64url")}`;

type Entry = Readonly<{
  key: string;
  observationKey: string;
  balanceKind: CurrentDepositBalanceKind;
  amount: CurrentDepositExactAmount;
  sourceField: string;
}>;

function timeEvidence(effectiveAt: string): CurrentDepositTimeEvidence {
  return {
    effectiveAt,
    effectiveTimeBasis: "provider-system-time",
    effectiveTimeRuleVersion: contractVersion,
    sourceField: "systemTime",
    sourceValue: effectiveAt,
    contractVersion,
  };
}

function capture(
  captureId: string,
  entries: readonly Entry[],
  effectiveAt = "2026-09-08T12:00:00.000+08:00",
): CurrentDepositBalanceCaptureInput {
  const time = timeEvidence(effectiveAt);
  const records = entries.map((entry) => {
    const draft = currentDepositSourceRecord({
      sourceRecordKey: entry.key,
      providerKey: token(`${captureId}:provider:${entry.key}`),
      contentHash: token(`${captureId}:content-placeholder:${entry.key}`),
      sourceField: entry.sourceField,
      balanceKind: entry.balanceKind,
      currency: "TWD",
      value: entry.amount,
      time,
    });
    return {
      ...draft,
      contentHash: currentDepositSourceRecordContentHash(draft.compact),
    };
  });
  return {
    captureId,
    authorityRoute: route,
    contractVersion,
    subjectDigest: token("current-deposit-balance-test-subject"),
    identity: {
      integrationNamespace: "cathay",
      sourceConnectionKey,
      identityEpochKey,
      stream: "domestic-deposit",
      sourceAccountKey,
    },
    observedAt: "2026-09-08T12:01:00.000+08:00",
    scope: {
      startDate: "2026-09-08",
      endDate: "2026-09-08",
    },
    providerResponse: { endpoint, status: 200 },
    pages: [
      {
        pageOrdinal: 0,
        responseCode: "200",
        rowCount: records.length,
        terminal: true,
        metadata: { provider: "cathay", testFixture: true },
      },
    ],
    records,
    observations: entries.map((entry) => ({
      observationKey: entry.observationKey,
      balanceKind: entry.balanceKind,
      balance: entry.amount,
      currency: "TWD",
      time,
      sourceRecordKey: entry.key,
      sourceField: entry.sourceField,
    })),
  };
}

function ctbcCapture(
  captureId = "ctbc-current-balance-resource",
): CurrentDepositBalanceCaptureInput {
  const effectiveAt = "2026-09-09T02:09:43.601Z";
  const providerServerTime = "1788919783601";
  const time: CurrentDepositTimeEvidence = {
    effectiveAt,
    effectiveTimeBasis: "provider-system-time",
    effectiveTimeRuleVersion: "ctbc/current-deposit-balance-v1",
    sourceField: "serverTime",
    sourceValue: providerServerTime,
    contractVersion: "ctbc/current-deposit-balance-v1",
  };
  const sourceRecordKey = token(`${captureId}:record`);
  const draft = currentDepositSourceRecord({
    sourceRecordKey,
    providerKey: token(`${captureId}:provider`),
    contentHash: token(`${captureId}:content-placeholder`),
    sourceField: "balance",
    balanceKind: "ledger",
    currency: "TWD",
    value: { coefficient: "13155", scale: 0 },
    time,
    compact: {
      provider: "ctbc",
      resource: "/twrbc-deposit/qu001/010",
      accountId: "0000314540554100",
    },
  });
  const record = {
    ...draft,
    contentHash: currentDepositSourceRecordContentHash(draft.compact),
  };
  return {
    captureId,
    authorityRoute: ctbcRoute,
    contractVersion: "ctbc/current-deposit-balance-v1",
    subjectDigest: token(`${captureId}:subject`),
    identity: {
      integrationNamespace: "ctbc",
      sourceConnectionKey: "existing-ctbc-connection",
      identityEpochKey: "existing-ctbc-epoch",
      stream: "domestic-deposit",
      sourceAccountKey: "0000314540554100",
    },
    observedAt: "2026-09-09T02:10:00.000Z",
    scope: {
      startDate: "2026-09-09",
      endDate: "2026-09-09",
    },
    providerResponse: {
      endpoint:
        "https://www.ctbcbank.com/IB/api/adapters/IB_Adapter/resource/ebmwResource",
      status: 200,
      cacheControl: "no-cache, no-store, must-revalidate",
      requestResource: "/twrbc-deposit/qu001/010",
    },
    pages: [
      {
        pageOrdinal: 0,
        responseCode: "200",
        rowCount: 1,
        terminal: true,
        metadata: {
          provider: "ctbc",
          resource: "/twrbc-deposit/qu001/010",
          testFixture: true,
        },
      },
    ],
    records: [record],
    observations: [
      {
        observationKey: token(`${captureId}:observation`),
        balanceKind: "ledger",
        balance: { coefficient: "13155", scale: 0 },
        currency: "TWD",
        time,
        sourceRecordKey,
        sourceField: "balance",
      },
    ],
  };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "current-deposit-balance-writer-"));
  await commitCathayDomesticDeposit(directory, CATHAY_DOMESTIC_DEPOSIT_FIXTURE);
  const store = createCanonicalSourceStore(join(directory, "canonical.sqlite"));
  return { directory, store };
}

function counts(store: ReturnType<typeof createCanonicalSourceStore>) {
  return {
    captures: Number(
      (store.db.prepare("SELECT COUNT(*) AS value FROM source_captures").get() as { value?: number }).value,
    ),
    accounts: Number(
      (store.db.prepare("SELECT COUNT(*) AS value FROM financial_accounts").get() as { value?: number }).value,
    ),
    transactions: Number(
      (store.db.prepare("SELECT COUNT(*) AS value FROM financial_transactions").get() as { value?: number }).value,
    ),
    observations: Number(
      (store.db.prepare("SELECT COUNT(*) AS value FROM balance_observations").get() as { value?: number }).value,
    ),
    revisions: Number(
      (store.db.prepare("SELECT COUNT(*) AS value FROM balance_observation_revisions").get() as { value?: number }).value,
    ),
  };
}

test("current deposit balances attach existing identities and respect both projection families", async () => {
  const { directory, store } = await fixture();
  try {
    const input = capture(
      "current-balance-ledger-and-available",
      [
        {
          key: token("current-balance-ledger-record"),
          observationKey: token("current-balance-ledger"),
          balanceKind: "ledger",
          amount: { coefficient: "100", scale: 1 },
          sourceField: "accountBalance",
        },
        {
          key: token("current-balance-available-record"),
          observationKey: token("current-balance-available"),
          balanceKind: "available",
          amount: { coefficient: "90", scale: 1 },
          sourceField: "avaliableBalance",
        },
      ],
      "2026-09-08T23:59:59.123456789Z",
    );
    const result = await commitCurrentDepositBalanceCapture(
      store,
      admitCurrentDepositBalanceCapture(input),
    );
    assert.equal(result.observationCount, 2);
    assert.equal(result.revisionCount, 2);
    assert.equal(result.deduplicatedRevisionCount, 0);
    assert.deepEqual(counts(store), {
      captures: 2,
      accounts: 1,
      transactions: 3,
      observations: 2,
      revisions: 2,
    });
    assert.equal(
      Number(
        (store.db
          .prepare("SELECT COUNT(*) AS value FROM current_depository_balance_observations")
          .get() as { value?: number }).value,
      ),
      2,
    );

    const runtime = createCanonicalProjectionRuntime(store.db);
    const current = runtime.read({
      kind: "current",
      families: ["depository-balances", "overview-depository-balances"],
      scope: { sourceConnectionKey },
    });
    assert.equal(current.families["depository-balances"].length, 2);
    assert.deepEqual(
      current.families["overview-depository-balances"].map((row) => row.balanceKind),
      ["ledger"],
    );

    const beforeCapture = runtime.read({
      kind: "historical",
      families: ["depository-balances"],
      scope: { sourceConnectionKey },
      cutoff: { financialAt: "2026-09-08", knowledgeAt: 1 },
    });
    assert.equal(beforeCapture.families["depository-balances"].length, 0);
    const atCapture = runtime.read({
      kind: "historical",
      families: ["depository-balances"],
      scope: { sourceConnectionKey },
      cutoff: { financialAt: "2026-09-08", knowledgeAt: result.commitSequence },
    });
    assert.equal(atCapture.families["depository-balances"].length, 2);

    assert.throws(
      () =>
        store.db
          .prepare("UPDATE balance_observations SET balance_currency = 'USD'")
          .run(),
      /immutable/i,
    );
    assert.throws(
      () => store.db.prepare("DELETE FROM balance_observation_revisions").run(),
      /immutable|cannot be deleted/i,
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("same-instant equal decimals deduplicate, contradictions roll back, and new provider time creates a new observation", async () => {
  const { directory, store } = await fixture();
  try {
    const first = capture("current-balance-first", [
      {
        key: token("current-balance-first-record"),
        observationKey: token("current-balance-observation"),
        balanceKind: "ledger",
        amount: { coefficient: "100", scale: 1 },
        sourceField: "accountBalance",
      },
    ]);
    const firstResult = await commitCurrentDepositBalanceCapture(
      store,
      admitCurrentDepositBalanceCapture(first),
    );
    assert.equal(firstResult.revisionCount, 1);

    const equivalent = capture("current-balance-equivalent", [
      {
        key: token("current-balance-equivalent-record"),
        observationKey: token("current-balance-observation"),
        balanceKind: "ledger",
        amount: { coefficient: "1000", scale: 2 },
        sourceField: "accountBalance",
      },
    ]);
    const equivalentResult = await commitCurrentDepositBalanceCapture(
      store,
      admitCurrentDepositBalanceCapture(equivalent),
    );
    assert.equal(equivalentResult.revisionCount, 0);
    assert.equal(equivalentResult.deduplicatedRevisionCount, 1);
    assert.deepEqual(counts(store), {
      captures: 3,
      accounts: 1,
      transactions: 3,
      observations: 1,
      revisions: 1,
    });

    const contradiction = capture("current-balance-contradiction", [
      {
        key: token("current-balance-contradiction-record"),
        observationKey: token("current-balance-observation"),
        balanceKind: "ledger",
        amount: { coefficient: "101", scale: 1 },
        sourceField: "accountBalance",
      },
    ]);
    await assert.rejects(
      () =>
        commitCurrentDepositBalanceCapture(
          store,
          admitCurrentDepositBalanceCapture(contradiction),
        ),
      /contradict/i,
    );
    assert.deepEqual(counts(store), {
      captures: 3,
      accounts: 1,
      transactions: 3,
      observations: 1,
      revisions: 1,
    });

    const later = capture(
      "current-balance-later",
      [
        {
          key: token("current-balance-later-record"),
          observationKey: token("current-balance-observation"),
          balanceKind: "ledger",
          amount: { coefficient: "101", scale: 1 },
          sourceField: "accountBalance",
        },
      ],
      "2026-09-08T13:00:00.000+08:00",
    );
    const laterResult = await commitCurrentDepositBalanceCapture(
      store,
      admitCurrentDepositBalanceCapture(later),
    );
    assert.equal(laterResult.revisionCount, 1);
    assert.equal(laterResult.deduplicatedRevisionCount, 0);
    assert.deepEqual(counts(store), {
      captures: 4,
      accounts: 1,
      transactions: 3,
      observations: 2,
      revisions: 2,
    });
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("plain identity admission remains closed to ordinary source captures and cannot create an account", async () => {
  const { directory, store } = await fixture();
  try {
    const valid = capture("current-balance-identity-check", [
      {
        key: token("current-balance-identity-record"),
        observationKey: token("current-balance-identity-observation"),
        balanceKind: "ledger",
        amount: { coefficient: "100", scale: 1 },
        sourceField: "accountBalance",
      },
    ]);
    const sourceRecord = valid.records[0]!;
    await assert.rejects(
      () =>
        createCanonicalSourceCaptureAdmission(store).admit({
          captureId: "ordinary-plain-identity-capture",
          integrationNamespace: "cathay",
          sourceConnectionKey,
          identityEpoch: identityEpochKey,
          stream: "domestic-deposit",
          recordKind: "current-deposit-balance",
          routeKey: route,
          contractVersion,
          subjectDigest: valid.subjectDigest,
          observedAt: valid.observedAt,
          scope: {
            startDate: "2026-09-08",
            endDate: "2026-09-08",
            dateFormat: "YYYY-MM-DD",
            kind: "point-in-time",
            completeness: "single-page",
            ruleVersion: contractVersion,
            completenessBasis: "provider-current-balance-snapshot",
            sourceAccountKey,
          },
          pages: [...valid.pages],
          records: [
            {
              occurrenceKey: sourceRecord.sourceRecordKey,
              collisionKey: sourceRecord.sourceRecordKey,
              providerKey: sourceRecord.providerKey,
              contentHash: sourceRecord.contentHash,
              compact: sourceRecord.compact,
              sequenceLexeme: sourceRecord.sourceRecordKey,
            },
          ],
        }),
      /opaque|token/i,
    );

    const missingAccount = admitCurrentDepositBalanceCapture({
      ...valid,
      captureId: "current-balance-missing-account",
      identity: { ...valid.identity, sourceAccountKey: token("missing-account") },
    });
    await assert.rejects(
      () => commitCurrentDepositBalanceCapture(store, missingAccount),
      /existing depository account/i,
    );
    assert.deepEqual(counts(store), {
      captures: 1,
      accounts: 1,
      transactions: 3,
      observations: 0,
      revisions: 0,
    });
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("CTBC current balance requires the shared-endpoint request resource in source evidence", () => {
  const valid = ctbcCapture();
  assert.equal(valid.observations[0]?.time.sourceField, "serverTime");
  assert.equal(valid.observations[0]?.time.sourceValue, "1788919783601");
  assert.doesNotThrow(() => admitCurrentDepositBalanceCapture(valid));
  assert.throws(
    () =>
      admitCurrentDepositBalanceCapture({
        ...valid,
        providerResponse: {
          ...valid.providerResponse,
          requestResource: "/twrbc-deposit/qu001/011",
        },
      }),
    /request resource/i,
  );
  assert.throws(
    () =>
      admitCurrentDepositBalanceCapture({
        ...valid,
        pages: [
          {
            ...valid.pages[0]!,
            metadata: { provider: "ctbc", resource: "/twrbc-deposit/qu001/011" },
          },
        ],
      }),
    /request resource/i,
  );
});

test("CTBC epoch-millisecond time preserves the exact provider instant", () => {
  const valid = ctbcCapture("ctbc-current-balance-epoch-ms");
  assert.equal(valid.observations[0]?.time.effectiveAt, "2026-09-09T02:09:43.601Z");
  assert.doesNotThrow(() => admitCurrentDepositBalanceCapture(valid));
  assert.throws(
    () =>
      admitCurrentDepositBalanceCapture({
        ...valid,
        observations: valid.observations.map((observation) => ({
          ...observation,
          time: {
            ...observation.time,
            sourceValue: "1788919783601.0",
          },
        })),
      }),
    /provider system time|effective time/i,
  );
});

test("provider epoch seconds remain an accepted system-time representation", () => {
  const base = capture(
    "current-balance-epoch-seconds",
    [
      {
        key: token("current-balance-epoch-seconds-record"),
        observationKey: token("current-balance-epoch-seconds-observation"),
        balanceKind: "ledger",
        amount: { coefficient: "100", scale: 1 },
        sourceField: "accountBalance",
      },
    ],
    "2026-09-08T12:00:00.000Z",
  );
  const sourceValue = "1788868800";
  const records = base.records.map((record) => {
    const compact = {
      ...record.compact,
      effectiveTimeSourceValue: sourceValue,
    };
    return {
      ...record,
      compact,
      contentHash: currentDepositSourceRecordContentHash(compact),
    };
  });
  const captureWithEpochSeconds: CurrentDepositBalanceCaptureInput = {
    ...base,
    records,
    observations: base.observations.map((observation) => ({
      ...observation,
      time: { ...observation.time, sourceValue },
    })),
  };
  assert.doesNotThrow(() => admitCurrentDepositBalanceCapture(captureWithEpochSeconds));
});

test("HTTP Date and RFC3339 zero-millisecond spellings identify one provider instant", () => {
  const input = capture("current-balance-http-date", [
    {
      key: token("current-balance-http-date-record"),
      observationKey: token("current-balance-http-date-observation"),
      balanceKind: "ledger",
      amount: { coefficient: "100", scale: 1 },
      sourceField: "accountBalance",
    },
  ]);
  const sourceValue = "Tue, 08 Sep 2026 12:00:00 GMT";
  const httpTime = {
    effectiveAt: "2026-09-08T12:00:00.000Z",
    effectiveTimeBasis: "provider-http-date" as const,
    effectiveTimeRuleVersion: "fubon/current-deposit-balance-v1",
    sourceField: "HTTP Date",
    sourceValue,
    contractVersion: "fubon/current-deposit-balance-v1",
  };
  const records = input.records.map((record) => {
    const compact = {
      ...record.compact,
      sourceField: "即時餘額",
      effectiveAt: httpTime.effectiveAt,
      effectiveTimeSourceField: httpTime.sourceField,
      effectiveTimeSourceValue: sourceValue,
    };
    return {
      ...record,
      compact,
      contentHash: currentDepositSourceRecordContentHash(compact),
    };
  });
  const httpCapture: CurrentDepositBalanceCaptureInput = {
    ...input,
    authorityRoute: "fubon/domestic-deposit/current-balance-v1",
    contractVersion: "fubon/current-deposit-balance-v1",
    identity: {
      ...input.identity,
      integrationNamespace: "fubon",
      sourceConnectionKey: "existing-fubon-connection",
      identityEpochKey: "existing-fubon-epoch",
    },
    providerResponse: {
      endpoint:
        "https://ebank.taipeifubon.com.tw/B2C/cboqu/cboqu003/CBOQU003_Home.faces",
      status: 200,
      cacheControl: "no-store, no-cache",
    },
    records,
    observations: input.observations.map((observation) => ({
      ...observation,
      sourceField: "即時餘額",
      time: httpTime,
    })),
  };
  assert.doesNotThrow(() => admitCurrentDepositBalanceCapture(httpCapture));
  for (const invalidEndpoint of [
    `${httpCapture.providerResponse.endpoint}?unexpected=1`,
    `${httpCapture.providerResponse.endpoint}#fragment`,
    `${httpCapture.providerResponse.endpoint}#`,
    httpCapture.providerResponse.endpoint.replace(
      "https://",
      "https://user:password@",
    ),
    httpCapture.providerResponse.endpoint.replace("https://", "https://@"),
    httpCapture.providerResponse.endpoint.replace("https://", "https://")
      .replace("ebank.taipeifubon.com.tw/", "ebank.taipeifubon.com.tw:8443/"),
  ]) {
    assert.throws(
      () =>
        admitCurrentDepositBalanceCapture({
          ...httpCapture,
          providerResponse: {
            ...httpCapture.providerResponse,
            endpoint: invalidEndpoint,
          },
        }),
      /endpoint|host|query/i,
    );
  }
  assert.throws(
    () =>
      currentDepositSourceRecord({
        sourceRecordKey: token("fraction-overflow-record"),
        providerKey: token("fraction-overflow-provider"),
        contentHash: token("fraction-overflow-content"),
        sourceField: "帳面餘額",
        balanceKind: "ledger",
        currency: "TWD",
        value: { coefficient: "1", scale: 0 },
        time: {
          ...httpTime,
          effectiveAt: "2026-09-08T12:00:00.1234567891Z",
          sourceValue: "Tue, 08 Sep 2026 12:00:00 GMT",
        },
      }),
    /RFC3339|fraction/i,
  );
});
