import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { chromium, type Browser } from "playwright";

import { strictSourceText } from "../lib/automation/source-text.ts";
import {
  YUANTA_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH,
  YUANTA_CURRENT_DEPOSIT_DOMESTIC_HEADERS,
  YUANTA_CURRENT_DEPOSIT_FOREIGN_HEADERS,
  parseYuantaCurrentDepositBalanceSnapshot,
  parseYuantaCurrentDepositBalanceTable,
  readYuantaCurrentDepositBalances,
  type YuantaCurrentDepositResponseMetadata,
} from "./yuanta-current-deposit-balances.ts";
import { YUANTA_EBANK_ORIGIN, yuantaEbankSite } from "./yuanta-ebank-site.ts";

type Cell = {
  kind: "cell";
  tag: "th" | "td";
  text: string;
  className?: string;
};
type Row = { kind: "row"; cells: Cell[] };
type Table = { kind: "table"; className: string; rows: Row[] };
type FixtureNode = Table | Row | Cell;

/** Minimal Locator surface used to exercise the live DOM parser. */
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
        return false;
      });
      descendants.push(...cells);
    }
    return new FixtureLocator(descendants);
  }

  nth(index: number): FixtureLocator {
    return new FixtureLocator(this.nodes[index] ? [this.nodes[index]!] : []);
  }

  first(): FixtureLocator {
    return this.nth(0);
  }

  async count(): Promise<number> {
    return this.nodes.length;
  }

  async innerText(): Promise<string> {
    const node = this.nodes[0];
    if (!node) throw new Error("Fixture locator is empty.");
    if (node.kind === "cell") return node.text;
    throw new Error("Fixture innerText is only defined for cells.");
  }

  async getAttribute(name: string): Promise<string | null> {
    const node = this.nodes[0];
    if (!node) return null;
    if (node.kind === "table" && name === "class") return node.className;
    if (node.kind === "cell" && name === "class") return node.className ?? null;
    return null;
  }
}

function tableLocator(className: string, rows: Row[]): FixtureLocator {
  return new FixtureLocator([{ kind: "table", className, rows }]);
}

function header(values: readonly string[]): Row {
  return {
    kind: "row",
    cells: values.map((text) => ({ kind: "cell", tag: "th", text })),
  };
}

function data(values: readonly string[], hidden: readonly string[] = []): Row {
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

const response = (
  overrides: Partial<YuantaCurrentDepositResponseMetadata> = {},
): YuantaCurrentDepositResponseMetadata => ({
  url: `https://ebank.yuantabank.com.tw${YUANTA_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH}`,
  status: 200,
  method: "POST",
  headers: {
    date: "Tue, 08 Sep 2026 13:20:04 GMT",
    "cache-control": "no-store",
  },
  ...overrides,
});

const observedAt = "2026-09-08T21:20:10+08:00";

const domesticRows = [
  ["活期存款", "臺北分行", "0012345678901234", "0.8%", "1,025.50", "1,125.75"],
  ["活期存款", "高雄分行", "9876543210987654", "0.9%", "2,000", "1,950"],
] as const;

const domestic = parseYuantaCurrentDepositBalanceSnapshot({
  kind: "domestic",
  rows: domesticRows,
  response: response(),
  observedAt,
  financialAuthority: {
    sourceConnectionKey: "sha256:authority-connection",
    identityEpochKey: "yuanta-epoch-v2",
    authorityClass: "authenticated-current-state",
  },
});

assert.equal(domestic.length, 2);
assert.equal(domestic[0]?.accountNumber, domesticRows[0][2]);
assert.equal(domestic[0]?.currency, "TWD");
assert.deepEqual(domestic[0]?.available, {
  coefficient: "102550",
  scale: 2,
  sourceLexeme: "1,025.50",
});
assert.deepEqual(domestic[0]?.ledger, {
  coefficient: "112575",
  scale: 2,
  sourceLexeme: "1,125.75",
});
assert.notDeepEqual(domestic[0]?.available, domestic[0]?.ledger);
assert.equal(domestic[0]?.effectiveAt, "2026-09-08T13:20:04.000Z");
assert.equal(domestic[0]?.providerHttpDate, "Tue, 08 Sep 2026 13:20:04 GMT");
assert.equal(domestic[0]?.observedAt, observedAt);
assert.deepEqual(domestic[0]?.financialAuthority, {
  sourceConnectionKey: "sha256:authority-connection",
  identityEpochKey: "yuanta-epoch-v2",
  authorityClass: "authenticated-current-state",
});
assert.match(domestic[0]?.sourceAccountKey ?? "", /^sha256:/u);
assert.equal(domestic[0]?.sourceEvidence.cacheControl, "no-store");

const domesticTable = tableLocator("normalTable botM2", [
  header(YUANTA_CURRENT_DEPOSIT_DOMESTIC_HEADERS),
  data(domesticRows[0]),
  data(domesticRows[1]),
  {
      kind: "row",
      cells: [
      { kind: "cell", tag: "th", text: "筆數:2筆" },
      { kind: "cell", tag: "th", text: "總計(臺幣TWD):3,075.75" },
    ],
  },
]);
const parsedDomesticTable = await parseYuantaCurrentDepositBalanceTable(
  domesticTable as never,
  { kind: "domestic", response: response(), observedAt },
);
assert.equal(parsedDomesticTable.length, 2);
assert.equal(parsedDomesticTable[0]?.available.coefficient, "102550");

const foreignRows = [
  [
    "臺北分行",
    "外幣活期",
    "美元",
    "0011223344556677",
    "1,000.25",
    "1,010.75",
    "not-a-rate",
    "not-a-valuation",
  ],
  [
    "臺中分行",
    "外幣活期",
    "日幣",
    "9988776655443322",
    "2,500",
    "2,450",
    "also-not-a-rate",
    "also-not-a-valuation",
  ],
] as const;
const foreignTable = tableLocator("normalTable", [
  header(YUANTA_CURRENT_DEPOSIT_FOREIGN_HEADERS),
  data(foreignRows[0]),
  data(foreignRows[1]),
]);
const foreign = await parseYuantaCurrentDepositBalanceTable(
  foreignTable as never,
  {
    kind: "foreign",
    response: response({
      headers: {
        date: "Tue, 08 Sep 2026 13:24:22 GMT",
        "cache-control": "private, no-store",
      },
    }),
    observedAt,
  },
);
assert.deepEqual(
  foreign.map((row) => ({
    accountNumber: row.accountNumber,
    currency: row.currency,
    available: row.available.coefficient,
    ledger: row.ledger.coefficient,
  })),
  [
    { accountNumber: foreignRows[0][3], currency: "USD", available: "100025", ledger: "101075" },
    { accountNumber: foreignRows[1][3], currency: "JPY", available: "2500", ledger: "2450" },
  ],
);
assert.equal(foreign[0]?.providerHttpDate, "Tue, 08 Sep 2026 13:24:22 GMT");
assert.equal(foreign[0]?.sourceAccountKey, "0011223344556677");

const alternateForeignAliases = parseYuantaCurrentDepositBalanceSnapshot({
  kind: "foreign",
  rows: [
    [
      "臺北分行",
      "外幣活期",
      "美金",
      "0011223344556678",
      "1",
      "1",
      "31.2",
      "31.2",
    ],
    [
      "臺中分行",
      "外幣活期",
      "日圓",
      "9988776655443323",
      "2",
      "2",
      "0.22",
      "0.44",
    ],
  ],
  response: response(),
  observedAt,
});
assert.deepEqual(
  alternateForeignAliases.map((row) => row.currency),
  ["USD", "JPY"],
);

assert.throws(
  () =>
    parseYuantaCurrentDepositBalanceSnapshot({
      kind: "foreign",
      rows: [[
        "臺北分行",
        "外幣活期",
        "日圓幣",
        "0011223344556677",
        "1,000.25",
        "1,010.75",
        "31.2",
        "31,200",
      ]],
      response: response(),
      observedAt,
    }),
  /currency is invalid/u,
);

const snapshotInput = {
  kind: "domestic" as const,
  rows: domesticRows,
  observedAt,
};
assert.throws(
  () =>
    parseYuantaCurrentDepositBalanceSnapshot({
      ...snapshotInput,
      response: response({
        url: "https://ebank.yuantabank.com.tw/wrong",
      }),
    }),
  /endpoint is unexpected/u,
);
assert.throws(
  () =>
    parseYuantaCurrentDepositBalanceSnapshot({
      ...snapshotInput,
      response: response({
        url: "https://example.test/nib/tx/finance_overview_for_summary",
      }),
    }),
  /host is unexpected/u,
);
assert.throws(
  () =>
    parseYuantaCurrentDepositBalanceSnapshot({
      ...snapshotInput,
      response: response({ status: 503 }),
    }),
  /status is 503/u,
);
assert.throws(
  () =>
    parseYuantaCurrentDepositBalanceSnapshot({
      ...snapshotInput,
      response: response({
        headers: { "cache-control": "no-store" },
      }),
    }),
  /missing HTTP Date/u,
);
assert.throws(
  () =>
    parseYuantaCurrentDepositBalanceSnapshot({
      ...snapshotInput,
      response: response({
        headers: {
          date: "Tue, 08 Sep 2026 13:20:04 GMT",
          "cache-control": "private, max-age=0",
        },
      }),
    }),
  /Cache-Control: no-store/u,
);
assert.throws(
  () =>
    parseYuantaCurrentDepositBalanceSnapshot({
      ...snapshotInput,
      response: response({
        headers: {
          date: "Tue, 08 Sep 2026 13:20:04 +0000",
          "cache-control": "no-store",
        },
      }),
    }),
  /HTTP Date is invalid/u,
);
assert.throws(
  () =>
    parseYuantaCurrentDepositBalanceSnapshot({
      ...snapshotInput,
      response: response(),
      observedAt: "2026-02-30T21:20:10+08:00",
    }),
  /invalid calendar date/u,
);
assert.throws(
  () =>
    parseYuantaCurrentDepositBalanceSnapshot({
      ...snapshotInput,
      response: response(),
      rows: [[
        domesticRows[0]![0]!,
        domesticRows[0]![1]!,
        domesticRows[0]![2]!,
        domesticRows[0]![3]!,
        "1,2",
        domesticRows[0]![5]!,
      ]],
    }),
  /not an exact decimal/u,
);

const CID = "synthetic-cid";
const CANCELLED = new Error("synthetic cancellation");
const balanceHeaders = {
  date: "Tue, 08 Sep 2026 13:24:22 GMT",
  "cache-control": "private, no-store",
};
const htmlRow = (tag: "th" | "td", values: readonly string[]) =>
  `<tr>${values.map((value) => `<${tag}>${value}</${tag}>`).join("")}</tr>`;
const balanceTables = {
  domestic: `<table class="normalTable botM2">${htmlRow("th", YUANTA_CURRENT_DEPOSIT_DOMESTIC_HEADERS)}${htmlRow("td", domesticRows[0])}${htmlRow("th", ["筆數:1筆", "總計(臺幣TWD):1,025.50"])}</table>`,
  foreign: `<table class="normalTable">${htmlRow("th", YUANTA_CURRENT_DEPOSIT_FOREIGN_HEADERS)}${htmlRow("td", ["臺北分行", "外幣活期", "USD", "0011223344556677", "1,000.25", "1,010.75", "31.2", "31,200"])}</table>`,
} as const;
// The FX card is hidden until its summary tab is clicked, and carries a hidden
// 活期明細 link that must never be clicked.
const SUMMARY_PAGE = `<form name="tw" method="post" action="/nib/tx/finance_overview_for_summary"><input type="hidden" name="kind" value="domestic"></form>
<form name="fx" method="post" action="/nib/tx/finance_overview_for_summary"><input type="hidden" name="kind" value="foreign"></form>
<section><h2>目前臺幣存款總額</h2><a href="#" onclick="document.forms.tw.submit(); return false;">活期明細</a></section>
<a id="submenuAreaFX" href="#" onclick="parent.tabClicks = (parent.tabClicks ?? 0) + 1; document.getElementById('fx').style.display = ''; return false;">外幣</a>
<section id="fx" style="display: none"><h2>目前外幣存款總額</h2>
  <a href="#" style="display: none" onclick="parent.hiddenClicked = true; return false;">活期明細</a>
  <a href="#" onclick="document.forms.fx.submit(); return false;">活期明細</a>
</section>`;

let browser: Browser;
before(async () => {
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser.close();
});

/**
 * Read balances from a synthetic fmenu/fmain frameset whose fmain was left on
 * a product page, as the statement runs leave it.
 */
async function readThroughShell(
  kind: "domestic" | "foreign",
  options: Readonly<{ cid?: boolean; signal?: AbortSignal; holdBalance?: () => void }> = {},
) {
  const page = await browser.newPage();
  const served: string[] = [];
  const cid = options.cid ?? true;
  const query = cid ? `?type=page&cid=${CID}` : "";
  try {
    await page.route(`${YUANTA_EBANK_ORIGIN}/**`, async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      served.push(`${request.method()} ${url.pathname}${url.search}`);
      const html = (body: string) => route.fulfill({ contentType: "text/html; charset=utf-8", body });
      switch (url.pathname) {
        case "/nib/shell.jsp":
          return await html(`<iframe name="fmenu" src="/nib/menu.jsp"></iframe><iframe name="fmain" src="/nib/tx/fxtransactiondetails${query}"></iframe>`);
        case "/nib/tx/summary":
          return await html(SUMMARY_PAGE);
        case YUANTA_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH: {
          if (options.holdBalance) {
            options.holdBalance();
            return;
          }
          const posted = new URLSearchParams(request.postData() ?? "").get("kind");
          return await route.fulfill({
            contentType: "text/html; charset=utf-8",
            headers: balanceHeaders,
            body: posted === "foreign" ? balanceTables.foreign : balanceTables.domestic,
          });
        }
        default:
          return await html(`<p>${url.pathname}</p>`);
      }
    });
    await page.goto(`${YUANTA_EBANK_ORIGIN}/nib/shell.jsp${query}`, { waitUntil: "load" });
    const site = yuantaEbankSite(page, {
      signal: options.signal ?? new AbortController().signal,
      text: strictSourceText,
    });
    const rows = await readYuantaCurrentDepositBalances(site, kind, { observedAt, timeoutMs: 5_000 });
    const clicks = await page.evaluate(() => ({
      tab: (window as { tabClicks?: number }).tabClicks ?? 0,
      hidden: (window as { hiddenClicked?: boolean }).hiddenClicked ?? false,
    }));
    return { rows, served, clicks };
  } finally {
    await page.close();
  }
}

test("the foreign reader reopens the summary with the session's cid, reveals the FX tab and reads the posted table", async () => {
  const { rows, served, clicks } = await readThroughShell("foreign");
  assert.ok(served.includes(`GET /nib/tx/summary?type=page&cid=${CID}`), "fmain is sent back to the summary route");
  assert.deepEqual(clicks, { tab: 1, hidden: false }, "the FX tab is clicked once and the hidden link never");
  assert.ok(served.includes(`POST ${YUANTA_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH}`));
  assert.deepEqual(
    rows.map((row) => [row.kind, row.accountNumber, row.currency, row.ledger.sourceLexeme, row.providerHttpDate]),
    [["foreign", "0011223344556677", "USD", "1,010.75", balanceHeaders.date]],
    "the balances and HTTP Date come from the observed POST response",
  );
});

test("the domestic reader opens the summary without a cid when the session carries none", async () => {
  const { rows, served, clicks } = await readThroughShell("domestic", { cid: false });
  assert.ok(served.includes("GET /nib/tx/summary"), "the summary route is opened without a query");
  assert.equal(clicks.tab, 0, "the domestic card is not behind the FX tab");
  assert.deepEqual(
    rows.map((row) => [row.kind, row.accountNumber, row.available.sourceLexeme, row.effectiveAt]),
    [["domestic", "0012345678901234", "1,025.50", "2026-09-08T13:24:22.000Z"]],
    "the footer totals row is not a balance",
  );
});

test("cancelling the run interrupts the balance response wait", async () => {
  const controller = new AbortController();
  const started = Date.now();
  await assert.rejects(
    readThroughShell("domestic", { signal: controller.signal, holdBalance: () => controller.abort(CANCELLED) }),
    (error: unknown) => error === CANCELLED,
  );
  assert.ok(Date.now() - started < 4_000, "the reader does not wait out its 5 s response timeout");
});

const source = await readFile(new URL("./yuanta-current-deposit-balances.ts", import.meta.url), "utf8");
assert.doesNotMatch(source, /\bfetch\s*\(/u);
assert.doesNotMatch(source, /click\(\{\s*force:/u);

console.log("yuanta-current-deposit-balances.check passed");
