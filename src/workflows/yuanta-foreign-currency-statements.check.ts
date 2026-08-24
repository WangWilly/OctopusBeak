import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  admitForeignCurrencyDepositCapture,
  commitForeignCurrencyDepositCapture,
} from "../ledger/canonical/foreign-currency-deposit.ts";
import { createCanonicalSourceStore } from "../ledger/canonical/canonical-source-store.ts";

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
  { dateRange: "one_week", accountFilters: [], currencyFilters: [], channelType: "all", replaceActiveSession: true },
  "fx-1",
  "2026-08-24T12:00:00+08:00",
  "yuanta-foreign-check-observation-1",
);
assert.equal(yuantaForeignCapture.accountType, "depository");
assert.equal(yuantaForeignCapture.records[0]!.currencyEvidence.currency, "USD");
assert.equal(
  yuantaForeignCapture.records[0]!.sourceReportedRate?.rate,
  "31.50",
);
assert.deepEqual(
  admitForeignCurrencyDepositCapture(yuantaForeignCapture).records[0]!
    .conversionEvidence?.sourceReportedRate?.amount,
  { coefficient: "315", scale: 1 },
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
      { dateRange: "one_week", accountFilters: [], currencyFilters: [], channelType: "all", replaceActiveSession: true },
      "fx-1",
      "2026-08-24T12:00:00+08:00",
      "yuanta-foreign-check-observation-invalid",
    ),
  /source currency/i,
);

const emptyYuantaCapture = buildYuantaForeignCurrencyCaptureInput(
  [],
  { dateRange: "one_week", accountFilters: [], currencyFilters: [], channelType: "all", replaceActiveSession: true },
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
