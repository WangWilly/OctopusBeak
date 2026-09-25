import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { admitCurrentDepositBalanceCapture } from "../ledger/pglite/current-deposit-admission.ts";
import { currentDepositBalanceCommandRequest } from "../ledger/pglite/current-deposit-balance-command.ts";
import {
  buildCtbcCurrentDepositBalanceCapture,
  ctbcDetailRowsToStatementRows,
  indexCtbcCurrentDepositFinancialCaptures,
  resolveCtbcAccountScope,
} from "./ctbc-statements.ts";

const providerSource = readFileSync(new URL("./ctbc-statements.ts", import.meta.url), "utf8");
assert.doesNotMatch(providerSource, /from\s+["']libretto["']|export\s+default\s+workflow\s*\(|librettoAuthenticate|\bpause\(|npx libretto/u);
assert.doesNotMatch(providerSource, /node:fs\/promises|writeFile|downloads|csvFilename|csvPath|jsonFilename|jsonPath|ctbcResponseDiagnostic/u);
assert.doesNotMatch(providerSource, /requirePGliteChildRpcClientFromEnv|executePGliteWorkflowRun|pglite-child-rpc-client|runCtbcStatements/u);
assert.match(providerSource, /runCtbcProviderWorkflow/u);
assert.match(providerSource, /financialCommit\.execute/u);

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

const rows = ctbcDetailRowsToStatementRows([
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
]);

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
