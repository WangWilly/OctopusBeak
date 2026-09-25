import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHooks } from "node:module";

import { deriveSourceConnectionIdentityKey } from "../ledger/canonical/source-connection-identity.ts";
import { dismissYuantaBankNotice } from "./yuanta-auth.ts";
import { YUANTA_RELATION_EVIDENCE_FIXTURES_V1 } from "./yuanta-relation-evidence.fixtures.ts";
import { deriveYuantaDomesticDepositAccountKey } from "../ledger/canonical/yuanta-deposit-account-key.ts";
import { strictSourceText } from "../lib/automation/source-text.ts";
import type { PGliteWorkflowRunItem } from "../ledger/pglite/workflow-run.ts";

const stableConnectionScope = "YUANTA-USER-001\u0000YUANTA-ACCOUNT-001";
const stableConnectionKey = deriveSourceConnectionIdentityKey(
  "yuanta",
  stableConnectionScope,
);
const stableConnectionIdentity = {
  sourceConnectionScope: stableConnectionScope,
  sourceConnectionKey: stableConnectionKey,
  observedAt: () => "2026-08-21T11:04:05+08:00",
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./browser-interaction.js") {
      return nextResolve("./browser-interaction.ts", context);
    }
    return nextResolve(specifier, context);
  },
});

const {
  buildYuantaCapture,
  deriveYuantaDomesticDepositAccountNumberEvidence,
  deriveYuantaDomesticDepositQueryRange,
  readYuantaDepositAccountOptions,
  runYuantaStatements,
  statementRowsFromDownloadedCsv,
  yuantaLoanAccountEvidenceFromTransactionNote,
  yuantaObservedAt,
} = await import("./yuanta-statements.ts");

assert.deepEqual(
  deriveYuantaDomesticDepositAccountNumberEvidence({
    value: "0012345678901234",
    label: "臺幣活期存款 0012345678901234",
  }),
  {
    value: "0012345678901234",
    kind: "depository-account",
    evidenceVersion: "yuanta/domestic-deposit/account-number-v1",
    sourceField: "#acctno option.value",
  },
);
assert.equal(
  deriveYuantaDomesticDepositAccountNumberEvidence({
    value: "0012345678901234",
    label: "臺幣活期存款 ****1234",
  }),
  null,
);

const workflowNumberedCapture = buildYuantaCapture(
  {
    value: "0012345678901234",
    label: "臺幣活期存款 0012345678901234",
  },
  deriveYuantaDomesticDepositQueryRange(
    "one_month",
    "2026-08-21T12:00:00+08:00",
  ),
  "2026-08-21T12:00:00+08:00",
  {
    filename: "synthetic-yuanta.csv",
    rows: [],
    source: {
      filename: "synthetic-yuanta.csv",
      byteLength: 0,
      contentDigest: "sha256:synthetic-yuanta" as const,
      columnNames: [],
      rows: [],
      terminal: true,
    },
  },
);
assert.deepEqual(workflowNumberedCapture.account.accountNumber, {
  value: "0012345678901234",
  kind: "depository-account",
  evidenceVersion: "yuanta/domestic-deposit/account-number-v1",
  sourceField: "#acctno option.value",
});

assert.deepEqual(
  yuantaLoanAccountEvidenceFromTransactionNote("0012345678901234", 7),
  {
    rowOrdinal: 7,
    accountValue: "0012345678901234",
    normalizedAccountValue: "12345678901234",
    role: "beneficiary",
    purpose: "loan_repayment",
    scope: "loan_contract",
    evidenceKind: "transaction-counterparty-account",
    sourceField: "備註",
    contractVersion: "yuanta/transaction-note-loan-account-leading-00/v1",
  },
);
for (const value of [
  "12345678901234",
  "001234567890123",
  "00123456789012345",
  "00******901234",
  "用途 0012345678901234",
]) {
  assert.equal(yuantaLoanAccountEvidenceFromTransactionNote(value, 0), null);
}

await assert.rejects(
  () =>
    runYuantaStatements(
      {} as never,
      {
        dateRange: "one_month",
        accountFilters: [],
        replaceActiveSession: true,
      },
      {
        sourceConnectionScope: stableConnectionScope,
        sourceConnectionKey: "invalid-source-connection-key",
        deferredCommitItems: [],
        sourceText: strictSourceText,
        signal: new AbortController().signal,
      },
    ),
  /stable caller-supplied Source Connection scope and key/u,
);
const { StatementComponentAbsentError } =
  await import("./run-selected-statements.ts");

class DelayedVisibilityLocator {
  private readonly visibleAt: number;
  private hidden = false;
  clicked = false;

  constructor(delayMs: number) {
    this.visibleAt = Date.now() + delayMs;
  }

  async isVisible(): Promise<boolean> {
    return !this.hidden && Date.now() >= this.visibleAt;
  }

  async waitFor(options: {
    state: "visible" | "hidden";
    timeout?: number;
  }): Promise<void> {
    const deadline = Date.now() + (options.timeout ?? 1_000);
    while (Date.now() < deadline) {
      const visible = await this.isVisible();
      if (visible === (options.state === "visible")) return;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error(`Timed out waiting for ${options.state}.`);
  }

  locator(selector: string): DelayedVisibilityLocator {
    assert.equal(selector, "#commonPopupLeftBtnImg");
    return this;
  }

  async click(): Promise<void> {
    this.clicked = true;
    this.hidden = true;
  }
}

const source = readFileSync(
  new URL("./yuanta-statements.ts", import.meta.url),
  "utf8",
);

assert.doesNotMatch(source, /from ["']libretto["']/u, "the domestic provider must not register a Libretto production workflow");
assert.doesNotMatch(source, /requirePGliteChildRpcClientFromEnv|executePGliteWorkflowRun/u, "the domestic provider must return items to the App commit port");
assert.doesNotMatch(source, /from ["']node:fs\/promises["']|writeBankTransactionsFile|downloads[\\/]yuanta-statements/u, "the domestic provider must not write statement source or output files");
assert.doesNotMatch(source, /console\.log\s*\(|export default/u, "the domestic provider must not write standalone logs or expose a legacy workflow entry");
assert.doesNotMatch(source, /from ["']\.\/yuanta-auth\.ts["']/u, "the collector must leave authentication to the App-owned parent");
assert.match(source, /decode\(bytes, ["']big5["']\)/u, "download bytes must remain strictly decoded as Big5");

const popup = new DelayedVisibilityLocator(20);
const dismissed = await dismissYuantaBankNotice(
  {
    locator(selector: string) {
      assert.equal(selector, "#commonPopup");
      return popup;
    },
  } as never,
  100,
);
assert.equal(dismissed, true);
assert.equal(popup.clicked, true);

const absentPopup = new DelayedVisibilityLocator(1_000);
const dismissedAbsentPopup = await dismissYuantaBankNotice(
  {
    locator(selector: string) {
      assert.equal(selector, "#commonPopup");
      return absentPopup;
    },
  } as never,
  10,
);
assert.equal(dismissedAbsentPopup, false);
assert.equal(absentPopup.clicked, false);

function accountOptionsPage(
  options: Array<{ value: string; label: string }>,
): never {
  const selectLocator = {
    first: () => ({
      waitFor: async ({ state }: { state: "attached" }) => {
        assert.equal(state, "attached");
      },
    }),
  };
  const optionLocator = {
    count: async () => options.length,
    nth: (index: number) => ({
      getAttribute: async (name: string) =>
        name === "value" ? (options[index]?.value ?? null) : null,
      textContent: async () => options[index]?.label ?? null,
    }),
  };
  return {
    frames: () => [],
    waitForTimeout: async () => {},
    locator: (selector: string) =>
      selector === "#acctno" ? selectLocator : optionLocator,
  } as never;
}

await assert.rejects(
  readYuantaDepositAccountOptions(
    accountOptionsPage([{ value: "", label: "請選擇帳戶" }]),
  ),
  (error: unknown) => {
    assert.ok(error instanceof StatementComponentAbsentError);
    assert.equal(error.skipReason, "absent");
    return true;
  },
);

assert.deepEqual(
  await readYuantaDepositAccountOptions(
    accountOptionsPage([
      { value: "", label: "請選擇帳戶" },
      { value: "acct-1", label: "臺幣活期存款" },
      { value: "acct-2", label: "臺幣綜合存款" },
    ]),
    ["stale-account-selection"],
  ),
  [
    { value: "acct-1", label: "臺幣活期存款" },
    { value: "acct-2", label: "臺幣綜合存款" },
  ],
);

const observedAt = yuantaObservedAt(new Date("2026-08-21T03:04:05.000Z"));
assert.equal(observedAt, "2026-08-21T11:04:05+08:00");
const boundedRange = deriveYuantaDomesticDepositQueryRange(
  "one_week",
  observedAt,
);
assert.deepEqual(boundedRange, {
  dateRange: "one_week",
  startDate: "2026-08-15",
  endDate: "2026-08-21",
});
assert.deepEqual(
  deriveYuantaDomesticDepositQueryRange(
    "one_month",
    "2026-09-02T00:00:00+08:00",
  ),
  {
    dateRange: "one_month",
    startDate: "2026-08-02",
    endDate: "2026-09-02",
  },
);
assert.deepEqual(
  deriveYuantaDomesticDepositQueryRange(
    "three_months",
    "2026-09-02T00:00:00+08:00",
  ),
  {
    dateRange: "three_months",
    startDate: "2026-06-02",
    endDate: "2026-09-02",
  },
);
assert.equal(
  deriveYuantaDomesticDepositQueryRange(
    "one_month",
    "2026-03-31T00:00:00+08:00",
  ).startDate,
  "2026-02-28",
);

const csv = [
  '"帳號","帳務日期","交易日期","交易時間","交易說明","支出金額","存入金額","帳面餘額","票據號碼","備註"',
  '"123456","20260802","20260802","09:10:11","PRIVATE DESCRIPTION","","100","900","","PRIVATE NOTE"',
  '"帳號","帳務日期","交易日期","交易時間","交易說明","支出金額","存入金額","帳面餘額","票據號碼","備註"',
  '"123456","20260803","20260803","10:00:00","SECOND","50","","850","",""',
].join("\n");
const parsedRows = statementRowsFromDownloadedCsv(csv, "********3456");
assert.equal(parsedRows.length, 2);
assert.equal(parsedRows[0]?.sourceRowOrdinal, 0);
assert.equal(parsedRows[1]?.sourceRowOrdinal, 1);
assert.equal(parsedRows[0]?.accountLabel, "********3456");
assert.match(JSON.stringify(parsedRows), /PRIVATE DESCRIPTION|PRIVATE NOTE/);

const workflowAccount = {
  value: "YUANTA-ACCOUNT-001",
  label: "臺幣活期存款 YUANTA-ACCOUNT-001",
};
const workflowValues = [
  "臺幣活期存款",
  workflowAccount.value,
  "20260802",
  "20260802",
  "09:10:11",
  "CLEAN DEPOSIT",
  "",
  "100",
  "900",
  "",
  "",
];
const workflowDownload = {
  filename: "yuanta-synthetic.csv",
  rows: [
    {
      accountLabel: workflowAccount.label,
      values: workflowValues.slice(1),
      sourceRowOrdinal: 0,
    },
  ],
  source: {
    filename: "yuanta-synthetic.csv",
    byteLength: 128,
    contentDigest: "sha256:yuanta-synthetic-content" as `sha256:${string}`,
    columnNames: [
      "帳戶名稱",
      "帳號",
      "帳務日期",
      "交易日期",
      "交易時間",
      "交易說明",
      "支出金額",
      "存入金額",
      "帳面餘額",
      "票據號碼",
      "備註",
    ],
    terminal: true,
    rows: [{ rowOrdinal: 0, values: workflowValues }],
  },
  counterpartyAccountEvidence: [
    YUANTA_RELATION_EVIDENCE_FIXTURES_V1.exactCounterpartyAccount,
  ],
};
const workflowCurrentSourceAccountKey = deriveYuantaDomesticDepositAccountKey(
  workflowAccount.value,
);
const workflowCurrentBalanceRow = {
  source: "yuanta" as const,
  kind: "domestic" as const,
  stream: "domestic-deposit" as const,
  accountNumber: workflowAccount.value,
  sourceAccountKey: workflowCurrentSourceAccountKey,
  currency: "TWD",
  available: { coefficient: "800", scale: 2, sourceLexeme: "800.00" },
  ledger: { coefficient: "900", scale: 2, sourceLexeme: "900.00" },
  effectiveAt: "2026-08-21T01:00:00.000Z",
  providerHttpDate: "Fri, 21 Aug 2026 01:00:00 GMT",
  observedAt: "2026-08-21T09:00:00+08:00",
  sourceEvidence: {
    endpoint: "/nib/tx/finance_overview_for_summary" as const,
    method: "POST" as const,
    status: 200 as const,
    cacheControl: "no-store",
    contractVersion: "yuanta/current-deposit-balance-v1" as const,
  },
};
const nextDayAccountingWorkflowDownload = {
  ...workflowDownload,
  rows: [
    {
      ...workflowDownload.rows[0]!,
      values: [
        "YUANTA-ACCOUNT-001",
        "20260622",
        "20260619",
        "09:10:11",
        "CLEAN DEPOSIT",
        "",
        "100",
        "900",
        "",
        "",
      ],
    },
  ],
  source: {
    ...workflowDownload.source,
    contentDigest: "sha256:yuanta-accounting-date-range-content" as `sha256:${string}`,
    rows: [
      {
        rowOrdinal: 0,
        values: [
          "臺幣活期存款",
          "YUANTA-ACCOUNT-001",
          "20260622",
          "20260619",
          "09:10:11",
          "CLEAN DEPOSIT",
          "",
          "100",
          "900",
          "",
          "",
        ],
      },
    ],
  },
};
const transactionOutsideWorkflowDownload = {
  ...nextDayAccountingWorkflowDownload,
  rows: [
    {
      ...nextDayAccountingWorkflowDownload.rows[0]!,
      values: [
        "YUANTA-ACCOUNT-001",
        "20260619",
        "20260622",
        "09:10:11",
        "CLEAN DEPOSIT",
        "",
        "100",
        "900",
        "",
        "",
      ],
    },
  ],
  source: {
    ...nextDayAccountingWorkflowDownload.source,
    contentDigest: "sha256:yuanta-accounting-date-outside-content" as `sha256:${string}`,
    rows: [
      {
        rowOrdinal: 0,
        values: [
          "臺幣活期存款",
          "YUANTA-ACCOUNT-001",
          "20260619",
          "20260622",
          "09:10:11",
          "CLEAN DEPOSIT",
          "",
          "100",
          "900",
          "",
          "",
        ],
      },
    ],
  },
};
const maskedWorkflowDownload = {
  ...workflowDownload,
  source: {
    ...workflowDownload.source,
    contentDigest: "sha256:yuanta-masked-content" as `sha256:${string}`,
  },
  counterpartyAccountEvidence: [
    YUANTA_RELATION_EVIDENCE_FIXTURES_V1.maskedCounterpartyAccount,
  ],
};
const secondWorkflowAccount = {
  value: "YUANTA-ACCOUNT-002",
  label: "臺幣活期存款 YUANTA-ACCOUNT-002",
};
const secondWorkflowValues = [...workflowValues];
secondWorkflowValues[0] = secondWorkflowAccount.label;
secondWorkflowValues[1] = secondWorkflowAccount.value;
const secondWorkflowDownload = {
  ...workflowDownload,
  rows: [
    {
      ...workflowDownload.rows[0]!,
      accountLabel: secondWorkflowAccount.label,
      values: secondWorkflowValues.slice(1),
    },
  ],
  source: {
    ...workflowDownload.source,
    contentDigest: "sha256:yuanta-synthetic-content-002" as `sha256:${string}`,
    rows: [{ rowOrdinal: 0, values: secondWorkflowValues }],
  },
};
const typedOutputDir = await mkdtemp(join(tmpdir(), "yuanta-deposit-typed-"));
const originalCwd = process.cwd();
process.chdir(typedOutputDir);
try {
  const deferredItems: PGliteWorkflowRunItem[] = [];
  let preparedDateRange: string | null = null;
  const typedResult = await runYuantaStatements(
    {} as never,
    { dateRange: "one_month", accountFilters: [], replaceActiveSession: true },
    {
      preparePage: async (_page, dateRange) => {
        preparedDateRange = dateRange;
      },
      observedAt: stableConnectionIdentity.observedAt,
      readDepositAccountOptions: async () => {
        assert.equal(preparedDateRange, "one_month", "the selected range must be prepared before account collection");
        return [workflowAccount];
      },
      queryAccount: async () => undefined,
      downloadStatementRows: async () => workflowDownload,
      sourceConnectionScope: stableConnectionScope,
      sourceConnectionKey: stableConnectionKey,
      readCurrentDepositBalances: async () => [workflowCurrentBalanceRow],
      deferredCommitItems: deferredItems,
      sourceText: strictSourceText,
      signal: new AbortController().signal,
    },
  );
  assert.ok(typedResult.itemCount > 0);
  assert.equal(preparedDateRange, "one_month", "the typed collector must apply the selected range before reading source data");
  assert.equal(typedResult.sourceCount, 1);
  assert.equal(typedResult.rowCount, 1);
  assert.equal(deferredItems.length, typedResult.itemCount);
  assert.ok(deferredItems.every((item) => item.provider === "yuanta" && item.command));
  assert.deepEqual(await readdir(typedOutputDir), []);

  const rejectedItems: PGliteWorkflowRunItem[] = [];
  await assert.rejects(
    runYuantaStatements(
      {} as never,
      { dateRange: "one_month", accountFilters: [], replaceActiveSession: true },
      {
        preparePage: async () => undefined,
        observedAt: stableConnectionIdentity.observedAt,
        readDepositAccountOptions: async () => [workflowAccount],
        queryAccount: async () => undefined,
        downloadStatementRows: async () => {
          strictSourceText.decode(Uint8Array.of(0x81), "big5");
          return workflowDownload;
        },
        sourceConnectionScope: stableConnectionScope,
        sourceConnectionKey: stableConnectionKey,
        deferredCommitItems: rejectedItems,
        sourceText: strictSourceText,
        signal: new AbortController().signal,
      },
    ),
    /Source text integrity failed/u,
  );
  assert.deepEqual(rejectedItems, [], "malformed Big5 must fail before any source item is returned");

  const canceledItems: PGliteWorkflowRunItem[] = [];
  const cancellation = new AbortController();
  cancellation.abort();
  await assert.rejects(
    runYuantaStatements(
      {} as never,
      { dateRange: "one_month", accountFilters: [], replaceActiveSession: true },
      {
        preparePage: async () => { throw new Error("canceled collection navigated the browser"); },
        sourceConnectionScope: stableConnectionScope,
        sourceConnectionKey: stableConnectionKey,
        deferredCommitItems: canceledItems,
        sourceText: strictSourceText,
        signal: cancellation.signal,
      },
    ),
    /abort/u,
  );
  assert.deepEqual(canceledItems, [], "cancellation must return no commit items");
} finally {
  process.chdir(originalCwd);
  await rm(typedOutputDir, { recursive: true, force: true });
}
