import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { PGlite } from "@electric-sql/pglite";
import { createPGliteChildRpcServer } from "../../electron/pglite-child-rpc.ts";
import { createPGliteViewWorkerClient } from "../../electron/pglite-view-worker-client.ts";
import {
  createCanonicalSourceStore,
} from "../ledger/canonical/canonical-source-store.ts";
import { admitCurrentDepositBalanceCapture } from "../ledger/canonical/current-deposit-balance-writer.ts";
import { currentDepositBalanceCommandRequest } from "../ledger/pglite/current-deposit-balance-command.ts";
import {
  buildCtbcCurrentDepositBalanceCapture,
  ctbcDetailTelemetry,
  ctbcDetailRowsToStatementRows,
  ctbcStatementRowsToCsv,
  indexCtbcCurrentDepositFinancialCaptures,
  resolveCtbcAccountScope,
  runCtbcStatements,
} from "./ctbc-statements.ts";

const telemetry = ctbcDetailTelemetry({
  detailList: [
    {
      actDtFull: "2026/07/03",
      trnDtFull: "20260702",
      memo1: "PRIVATE-MEMO",
      dbAmtDisplay: "0",
      crAmtDisplay: "1,234",
    },
    {
      actDtFull: "20260704",
      trnDtFull: "2026-07-04T12:34:56",
      dbAmt: "25",
      crAmt: "0.00",
    },
  ],
  nextKey: "opaque-present",
});
assert.deepEqual(telemetry, {
  rowCount: 2,
  nextKey: "present",
  accountingDateShapes: { "slash-date": 1, "compact-date": 1 },
  transactionDateShapes: { "compact-date": 1, "date-time-prefix": 1 },
  amountPairs: {
    "valid-zero|valid-nonzero": 1,
    "valid-nonzero|valid-zero": 1,
  },
});
assert.doesNotMatch(
  JSON.stringify(telemetry),
  /PRIVATE-MEMO|2026\/07\/03|20260702|1,234|opaque-present/,
);

const uiAccounts = [
  { accountId: "fixture-a", label: "A", optionIndex: 0 },
  { accountId: "fixture-b", label: "B", optionIndex: 1 },
];
assert.deepEqual(
  resolveCtbcAccountScope(uiAccounts, [
    { accountId: "fallback", label: "fallback" },
  ]),
  uiAccounts,
);
assert.deepEqual(
  resolveCtbcAccountScope([], [{ accountId: "fixture-a", label: "single" }]),
  [{ accountId: "fixture-a", label: "single" }],
);
assert.throws(
  () =>
    resolveCtbcAccountScope(
      [],
      [
        { accountId: "fixture-a", label: "A" },
        { accountId: "fixture-b", label: "B" },
      ],
    ),
  /stable options/,
);

const absent = await runCtbcStatements(
  {} as never,
  { telemetry: false },
  {
    collectStatements: async () => ({
      output: { count: 0, rowCount: 0, downloads: [] },
      captures: [],
    }),
  },
);
assert.deepEqual(absent, {
  count: 0,
  rowCount: 0,
  downloads: [],
  sourceCaptureCount: 0,
  status: "absent",
});

const sourceOnlyDir = await mkdtemp(join(tmpdir(), "ctbc-source-only-"));
try {
  const sourceOnly = await runCtbcStatements(
    {} as never,
    { telemetry: false },
    {
      canonicalLedgerDir: sourceOnlyDir,
      observedAt: "2026-08-24T12:34:56+08:00",
      readCurrentDepositBalances: async () => [],
      collectStatements: async () => ({
        output: { count: 1, rowCount: 1, downloads: [] },
        captures: [
          {
            accountId: "PRIVATE-CTBC-ACCOUNT",
            queryPeriods: ["2026/08/01~2026/08/31"],
            expectedRangeCount: 1,
            responses: [
              {
                rangeOrdinal: 0,
                startDate: "2026/08/01",
                endDate: "2026/08/31",
                code: "0000",
                nextKey: null,
                terminal: true,
                responseShape: {
                  hasRsData: true,
                  rsDataKind: "object",
                  hasDetailList: true,
                  detailListIsArray: true,
                  detailListRowCount: 1,
                  nextKeyPresent: false,
                },
                rows: ctbcDetailRowsToStatementRows(
                  {
                    accountId: "PRIVATE-CTBC-ACCOUNT",
                    label: "PRIVATE-CTBC-LABEL",
                  },
                  [
                    {
                      actDtFull: "2026/08/03",
                      trnDtFull: "2026/08/02",
                      actDtTm: "2026-08-03-09.08.07.000000",
                      memo1: "PRIVATE-CTBC-MEMO",
                      dbAmtDisplay: "0",
                      crAmtDisplay: "1,234",
                      balanceAmt: "5,678",
                    },
                  ],
                ),
              },
            ],
          },
        ],
      }),
    },
  );
  assert.equal(sourceOnly.status, "financial-admitted");
  assert.equal(sourceOnly.sourceCaptureCount, 1);
  const verify = createCanonicalSourceStore(sourceOnlyDir);
  const sourceCount = verify.db
    .prepare("SELECT COUNT(*) AS count FROM source_records")
    .get() as { count: number };
  const financialCount = verify.db
    .prepare("SELECT COUNT(*) AS count FROM financial_transactions")
    .get() as { count: number };
  const payloads = verify.db
    .prepare("SELECT payload_json FROM source_records")
    .all() as Array<{ payload_json: string }>;
  verify.close();
  assert.equal(sourceCount.count, 2);
  assert.equal(financialCount.count, 1);
  assert.doesNotMatch(
    JSON.stringify(payloads),
    /PRIVATE-CTBC|1,234|5,678|2026\/08\/0[23]/,
  );
} finally {
  await rm(sourceOnlyDir, { recursive: true, force: true });
}

const enabledDir = await mkdtemp(join(tmpdir(), "ctbc-pglite-workflow-"));
const enabledLegacyDir = await mkdtemp(join(tmpdir(), "ctbc-pglite-no-sqlite-"));
const enabledWorker = new Worker(new URL("../../electron/pglite-view-worker.ts", import.meta.url), {
  execArgv: ["--experimental-strip-types"],
  workerData: { dataDir: enabledDir },
});
const enabledOwner = createPGliteViewWorkerClient(enabledWorker);
const enabledServer = createPGliteChildRpcServer({
  provider: {
    operational: enabledOwner.operationalProvider,
    financial: enabledOwner.financial.registry,
  },
});
const priorEnabledEnv = {
  required: process.env.OCTOPUSBEAK_PGLITE_WORKFLOW_REQUIRED,
  endpoint: process.env.OCTOPUSBEAK_PGLITE_CHILD_RPC_ENDPOINT,
  token: process.env.OCTOPUSBEAK_PGLITE_CHILD_RPC_TOKEN,
};
try {
  await enabledServer.ready;
  Object.assign(process.env, enabledServer.env);
  const output = await runCtbcStatements({} as never, { telemetry: false }, {
    canonicalLedgerDir: enabledLegacyDir,
    observedAt: "2026-08-24T12:34:56+08:00",
    readCurrentDepositBalances: async () => [],
    collectStatements: async () => ({
      output: { count: 1, rowCount: 1, downloads: [] },
      captures: [{
        accountId: "PRIVATE-CTBC-ACCOUNT",
        queryPeriods: ["2026/08/01~2026/08/31"],
        expectedRangeCount: 1,
        responses: [{
          rangeOrdinal: 0,
          startDate: "2026/08/01",
          endDate: "2026/08/31",
          code: "0000",
          nextKey: null,
          terminal: true,
          responseShape: {
            hasRsData: true,
            rsDataKind: "object",
            hasDetailList: true,
            detailListIsArray: true,
            detailListRowCount: 1,
            nextKeyPresent: false,
          },
          rows: ctbcDetailRowsToStatementRows(
            { accountId: "PRIVATE-CTBC-ACCOUNT", label: "PRIVATE-CTBC-LABEL" },
            [{
              actDtFull: "2026/08/03",
              trnDtFull: "2026/08/02",
              actDtTm: "2026-08-03-09.08.07.000000",
              memo1: "PRIVATE-CTBC-MEMO",
              dbAmtDisplay: "0",
              crAmtDisplay: "1,234",
              balanceAmt: "5,678",
            }],
          ),
        }],
      }],
    }),
  });
  assert.equal(output.status, "financial-admitted");
  assert.deepEqual(await readdir(enabledLegacyDir), []);
} finally {
  for (const [key, value] of [
    ["OCTOPUSBEAK_PGLITE_WORKFLOW_REQUIRED", priorEnabledEnv.required],
    ["OCTOPUSBEAK_PGLITE_CHILD_RPC_ENDPOINT", priorEnabledEnv.endpoint],
    ["OCTOPUSBEAK_PGLITE_CHILD_RPC_TOKEN", priorEnabledEnv.token],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await enabledServer.close();
  await enabledOwner.close();
  await rm(enabledLegacyDir, { recursive: true, force: true });
}
const enabledDb = await PGlite.create(enabledDir);
try {
  assert.equal((await enabledDb.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM financial_transactions")).rows[0]?.count, 1);
  assert.equal((await enabledDb.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM source_captures")).rows[0]?.count, 2);
} finally {
  await enabledDb.close();
  await rm(enabledDir, { recursive: true, force: true });
}

const successfulEmptyDir = await mkdtemp(
  join(tmpdir(), "ctbc-successful-empty-"),
);
try {
  const successfulEmpty = await runCtbcStatements(
    {} as never,
    { telemetry: false },
    {
      canonicalLedgerDir: successfulEmptyDir,
      observedAt: "2026-08-29T21:23:06+08:00",
      readCurrentDepositBalances: async () => [],
      collectStatements: async () => ({
        output: { count: 1, rowCount: 0, downloads: [] },
        captures: [
          {
            accountId: "PRIVATE-CTBC-ACCOUNT",
            queryPeriods: ["2026/03/01~2026/03/31"],
            expectedRangeCount: 1,
            responses: [
              {
                rangeOrdinal: 0,
                startDate: "2026/03/01",
                endDate: "2026/03/31",
                code: "0000",
                nextKey: null,
                terminal: true,
                rows: [],
                responseShape: {
                  hasRsData: true,
                  rsDataKind: "object",
                  hasDetailList: true,
                  detailListIsArray: true,
                  detailListRowCount: 0,
                  nextKeyPresent: false,
                },
              } as never,
            ],
          },
        ],
      }),
    },
  );
  assert.equal(successfulEmpty.status, "source-only");
  assert.equal(successfulEmpty.sourceCaptureCount, 1);
} finally {
  await rm(successfulEmptyDir, { recursive: true, force: true });
}

const rows = ctbcDetailRowsToStatementRows(
  { accountId: "123456", label: "新臺幣-123456" },
  [
    {
      actDtFull: "2026/07/03",
      trnDtFull: "2026/07/02",
      actDtTm: "2026-07-03-09.08.07.000000",
      memo1: "薪資",
      memo2: "七月",
      passBookMemo: "公司,入帳",
      dbAmtDisplay: "0",
      crAmtDisplay: "1,234",
      balanceAmt: "5,678",
      sortActDtTm: "2026 07 03 09:08:07 000",
    },
  ],
);

assert.deepEqual(
  rows.map((row) => row.values),
  [
    [
      "2026/07/03",
      "2026/07/02",
      "09:08:07",
      "薪資",
      "0",
      "1,234",
      "5,678",
      "公司,入帳 七月",
    ],
  ],
);

assert.equal(
  ctbcStatementRowsToCsv(rows),
  '帳務日期,交易日期,交易時間,摘要,支出金額,存入金額,即時餘額,附註\n2026/07/03,2026/07/02,09:08:07,薪資,0,"1,234","5,678","公司,入帳 七月"\n',
);

const syntheticCtbcAccountNumber = ["0000", "3145", "4055", "4100"].join("");
const conflictingCtbcAccountNumber = ["0000", "3145", "4055", "4101"].join("");

const currentRow = {
  source: "ctbc" as const,
  stream: "domestic-deposit" as const,
  accountNumber: syntheticCtbcAccountNumber,
  sourceAccountKey: syntheticCtbcAccountNumber,
  currency: "TWD" as const,
  ledger: { coefficient: "13155", scale: 0, sourceLexeme: "13,155" },
  providerFields: {
    accountId: syntheticCtbcAccountNumber,
    digiSvType: "",
    acctType: "01",
    accountNickName: "",
    openDt: "20200101",
    isRelaC: "N" as const,
  },
  effectiveAt: "2026-09-09T02:09:43.601Z",
  providerServerTime: 1788919783601,
  providerDataTime: "2026/09/09 10:09:43",
  providerHttpDate: "Wed, 09 Sep 2026 02:09:43 GMT",
  observedAt: "2026-09-09T10:10:00+08:00",
  sourceEvidence: {
    endpoint: "/IB/api/adapters/IB_Adapter/resource/ebmwResource" as const,
    requestResource: "/twrbc-deposit/qu001/010" as const,
    status: 200 as const,
    cacheControl: "no-cache, no-store, must-revalidate",
    contractVersion: "ctbc/current-deposit-balance-v1" as const,
  },
};

const existingIdentity = {
  authorityRoute: "ctbc/domestic-deposit/human-attested-v1",
  identity: {
    integrationNamespace: "ctbc",
    sourceConnectionKey: "sha256:ctbc-connection",
    identityEpochKey: "sha256:ctbc-epoch",
    stream: "domestic-deposit",
    subjectDigest: "sha256:ctbc-subject",
    accountNo: syntheticCtbcAccountNumber,
    sourceAccountKey: syntheticCtbcAccountNumber,
    accountNumber: { value: syntheticCtbcAccountNumber },
    currency: "TWD",
  },
};
const currentCapture = buildCtbcCurrentDepositBalanceCapture(
  currentRow,
  existingIdentity,
);
assert.equal(currentCapture.identity.sourceAccountKey, syntheticCtbcAccountNumber);
assert.equal(currentCapture.observations.length, 1);
assert.equal(currentCapture.observations[0]?.balanceKind, "ledger");
assert.equal(currentCapture.observations[0]?.sourceField, "balance");
assert.equal(currentCapture.observations[0]?.time.sourceField, "serverTime");
assert.equal(currentCapture.observations[0]?.time.sourceValue, "1788919783601");
assert.doesNotThrow(() => admitCurrentDepositBalanceCapture(currentCapture));
const pgliteBalanceRequest = currentDepositBalanceCommandRequest(admitCurrentDepositBalanceCapture(currentCapture));
assert.equal(pgliteBalanceRequest.capture.routeKey, "ctbc/domestic-deposit/current-balance-v1");
assert.equal(pgliteBalanceRequest.account.sourceAccountKey, syntheticCtbcAccountNumber);
assert.deepEqual(pgliteBalanceRequest.observations[0]?.balance, { coefficient: "13155", scale: 0 });
assert.equal(pgliteBalanceRequest.observations[0]?.evidenceSourceValue, "1788919783601");
assert.deepEqual(currentCapture.observations[0]?.balance, {
  coefficient: "13155",
  scale: 0,
});
assert.equal(currentCapture.providerResponse.requestResource, "/twrbc-deposit/qu001/010");
assert.doesNotMatch(
  JSON.stringify(currentCapture),
  /availableBalance|twdAcctSummaryTotalAmount|AUTH-TOKEN|deviceId/u,
);

const currentIdentityMap = indexCtbcCurrentDepositFinancialCaptures([
  existingIdentity,
]);
assert.equal(
  currentIdentityMap.get(
    `sha256:ctbc-connection\u0000sha256:ctbc-epoch\u0000domestic-deposit\u0000${syntheticCtbcAccountNumber}`,
  ),
  existingIdentity,
);
assert.throws(
  () =>
    buildCtbcCurrentDepositBalanceCapture(currentRow, {
      ...existingIdentity,
      identity: {
        ...existingIdentity.identity,
        accountNo: conflictingCtbcAccountNumber,
        sourceAccountKey: conflictingCtbcAccountNumber,
        accountNumber: { value: conflictingCtbcAccountNumber },
      },
    }),
  /exactly match existing account evidence/u,
);
assert.throws(
  () =>
    buildCtbcCurrentDepositBalanceCapture(currentRow, {
      ...existingIdentity,
      authorityRoute: "ctbc/domestic-deposit/preflight-v1",
    }),
  /not an admitted TWD CTBC account/u,
);
