import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "vite";

const server = await createServer({
  configFile: false,
  cacheDir: "/tmp/octopus-beak-fubon-statements-evidence-check",
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "silent",
});

const module = await server
  .ssrLoadModule("/src/workflows/fubon-statements.ts")
  .finally(() => server.close());

class SyntheticCell {
  readonly textContent: string;

  constructor(textContent: string) {
    this.textContent = textContent;
  }
}

class SyntheticRow {
  private readonly source: string;

  constructor(source: string) {
    this.source = source;
  }

  querySelectorAll(selector: string): SyntheticCell[] {
    if (selector !== "th,td") return [];
    return [
      ...this.source.matchAll(/<(?:th|td)[^>]*>([\s\S]*?)<\/(?:th|td)>/gi),
    ].map((match) => new SyntheticCell(match[1] ?? ""));
  }
}

class SyntheticTable {
  private readonly source: string;

  constructor(source: string) {
    this.source = source;
  }

  querySelectorAll(selector: string): SyntheticRow[] {
    if (selector !== "tr") return [];
    return [...this.source.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(
      (match) => new SyntheticRow(match[1] ?? ""),
    );
  }
}

class SyntheticLink {
  readonly textContent: string;
  private readonly onclick: string;

  constructor(textContent: string, onclick: string) {
    this.textContent = textContent;
    this.onclick = onclick;
  }

  getAttribute(name: string): string | null {
    return name === "onclick" ? this.onclick : null;
  }
}

class SyntheticDocument {
  private readonly source: string;

  constructor(source: string) {
    this.source = source;
  }

  querySelectorAll(selector: string): SyntheticTable[] | SyntheticLink[] {
    if (selector === "table") {
      return [...this.source.matchAll(/<table[^>]*>[\s\S]*?<\/table>/gi)].map(
        (match) => new SyntheticTable(match[0] ?? ""),
      );
    }
    if (selector === "a") {
      return [
        ...this.source.matchAll(
          /<a[^>]*onclick="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
        ),
      ].map((match) => new SyntheticLink(match[2] ?? "", match[1] ?? ""));
    }
    return [];
  }

  getElementById(id: string): { value: string } | null {
    const match = this.source.match(
      new RegExp(`<input[^>]*id="${id}"[^>]*value="([^"]*)"`, "i"),
    );
    return match ? { value: match[1] ?? "" } : null;
  }
}

const syntheticParser = class {
  parseFromString(source: string): SyntheticDocument {
    return new SyntheticDocument(source);
  }
};
const globalObject = globalThis as unknown as Record<string, unknown>;
const previousDomParser = globalObject.DOMParser;
globalObject.DOMParser = syntheticParser;
const parserPage = {
  evaluate: async (callback: (input: unknown) => unknown, input: unknown) =>
    callback(input),
};
const parserHtml = `
  <input id="form1:startDate" value="2026/01/01">
  <input id="form1:endDate" value="2026/01/31">
  <table><tr>
    <th>帳務日期</th><th>交易時間</th><th>摘要</th><th>支出金額</th>
    <th>存入金額</th><th>即時餘額</th><th>附註</th>
  </tr><tr>
    <td>2026/01/02</td><td>09:10:11</td><td>SYNTHETIC</td><td></td>
    <td>100</td><td>100</td><td>NOTE</td>
  </tr></table>
  <a onclick="setDataGridCurrentPage('x', 2, 'resultGrid:dataGridCurrentPage')">下一頁</a>
  <script>
    setupComboBox("form1:comboAccount", "", "123456");
    comboAccountItems[0] = new Array("123456 (012)", "123456");
  </script>
`;
let parsedPage: Awaited<
  ReturnType<typeof module.parseFubonDepositStatementHtml>
>;
try {
  parsedPage = await module.parseFubonDepositStatementHtml(
    parserPage,
    parserHtml,
    0,
    1,
  );
} finally {
  if (previousDomParser === undefined) delete globalObject.DOMParser;
  else globalObject.DOMParser = previousDomParser;
}
assert.equal(parsedPage.pageOrdinal, 0);
assert.equal(parsedPage.responseSequence, 1);
assert.equal(parsedPage.terminal, false);
assert.equal(parsedPage.nextPage, "2");
assert.equal(parsedPage.pageFieldName, "resultGrid:dataGridCurrentPage");
assert.deepEqual(parsedPage.queryRange, {
  startDate: "2026/01/01",
  endDate: "2026/01/31",
});
assert.deepEqual(parsedPage.selectedAccount, {
  value: "123456",
  label: "123456 (012)",
  branchName: "012",
});
assert.deepEqual(parsedPage.rows[0]?.cells, [
  "2026/01/02",
  "09:10:11",
  "SYNTHETIC",
  "",
  "100",
  "100",
  "NOTE",
]);
assert.equal(parsedPage.zeroObservation, "non-empty-page");
globalObject.DOMParser = syntheticParser;
let emptyParsedPage: Awaited<
  ReturnType<typeof module.parseFubonDepositStatementHtml>
>;
try {
  emptyParsedPage = await module.parseFubonDepositStatementHtml(
    parserPage,
    parserHtml.replace(/<tr>\s*<td>2026\/01\/02[\s\S]*?<\/tr>/, ""),
    1,
    2,
  );
} finally {
  if (previousDomParser === undefined) delete globalObject.DOMParser;
  else globalObject.DOMParser = previousDomParser;
}
assert.equal(emptyParsedPage.terminal, false);
assert.equal(emptyParsedPage.zeroObservation, "empty-page");
assert.equal(emptyParsedPage.rows.length, 0);

const accountValue = "123456789012";
const accountLabel = "123456789012 (012)";
const statement = {
  account: accountLabel,
  accountId: accountValue,
  queryPeriod: "2026/01/01~2026/01/31",
  branchName: "012",
  rows: [["2026/01/02", "09:10:11", "SYNTHETIC", "", "100", "100", "NOTE"]],
  pages: [
    {
      pageOrdinal: 0,
      responseSequence: 1,
      terminal: true,
      nextPage: null,
      pageFieldName: null,
      queryRange: { startDate: "2026/01/01", endDate: "2026/01/31" },
      selectedAccount: {
        value: accountValue,
        label: accountLabel,
        branchName: "012",
      },
      providerPageSize: 10,
      rows: [
        {
          rowOrdinal: 0,
          cells: [
            "2026/01/02",
            "09:10:11",
            "SYNTHETIC",
            "",
            "100",
            "100",
            "NOTE",
          ] as const,
          sourceOccurrenceId: "SYNTHETIC-OCCURRENCE",
        },
      ],
      zeroObservation: "non-empty-page" as const,
    },
  ],
  accountOption: {
    value: accountValue,
    label: accountLabel,
    branchName: "012",
  },
};

const rawEvidence = module.buildFubonDepositStatementEvidence(
  [statement],
  "2026-02-01T00:00:00.000Z",
);
assert.equal(rawEvidence.length, 1);
assert.equal(rawEvidence[0].account.value, accountValue);
assert.equal(
  rawEvidence[0].pages[0].rows[0].sourceOccurrenceId,
  "SYNTHETIC-OCCURRENCE",
);

assert.throws(
  () => module.redactFubonDepositStatementEvidence(rawEvidence[0]),
  /structural admission/,
);

const calls: string[] = [];
const output = await module.runFubonStatements(
  {},
  { dateRanges: ["1"], downloadFormat: "EXCEL" },
  {
    openTransactionDetailForAccountIndex: async () => {
      calls.push("open");
      return "********9012";
    },
    readDepositAccountOptions: async () => [
      { value: accountValue, label: accountLabel },
    ],
    selectDepositAccount: async () => {
      calls.push("select");
    },
    fetchDepositStatement: async () => statement,
    writeDepositStatementFiles: async () => ({
      accountId: "********9012",
      account: "********9012",
      queryPeriods: [statement.queryPeriod],
      branchName: statement.branchName,
      baseName: "safe-1",
      csvFilename: "safe-1.csv",
      csvPath: "/tmp/safe-1.csv",
      csvBytes: 1,
      jsonFilename: "safe-1.json",
      jsonPath: "/tmp/safe-1.json",
      jsonBytes: 1,
      rowCount: 1,
    }),
  },
);

assert.deepEqual(calls, ["open", "select"]);
assert.equal(output.count, 1);
assert.equal(output.evidence.length, 1);
assert.equal(output.downloads[0].account, "********9012");
assert.equal(output.downloads[0].accountId, "********9012");
assert.equal(output.evidence[0].account.label, "********9012");
assert.match(output.evidence[0].account.valueDigest, /^sha256:/);
assert.equal(output.evidence[0].pages[0].rows[0].cells.length, 7);
assert.doesNotMatch(JSON.stringify(output), new RegExp(accountValue));
assert.doesNotMatch(JSON.stringify(output), /SYNTHETIC-OCCURRENCE/);
assert.doesNotThrow(() => module.fubonStatementsOutputSchema.parse(output));

const previousWorkingDirectory = process.cwd();
const defaultWriterDirectory = await mkdtemp(
  join(tmpdir(), "fubon-default-writer-"),
);
try {
  process.chdir(defaultWriterDirectory);
  const defaultWriterOutput = await module.runFubonStatements(
    {},
    { dateRanges: ["1"], downloadFormat: "EXCEL" },
    {
      openTransactionDetailForAccountIndex: async () => "********9012",
      readDepositAccountOptions: async () => [
        { value: accountValue, label: accountLabel },
      ],
      selectDepositAccount: async () => {},
      fetchDepositStatement: async () => statement,
    },
  );
  const defaultDownload = defaultWriterOutput.downloads[0];
  assert.equal(defaultDownload.account, "********9012");
  assert.equal(defaultDownload.accountId, "********9012");
  assert.doesNotMatch(defaultDownload.baseName, new RegExp(accountValue));
  assert.doesNotMatch(defaultDownload.csvPath, new RegExp(accountValue));
  assert.doesNotMatch(defaultDownload.jsonPath, new RegExp(accountValue));
  const defaultCsv = await readFile(defaultDownload.csvPath, "utf8");
  const defaultJson = await readFile(defaultDownload.jsonPath, "utf8");
  assert.doesNotMatch(defaultCsv, new RegExp(accountValue));
  assert.doesNotMatch(defaultCsv, /SYNTHETIC-OCCURRENCE/);
  assert.doesNotMatch(defaultJson, new RegExp(accountValue));
  assert.doesNotMatch(defaultJson, /SYNTHETIC-OCCURRENCE/);
  assert.doesNotThrow(() =>
    module.fubonStatementsOutputSchema.parse(defaultWriterOutput),
  );
} finally {
  process.chdir(previousWorkingDirectory);
  await rm(defaultWriterDirectory, { recursive: true, force: true });
}

const secondAccountValue = "222233334444";
const secondAccountLabel = `${secondAccountValue} (099)`;
const statementForAccount = (value: string, label: string) => ({
  ...statement,
  account: label,
  accountId: value,
  pages: statement.pages.map((page) => ({
    ...page,
    selectedAccount: {
      value,
      label,
      branchName: page.selectedAccount.branchName,
    },
  })),
  accountOption: {
    value,
    label,
    branchName: "012",
  },
});
let malformedWriterCalls = 0;
await assert.rejects(
  module.runFubonStatements(
    {},
    { dateRanges: ["1"], downloadFormat: "EXCEL" },
    {
      openTransactionDetailForAccountIndex: async () => "********9012",
      readDepositAccountOptions: async () => [
        { value: accountValue, label: accountLabel },
        { value: secondAccountValue, label: secondAccountLabel },
      ],
      selectDepositAccount: async () => {},
      fetchDepositStatement: async (
        _page: unknown,
        _range: string,
        account: { value: string },
      ) =>
        account.value === secondAccountValue
          ? {
              ...statementForAccount(secondAccountValue, secondAccountLabel),
              pages: [],
              rows: [],
            }
          : statementForAccount(accountValue, accountLabel),
      writeDepositStatementFiles: async () => {
        malformedWriterCalls += 1;
        throw new Error("writer must not run for malformed evidence");
      },
    },
  ),
  /evidence admission blocked:.*(?:query-range-invalid|page-missing)/,
);
assert.equal(malformedWriterCalls, 0);
