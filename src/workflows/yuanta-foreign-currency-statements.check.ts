import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  admitForeignCurrencyDepositCapture,
  commitForeignCurrencyDepositCapture,
} from "../ledger/canonical/foreign-currency-deposit.ts";
import { createCanonicalSourceStore } from "../ledger/canonical/canonical-source-store.ts";
import { deriveYuantaForeignSettlementLinkageKey } from "../ledger/canonical/investment-funding-relations.ts";

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

const {
  readYuantaForeignCurrencyAccountOptions,
  readYuantaForeignCurrencyOptions,
  buildYuantaForeignCurrencyCaptureInput,
} = await import("./yuanta-foreign-currency-statements.ts");
const { StatementComponentAbsentError } =
  await import("./run-selected-statements.ts");

const foreignWorkflowSource = await readFile(
  new URL("./yuanta-foreign-currency-statements.ts", import.meta.url),
  "utf8",
);
assert.match(foreignWorkflowSource, /resolveCanonicalInvestmentFundingRelations/);
assert.match(
  foreignWorkflowSource,
  /await commitForeignCurrencyDepositCaptureBatch\([\s\S]*?resolveCanonicalInvestmentFundingRelations\(financialStore\)/,
);

const fixedForeignDateRange = {
  startDate: "2026-08-14",
  endDate: "2026-08-24",
};

function locatorForOptions(options: Array<{ value: string; label: string }>) {
  return {
    first: () => ({
      waitFor: async ({ state }: { state: "attached" }) => {
        assert.equal(state, "attached");
      },
    }),
    count: async () => options.length,
    nth: (index: number) => ({
      getAttribute: async (name: string) =>
        name === "value" ? (options[index]?.value ?? null) : null,
      textContent: async () => options[index]?.label ?? null,
    }),
  };
}

function foreignOptionsPage(
  accounts: Array<{ value: string; label: string }>,
  currencies: Array<{ value: string; label: string }>,
): never {
  return {
    frames: () => [],
    waitForTimeout: async () => {},
    locator: (selector: string) => {
      if (selector === "#acctno") return locatorForOptions(accounts);
      if (selector === "#acctno option") return locatorForOptions(accounts);
      if (selector === 'select[name="currency"] option') {
        return locatorForOptions(currencies);
      }
      throw new Error(`Unexpected selector ${selector}`);
    },
  } as never;
}

await assert.rejects(
  readYuantaForeignCurrencyAccountOptions(
    foreignOptionsPage([{ value: "", label: "請選擇帳戶" }], []),
  ),
  (error: unknown) => {
    assert.ok(error instanceof StatementComponentAbsentError);
    assert.equal(error.skipReason, "absent");
    return true;
  },
);

assert.deepEqual(
  await readYuantaForeignCurrencyAccountOptions(
    foreignOptionsPage(
      [
        { value: "", label: "請選擇帳戶" },
        { value: "fx-1", label: "外幣綜合存款" },
        { value: "fx-2", label: "外幣活期存款" },
      ],
      [],
    ),
  ),
  [
    { value: "fx-1", label: "外幣綜合存款" },
    { value: "fx-2", label: "外幣活期存款" },
  ],
);

assert.deepEqual(
  await readYuantaForeignCurrencyAccountOptions(
    foreignOptionsPage(
      [
        { value: "fx-1", label: "外幣綜合存款" },
        { value: "fx-2", label: "外幣活期存款" },
      ],
      [],
    ),
    ["missing"],
  ),
  [
    { value: "fx-1", label: "外幣綜合存款" },
    { value: "fx-2", label: "外幣活期存款" },
  ],
);

await assert.rejects(
  readYuantaForeignCurrencyOptions(
    foreignOptionsPage(
      [{ value: "fx-1", label: "外幣綜合存款" }],
      [{ value: "", label: "請選擇幣別" }],
    ),
  ),
  (error: unknown) => {
    assert.ok(error instanceof StatementComponentAbsentError);
    assert.equal(error.skipReason, "absent");
    return true;
  },
);

assert.deepEqual(
  await readYuantaForeignCurrencyOptions(
    foreignOptionsPage(
      [{ value: "fx-1", label: "外幣綜合存款" }],
      [
        { value: "ALL", label: "全部幣別" },
        { value: "USD", label: "美元" },
      ],
    ),
  ),
  [{ value: "ALL", label: "全部幣別" }],
);

const yuantaForeignCapture = buildYuantaForeignCurrencyCaptureInput(
  [
    {
      accountLabel: "外幣綜合存款",
      accountValue: "fx-1",
      queryCurrencyLabel: "全部幣別",
      queryCurrencyValue: "ALL",
      values: [
        "1",
        "20260823",
        "20260823",
        "09:10",
        "USD",
        "外幣存入",
        "",
        "10.00",
        "110.00",
        "交易資訊",
        "31.50",
      ],
      sortTime: null,
    },
  ],
  { dateRange: "one_week", customDateRange: fixedForeignDateRange, accountFilters: [], currencyFilters: [], channelType: "all", replaceActiveSession: true },
  "fx-1",
  "2026-08-24T12:00:00+08:00",
  "yuanta-foreign-check-observation-1",
  undefined,
  "synthetic-yuanta-login",
);
assert.equal(yuantaForeignCapture.accountType, "depository");
assert.equal(yuantaForeignCapture.records[0]!.currencyEvidence.currency, "USD");
assert.equal(
  (yuantaForeignCapture.records[0]!.sourcePayload as Record<string, unknown>)
    .settlementLinkageKey,
  deriveYuantaForeignSettlementLinkageKey("synthetic-yuanta-login", "USD"),
);
assert.equal(
  yuantaForeignCapture.records[0]!.sourceReportedRate?.rate,
  "31.5",
);
assert.deepEqual(
  admitForeignCurrencyDepositCapture(yuantaForeignCapture).records[0]!
    .conversionEvidence?.sourceReportedRate?.amount,
  { coefficient: "315", scale: 1 },
);

const yuantaMultipleRowsFromOneAccount =
  buildYuantaForeignCurrencyCaptureInput(
    [
      {
        accountLabel: "foreign account",
        accountValue: "foreign-account-1",
        queryCurrencyLabel: "all currencies",
        queryCurrencyValue: "ALL",
        values: [
          "foreign-account-1",
          "20260823",
          "20260823",
          "09:10:00",
          "USD",
          "deposit",
          "0",
          "10.00",
          "110.00",
          "first transaction",
          "31.50",
        ],
        sortTime: null,
      },
      {
        accountLabel: "foreign account",
        accountValue: "foreign-account-1",
        queryCurrencyLabel: "all currencies",
        queryCurrencyValue: "ALL",
        values: [
          "foreign-account-1",
          "20260822",
          "20260822",
          "08:20:00",
          "USD",
          "withdrawal",
          "5.00",
          "0",
          "105.00",
          "second transaction",
          "31.40",
        ],
        sortTime: null,
      },
    ],
    {
      dateRange: "three_months",
      customDateRange: fixedForeignDateRange,
      accountFilters: [],
      currencyFilters: [],
      channelType: "all",
      replaceActiveSession: true,
    },
    "foreign-account-1",
    "2026-08-24T12:00:00+08:00",
    "yuanta-foreign-check-multiple-rows-one-account",
  );
const admittedYuantaMultipleRowsFromOneAccount =
  admitForeignCurrencyDepositCapture(yuantaMultipleRowsFromOneAccount);
assert.equal(admittedYuantaMultipleRowsFromOneAccount.records.length, 2);
assert.notEqual(
  admittedYuantaMultipleRowsFromOneAccount.records[0]!.occurrenceKey,
  admittedYuantaMultipleRowsFromOneAccount.records[1]!.occurrenceKey,
);

const yuantaZeroPaddedInflow = buildYuantaForeignCurrencyCaptureInput(
  [
    {
      accountLabel: "外幣綜合存款",
      accountValue: "fx-1",
      queryCurrencyLabel: "全部幣別",
      queryCurrencyValue: "ALL",
      values: [
        "2",
        "20260818",
        "20260818",
        "10:51:56",
        "USD",
        "複委託入",
        "000000000000.00",
        "000000000126.3800",
        "000000000833.2000",
        "淨額入",
        "000001.000000",
      ],
      sortTime: null,
    },
  ],
  { dateRange: "three_months", customDateRange: fixedForeignDateRange, accountFilters: [], currencyFilters: [], channelType: "all", replaceActiveSession: true },
  "fx-1",
  "2026-08-24T12:00:00+08:00",
  "yuanta-foreign-check-zero-padded-inflow",
);
assert.equal(yuantaZeroPaddedInflow.records[0]!.direction, "inflow");
assert.equal(yuantaZeroPaddedInflow.records[0]!.amount, "126.38");
assert.equal(yuantaZeroPaddedInflow.records[0]!.balanceAfter, "833.2");
assert.equal(yuantaZeroPaddedInflow.records[0]!.originalAmount?.amount, "126.38");
assert.equal(yuantaZeroPaddedInflow.records[0]!.sourceReportedRate?.rate, "1");
assert.deepEqual(
  admitForeignCurrencyDepositCapture(yuantaZeroPaddedInflow).records[0]!.amount,
  { coefficient: "12638", scale: 2 },
);
assert.deepEqual(
  admitForeignCurrencyDepositCapture(yuantaZeroPaddedInflow).records[0]!
    .balanceAfter,
  { coefficient: "8332", scale: 1 },
);

const yuantaZeroPaddedOutflow = buildYuantaForeignCurrencyCaptureInput(
  [
    {
      accountLabel: "外幣綜合存款",
      accountValue: "fx-1",
      queryCurrencyLabel: "全部幣別",
      queryCurrencyValue: "ALL",
      values: [
        "3",
        "20260814",
        "20260814",
        "11:07:44",
        "USD",
        "複委託扣",
        "000000004603.5200",
        "000000000000.00",
        "000000000706.8200",
        "淨額扣",
        "000001.000000",
      ],
      sortTime: null,
    },
  ],
  { dateRange: "three_months", customDateRange: fixedForeignDateRange, accountFilters: [], currencyFilters: [], channelType: "all", replaceActiveSession: true },
  "fx-1",
  "2026-08-24T12:00:00+08:00",
  "yuanta-foreign-check-zero-padded-outflow",
);
assert.equal(yuantaZeroPaddedOutflow.records[0]!.direction, "outflow");
assert.equal(yuantaZeroPaddedOutflow.records[0]!.amount, "4603.52");
assert.deepEqual(
  admitForeignCurrencyDepositCapture(yuantaZeroPaddedOutflow).records[0]!.amount,
  { coefficient: "460352", scale: 2 },
);

const yuantaUnpaddedInflow = buildYuantaForeignCurrencyCaptureInput(
  [
    {
      accountLabel: "外幣綜合存款",
      accountValue: "fx-1",
      queryCurrencyLabel: "全部幣別",
      queryCurrencyValue: "ALL",
      values: [
        "2",
        "20260818",
        "20260818",
        "10:51:56",
        "USD",
        "複委託入",
        "0",
        "126.38",
        "833.2",
        "淨額入",
        "1",
      ],
      sortTime: null,
    },
  ],
  { dateRange: "three_months", customDateRange: fixedForeignDateRange, accountFilters: [], currencyFilters: [], channelType: "all", replaceActiveSession: true },
  "fx-1",
  "2026-08-24T12:00:00+08:00",
  "yuanta-foreign-check-unpadded-inflow",
);
assert.equal(
  admitForeignCurrencyDepositCapture(yuantaZeroPaddedInflow).records[0]!.contentHash,
  admitForeignCurrencyDepositCapture(yuantaUnpaddedInflow).records[0]!.contentHash,
);

const yuantaDifferentForeignAmount = buildYuantaForeignCurrencyCaptureInput(
  [
    {
      accountLabel: "外幣綜合存款",
      accountValue: "fx-1",
      queryCurrencyLabel: "全部幣別",
      queryCurrencyValue: "ALL",
      values: [
        "2",
        "20260818",
        "20260818",
        "10:51:56",
        "USD",
        "複委託入",
        "0",
        "126.39",
        "833.2",
        "淨額入",
        "1",
      ],
      sortTime: null,
    },
  ],
  { dateRange: "three_months", customDateRange: fixedForeignDateRange, accountFilters: [], currencyFilters: [], channelType: "all", replaceActiveSession: true },
  "fx-1",
  "2026-08-24T12:00:00+08:00",
  "yuanta-foreign-check-different-amount",
);
assert.notEqual(
  admitForeignCurrencyDepositCapture(yuantaDifferentForeignAmount).records[0]!.contentHash,
  admitForeignCurrencyDepositCapture(yuantaUnpaddedInflow).records[0]!.contentHash,
);

assert.throws(
  () =>
    buildYuantaForeignCurrencyCaptureInput(
      [
        {
          accountLabel: "外幣綜合存款",
          accountValue: "fx-1",
          queryCurrencyLabel: "全部幣別",
          queryCurrencyValue: "ALL",
          values: [
            "4",
            "20260818",
            "20260818",
            "10:51:56",
            "USD",
            "雙向",
            "1.00",
            "2.00",
            "833.20",
            "",
            "1.000000",
          ],
          sortTime: null,
        },
      ],
      { dateRange: "three_months", customDateRange: fixedForeignDateRange, accountFilters: [], currencyFilters: [], channelType: "all", replaceActiveSession: true },
      "fx-1",
      "2026-08-24T12:00:00+08:00",
      "yuanta-foreign-check-both-nonzero",
    ),
  /exactly one amount direction/i,
);

assert.throws(
  () =>
    buildYuantaForeignCurrencyCaptureInput(
      [
        {
          accountLabel: "外幣綜合存款",
          accountValue: "fx-1",
          queryCurrencyLabel: "全部幣別",
          queryCurrencyValue: "ALL",
          values: [
            "5",
            "20260818",
            "20260818",
            "10:51:56",
            "USD",
            "雙零",
            "000000000000.00",
            "000000000000.00",
            "833.20",
            "",
            "1.000000",
          ],
          sortTime: null,
        },
      ],
      { dateRange: "three_months", customDateRange: fixedForeignDateRange, accountFilters: [], currencyFilters: [], channelType: "all", replaceActiveSession: true },
      "fx-1",
      "2026-08-24T12:00:00+08:00",
      "yuanta-foreign-check-both-zero",
    ),
  /exactly one amount direction/i,
);

assert.throws(
  () =>
    buildYuantaForeignCurrencyCaptureInput(
      [
        {
          accountLabel: "外幣綜合存款",
          accountValue: "fx-1",
          queryCurrencyLabel: "全部幣別",
          queryCurrencyValue: "ALL",
          values: [
            "6",
            "20260818",
            "20260818",
            "10:51:56",
            "USD",
            "無效金額",
            "not-a-number",
            "0",
            "833.20",
            "",
            "1.000000",
          ],
          sortTime: null,
        },
      ],
      { dateRange: "three_months", customDateRange: fixedForeignDateRange, accountFilters: [], currencyFilters: [], channelType: "all", replaceActiveSession: true },
      "fx-1",
      "2026-08-24T12:00:00+08:00",
      "yuanta-foreign-check-invalid-amount",
    ),
  /exact decimal/i,
);

const yuantaCorrectedMutableFacts = buildYuantaForeignCurrencyCaptureInput(
  [
    {
      accountLabel: "外幣綜合存款",
      accountValue: "fx-1",
      queryCurrencyLabel: "全部幣別",
      queryCurrencyValue: "ALL",
      values: [
        "1",
        "20260824",
        "20260824",
        "10:30",
        "USD",
        "更正後說明",
        "10.00",
        "",
        "100.00",
        "更正後交易資訊",
        "31.60",
      ],
      sortTime: null,
    },
  ],
  { dateRange: "one_week", customDateRange: fixedForeignDateRange, accountFilters: [], currencyFilters: [], channelType: "all", replaceActiveSession: true },
  "fx-1",
  "2026-08-24T13:00:00+08:00",
  "yuanta-foreign-check-observation-2",
);
assert.notEqual(
  yuantaCorrectedMutableFacts.records[0]!.sourceKey,
  yuantaForeignCapture.records[0]!.sourceKey,
);
assert.throws(
  () =>
    buildYuantaForeignCurrencyCaptureInput(
      [
        {
          accountLabel: "外幣綜合存款",
          accountValue: "fx-1",
          queryCurrencyLabel: "全部幣別",
          queryCurrencyValue: "ALL",
          values: ["1", "20260823", "20260823", "09:10", "", "存入", "", "10", "110", "", "31.5"],
          sortTime: null,
        },
      ],
      { dateRange: "one_week", customDateRange: fixedForeignDateRange, accountFilters: [], currencyFilters: [], channelType: "all", replaceActiveSession: true },
      "fx-1",
      "2026-08-24T12:00:00+08:00",
      "yuanta-foreign-check-observation-invalid",
    ),
  /source currency/i,
);

const emptyYuantaCapture = buildYuantaForeignCurrencyCaptureInput(
  [],
  { dateRange: "one_week", customDateRange: fixedForeignDateRange, accountFilters: [], currencyFilters: [], channelType: "all", replaceActiveSession: true },
  "fx-empty-133",
  "2026-08-24T12:00:00+08:00",
  "yuanta-foreign-check-empty-observation",
  "provider-explicit-no-data",
);
const yuantaEmptyDirectory = await mkdtemp(join(tmpdir(), "yuanta-foreign-empty-133-"));
try {
  const store = createCanonicalSourceStore(join(yuantaEmptyDirectory, "canonical.sqlite"));
  const result = await commitForeignCurrencyDepositCapture(
    store,
    admitForeignCurrencyDepositCapture(emptyYuantaCapture),
  );
  assert.equal(result.transactionCount, 0);
  assert.equal(
    Number((store.db.prepare("SELECT COUNT(*) AS count FROM source_captures").get() as { count?: number }).count ?? 0),
    1,
  );
  assert.equal(
    Number((store.db.prepare("SELECT COUNT(*) AS count FROM source_sync_states").get() as { count?: number }).count ?? 0),
    1,
  );
  store.close();
} finally {
  await rm(yuantaEmptyDirectory, { recursive: true, force: true });
}
