import assert from "node:assert/strict";
import test from "node:test";
import { translations } from "../i18n/i18n.ts";
import type { OverviewPageDto } from "../overview/types.ts";
import type { AccountRowDto } from "../shared-ledger/types.ts";
import { unvaluedAccountLabels } from "./unvalued-accounts.ts";

function account(id: string, overrides: Partial<AccountRowDto>): AccountRowDto {
  return {
    id,
    label: "",
    institution: "",
    product: "Investment account",
    group: "investment",
    kind: "brokerage",
    typeLabel: "Investment",
    amountLines: [],
    transactionCount: 0,
    assetPositionCount: 0,
    lastUpdated: null,
    valueAvailability: "awaiting",
    ...overrides,
  };
}

const overview: Pick<OverviewPageDto, "accounts" | "sourceGaps"> = {
  accounts: [
    account("tdcc-fubon", {
      label: "富邦 · Investment account · 0462817",
      institution: "富邦",
      institutionKey: "broker-9600",
    }),
    account("yuanta-fund", {
      label: "Yuanta Bank · Fund · 1234",
      institution: "Yuanta Bank",
      institutionKey: "yuanta-bank",
      product: "Fund",
      kind: "fund",
    }),
  ],
  sourceGaps: [
    { accountId: "tdcc-fubon", sourceConnectionKey: "tdcc", accountNo: "0462817", integrationNamespace: "tdcc", reason: "current-value-not-observed" },
    { accountId: "yuanta-fund", sourceConnectionKey: "yuanta", accountNo: "1234", integrationNamespace: "yuanta-fund", reason: "current-value-not-observed" },
    { accountId: "expected:tdcc:fund", sourceConnectionKey: "expected:tdcc:fund", accountNo: null, integrationNamespace: "tdcc", reason: "source-not-collected" },
  ],
};

test("a task lists its own accounts without a current value in the interface language", () => {
  assert.deepEqual(unvaluedAccountLabels("sync-tdcc", overview, translations["zh-TW"]), ["富邦 · 投資帳戶 · 0462817"]);
  assert.deepEqual(unvaluedAccountLabels("sync-tdcc", overview, translations.en), ["富邦 · Investment account · 0462817"]);
});

test("a task covers every namespace its workflow writes", () => {
  assert.deepEqual(unvaluedAccountLabels("yuanta-all-statements", overview, translations["zh-TW"]), ["元大銀行 · 基金 · 1234"]);
});

test("a source that was not collected is not an account without a value", () => {
  assert.deepEqual(unvaluedAccountLabels("fubon-all-statements", overview, translations["zh-TW"]), []);
  assert.deepEqual(
    unvaluedAccountLabels("sync-tdcc", { ...overview, sourceGaps: overview.sourceGaps.slice(2) }, translations["zh-TW"]),
    [],
  );
});

test("every source task names the namespaces it writes", async () => {
  const { AUTOMATION_TASKS } = await import("./server/tasks.ts");
  const { taskIntegrationNamespaces } = await import("../institutions/institutions.ts");
  const missing = AUTOMATION_TASKS
    .filter((task) => task.credentialGroupId !== undefined)
    .filter((task) => taskIntegrationNamespaces(task.id).length === 0)
    .map((task) => task.id);
  assert.deepEqual(missing, []);
});
