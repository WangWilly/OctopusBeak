import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  HNCB_CURRENT_DEPOSIT_BALANCE_PATH,
  HNCB_CURRENT_DEPOSIT_BALANCE_TRANSACTION,
  HNCB_CURRENT_DEPOSIT_HEADERS,
  HNCB_CURRENT_DEPOSIT_OVERVIEW_HEADERS,
  HNCB_CURRENT_DEPOSIT_OVERVIEW_PATH,
  HNCB_CURRENT_DEPOSIT_OVERVIEW_TRANSACTION,
  parseHncbCurrentDepositBalanceSnapshot,
  parseHncbCurrentDepositBalanceTable,
  parseHncbCurrentDepositOverviewTable,
  type HncbCurrentDepositResponseMetadata,
} from "./hncb-current-deposit-balances.ts";

type Cell = {
  kind: "cell";
  tag: "th" | "td";
  text: string;
  attributes?: Readonly<Record<string, string>>;
};
type Row = { kind: "row"; cells: Cell[] };
type Table = { kind: "table"; rows: Row[]; nested?: Table[] };
type Root = { kind: "root"; tables: Table[] };
type FixtureNode = Root | Table | Row | Cell;

class FixtureLocator {
  private readonly nodes: readonly FixtureNode[];

  constructor(nodes: readonly FixtureNode[]) {
    this.nodes = nodes;
  }

  locator(selector: string): FixtureLocator {
    const descendants: FixtureNode[] = [];
    for (const node of this.nodes) {
      if (node.kind === "root" && selector === "table") {
        descendants.push(...node.tables);
        continue;
      }
      if (node.kind === "table" && selector === "tr") {
        descendants.push(...node.rows);
        continue;
      }
      if (
        node.kind === "table" &&
        selector === ":scope > thead > tr, :scope > tbody > tr, :scope > tfoot > tr, :scope > tr"
      ) {
        descendants.push(...node.rows);
        continue;
      }
      if (node.kind === "table" && selector === "table") {
        descendants.push(...(node.nested ?? []));
        continue;
      }
      if (node.kind !== "row") continue;
      const cells = node.cells.filter((cell) => {
        if (selector === "th, td") return true;
        if (selector === ":scope > th, :scope > td") return true;
        if (selector === ":scope > th") return cell.tag === "th";
        if (selector === ":scope > td") return cell.tag === "td";
        if (selector === "th") return cell.tag === "th";
        if (selector === "td") return cell.tag === "td";
        return false;
      });
      descendants.push(...cells);
    }
    return new FixtureLocator(descendants);
  }

  nth(index: number): FixtureLocator {
    return new FixtureLocator(this.nodes[index] ? [this.nodes[index]!] : []);
  }

  async count(): Promise<number> {
    return this.nodes.length;
  }

  async innerText(): Promise<string> {
    const node = this.nodes[0];
    if (!node) throw new Error("Fixture node is missing.");
    if (node.kind === "cell") return node.text;
    if (node.kind === "row") return node.cells.map((cell) => cell.text).join(" ");
    if (node.kind === "root") {
      return node.tables
        .flatMap((table) => table.rows.flatMap((row) => row.cells.map((cell) => cell.text)))
        .join(" ");
    }
    return node.rows.flatMap((row) => row.cells.map((cell) => cell.text)).join(" ");
  }

  async getAttribute(name: string): Promise<string | null> {
    const node = this.nodes[0];
    if (!node || node.kind !== "cell") return null;
    return node.attributes?.[name] ?? null;
  }

  async evaluate<T>(fn: (element: { tagName: string }) => T): Promise<T> {
    const node = this.nodes[0];
    if (!node || node.kind !== "cell") throw new Error("Fixture cell is missing.");
    return fn({ tagName: node.tag.toUpperCase() });
  }
}

function header(): Row {
  return {
    kind: "row",
    cells: HNCB_CURRENT_DEPOSIT_HEADERS.map((text) => ({
      kind: "cell",
      tag: "td",
      text,
    })),
  };
}

function data(values: readonly string[]): Row {
  return {
    kind: "row",
    cells: values.map((text) => ({ kind: "cell", tag: "td", text })),
  };
}

function fixtureTable(rows: Row[], nested: Table[] = []): FixtureLocator {
  return new FixtureLocator([{ kind: "table", rows, nested }]);
}

const response = (
  overrides: Partial<HncbCurrentDepositResponseMetadata> = {},
): HncbCurrentDepositResponseMetadata => ({
  url: `https://netbank.hncb.com.tw${HNCB_CURRENT_DEPOSIT_BALANCE_PATH}?trx=${HNCB_CURRENT_DEPOSIT_BALANCE_TRANSACTION}`,
  status: 200,
  method: "GET",
  headers: {
    date: "Tue, 08 Sep 2026 13:43:07 GMT",
    "cache-control": "no-store",
  },
  ...overrides,
});

const overviewResponse = (
  overrides: Partial<HncbCurrentDepositResponseMetadata> = {},
): HncbCurrentDepositResponseMetadata => ({
  url: `https://netbank.hncb.com.tw${HNCB_CURRENT_DEPOSIT_OVERVIEW_PATH}?trx=${HNCB_CURRENT_DEPOSIT_OVERVIEW_TRANSACTION}&state=prompt&time_str=20260909135527`,
  status: 200,
  method: "GET",
  headers: {
    date: "Wed, 09 Sep 2026 05:57:04 GMT",
    "cache-control": "no-store",
    "content-type": "text/html; charset=big5",
  },
  ...overrides,
});

const observedAt = "2026-09-08T21:43:20+08:00";
const rowA = [
  "PII-SHOULD-NOT-ESCAPE",
  "00123456789012",
  "臺幣",
  "1,000.25",
  "HOLD-1",
  "HOLD-2",
  "HOLD-3",
  "HOLD-4",
  "HOLD-5",
  "HOLD-6",
  "1,100.75",
  "PLEDGE-1",
] as const;
const rowB = [
  "OTHER-PII",
  "98765432109876",
  "USD",
  "2,500",
  "unused",
  "unused",
  "unused",
  "unused",
  "unused",
  "unused",
  "2,450",
  "unused",
] as const;
const formattedAccountRow = rowA.map((value, index) =>
  index === 1 ? "001-234567-890" : value,
);
const unavailableBalanceRow = [
  "OTHER-PII",
  "987-654321-098",
  "",
  "-",
  "-",
  "-",
  "-",
  "-",
  "-",
  "-",
  "-",
  "-",
] as const;

const parsed = parseHncbCurrentDepositBalanceSnapshot({
  rows: [rowA, rowB],
  response: response(),
  observedAt,
  financialAuthority: {
    sourceConnectionKey: "sha256:hncb-connection",
    identityEpochKey: "hncb-epoch-v1",
    authorityClass: "authenticated-current-state",
  },
});
assert.equal(parsed.length, 2);
assert.equal(parsed[0]?.accountNumber, "00123456789012");
assert.equal(parsed[0]?.currency, "TWD");
assert.deepEqual(parsed[0]?.available, {
  coefficient: "100025",
  scale: 2,
  sourceLexeme: "1,000.25",
});
assert.deepEqual(parsed[0]?.ledger, {
  coefficient: "110075",
  scale: 2,
  sourceLexeme: "1,100.75",
});
assert.notDeepEqual(parsed[0]?.available, parsed[0]?.ledger);
assert.equal(parsed[0]?.effectiveAt, "2026-09-08T13:43:07.000Z");
assert.equal(parsed[0]?.providerHttpDate, "Tue, 08 Sep 2026 13:43:07 GMT");
assert.equal(parsed[0]?.observedAt, observedAt);
assert.doesNotMatch(JSON.stringify(parsed), /PII-SHOULD-NOT-ESCAPE/u);
assert.doesNotMatch(JSON.stringify(parsed), /HOLD-1/u);

const parsedFormattedAndUnavailable = parseHncbCurrentDepositBalanceSnapshot({
  rows: [formattedAccountRow, unavailableBalanceRow],
  response: response(),
  observedAt,
});
assert.equal(parsedFormattedAndUnavailable.length, 1);
assert.equal(parsedFormattedAndUnavailable[0]?.accountNumber, "001234567890");
assert.equal(parsedFormattedAndUnavailable[0]?.currency, "TWD");

const partiallyUnavailable = unavailableBalanceRow.map((value, index) =>
  index === 10 ? "0" : value,
);
assert.throws(
  () =>
    parseHncbCurrentDepositBalanceSnapshot({
      rows: [partiallyUnavailable],
      response: response(),
      observedAt,
    }),
  /currency is invalid/u,
);

const currentTable = fixtureTable([
  header(),
  data(rowA),
  data(rowB),
  {
    kind: "row",
    cells: [
      {
        kind: "cell",
        tag: "td",
        text: "查詢結果",
        attributes: { colspan: "12" },
      },
    ],
  },
]);
const parsedTable = await parseHncbCurrentDepositBalanceTable(
  currentTable as never,
  { response: response(), observedAt },
);
assert.equal(parsedTable.length, 2);
assert.equal(parsedTable[1]?.ledger.coefficient, "2450");

function overviewParentHeader(): Row {
  const cells = [
    ["帳號", { rowspan: "2" }],
    ["類別", { rowspan: "2" }],
    ["幣別", { rowspan: "2" }],
    ["帳上餘額", { rowspan: "2" }],
    ["可用餘額", { colspan: "2" }],
    ["薪轉利率", { rowspan: "2" }],
    ["餘額查詢", { rowspan: "2" }],
    ["明細查詢", { rowspan: "2" }],
    ["轉帳", { rowspan: "2" }],
    ["其他查詢", { rowspan: "2" }],
  ] as const;
  return {
    kind: "row",
    cells: cells.map(([text, attributes]) => ({
      kind: "cell",
      tag: "th",
      text,
      attributes,
    })),
  };
}

function overviewSecondHeader(): Row {
  return {
    kind: "row",
    cells: ["原幣", "折合新台幣"].map((text) => ({
      kind: "cell",
      tag: "th",
      text,
    })),
  };
}

function overviewData(values: readonly string[]): Row {
  assert.equal(values.length, HNCB_CURRENT_DEPOSIT_OVERVIEW_HEADERS.length);
  return data(values);
}

const overviewRows = [
  overviewData([
    "166203735484",
    "活儲",
    "新台幣",
    "11,389.00",
    "11,389.00",
    "-",
    "-",
    "餘額",
    "明細",
    "轉帳",
    "其他",
  ]),
  overviewData([
    "166970072770",
    "活存",
    "",
    "0.00",
    "0.00",
    "-",
    "-",
    "餘額",
    "明細",
    "",
    "其他",
  ]),
];
const overviewTable = fixtureTable([
  overviewParentHeader(),
  overviewSecondHeader(),
  ...overviewRows,
  {
    kind: "row",
    cells: [{ kind: "cell", tag: "td", text: "查詢結果", attributes: { colspan: "11" } }],
  },
]);
const parsedOverview = await parseHncbCurrentDepositOverviewTable(
  overviewTable as never,
  { response: overviewResponse(), observedAt },
);
assert.equal(parsedOverview.length, 2);
assert.equal(parsedOverview[0]?.currency, "TWD");
assert.equal(parsedOverview[0]?.ledger.coefficient, "1138900");
assert.equal(parsedOverview[1]?.accountNumber, "166970072770");
assert.equal(parsedOverview[1]?.currency, "");
assert.equal(parsedOverview[1]?.currencyResolution, "missing");
assert.equal(parsedOverview[1]?.ledger.coefficient, "0");
assert.equal(parsedOverview[1]?.available.coefficient, "0");
assert.equal(parsedOverview[1]?.sourceEvidence.url, overviewResponse().url);

const malformedOverviewHeader = overviewParentHeader();
malformedOverviewHeader.cells[4]!.attributes = { colspan: "1" };
await assert.rejects(
  () =>
    parseHncbCurrentDepositOverviewTable(
      fixtureTable([malformedOverviewHeader, overviewSecondHeader(), ...overviewRows]) as never,
      { response: overviewResponse(), observedAt },
    ),
  /headers are not recognized|parent header must span/u,
);

const unmarkedSingleCell = fixtureTable([
  header(),
  data(rowA),
  data(rowB),
  { kind: "row", cells: [{ kind: "cell", tag: "td", text: "查詢結果" }] },
]);
await assert.rejects(
  () => parseHncbCurrentDepositBalanceTable(unmarkedSingleCell as never, { response: response(), observedAt }),
  /12 TD cells/u,
);

const nestedTable = new FixtureLocator([
  {
    kind: "root",
    tables: [
      {
        kind: "table",
        rows: [header(), data(rowA)],
        nested: [{ kind: "table", rows: [header(), data(rowA)] }],
      },
    ],
  },
]);
// The parser must reject a nested result table instead of treating its cells
// as another account row. The fixture intentionally uses the same observed
// header so the nested-table guard is the decisive check.
await assert.rejects(
  () => parseHncbCurrentDepositBalanceTable(nestedTable as never, { response: response(), observedAt }),
  /headers are not recognized/u,
);

const overlong = fixtureTable([header(), data([...rowA, "unexpected"])]);
await assert.rejects(
  () => parseHncbCurrentDepositBalanceTable(overlong as never, { response: response(), observedAt }),
  /12 TD cells/u,
);

const snapshotInput = { rows: [rowA, rowB], observedAt } as const;
assert.throws(
  () =>
    parseHncbCurrentDepositBalanceSnapshot({
      ...snapshotInput,
      response: response({
        url: `https://netbank.hncb.com.tw/wrong?trx=${HNCB_CURRENT_DEPOSIT_BALANCE_TRANSACTION}`,
      }),
    }),
  /endpoint is unexpected/u,
);
assert.throws(
  () =>
    parseHncbCurrentDepositBalanceSnapshot({
      ...snapshotInput,
      response: response({
        url: `https://example.test${HNCB_CURRENT_DEPOSIT_BALANCE_PATH}?trx=${HNCB_CURRENT_DEPOSIT_BALANCE_TRANSACTION}`,
      }),
    }),
  /host is unexpected/u,
);
assert.throws(
  () =>
    parseHncbCurrentDepositBalanceSnapshot({
      ...snapshotInput,
      response: response({ status: 502 }),
    }),
  /status is 502/u,
);
assert.throws(
  () =>
    parseHncbCurrentDepositBalanceSnapshot({
      ...snapshotInput,
      response: response({
        url: `https://netbank.hncb.com.tw${HNCB_CURRENT_DEPOSIT_BALANCE_PATH}?trx=other`,
      }),
    }),
  /transaction is unexpected/u,
);
assert.throws(
  () =>
    parseHncbCurrentDepositBalanceSnapshot({
      ...snapshotInput,
      response: response({ headers: { "cache-control": "no-store" } }),
    }),
  /missing HTTP Date/u,
);
assert.throws(
  () =>
    parseHncbCurrentDepositBalanceSnapshot({
      ...snapshotInput,
      response: response({
        headers: {
          date: "Tue, 08 Sep 2026 13:43:07 GMT",
          "cache-control": "private",
        },
      }),
    }),
  /Cache-Control: no-store/u,
);
assert.throws(
  () =>
    parseHncbCurrentDepositBalanceSnapshot({
      ...snapshotInput,
      response: response({
        headers: {
          date: "Tue, 08 Sep 2026 13:43:07 +0000",
          "cache-control": "no-store",
        },
      }),
    }),
  /HTTP Date is invalid/u,
);
assert.throws(
  () =>
    parseHncbCurrentDepositBalanceSnapshot({
      ...snapshotInput,
      response: response(),
      observedAt: "2026-02-30T21:43:20+08:00",
    }),
  /invalid calendar date/u,
);
assert.throws(
  () =>
    parseHncbCurrentDepositBalanceSnapshot({
      ...snapshotInput,
      response: response(),
      rows: [[
        rowA[0]!,
        rowA[1]!,
        rowA[2]!,
        "1,2",
        ...rowA.slice(4),
      ]],
    }),
  /not an exact decimal/u,
);

const source = await readFile(new URL("./hncb-current-deposit-balances.ts", import.meta.url), "utf8");
assert.match(source, /帳務查詢/u);
assert.match(source, /餘額查詢/u);
assert.match(source, /活期存款/u);
assert.match(source, /waitForResponse/);
assert.doesNotMatch(source, /\bfetch\s*\(/u);
assert.doesNotMatch(source, /click\(\{\s*force:/u);

console.log("hncb-current-deposit-balances.check passed");
