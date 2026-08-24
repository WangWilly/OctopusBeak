import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  runSinopacStatements,
  sinopacApiRowsToStatementRows,
  sinopacManualAuthMessage,
  sinopacPasswordExpiryNoticeDismissTargets,
  sinopacQueryWindows,
  sinopacFilterAccounts,
  sinopacLoginEntryUrl,
  sinopacSortAccounts,
  sinopacSignedInPageUrl,
  sinopacStatementRowsToCsv,
  buildSinopacForeignCurrencyCaptureInput,
  SINOPAC_LOGIN_URL,
} from "./sinopac-statements.ts";
import { createCanonicalSourceStore } from "../ledger/canonical/canonical-source-store.ts";
import { admitForeignCurrencyDepositCapture } from "../ledger/canonical/foreign-currency-deposit.ts";

assert.deepEqual(
  sinopacQueryWindows({ startDate: "20250706", endDate: "20260705" }),
  [
    { startDate: "20260605", endDate: "20260705" },
    { startDate: "20260504", endDate: "20260604" },
    { startDate: "20260403", endDate: "20260503" },
    { startDate: "20260302", endDate: "20260402" },
    { startDate: "20260201", endDate: "20260301" },
    { startDate: "20251231", endDate: "20260131" },
    { startDate: "20251130", endDate: "20251230" },
    { startDate: "20251029", endDate: "20251129" },
    { startDate: "20250928", endDate: "20251028" },
    { startDate: "20250827", endDate: "20250927" },
    { startDate: "20250726", endDate: "20250826" },
    { startDate: "20250706", endDate: "20250725" },
  ],
);
assert.deepEqual(
  sinopacQueryWindows({ startDate: "20240229", endDate: "20240331" }),
  [{ startDate: "20240229", endDate: "20240331" }],
);
assert.deepEqual(
  sinopacQueryWindows({ startDate: "20260701", endDate: "20260731" }, 3),
  sinopacQueryWindows({ startDate: "20260701", endDate: "20260731" }),
);
assert.deepEqual(
  sinopacQueryWindows({ startDate: "20240101", endDate: "20240331" }),
  [
    { startDate: "20240229", endDate: "20240331" },
    { startDate: "20240128", endDate: "20240228" },
    { startDate: "20240101", endDate: "20240127" },
  ],
);

assert.equal(
  SINOPAC_LOGIN_URL,
  "https://mma.sinopac.com/MemberPortal/Member/MMALogin.aspx",
);
assert.equal(
  sinopacLoginEntryUrl(
    "https://mma.sinopac.com/MemberPortal/Member/MMALogin.aspx?from=start",
  ),
  true,
);
assert.equal(
  sinopacLoginEntryUrl(
    "https://mma.sinopac.com/mma/bank/transdetail/mma_transdetail.aspx",
  ),
  false,
);
assert.deepEqual(
  sinopacSortAccounts([
    { DataText: "USD account", DataValue: "002", DisplayText: "USD" },
    { DataText: "TWD account", DataValue: "003", DisplayText: "TWD" },
    { DataText: "TWD account", DataValue: "001", DisplayText: "TWD" },
  ]).map((account) => account.DataValue),
  ["001", "003", "002"],
);
assert.deepEqual(
  sinopacFilterAccounts(
    [
      { DataText: "USD account", DataValue: "002", DisplayText: "USD" },
      { DataText: "TWD account", DataValue: "001", DisplayText: "TWD" },
    ],
    [],
    [],
  ).map((account) => account.DataValue),
  ["001", "002"],
);
assert.equal(
  sinopacManualAuthMessage("sinopac-demo"),
  "manual-auth-required: enter the SinoPac CAPTCHA in the browser, then run `npx libretto resume --session sinopac-demo`.",
);

const sinopacForeignCapture = buildSinopacForeignCurrencyCaptureInput(
  { DataText: "USD account", DataValue: "002", DisplayText: "USD" },
  [
    {
      sortKey: "2026/08/23 09:10",
      values: [
        "2026/08/23",
        "",
        "09:10",
        "foreign deposit",
        "",
        "10.00",
        "110.00",
        "memo",
        "31.50",
      ],
    },
  ],
  { startDate: "20260801", endDate: "20260823" },
  "2026-08-24T12:00:00+08:00",
);
assert.equal(sinopacForeignCapture.accountType, "depository");
assert.equal(
  sinopacForeignCapture.records[0]!.sourceReportedRate?.rate,
  "31.50",
);
assert.deepEqual(
  admitForeignCurrencyDepositCapture(sinopacForeignCapture).records[0]!
    .conversionEvidence?.sourceReportedRate?.amount,
  { coefficient: "315", scale: 1 },
);

const sourceDir = await mkdtemp(join(tmpdir(), "sinopac-workflow-source-"));
try {
  const accounts = [
    { DataText: "TWD account", DataValue: "001", DisplayText: "TWD" },
    { DataText: "USD account", DataValue: "002", DisplayText: "USD" },
  ];
  let writeCount = 0;
  const result = await runSinopacStatements(
    {} as never,
    {
      startDate: "20260801",
      endDate: "20260823",
      accountFilters: [],
      currencyFilters: [],
    },
    accounts,
    {
      canonicalSourceLedgerDir: sourceDir,
      queryTransactions: async (account) => ({
        Header: "SUCCESS",
        SubInfo: [
          {
            DataText1: "2026/08/02<br />09:10",
            DataText2: "2026/08/02",
            DataText3: `${account.DisplayText} transaction`,
            DataText4: "-100",
            DataText5: "900",
          },
        ],
      }),
      writeStatementFile: async (account, queryPeriods, rows) => {
        writeCount += 1;
        return {
          accountId: account.DataValue ?? "",
          account: account.DataText ?? "",
          currency: account.DisplayText ?? "",
          kind:
            account.DisplayText === "TWD"
              ? ("domestic" as const)
              : ("foreign" as const),
          queryPeriods,
          baseName: "synthetic",
          csvFilename: "synthetic.csv",
          csvPath: "synthetic.csv",
          csvBytes: 1,
          jsonFilename: "synthetic.json",
          jsonPath: "synthetic.json",
          jsonBytes: 1,
          rowCount: rows.length,
        };
      },
    },
  );
  assert.equal(result.status, "source-only");
  assert.equal(result.count, 2);
  assert.equal(result.skippedAccounts.length, 0);
  assert.equal(writeCount, 2);
  const financialDir = await mkdtemp(
    join(tmpdir(), "sinopac-workflow-financial-"),
  );
  try {
    const financialResult = await runSinopacStatements(
      {} as never,
      {
        startDate: "20260801",
        endDate: "20260823",
        accountFilters: [],
        currencyFilters: [],
      },
      accounts,
      {
        canonicalSourceLedgerDir: sourceDir,
        canonicalFinancialLedgerDir: financialDir,
        queryTransactions: async (account) => ({
          Header: "SUCCESS",
          SubInfo: [
            {
              DataText1: "2026/08/02<br />09:10",
              DataText2: "2026/08/02",
              DataText3: `${account.DisplayText} financial transaction`,
              DataText4: "-100",
              DataText5: "900",
            },
          ],
        }),
        writeStatementFile: async (account, queryPeriods, rows) => ({
          accountId: account.DataValue ?? "",
          account: account.DataText ?? "",
          currency: account.DisplayText ?? "",
          kind: account.DisplayText === "TWD" ? "domestic" : "foreign",
          queryPeriods,
          baseName: "financial",
          csvFilename: "financial.csv",
          csvPath: "financial.csv",
          csvBytes: 1,
          jsonFilename: "financial.json",
          jsonPath: "financial.json",
          jsonBytes: 1,
          rowCount: rows.length,
        }),
      },
    );
    assert.equal(financialResult.status, "financial-admitted");
    const financialStore = createCanonicalSourceStore(
      join(financialDir, "canonical.sqlite"),
    );
    try {
      assert.equal(
        Number(
          (
            financialStore.db
              .prepare("SELECT COUNT(*) AS count FROM financial_transactions")
              .get() as { count?: number }
          ).count ?? 0,
        ),
        2,
        "both TWD and foreign-currency accounts are financially admitted",
      );
      assert.equal(
        Number(
          (
            financialStore.db
              .prepare(
                "SELECT COUNT(*) AS count FROM source_captures WHERE stream = 'foreign-currency-deposit'",
              )
              .get() as { count?: number }
          ).count ?? 0,
        ),
        1,
        "foreign currency has a canonical financial capture",
      );
    } finally {
      financialStore.close();
    }
  } finally {
    await rm(financialDir, { recursive: true, force: true });
  }
  const duplicateResult = await runSinopacStatements(
    {} as never,
    {
      startDate: "20260801",
      endDate: "20260823",
      accountFilters: [],
      currencyFilters: [],
    },
    [{ DataText: "duplicate account", DataValue: "003", DisplayText: "TWD" }],
    {
      canonicalSourceLedgerDir: sourceDir,
      queryTransactions: async () => ({
        Header: "SUCCESS",
        SubInfo: [
          {
            DataText1: "2026/08/02<br />09:10",
            DataText2: "2026/08/02",
            DataText3: "same transaction",
            DataText4: "100",
            DataText5: "900",
          },
          {
            DataText1: "2026/08/02<br />09:10",
            DataText2: "2026/08/02",
            DataText3: "same transaction",
            DataText4: "100",
            DataText5: "900",
          },
        ],
      }),
      writeStatementFile: async (account, queryPeriods, rows) => ({
        accountId: account.DataValue ?? "",
        account: account.DataText ?? "",
        currency: account.DisplayText ?? "",
        kind: "domestic",
        queryPeriods,
        baseName: "synthetic-duplicates",
        csvFilename: "synthetic-duplicates.csv",
        csvPath: "synthetic-duplicates.csv",
        csvBytes: 1,
        jsonFilename: "synthetic-duplicates.json",
        jsonPath: "synthetic-duplicates.json",
        jsonBytes: 1,
        rowCount: rows.length,
      }),
    },
  );
  assert.equal(duplicateResult.downloads[0]?.rowCount, 2);
  const absentResult = await runSinopacStatements(
    {} as never,
    {
      startDate: "20260801",
      endDate: "20260823",
      accountFilters: [],
      currencyFilters: [],
    },
    [accounts[0]!],
    {
      canonicalSourceLedgerDir: sourceDir,
      queryTransactions: async () => ({
        Header: "FAIL",
        Message: "查無資料",
      }),
      writeStatementFile: async () => {
        throw new Error("provider no-data must not write a file");
      },
    },
  );
  assert.equal(absentResult.status, "source-only");
  assert.equal(absentResult.downloads.length, 0);
  assert.deepEqual(absentResult.skippedAccounts, [
    { accountId: "001", currency: "TWD", reason: "provider-explicit-no-data" },
  ]);
  const foreignAbsentResult = await runSinopacStatements(
    {} as never,
    {
      startDate: "20260801",
      endDate: "20260823",
      accountFilters: [],
      currencyFilters: [],
    },
    [accounts[1]!],
    {
      canonicalSourceLedgerDir: sourceDir,
      queryTransactions: async () => ({
        Header: "FAIL",
        Message: "查無資料",
      }),
      writeStatementFile: async () => {
        throw new Error("provider no-data must not write a file");
      },
    },
  );
  assert.deepEqual(foreignAbsentResult.skippedAccounts, [
    { accountId: "002", currency: "USD", reason: "provider-explicit-no-data" },
  ]);
  const noDataStore = createCanonicalSourceStore(
    join(sourceDir, "canonical.sqlite"),
  );
  try {
    assert.equal(
      Number(
        (
          noDataStore.db
            .prepare(
              "SELECT COUNT(*) AS count FROM capture_scopes WHERE absence_authority = 'provider-explicit-no-data'",
            )
            .get() as { count?: number }
        ).count ?? 0,
      ),
      2,
    );
  } finally {
    noDataStore.close();
  }
  const mixedResult = await runSinopacStatements(
    {} as never,
    {
      startDate: "20260701",
      endDate: "20260823",
      accountFilters: [],
      currencyFilters: [],
    },
    [{ DataText: "mixed account", DataValue: "004", DisplayText: "TWD" }],
    {
      canonicalSourceLedgerDir: sourceDir,
      queryTransactions: async (_account, window) =>
        window.endDate === "20260823"
          ? {
              Header: "SUCCESS",
              SubInfo: [
                {
                  DataText1: "2026/08/02<br />09:10",
                  DataText2: "2026/08/02",
                  DataText3: "mixed-window transaction",
                  DataText4: "100",
                  DataText5: "900",
                },
              ],
            }
          : { Header: "FAIL", Message: "查無資料" },
      writeStatementFile: async (account, queryPeriods, rows) => ({
        accountId: account.DataValue ?? "",
        account: account.DataText ?? "",
        currency: account.DisplayText ?? "",
        kind: "domestic",
        queryPeriods,
        baseName: "mixed-window",
        csvFilename: "mixed-window.csv",
        csvPath: "mixed-window.csv",
        csvBytes: 1,
        jsonFilename: "mixed-window.json",
        jsonPath: "mixed-window.json",
        jsonBytes: 1,
        rowCount: rows.length,
      }),
    },
  );
  assert.equal(mixedResult.rowCount, 1);
  assert.deepEqual(mixedResult.skippedAccounts, []);
  const mixedStore = createCanonicalSourceStore(
    join(sourceDir, "canonical.sqlite"),
  );
  try {
    assert.equal(
      Number(
        (
          mixedStore.db
            .prepare(
              "SELECT COUNT(*) AS count FROM capture_scopes WHERE scope_start = '20260701' AND scope_end = '20260823' AND absence_authority IS NULL",
            )
            .get() as { count?: number }
        ).count ?? 0,
      ),
      1,
    );
  } finally {
    mixedStore.close();
  }
  await assert.rejects(
    () =>
      runSinopacStatements(
        {} as never,
        {
          startDate: "20260801",
          endDate: "20260823",
          accountFilters: [],
          currencyFilters: [],
        },
        [accounts[0]!],
        {
          canonicalSourceLedgerDir: sourceDir,
          queryTransactions: async () => ({ Header: "SUCCESS" }),
        },
      ),
    /source admission blocked|zero-result-authority-unproven/i,
  );
} finally {
  await rm(sourceDir, { recursive: true, force: true });
}

assert.deepEqual(sinopacPasswordExpiryNoticeDismissTargets().slice(0, 2), [
  'a:has-text("延用舊密碼"):visible',
  'button:has-text("延用舊密碼"):visible',
]);

assert.equal(
  sinopacSignedInPageUrl(
    "https://mma.sinopac.com/mma/mymma/myasset/mma_assets_summary.aspx",
  ),
  true,
);
assert.equal(
  sinopacSignedInPageUrl(
    "https://mma.sinopac.com/mma/bank/transdetail/mma_transdetail.aspx",
  ),
  true,
);
assert.equal(
  sinopacSignedInPageUrl(
    "https://mma.sinopac.com/MemberPortal/Member/Trade.aspx",
  ),
  false,
);

const rows = sinopacApiRowsToStatementRows([
  {
    DataText1: "2025/09/29<br />06:01",
    DataText2: "2025/09/29",
    DataText3: "電子交易",
    DataText4: '<font color="#ff6000">-109</font>',
    DataText5: "9,029",
    DataText7: "31.2",
    DataText8: "一卡通Money自動儲值<br>iPASS MO",
  },
  {
    DataText1: "2025/10/21<br />00:13",
    DataText2: "2025/10/21",
    DataText3: "利息存入",
    DataText4: '<font color="#009a12">6</font>',
    DataText5: "9,035",
  },
]);

assert.deepEqual(
  rows.map((row) => row.values),
  [
    [
      "2025/09/29",
      "2025/09/29",
      "06:01",
      "電子交易",
      "109",
      "",
      "9,029",
      "一卡通Money自動儲值 iPASS MO",
      "31.2",
    ],
    ["2025/10/21", "2025/10/21", "00:13", "利息存入", "", "6", "9,035", "", ""],
  ],
);

assert.equal(
  sinopacStatementRowsToCsv(rows),
  '帳務日期,交易日期,交易時間,摘要,支出金額,存入金額,即時餘額,附註,匯率\n2025/09/29,2025/09/29,06:01,電子交易,109,,"9,029",一卡通Money自動儲值 iPASS MO,31.2\n2025/10/21,2025/10/21,00:13,利息存入,,6,"9,035",,\n',
);
