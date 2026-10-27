import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";

import { strictSourceText } from "../lib/automation/source-text.ts";
import { FUBON_EBANK_ENTRY_URL, fubonEbankSite } from "./fubon-ebank-site.ts";

import {
  FUBON_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH,
  FUBON_CURRENT_DEPOSIT_HEADERS,
  parseFubonCurrentDepositBalanceSnapshot,
  parseFubonCurrentDepositBalanceTable,
  readFubonCurrentDepositBalances,
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
assert.equal(parsed[0]?.accountNumber, visibleRows[0]![0]);
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
assert.equal(parsedTable[0]?.accountNumber, visibleRows[0]![0]);
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
assert.equal(parsedHeaderWithHiddenCells[0]?.accountNumber, visibleRows[0]![0]);

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

const twdRow = visibleRows[0]!;
const usdHoldingRow = [
  twdRow[0], twdRow[1], "外幣活存", twdRow[3], "美金", "12.34", "12.34", "", "", "快速功能",
] as const;
const multiCurrencyRows = parseFubonCurrentDepositBalanceSnapshot({
  ...snapshotInput,
  response: response(),
  rows: [twdRow, usdHoldingRow],
});
assert.deepEqual(
  multiCurrencyRows.map((row) => [row.accountNumber, row.currency, row.currencySourceLexeme]),
  [
    ["00123456789012", "TWD", "臺幣"],
    ["00123456789012", "USD", "美金"],
  ],
  "one account may hold a TWD and a USD balance in the same snapshot",
);
assert.throws(
  () =>
    parseFubonCurrentDepositBalanceSnapshot({
      ...snapshotInput,
      response: response(),
      rows: [twdRow, [...twdRow]],
    }),
  /duplicate account/u,
  "the same account and currency twice is still a duplicate",
);
assert.throws(
  () =>
    parseFubonCurrentDepositBalanceSnapshot({
      ...snapshotInput,
      response: response(),
      rows: [[...twdRow.slice(0, 4), "火星幣", ...twdRow.slice(5)]],
    }),
  /currency is invalid/u,
  "an unmapped currency label fails closed",
);

const source = await readFile(new URL("./fubon-current-deposit-balances.ts", import.meta.url), "utf8");
assert.doesNotMatch(source, /DEBUG-fubon-v27/u);
assert.doesNotMatch(source, /\bfetch\s*\(/u);
assert.doesNotMatch(source, /click\(\{\s*force:/u);


const ORIGIN = new URL(FUBON_EBANK_ENTRY_URL).origin;
const PROVIDER_DATE = "Tue, 08 Sep 2026 13:40:10 GMT";
const cells = (values: readonly string[], tag: "th" | "td") =>
  values.map((value) => `<${tag}>${value}</${tag}>`).join("");
const HEADER_ROW = `<tr>${cells(FUBON_CURRENT_DEPOSIT_HEADERS, "th")}</tr>`;
const DATA_ROWS = visibleRows
  .map((row, index) =>
    `<tr>${cells(row, "td")}${hiddenRows[index]!.map((value) => `<td class="hide" style="display:none">${value}</td>`).join("")}</tr>`)
  .join("");

let browser: Browser;
before(async () => {
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser.close();
});

type Shell = Readonly<{ headerRowDelayMs?: number; balanceHangs?: boolean }>;

/**
 * frame1 holds 存款交易查詢, which only a real pointer click opens, and that
 * reveals 我的存款, which loads the balance page into txnFrame.
 */
async function withDepositShell(
  options: Shell,
  body: (page: Page, requested: string[]) => Promise<void>,
): Promise<void> {
  const page = await browser.newPage();
  const requested: string[] = [];
  try {
    await page.route(`${ORIGIN}/**`, async (route) => {
      const { pathname } = new URL(route.request().url());
      requested.push(pathname);
      const html = (content: string, headers: Record<string, string> = {}) =>
        route.fulfill({ contentType: "text/html; charset=utf-8", headers, body: content });
      switch (pathname) {
        case "/B2C/common/Index.faces":
          return await html(`<iframe name="frame1" src="/B2C/header.faces"></iframe><iframe name="txnFrame" src="/B2C/home.faces"></iframe>`);
        case "/B2C/header.faces":
          return await html(`<a id="menu_CDS" href="javascript:void(0)">存款交易查詢</a><div id="cds"></div>
            <script>
              document.getElementById("menu_CDS").addEventListener("click", (event) => {
                if (!event.isTrusted) return;
                document.getElementById("cds").innerHTML =
                  '<a class="task_CBOQU003 menu_CDS0102" href="javascript:void(0)" onclick="parent.frames.txnFrame.location.href=\\'${FUBON_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH}\\'">我的存款</a>';
              });
            </script>`);
        case "/B2C/home.faces":
          return await html(`<p>首頁</p>`);
        case FUBON_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH: {
          if (options.balanceHangs) return;
          const rows = options.headerRowDelayMs === undefined
            ? `${HEADER_ROW}${DATA_ROWS}`
            : DATA_ROWS;
          const lateHeader = options.headerRowDelayMs === undefined
            ? ""
            : `<script>setTimeout(() => document.querySelector("tbody").insertAdjacentHTML("afterbegin", ${JSON.stringify(HEADER_ROW)}), ${options.headerRowDelayMs});</script>`;
          return await html(
            `<table id="form1:resultGrid_DataGridBody" class="tb_bkBody m10"><tbody>${rows}</tbody></table>${lateHeader}`,
            { date: PROVIDER_DATE, "cache-control": "no-store, no-cache" },
          );
        }
        default:
          return await html(`<p>${pathname}</p>`);
      }
    });
    await page.goto(FUBON_EBANK_ENTRY_URL, { waitUntil: "load" });
    await body(page, requested);
  } finally {
    await page.close();
  }
}

const siteFor = (page: Page, signal = new AbortController().signal) =>
  fubonEbankSite(page, { signal, text: strictSourceText });

test("the balance page is reached through 存款交易查詢 and 我的存款, and its response is the evidence", () =>
  withDepositShell({}, async (page, requested) => {
    const rows = await readFubonCurrentDepositBalances(siteFor(page), { observedAt, timeoutMs: 10_000 });
    assert.deepEqual(rows.map((row) => [row.accountNumber, row.currency, row.instantBalance.sourceLexeme]), [
      ["00123456789012", "TWD", "0"],
      ["98765432109876", "USD", "2,000.00"],
    ]);
    assert.equal(rows[0]?.providerHttpDate, PROVIDER_DATE);
    assert.equal(rows[0]?.sourceEvidence.cacheControl, "no-store, no-cache");
    assert.equal(requested.filter((path) => path === FUBON_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH).length, 1);
  }));

test("a header row that renders after the table is waited for before the table is parsed", () =>
  withDepositShell({ headerRowDelayMs: 600 }, async (page) => {
    const rows = await readFubonCurrentDepositBalances(siteFor(page), { observedAt, timeoutMs: 10_000 });
    assert.equal(rows.length, 2);
  }));

test("a run cancelled while the bank holds the balance response rejects with its reason", () =>
  withDepositShell({ balanceHangs: true }, async (page, requested) => {
    const controller = new AbortController();
    const cancelled = new Error("synthetic cancellation");
    const read = readFubonCurrentDepositBalances(siteFor(page, controller.signal), { observedAt });
    const startedAt = Date.now();
    while (!requested.includes(FUBON_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH)) {
      assert.ok(Date.now() - startedAt < 10_000, "the balance page was never requested");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    controller.abort(cancelled);
    await assert.rejects(read, (error) => error === cancelled);
  }));

console.log("fubon-current-deposit-balances.check passed");
