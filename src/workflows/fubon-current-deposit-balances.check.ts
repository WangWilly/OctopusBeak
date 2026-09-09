import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  FUBON_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH,
  FUBON_CURRENT_DEPOSIT_HEADERS,
  parseFubonCurrentDepositBalanceSnapshot,
  parseFubonCurrentDepositBalanceTable,
  waitForFubonCurrentDepositHeader,
  type FubonCurrentDepositResponseMetadata,
} from "./fubon-current-deposit-balances.ts";

type Cell = {
  kind: "cell";
  tag: "th" | "td";
  text: string;
  className?: string;
};
type Row = { kind: "row"; cells: Cell[] };
type Table = { kind: "table"; id: string; className: string; rows: Row[] };
type FixtureNode = Table | Row | Cell;

class FixtureLocator {
  private readonly nodes: readonly FixtureNode[];

  constructor(nodes: readonly FixtureNode[]) {
    this.nodes = nodes;
  }

  locator(selector: string): FixtureLocator {
    const descendants: FixtureNode[] = [];
    for (const node of this.nodes) {
      if (node.kind === "table" && selector === "tr") {
        descendants.push(...node.rows);
        continue;
      }
      if (node.kind !== "row") continue;
      const cells = node.cells.filter((cell) => {
        if (selector === "th, td") return true;
        if (selector === "th") return cell.tag === "th";
        if (selector === "td") return cell.tag === "td";
        if (selector === "td:not(.hide)") {
          return cell.tag === "td" && !cell.className?.split(/\s+/u).includes("hide");
        }
        if (selector === "th:not(.hide), td:not(.hide)") {
          return !cell.className?.split(/\s+/u).includes("hide");
        }
        if (selector === "td.hide") {
          return cell.tag === "td" && cell.className?.split(/\s+/u).includes("hide");
        }
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
    if (!node || node.kind !== "cell") throw new Error("Fixture cell is missing.");
    return node.text;
  }

  async getAttribute(name: string): Promise<string | null> {
    const node = this.nodes[0];
    if (!node) return null;
    if (node.kind === "table" && name === "id") return node.id;
    if (node.kind === "table" && name === "class") return node.className;
    if (node.kind === "cell" && name === "class") return node.className ?? null;
    return null;
  }
}

function header(values: readonly string[]): Row {
  return {
    kind: "row",
    cells: values.map((text) => ({ kind: "cell", tag: "th", text })),
  };
}

function headerWithHiddenCells(values: readonly string[]): Row {
  return {
    kind: "row",
    cells: [
      ...values.map((text) => ({ kind: "cell" as const, tag: "td" as const, text })),
      { kind: "cell", tag: "td", text: "internal-header-1", className: "hide" },
      { kind: "cell", tag: "td", text: "internal-header-2", className: "hide" },
    ],
  };
}

function data(values: readonly string[], hidden: readonly string[]): Row {
  return {
    kind: "row",
    cells: [
      ...values.map((text) => ({ kind: "cell" as const, tag: "td" as const, text })),
      ...hidden.map((text) => ({
        kind: "cell" as const,
        tag: "td" as const,
        text,
        className: "hide",
      })),
    ],
  };
}

function tableLocator(rows: Row[]): FixtureLocator {
  return new FixtureLocator([
    {
      kind: "table",
      id: "form1:resultGrid_DataGridBody",
      className: "tb_bkBody m10",
      rows,
    },
  ]);
}

const response = (
  overrides: Partial<FubonCurrentDepositResponseMetadata> = {},
): FubonCurrentDepositResponseMetadata => ({
  url: `https://ebank.taipeifubon.com.tw${FUBON_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH}`,
  status: 200,
  method: "POST",
  headers: {
    date: "Tue, 08 Sep 2026 13:40:10 GMT",
    "cache-control": "no-store, no-cache",
  },
  ...overrides,
});

const observedAt = "2026-09-08T21:40:20+08:00";
const visibleRows = [
  [
    "00123456789012",
    "主要帳戶",
    "活儲存款",
    "012",
    "臺幣",
    "0",
    "-1,250.50",
    "",
    "",
    "快速功能",
  ],
  [
    "98765432109876",
    "外幣帳戶",
    "外幣活存",
    "034",
    "USD",
    "2,000.00",
    "1,950.25",
    "",
    "",
    "快速功能",
  ],
] as const;
const hiddenRows = [
  ["internal-account-digits", "internal-token"],
  ["other-internal-digits", "other-internal-token"],
] as const;

const parsed = parseFubonCurrentDepositBalanceSnapshot({
  rows: visibleRows,
  response: response(),
  observedAt,
  financialAuthority: {
    sourceConnectionKey: "sha256:fubon-connection",
    identityEpochKey: "fubon-epoch-v1",
    authorityClass: "authenticated-current-state",
  },
});
assert.equal(parsed.length, 2);
assert.equal(parsed[0]?.accountNumber, "00123456789012");
assert.equal(parsed[0]?.currency, "TWD");
assert.equal(parsed[0]?.currencySourceLexeme, "臺幣");
assert.deepEqual(parsed[0]?.instantBalance, {
  coefficient: "0",
  scale: 0,
  sourceLexeme: "0",
});
assert.deepEqual(parsed[0]?.availableBalance, {
  coefficient: "-125050",
  scale: 2,
  sourceLexeme: "-1,250.50",
});
assert.notDeepEqual(parsed[0]?.instantBalance, parsed[0]?.availableBalance);
assert.equal(parsed[0]?.providerHttpDate, "Tue, 08 Sep 2026 13:40:10 GMT");
assert.equal(parsed[0]?.effectiveAt, "2026-09-08T13:40:10.000Z");
assert.equal(parsed[0]?.observedAt, observedAt);
assert.deepEqual(parsed[0]?.financialAuthority, {
  sourceConnectionKey: "sha256:fubon-connection",
  identityEpochKey: "fubon-epoch-v1",
  authorityClass: "authenticated-current-state",
});

const currentTable = tableLocator([
  header(FUBON_CURRENT_DEPOSIT_HEADERS),
  data(visibleRows[0], hiddenRows[0]),
  data(visibleRows[1], hiddenRows[1]),
  {
    kind: "row",
    cells: [{ kind: "cell", tag: "th", text: "總計" }],
  },
]);
const parsedTable = await parseFubonCurrentDepositBalanceTable(
  currentTable as never,
  { response: response(), observedAt },
);
assert.equal(parsedTable.length, 2);
assert.equal(parsedTable[0]?.accountNumber, "00123456789012");
assert.equal(parsedTable[1]?.availableBalance.coefficient, "195025");

const headerWithHiddenCellsTable = tableLocator([
  headerWithHiddenCells(FUBON_CURRENT_DEPOSIT_HEADERS),
  data(visibleRows[0], hiddenRows[0]),
]);
const parsedHeaderWithHiddenCells = await parseFubonCurrentDepositBalanceTable(
  headerWithHiddenCellsTable as never,
  { response: response(), observedAt },
);
assert.equal(parsedHeaderWithHiddenCells.length, 1);
assert.equal(parsedHeaderWithHiddenCells[0]?.accountNumber, "00123456789012");

const malformedHeaderTable = tableLocator([
  header(["帳號", "錯誤標題", ...FUBON_CURRENT_DEPOSIT_HEADERS.slice(2)]),
  data(visibleRows[0], hiddenRows[0]),
]);
await assert.rejects(
  () =>
    parseFubonCurrentDepositBalanceTable(malformedHeaderTable as never, {
      response: response(),
      observedAt,
    }),
  /headers are not recognized/u,
);

let headerProbeCount = 0;
let sleepCount = 0;
assert.equal(
  await waitForFubonCurrentDepositHeader(
    async () => {
      headerProbeCount += 1;
      return headerProbeCount === 3;
    },
    1_000,
    async () => {
      sleepCount += 1;
    },
  ),
  true,
);
assert.equal(headerProbeCount, 3);
assert.equal(sleepCount, 2);
assert.equal(
  await waitForFubonCurrentDepositHeader(async () => false, 0, async () => {
    throw new Error("a timed-out header poll must not sleep");
  }),
  false,
);

const wrongVisibleWidth = tableLocator([
  header(FUBON_CURRENT_DEPOSIT_HEADERS),
  data([...visibleRows[0], "overlong-visible"], hiddenRows[0]),
]);
await assert.rejects(
  () => parseFubonCurrentDepositBalanceTable(wrongVisibleWidth as never, { response: response(), observedAt }),
  /12 TD cells/u,
);

const wrongHiddenWidth = tableLocator([
  header(FUBON_CURRENT_DEPOSIT_HEADERS),
  data(visibleRows[0], ["only-one-hidden"]),
]);
await assert.rejects(
  () => parseFubonCurrentDepositBalanceTable(wrongHiddenWidth as never, { response: response(), observedAt }),
  /12 TD cells/u,
);

const snapshotInput = { rows: visibleRows, observedAt } as const;
assert.throws(
  () =>
    parseFubonCurrentDepositBalanceSnapshot({
      ...snapshotInput,
      response: response({
        url: "https://ebank.taipeifubon.com.tw/wrong",
      }),
    }),
  /endpoint is unexpected/u,
);
assert.throws(
  () =>
    parseFubonCurrentDepositBalanceSnapshot({
      ...snapshotInput,
      response: response({
        url: "https://example.test/B2C/cboqu/cboqu003/CBOQU003_Home.faces",
      }),
    }),
  /host is unexpected/u,
);
assert.throws(
  () =>
    parseFubonCurrentDepositBalanceSnapshot({
      ...snapshotInput,
      response: response({ status: 502 }),
    }),
  /status is 502/u,
);
assert.throws(
  () =>
    parseFubonCurrentDepositBalanceSnapshot({
      ...snapshotInput,
      response: response({ headers: { "cache-control": "no-store, no-cache" } }),
    }),
  /missing HTTP Date/u,
);
assert.throws(
  () =>
    parseFubonCurrentDepositBalanceSnapshot({
      ...snapshotInput,
      response: response({
        headers: { date: "Tue, 08 Sep 2026 13:40:10 GMT", "cache-control": "no-store" },
      }),
    }),
  /no-store, no-cache/u,
);
assert.throws(
  () =>
    parseFubonCurrentDepositBalanceSnapshot({
      ...snapshotInput,
      response: response({
        headers: {
          date: "Tue, 08 Sep 2026 13:40:10 +0000",
          "cache-control": "no-store, no-cache",
        },
      }),
    }),
  /HTTP Date is invalid/u,
);
assert.throws(
  () =>
    parseFubonCurrentDepositBalanceSnapshot({
      ...snapshotInput,
      response: response(),
      observedAt: "2026-02-30T21:40:20+08:00",
    }),
  /invalid calendar date/u,
);
assert.throws(
  () =>
    parseFubonCurrentDepositBalanceSnapshot({
      ...snapshotInput,
      response: response(),
      rows: [[
        visibleRows[0]![0]!,
        visibleRows[0]![1]!,
        visibleRows[0]![2]!,
        visibleRows[0]![3]!,
        visibleRows[0]![4]!,
        "1,2",
        visibleRows[0]![6]!,
        visibleRows[0]![7]!,
        visibleRows[0]![8]!,
        visibleRows[0]![9]!,
      ]],
    }),
  /not an exact decimal/u,
);

const source = await readFile(new URL("./fubon-current-deposit-balances.ts", import.meta.url), "utf8");
assert.match(source, /waitForResponse/);
assert.match(source, /存款交易查詢/u);
assert.match(source, /我的存款/u);
assert.match(source, /td:not\(\.hide\)/u);
assert.match(source, /tableHasCurrentDepositHeader/u);
assert.match(source, /FUBON_CURRENT_DEPOSIT_HEADER_READY_TIMEOUT_MS/u);
assert.match(source, /waitForFubonCurrentDepositHeader/u);
assert.doesNotMatch(source, /DEBUG-fubon-v27/u);
assert.doesNotMatch(source, /\bfetch\s*\(/u);
assert.doesNotMatch(source, /click\(\{\s*force:/u);

console.log("fubon-current-deposit-balances.check passed");
