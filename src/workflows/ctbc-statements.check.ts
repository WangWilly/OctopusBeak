import assert from "node:assert/strict";
import { indexCurrentBalanceCaptures } from "./current-balance-capture-match.ts";
import { readFileSync } from "node:fs";
import { admitCurrentDepositBalanceCapture } from "../ledger/pglite/current-deposit-admission.ts";
import { currentDepositBalanceCommandRequest } from "../ledger/pglite/current-deposit-balance-command.ts";
import type { ProductCollectionHandle, ProductStageRequest } from "../lib/automation/product-collection.ts";
import { strictSourceText } from "../lib/automation/source-text.ts";
import type { WorkflowContext } from "../lib/automation/workflow-executor.ts";
import {
  buildCtbcCurrentDepositBalanceCapture,
  ctbcDetailRowsToStatementRows,
  ctbcResponseShape,
  ctbcCurrentBalanceCaptureMatching,
  resolveCtbcAccountScope,
  stageCtbcDeposit,
  type CtbcDepositSourceSnapshot,
  type CtbcObservedAccountCapture,
} from "./ctbc-statements.ts";

const providerSource = readFileSync(new URL("./ctbc-statements.ts", import.meta.url), "utf8");
assert.doesNotMatch(providerSource, /from\s+["']libretto["']|export\s+default\s+workflow\s*\(|librettoAuthenticate|\bpause\(|npx libretto/u);
assert.doesNotMatch(providerSource, /node:fs\/promises|writeFile|downloads|csvFilename|csvPath|jsonFilename|jsonPath|ctbcResponseDiagnostic/u);
assert.doesNotMatch(providerSource, /requirePGliteChildRpcClientFromEnv|executePGliteWorkflowRun|pglite-child-rpc-client|runCtbcStatements/u);

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

const admittedCaptures = indexCurrentBalanceCaptures(
  [existingIdentity],
  ctbcCurrentBalanceCaptureMatching,
);
assert.equal(
  admittedCaptures.match([{ stream: "domestic-deposit", sourceAccountKey: syntheticCtbcAccountNumber }])
    .matched[0]?.capture,
  existingIdentity,
);
assert.throws(
  () => admittedCaptures.match([{ stream: "domestic-deposit", sourceAccountKey: conflictingCtbcAccountNumber }]),
  /^Error: CTBC current deposit snapshot has no admitted account identity\.$/u,
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

function stagingHarness(signal = new AbortController().signal) {
  const events: string[] = [];
  const staged: ProductStageRequest[] = [];
  let balanceReads = 0;
  const context: WorkflowContext = {
    runId: "ctbc-stage-check",
    signal,
    now: () => "2026-09-09T02:10:00.000Z",
    browser: { withPage: async () => assert.fail("the build half never opens a page") },
    text: strictSourceText,
    verification: { complete: async () => assert.fail("the build half never asks for assistance") },
    event: async (_stage, _outcome, code) => { events.push(code); },
    signalEvent: async () => undefined,
  };
  const product: ProductCollectionHandle = {
    stage: (...requests) => { staged.push(...requests); },
    reportActivity: async () => undefined,
    event: context.event,
  };
  return {
    events,
    staged,
    get balanceReads() { return balanceReads; },
    stage(snapshot: CtbcDepositSourceSnapshot, rows: readonly (typeof currentRow)[] | Error) {
      return stageCtbcDeposit(snapshot, { credentials: {
        ctbc_user_id: "synthetic-user", ctbc_account: "synthetic-account", ctbc_password: "synthetic-password",
      } }, context, product, async () => {
        balanceReads += 1;
        if (rows instanceof Error) throw rows;
        return rows;
      });
    },
  };
}

function observedAccount(accountId: string, detailList: Parameters<typeof ctbcDetailRowsToStatementRows>[0]): CtbcObservedAccountCapture {
  const body = { code: "0000" as const, rsData: { detailList, nextKey: "" } };
  return {
    accountId,
    queryPeriods: ["2026/08/01~2026/08/31"],
    expectedRangeCount: 1,
    responses: [{
      rangeOrdinal: 0,
      startDate: "2026/08/01",
      endDate: "2026/08/31",
      code: "0000",
      nextKey: null,
      terminal: true,
      rows: ctbcDetailRowsToStatementRows(detailList),
      responseShape: ctbcResponseShape(body),
    }],
  };
}

const salary = {
  actDtFull: "2026/08/03", trnDtFull: "2026/08/03",
  actDtTm: "2026-08-03-09.08.07.000000", sortActDtTm: "2026 08 03 09:08:07 000",
  memo1: "Synthetic salary", dbAmtDisplay: "0", crAmtDisplay: "1,234", balanceAmt: "5,678",
};
const financialSnapshot: CtbcDepositSourceSnapshot = {
  output: { count: 1, rowCount: 1 },
  captures: [observedAccount(syntheticCtbcAccountNumber, [salary])],
};

{
  // A financial capture stages its statement and the matched current balance together.
  const harness = stagingHarness();
  assert.deepEqual(await harness.stage(financialSnapshot, [currentRow]), { sourceCaptureCount: 1, rowCount: 1 });
  assert.equal(harness.balanceReads, 1);
  assert.deepEqual(harness.staged.map((item) => [item.product, item.command.kind]), [
    ["domestic-deposit", "financial.mixed.commit"],
    ["current-balance", "financial.balance.capture"],
  ]);
}

{
  // A source with fewer captures than selected accounts stages nothing and never reads balances.
  const harness = stagingHarness();
  await assert.rejects(
    harness.stage({ output: { count: 2, rowCount: 1 }, captures: financialSnapshot.captures }, [currentRow]),
    /no complete selected account capture/u,
  );
  assert.deepEqual(harness.events, ["source-validation-rejected"]);
  assert.deepEqual(harness.staged, []);
  assert.equal(harness.balanceReads, 0);
}

{
  // A capture that misses a range the bootstrap promised fails source admission before any balance read.
  const harness = stagingHarness();
  const incomplete = { ...financialSnapshot.captures[0]!, expectedRangeCount: 2 };
  await assert.rejects(
    harness.stage({ output: { count: 1, rowCount: 1 }, captures: [incomplete] }, [currentRow]),
    /source admission blocked/u,
  );
  assert.deepEqual(harness.events, ["source-validation-started", "source-validation-rejected"]);
  assert.deepEqual(harness.staged, []);
  assert.equal(harness.balanceReads, 0);
}

{
  // A current-balance row without an admitted statement identity rejects the whole product.
  const harness = stagingHarness();
  await assert.rejects(
    harness.stage(financialSnapshot, [{
      ...currentRow,
      accountNumber: conflictingCtbcAccountNumber,
      sourceAccountKey: conflictingCtbcAccountNumber,
    }]),
    /current balance source admission was rejected/u,
  );
  assert.ok(harness.events.includes("current-balance-validation-rejected"));
  assert.deepEqual(harness.staged, []);
}

{
  // A failed current-balance read fails the product with its own collection error.
  const harness = stagingHarness();
  await assert.rejects(
    harness.stage(financialSnapshot, new Error("synthetic balance page failure")),
    /current balance source collection failed/u,
  );
  assert.deepEqual(harness.events.slice(-2), ["current-balance-decoding-failed", "current-balance-collection-failed"]);
  assert.deepEqual(harness.staged, []);
}

{
  // A cancelled run builds nothing and never opens the balance page.
  const cancellation = new AbortController();
  cancellation.abort();
  const harness = stagingHarness(cancellation.signal);
  await assert.rejects(harness.stage(financialSnapshot, [currentRow]), /abort/iu);
  assert.deepEqual(harness.events, []);
  assert.deepEqual(harness.staged, []);
  assert.equal(harness.balanceReads, 0);
}
