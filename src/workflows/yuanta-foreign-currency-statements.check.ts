import assert from "node:assert/strict";
import { registerHooks } from "node:module";

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
