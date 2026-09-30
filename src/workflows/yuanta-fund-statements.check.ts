import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CanonicalInvestmentAdmissionError } from "../ledger/canonical/investment-financial-admission.ts";
import { strictSourceText } from "../lib/automation/source-text.ts";
import type { PGliteWorkflowRunItem } from "../ledger/pglite/workflow-run.ts";
import { runSelectedStatements } from "./run-selected-statements.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./browser-interaction.js") {
      return nextResolve("./browser-interaction.ts", context);
    }
    if (specifier === "./yuanta-statements.js") {
      return nextResolve("./yuanta-statements.ts", context);
    }
    return nextResolve(specifier, context);
  },
});

const yuantaFundModule = await import("./yuanta-fund-statements.ts");
const evaluateYuantaFundCanonicalAdmission: typeof yuantaFundModule.evaluateYuantaFundCanonicalAdmission =
  yuantaFundModule.evaluateYuantaFundCanonicalAdmission;
const assertYuantaFundCanonicalAdmission: typeof yuantaFundModule.assertYuantaFundCanonicalAdmission =
  yuantaFundModule.assertYuantaFundCanonicalAdmission;
const isYuantaFundPositionAbsentText: typeof yuantaFundModule.isYuantaFundPositionAbsentText =
  yuantaFundModule.isYuantaFundPositionAbsentText;
const parseYuantaFundValuationBasis: typeof yuantaFundModule.parseYuantaFundValuationBasis =
  yuantaFundModule.parseYuantaFundValuationBasis;
const canonicalYuantaFundCurrency: typeof yuantaFundModule.canonicalYuantaFundCurrency =
  yuantaFundModule.canonicalYuantaFundCurrency;
const runYuantaFundStatements: typeof yuantaFundModule.runYuantaFundStatements =
  yuantaFundModule.runYuantaFundStatements;
const yuantaFundStatementsInputSchema: typeof yuantaFundModule.yuantaFundStatementsInputSchema =
  yuantaFundModule.yuantaFundStatementsInputSchema;

const source = await readFile(
  new URL("./yuanta-fund-statements.ts", import.meta.url),
  "utf8",
);

assert.doesNotMatch(source, /console\.|emitAutomationProgress/);
assert.match(source, /positions = await extractFundPositions\(page\)/);
assert.match(source, /runFundMenuAction\(/);
assert.match(source, /evaluateYuantaFundCanonicalAdmission/);
assert.match(source, /PGLITE_CANONICAL_INVESTMENT_COMMIT_COMMAND/);
assert.match(source, /PGLITE_CANONICAL_INVESTMENT_RELATIONS_RESOLVE_COMMAND/);
assert.doesNotMatch(source, /createCanonicalInvestmentStore/);
assert.doesNotMatch(source, /commitCanonicalInvestmentCaptureBatch/);
assert.doesNotMatch(
  source,
  /from\s+["']libretto["']|LibrettoWorkflowContext|export\s+default\s+yuantaFundStatements|requirePGliteChildRpcClientFromEnv|executePGliteWorkflowRun|node:fs\/promises|writeFile\(|writeOutputTableFiles|fundDownloadsDir|waitForEvent\(["']download["']\)/u,
  "Yuanta fund typed execution must not retain a legacy runner, database client, or file output path",
);
assert.match(
  source,
  /sourceText\.assertIntact\(JSON\.stringify\(sourceCollection\.tables\)\)/u,
);
assert.match(source, /export async function runYuantaFundStatements/u);
assert.match(source, /reference-nav-and-fx-basis-date/);
assert.match(source, /investment-source-evidence/);

assert.equal(isYuantaFundPositionAbsentText("目前無持有基金"), true);
assert.equal(isYuantaFundPositionAbsentText("未持有基金部位"), true);
assert.equal(
  isYuantaFundPositionAbsentText("投資日期 基金名稱 交易編號"),
  false,
);
// Live investment-overview rows report the source currency as 台幣. It must
// reach the canonical adapter as ISO TWD rather than as a display label.
assert.equal(canonicalYuantaFundCurrency("台幣"), "TWD");

const position = {
  txnType: "S",
  paperNo: "FUND001",
  trustNo: "T12345",
  label: "SANITIZED FUND",
};
const fundKey = "S:FUND001:T12345";
const overview = {
  category: "investment-overview",
  fund: null,
  period: null,
  tableLabel: "investment-detail",
  rows: [
    [
      "投資日期",
      "幣別",
      "基金名稱 交易編號",
      "效率投資",
      "投資金額 不含息參考市值",
      "投資淨值 參考淨值",
      "單位數 參考匯率",
      "(不含息) 參考損益 參考報酬率",
      "(含息) 參考損益 參考報酬率",
      "累積配息 在途交易",
      "操作",
    ],
    [
      "2025/01/01",
      "新臺幣",
      "SANITIZED FUND T12345",
      "",
      "10000 10500",
      "10 10.5",
      "1000 1",
      "500 5%",
      "500 5%",
      "0 0",
      "",
    ],
  ],
};
const basisTable = {
  category: "investment-source-evidence",
  fund: fundKey,
  period: null,
  tableLabel: "reference-nav",
  rows: [
    ["參考項目", "參考基準日", "參考淨值", "最新淨值查詢"],
    ["贖回", "2026/09/01", "10.5", ""],
    ["申購", "2026/09/01", "10.6", ""],
    ["匯率", "2026/09/02", "1", ""],
  ],
};
const colspanBasisTable = {
  category: "investment-source-evidence",
  fund: fundKey,
  period: null,
  tableLabel: "reference-nav",
  rows: [
    ["參考項目", "參考基準日", "參考淨值", "最新淨值查詢"],
    ["贖回", "2026/09/04", "10.50台幣"],
    ["申購", "2026/09/04", "10.40台幣"],
    ["匯率", "2026/09/08", "1"],
  ],
  cellColspans: [
    [1, 1, 1, 1],
    [1, 1, 2],
    [1, 1, 2],
    [1, 1, 2],
  ],
};
const buyTable = {
  category: "historical-transactions",
  fund: fundKey,
  period: "2025/01/01-2026/09/08",
  tableLabel: "buy-details",
  rows: [
    [
      "投資日期",
      "基金名稱",
      "交易編號",
      "投資金額",
      "申購匯率",
      "申購淨值",
      "申購手續費",
      "點數折抵",
      "申購單位數",
    ],
    [
      "2026/08/28",
      "SANITIZED FUND",
      "T12345",
      "10000",
      "1",
      "10",
      "0",
      "0",
      "1000",
    ],
  ],
};
assert.deepEqual(parseYuantaFundValuationBasis(basisTable), {
  fundKey,
  navEffectiveOn: "2026-09-01",
  fxEffectiveOn: "2026-09-02",
});
assert.deepEqual(parseYuantaFundValuationBasis(colspanBasisTable), {
  fundKey,
  navEffectiveOn: "2026-09-04",
  fxEffectiveOn: "2026-09-08",
});
assert.throws(
  () =>
    parseYuantaFundValuationBasis({
      ...colspanBasisTable,
      cellColspans: colspanBasisTable.cellColspans?.map((row) =>
        row.length === 3 ? [1, 1, 1] : row,
      ),
    }),
  /unsupported source shape/,
);
assert.deepEqual(
  evaluateYuantaFundCanonicalAdmission([overview, basisTable], [position]),
  {
    status: "admitted",
    contractVersion: "yuanta-fund/investment/canonical-v1",
    holdingCount: 1,
    transactionCount: 0,
  },
);
assert.deepEqual(
  evaluateYuantaFundCanonicalAdmission(
    [overview, colspanBasisTable],
    [position],
  ),
  {
    status: "admitted",
    contractVersion: "yuanta-fund/investment/canonical-v1",
    holdingCount: 1,
    transactionCount: 0,
  },
);
const incompleteAdmission = evaluateYuantaFundCanonicalAdmission(
  [overview],
  [position],
);
if (incompleteAdmission.status !== "not-admitted") {
  throw new Error("overview-only fund evidence must remain non-admitted");
}
assert.equal(
  incompleteAdmission.reason,
  "source-effective-time-evidence-incomplete",
);
assert.throws(
  () => assertYuantaFundCanonicalAdmission(incompleteAdmission),
  (error: unknown) =>
    error instanceof CanonicalInvestmentAdmissionError &&
    error.message.includes("source-effective-time-evidence-incomplete"),
);
const partialAdmission = evaluateYuantaFundCanonicalAdmission(
  [overview, buyTable],
  [position],
);
assert.deepEqual(partialAdmission, {
  status: "partial",
  contractVersion: "yuanta-fund/investment/canonical-v1",
  holdingCount: 1,
  transactionCount: 1,
  reason: "source-effective-time-evidence-incomplete",
});
assert.throws(
  () => assertYuantaFundCanonicalAdmission(partialAdmission),
  (error: unknown) =>
    error instanceof CanonicalInvestmentAdmissionError &&
    error.message.includes("1 dated transaction row(s) were rejected") &&
    error.message.includes("the complete source was not admitted"),
);
const wrappedPartialRun = await runSelectedStatements(
  ["fund"],
  [
    {
      typeId: "fund",
      run: async () => {
        assertYuantaFundCanonicalAdmission(partialAdmission);
        return { count: 1 };
      },
    },
  ],
);
assert.deepEqual(wrappedPartialRun.results, [
  {
    typeId: "fund",
    status: "failed",
    error:
      "Yuanta fund canonical admission partial: source-effective-time-evidence-incomplete. 1 dated transaction row(s) were rejected; the complete source was not admitted because the source did not report a holding effective date.",
  },
]);
assert.equal(Object.hasOwn(wrappedPartialRun.outputs, "fund"), false);
const wrappedIncompleteRun = await runSelectedStatements(
  ["fund"],
  [
    {
      typeId: "fund",
      run: async () => {
        assert.throws(
          () => assertYuantaFundCanonicalAdmission(incompleteAdmission),
          (error: unknown) =>
            error instanceof CanonicalInvestmentAdmissionError &&
            error.message.includes("source-effective-time-evidence-incomplete"),
        );
        assertYuantaFundCanonicalAdmission(incompleteAdmission);
        return { count: 0 };
      },
    },
  ],
);
assert.deepEqual(wrappedIncompleteRun.results, [
  {
    typeId: "fund",
    status: "failed",
    error:
      "Yuanta fund canonical admission failed: source-effective-time-evidence-incomplete. Canonical Financial Commit was not opened.",
  },
]);
assert.equal(Object.hasOwn(wrappedIncompleteRun.outputs, "fund"), false);

const wrappedAdmittedRun = await runSelectedStatements(
  ["fund"],
  [
    {
      typeId: "fund",
      run: async () => {
        assertYuantaFundCanonicalAdmission(
          evaluateYuantaFundCanonicalAdmission(
            [overview, basisTable],
            [position],
          ),
        );
        return { count: 1 };
      },
    },
  ],
);
assert.deepEqual(wrappedAdmittedRun.results, [
  { typeId: "fund", status: "success" },
]);
assert.deepEqual(wrappedAdmittedRun.outputs.fund, { count: 1 });

type FundSourceCollector = NonNullable<
  Parameters<typeof runYuantaFundStatements>[3]["collectSourceTables"]
>;
const fundInput = yuantaFundStatementsInputSchema.parse({
  includePortfolioSummary: false,
  includeInvestmentDetails: true,
  includeHistoricalTransactions: false,
});
const validFundCollector: FundSourceCollector = async () => ({
  positions: [position],
  tables: [overview, basisTable],
});
const fundDependencies = (
  collector: FundSourceCollector,
  deferredCommitItems: PGliteWorkflowRunItem[],
  signal: AbortSignal,
): Parameters<typeof runYuantaFundStatements>[3] => ({
  collectOnly: true,
  deferredCommitItems,
  sourceText: strictSourceText,
  signal,
  now: () => "2026-09-09T12:00:00.000Z",
  collectSourceTables: collector,
});

const typedFundOutputDirectory = await mkdtemp(
  join(tmpdir(), "yuanta-fund-typed-output-"),
);
const typedFundOriginalCwd = process.cwd();
process.chdir(typedFundOutputDirectory);
try {
  const admittedItems: PGliteWorkflowRunItem[] = [];
  const collection = await runYuantaFundStatements(
    {} as never,
    fundInput,
    { yuanta_user_id: "synthetic-login", yuanta_account: "synthetic-account" },
    fundDependencies(
      validFundCollector,
      admittedItems,
      new AbortController().signal,
    ),
  );
  assert.deepEqual(collection, {
    sourceCount: 2,
    rowCount: 6,
    itemCount: 1,
  });
  assert.equal(admittedItems.length, 1);
  assert.equal(admittedItems[0]?.provider, "yuanta-fund");
  assert.equal(admittedItems[0]?.product, "investment");

  const partialItems: PGliteWorkflowRunItem[] = [];
  const partialCollector: FundSourceCollector = async () => ({
    positions: [position],
    tables: [overview, buyTable],
  });
  await assert.rejects(
    runYuantaFundStatements(
      {} as never,
      fundInput,
      {
        yuanta_user_id: "synthetic-login",
        yuanta_account: "synthetic-account",
      },
      fundDependencies(
        partialCollector,
        partialItems,
        new AbortController().signal,
      ),
    ),
    /dated transaction row\(s\) were rejected/u,
  );
  assert.deepEqual(partialItems, []);

  const malformedItems: PGliteWorkflowRunItem[] = [];
  const malformedCollector: FundSourceCollector = async () => ({
    positions: [position],
    tables: [
      {
        ...overview,
        rows: overview.rows.map((row) =>
          row.map((value) => value.replace("SANITIZED", "SANITIZED\uFFFD")),
        ),
      },
      basisTable,
    ],
  });
  await assert.rejects(
    runYuantaFundStatements(
      {} as never,
      fundInput,
      {
        yuanta_user_id: "synthetic-login",
        yuanta_account: "synthetic-account",
      },
      fundDependencies(
        malformedCollector,
        malformedItems,
        new AbortController().signal,
      ),
    ),
    /replacement-character/u,
  );
  assert.deepEqual(malformedItems, []);

  const cancelledItems: PGliteWorkflowRunItem[] = [];
  const cancellation = new AbortController();
  const abortAfterCollect: FundSourceCollector = async () => {
    cancellation.abort();
    return { positions: [position], tables: [overview, basisTable] };
  };
  await assert.rejects(
    runYuantaFundStatements(
      {} as never,
      fundInput,
      {
        yuanta_user_id: "synthetic-login",
        yuanta_account: "synthetic-account",
      },
      fundDependencies(abortAfterCollect, cancelledItems, cancellation.signal),
    ),
    /abort/u,
  );
  assert.deepEqual(cancelledItems, []);
  assert.deepEqual(await readdir(typedFundOutputDirectory), []);
} finally {
  process.chdir(typedFundOriginalCwd);
  await rm(typedFundOutputDirectory, { recursive: true, force: true });
}
