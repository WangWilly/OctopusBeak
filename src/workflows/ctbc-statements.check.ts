import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalSqlitePath,
  createCanonicalSourceStore,
} from "../ledger/canonical/canonical-source-store.ts";
import {
  ctbcDetailTelemetry,
  ctbcDetailRowsToStatementRows,
  ctbcStatementRowsToCsv,
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
      canonicalSourceLedgerDir: sourceOnlyDir,
      observedAt: "2026-08-24T12:34:56+08:00",
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
  assert.equal(sourceOnly.status, "source-only");
  assert.equal(sourceOnly.sourceCaptureCount, 1);
  const verify = createCanonicalSourceStore(canonicalSqlitePath(sourceOnlyDir));
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
  assert.equal(sourceCount.count, 1);
  assert.equal(financialCount.count, 0);
  assert.doesNotMatch(
    JSON.stringify(payloads),
    /PRIVATE-CTBC|1,234|5,678|2026\/08\/0[23]/,
  );
} finally {
  await rm(sourceOnlyDir, { recursive: true, force: true });
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
