import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  runSinopacStatements,
  sinopacApiRowsToStatementRows,
  sinopacManualAuthMessage,
  sinopacCaptchaAssistanceStage,
  sinopacPasswordExpiryNoticeDismissTargets,
  sinopacQueryWindows,
  sinopacFilterAccounts,
  sinopacLoginEntryUrl,
  sinopacSortAccounts,
  sinopacSignedInPageUrl,
  sinopacStatementRowsToCsv,
  runSinopacIdentityValidation,
  sinopacIdentityValidationSchema,
  SINOPAC_LOGIN_URL,
} from "./sinopac-statements.ts";
import { type SinopacIdentityRawRow } from "./sinopac-identity-evidence.ts";
import { createCanonicalSourceStore } from "../ledger/canonical/canonical-source-store.ts";

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
const captchaSelectors: string[] = [];
const captchaStage = sinopacCaptchaAssistanceStage({
  locator(selector: string) {
    captchaSelectors.push(selector);
    return { selector };
  },
} as never);
assert.equal(captchaStage.challengeKind, "text-captcha");
assert.equal(captchaStage.charset, "digits");
assert.equal(captchaStage.imagePreprocessing, undefined);
assert.equal(captchaStage.ocrPageSegmentationMode, "single-line");
assert.deepEqual(captchaStage.ocrAttemptPlan, [
  { imagePreprocessing: ["remove-interference-lines"] },
]);
assert.deepEqual(captchaStage.solveAcceptancePolicy, {
  mode: "confidence-only",
});
assert.equal(captchaStage.solverConfidenceThreshold, 0.9);
assert.equal(captchaStage.expectedAnswerLength, 6);
assert.equal(
  captchaStage.challengeImageRegion?.semanticId,
  "sinopac.login.captcha-image",
);
assert.deepEqual(captchaSelectors, [
  'input[id$="sino_keyword3"]',
  "#imgCode",
]);
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
        "domestic and human-attested foreign SinoPac rows are admitted",
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
        "SinoPac foreign currency uses the human-attested canonical contract",
      );
    } finally {
      financialStore.close();
    }
  } finally {
    await rm(financialDir, { recursive: true, force: true });
  }
  const foreignOnlyFinancialDir = await mkdtemp(
    join(tmpdir(), "sinopac-workflow-foreign-source-only-"),
  );
  try {
    const foreignOnlyResult = await runSinopacStatements(
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
        canonicalFinancialLedgerDir: foreignOnlyFinancialDir,
        queryTransactions: async () => ({
          Header: "SUCCESS",
          SubInfo: [
            {
              DataText1: "2026/08/02<br />09:10",
              DataText2: "2026/08/02",
              DataText3: "foreign source-only transaction",
              DataText4: "-100",
              DataText5: "900",
            },
          ],
        }),
        writeStatementFile: async (account, queryPeriods, rows) => ({
          accountId: account.DataValue ?? "",
          account: account.DataText ?? "",
          currency: account.DisplayText ?? "",
          kind: "foreign",
          queryPeriods,
          baseName: "foreign-source-only",
          csvFilename: "foreign-source-only.csv",
          csvPath: "foreign-source-only.csv",
          csvBytes: 1,
          jsonFilename: "foreign-source-only.json",
          jsonPath: "foreign-source-only.json",
          jsonBytes: 1,
          rowCount: rows.length,
        }),
      },
    );
    assert.equal(foreignOnlyResult.status, "financial-admitted");
    const foreignOnlyStore = createCanonicalSourceStore(
      join(foreignOnlyFinancialDir, "canonical.sqlite"),
    );
    try {
      assert.equal(
        Number(
          (
            foreignOnlyStore.db
              .prepare("SELECT COUNT(*) AS count FROM financial_transactions")
              .get() as { count?: number }
          ).count ?? 0,
        ),
        1,
      );
      assert.equal(
        Number(
          (
            foreignOnlyStore.db
              .prepare(
                "SELECT COUNT(*) AS count FROM source_captures WHERE stream = 'foreign-currency-deposit'",
              )
              .get() as { count?: number }
          ).count ?? 0,
        ),
        1,
      );
      const firstForeignPayload = JSON.parse(
        String(
          (
            foreignOnlyStore.db
              .prepare(
                "SELECT payload_json FROM source_records WHERE record_kind = 'sinopac-foreign-currency-deposit'",
              )
              .get() as { payload_json?: unknown }
          ).payload_json ?? "",
        ),
      ) as { sourceKey?: string };
      assert.equal(
        firstForeignPayload.sourceKey,
        "002:USD:2026-08-02T09:10:-100:900",
      );
      const repeatedForeignResult = await runSinopacStatements(
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
          canonicalFinancialLedgerDir: foreignOnlyFinancialDir,
          queryTransactions: async () => ({
            Header: "SUCCESS",
            SubInfo: [
              {
                DataText1: "2026/08/02<br />09:10",
                DataText2: "2026/08/02",
                DataText3: "foreign source-only transaction",
                DataText4: "-100.00",
                DataText5: "900.0",
                DataText9: "different display-only value",
              },
            ],
          }),
          writeStatementFile: async (account, queryPeriods, rows) => ({
            accountId: account.DataValue ?? "",
            account: account.DataText ?? "",
            currency: account.DisplayText ?? "",
            kind: "foreign",
            queryPeriods,
            baseName: "foreign-repeat",
            csvFilename: "foreign-repeat.csv",
            csvPath: "foreign-repeat.csv",
            csvBytes: 1,
            jsonFilename: "foreign-repeat.json",
            jsonPath: "foreign-repeat.json",
            jsonBytes: 1,
            rowCount: rows.length,
          }),
        },
      );
      assert.equal(repeatedForeignResult.status, "financial-admitted");
      assert.equal(
        Number(
          (
            foreignOnlyStore.db
              .prepare("SELECT COUNT(*) AS count FROM financial_transactions")
              .get() as { count?: number }
          ).count ?? 0,
        ),
        1,
        "normalized amount and balance lexemes keep one authority transaction",
      );
      assert.equal(
        Number(
          (
            foreignOnlyStore.db
              .prepare(
                "SELECT COUNT(*) AS count FROM source_records WHERE record_kind = 'sinopac-foreign-currency-deposit'",
              )
              .get() as { count?: number }
          ).count ?? 0,
        ),
        2,
        "the repeated capture adds provenance without duplicating authority",
      );
      const foreignPayloads = foreignOnlyStore.db
        .prepare(
          "SELECT payload_json FROM source_records WHERE record_kind = 'sinopac-foreign-currency-deposit'",
        )
        .all() as Array<{ payload_json?: unknown }>;
      assert.equal(
        foreignPayloads.some((row) =>
          String(row.payload_json ?? "").includes(
            "different display-only value",
          ),
        ),
        false,
        "DataText9 never enters identity or canonical payload",
      );
    } finally {
      foreignOnlyStore.close();
    }
  } finally {
    await rm(foreignOnlyFinancialDir, { recursive: true, force: true });
  }
  const foreignCollisionDir = await mkdtemp(
    join(tmpdir(), "sinopac-workflow-foreign-collision-"),
  );
  try {
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
          [accounts[1]!],
          {
            canonicalSourceLedgerDir: sourceDir,
            canonicalFinancialLedgerDir: foreignCollisionDir,
            queryTransactions: async () => ({
              Header: "SUCCESS",
              SubInfo: [
                {
                  DataText1: "2026/08/02<br />09:10",
                  DataText2: "2026/08/02",
                  DataText3: "first indistinguishable row",
                  DataText4: "-100",
                  DataText5: "900",
                },
                {
                  DataText1: "2026/08/02<br />09:10",
                  DataText2: "2026/08/02",
                  DataText3: "second indistinguishable row",
                  DataText4: "-100.00",
                  DataText5: "900.0",
                },
              ],
            }),
            writeStatementFile: async () => {
              throw new Error("collision must fail before statement writing");
            },
          },
        ),
      /human-attested source identity collision/i,
    );
    const collisionStore = createCanonicalSourceStore(
      join(foreignCollisionDir, "canonical.sqlite"),
    );
    try {
      assert.equal(
        Number(
          (
            collisionStore.db
              .prepare("SELECT COUNT(*) AS count FROM financial_transactions")
              .get() as { count?: number }
          ).count ?? 0,
        ),
        0,
      );
    } finally {
      collisionStore.close();
    }
  } finally {
    await rm(foreignCollisionDir, { recursive: true, force: true });
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

const identityInput = sinopacIdentityValidationSchema.parse({
  startDate: "20250825",
  endDate: "20260824",
  currency: "USD",
  overlapStartDate: "20260224",
  overlapEndDate: "20260824",
});
assert.equal(identityInput.currency, "USD");
assert.equal(
  sinopacIdentityValidationSchema.safeParse({
    startDate: "20250825",
    endDate: "20260824",
    currency: "TWD",
  }).success,
  false,
);

const identityRows: SinopacIdentityRawRow[] = [
  {
    DataText1: "2026/08/20 09:00",
    DataText2: "2026/08/20",
    DataText3: "synthetic row one",
    DataText4: "100.00",
    DataText5: "900.00",
    DataText6: "candidate-one",
    DataText7: "31.1",
    DataText8: "note-one",
    DataText9: "100.00<br />900.00",
    DataText10: "candidate-ten-one",
    DataText11: "candidate-eleven-one",
  },
  {
    DataText1: "2026/08/21 10:00",
    DataText2: "2026/08/21",
    DataText3: "synthetic row two",
    DataText4: "200.00",
    DataText5: "700.00",
    DataText6: "candidate-two",
    DataText7: "31.2",
    DataText8: "note-two",
    DataText9: "200.00<br />700.00",
    DataText10: "candidate-ten-two",
    DataText11: "candidate-eleven-two",
  },
];
const identityResponse = {
  Header: "SUCCESS",
  RecordCount: "3",
  SubInfo: [identityRows[0]!, identityRows[1]!, identityRows[0]!],
};
let identityQueryCount = 0;
const identityPage = {
  url: () => SINOPAC_LOGIN_URL,
  context: () => ({ cookies: async () => [] }),
  locator: () => ({
    all: async () => [],
    count: async () => 0,
  }),
  getByText: () => ({ count: async () => 0 }),
  evaluate: async (expression: unknown) => {
    if (typeof expression === "string") {
      return {
        botGlobal: false,
        fetchSource: "function fetch() { [native code] }",
        openSource: "function open() { [native code] }",
      };
    }
    identityQueryCount += 1;
    return [identityResponse];
  },
} as never;
const identitySummary = await runSinopacIdentityValidation(
  identityPage,
  identityInput,
  [{ DataText: "USD account", DataValue: "002", DisplayText: "USD" }],
);
assert.equal(identitySummary.mode, "identity-validation");
assert.equal(identitySummary.captures.length, 3);
assert.equal(identitySummary.exactRepeat.rowSetEqual, true);
assert.equal(identitySummary.overlap.rightRowsContained, true);
assert.equal(identitySummary.captures[0]?.duplicateCompleteRowsExist, true);
assert.equal(
  identitySummary.candidateFields.DataText6?.populationByCapture[
    "exact-repeat-1"
  ].uniqueWithinCapture,
  false,
);
assert.equal(
  identitySummary.candidateFields.DataText6?.exactRepeat.stableForMatchedRows,
  true,
);
assert.equal(
  identitySummary.derivedFields.DataText9.formula,
  'DataText4 + "<br />" + DataText5',
);
for (const capture of identitySummary.captures) {
  const derivation =
    identitySummary.derivedFields.DataText9.populationByCapture[capture.label];
  assert.equal(derivation.evaluatedRows, capture.rowCount);
  assert.equal(derivation.exactMatches, capture.rowCount);
  assert.equal(derivation.exactForAllEvaluatedRows, true);
}
assert.deepEqual(identitySummary.siteAssessment, {
  botProtectionDetected: false,
  fetchXhrWrapperCategory: { fetch: "native", xhr: "native" },
  challengeType: "none",
});
assert.deepEqual(identitySummary.sideEffects, {
  canonicalCommits: false,
  statementFilesWritten: false,
  rawValuesReturned: false,
});
assert.equal(
  identityQueryCount,
  sinopacQueryWindows({ startDate: "20250825", endDate: "20260824" }).length *
    2 +
    sinopacQueryWindows({ startDate: "20260224", endDate: "20260824" }).length,
);
const redactedIdentitySummary = JSON.stringify(identitySummary);
assert.equal(redactedIdentitySummary.includes("candidate-one"), false);
assert.equal(redactedIdentitySummary.includes("USD account"), false);
assert.equal(redactedIdentitySummary.includes("002"), false);
