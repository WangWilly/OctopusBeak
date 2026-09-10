import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  YUANTA_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH,
  YUANTA_CURRENT_DEPOSIT_DOMESTIC_HEADERS,
  YUANTA_CURRENT_DEPOSIT_FOREIGN_HEADERS,
  navigateYuantaCurrentDepositSummary,
  parseYuantaCurrentDepositBalanceSnapshot,
  parseYuantaCurrentDepositBalanceTable,
  readYuantaCurrentDepositBalances,
  yuantaCurrentDepositSummaryUrl,
  type YuantaCurrentDepositResponseMetadata,
} from "./yuanta-current-deposit-balances.ts";

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
assert.equal(domestic[0]?.accountNumber, "0012345678901234");
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
    { accountNumber: "0011223344556677", currency: "USD", available: "100025", ledger: "101075" },
    { accountNumber: "9988776655443322", currency: "JPY", available: "2500", ledger: "2450" },
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

// The all-statements run leaves fmain on a product page. The current reader
// must restore the provider's observed summary route before looking for the
// balance card; this fixture proves the route and cid propagation directly.
const navigationCalls: Array<{
  url: string;
  waitUntil?: string;
}> = [];
const navigationFrame = {
  url: () =>
    "https://ebank.yuantabank.com.tw/nib/tx/fxtransactiondetails?type=page&cid=cid-fixture",
  locator: (_selector: string) => ({
    first: () => ({
      count: async () => 0,
      inputValue: async () => "",
    }),
  }),
  goto: async (url: string, options: { waitUntil?: string }) => {
    navigationCalls.push({ url, waitUntil: options.waitUntil });
  },
};
const navigationPage = {
  frame: ({ name }: { name: string }) =>
    name === "fmain" ? navigationFrame : null,
  frames: () => [navigationFrame],
  locator: (selector: string) => navigationFrame.locator(selector),
  url: () => "https://ebank.yuantabank.com.tw/nib/login.jsp",
  waitForTimeout: async () => {},
};
assert.equal(
  yuantaCurrentDepositSummaryUrl("cid-fixture"),
  "https://ebank.yuantabank.com.tw/nib/tx/summary?type=page&cid=cid-fixture",
);
assert.equal(
  await navigateYuantaCurrentDepositSummary(navigationPage as never),
  true,
);
assert.deepEqual(navigationCalls, [
  {
    url: "https://ebank.yuantabank.com.tw/nib/tx/summary?type=page&cid=cid-fixture",
    waitUntil: "domcontentloaded",
  },
]);
assert.equal(
  await navigateYuantaCurrentDepositSummary({
    frame: () => null,
    frames: () => [],
    locator: (selector: string) => navigationFrame.locator(selector),
    url: () => "https://ebank.yuantabank.com.tw/nib/login.jsp",
    waitForTimeout: async () => {},
  } as never),
  false,
);

type ReaderLinkNode = {
  kind: "reader-link";
  text: string;
  visible: boolean;
  onClick: () => void;
};
type ReaderTabNode = {
  kind: "reader-tab";
  visible: boolean;
  onClick: () => void;
};
type ReaderContainerNode = {
  kind: "reader-container";
  links: ReaderLinkNode[];
  parent?: ReaderHeadingNode;
};
type ReaderHeadingNode = {
  kind: "reader-heading";
  text: string;
  parent: ReaderContainerNode;
};
type ReaderTableNode = {
  kind: "reader-table";
  className: string;
  rows: Row[];
};
type ReaderNode =
  | ReaderLinkNode
  | ReaderTabNode
  | ReaderContainerNode
  | ReaderHeadingNode
  | ReaderTableNode
  | Row
  | Cell;

class ReaderPageFixture {
  tableReady = false;
  summaryTabClicks = 0;
  clickedLink: string | null = null;
  private responseResolver: ((response: object) => void) | null = null;
  readonly response = {
    url: () => `https://ebank.yuantabank.com.tw${YUANTA_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH}`,
    status: () => 200,
    request: () => ({ method: () => "POST" }),
    allHeaders: async () => ({
      date: "Tue, 08 Sep 2026 13:24:22 GMT",
      "cache-control": "private, no-store",
    }),
  };
  readonly foreignFrame = new ReaderFrameFixture(this);

  constructor() {
    const hiddenLink: ReaderLinkNode = {
      kind: "reader-link",
      text: "活期明細",
      visible: false,
      onClick: () => {
        throw new Error("The hidden foreign-currency link must not be clicked.");
      },
    };
    const visibleLink: ReaderLinkNode = {
      kind: "reader-link",
      text: "活期明細",
      visible: true,
      onClick: () => {
        this.clickedLink = "visible";
        this.tableReady = true;
        this.responseResolver?.(this.response);
      },
    };
    const container: ReaderContainerNode = {
      kind: "reader-container",
      links: [hiddenLink, visibleLink],
    };
    const heading: ReaderHeadingNode = {
      kind: "reader-heading",
      text: "目前外幣存款總額",
      parent: container,
    };
    container.parent = heading;
    this.foreignFrame.nodes = [
      {
        kind: "reader-tab",
        visible: true,
        onClick: () => {
          this.summaryTabClicks += 1;
        },
      },
      heading,
      tableReaderNode([
        header(YUANTA_CURRENT_DEPOSIT_FOREIGN_HEADERS),
        data(["臺北分行", "外幣活期", "USD", "0011223344556677", "1,000.25", "1,010.75", "31.2", "31,200"]),
      ]),
    ];
  }

  frames(): ReaderFrameFixture[] {
    return [this.foreignFrame];
  }

  frame({ name }: { name: string }): ReaderFrameFixture | null {
    return name === "fmain" ? this.foreignFrame : null;
  }

  locator(_selector: string): ReaderLocator {
    return new ReaderLocator([], this);
  }

  url(): string {
    return "https://ebank.yuantabank.com.tw/nib/login.jsp";
  }

  async waitForTimeout(): Promise<void> {}

  waitForResponse(
    _predicate: unknown,
    _options?: unknown,
  ): Promise<object> {
    return new Promise((resolve) => {
      this.responseResolver = resolve;
    });
  }
}

class ReaderFrameFixture {
  nodes: ReaderNode[] = [];
  private readonly page: ReaderPageFixture;

  constructor(page: ReaderPageFixture) {
    this.page = page;
  }

  locator(selector: string): ReaderLocator {
    if (selector === 'input[name="cid"]') {
      return new ReaderLocator([], this.page);
    }
    if (selector === "#submenuAreaFX") {
      return new ReaderLocator(
        this.nodes.filter((node) => node.kind === "reader-tab"),
        this.page,
      );
    }
    if (selector.startsWith("table.normalTable")) {
      return new ReaderLocator(
        this.page.tableReady
          ? this.nodes.filter((node) => node.kind === "reader-table")
          : [],
        this.page,
      );
    }
    if (selector.includes("h1") && selector.includes("[role='heading']")) {
      return new ReaderLocator(
        this.nodes.filter((node) => node.kind === "reader-heading"),
        this.page,
      );
    }
    return new ReaderLocator([], this.page);
  }

  url(): string {
    return "https://ebank.yuantabank.com.tw/nib/tx/fxtransactiondetails?cid=fixture";
  }
}

class ReaderLocator {
  private readonly nodes: readonly ReaderNode[];
  private readonly page: ReaderPageFixture;

  constructor(
    nodes: readonly ReaderNode[],
    page: ReaderPageFixture,
  ) {
    this.nodes = nodes;
    this.page = page;
  }

  locator(selector: string): ReaderLocator {
    const descendants: ReaderNode[] = [];
    for (const node of this.nodes) {
      if (node.kind === "reader-heading") {
        if (selector === "xpath=..") descendants.push(node.parent);
        continue;
      }
      if (node.kind === "reader-container") {
        if (selector === "a") descendants.push(...node.links);
        continue;
      }
      if (node.kind === "reader-table" && selector === "tr") {
        descendants.push(...node.rows);
        continue;
      }
      if (node.kind !== "row") continue;
      if (selector === "table") continue;
      const cells = node.cells.filter((cell) => {
        if (selector === "th, td") return true;
        if (selector === "th") return cell.tag === "th";
        if (selector === "td") return cell.tag === "td";
        return false;
      });
      descendants.push(...cells);
    }
    return new ReaderLocator(descendants, this.page);
  }

  filter(options: { hasText: string | RegExp }): ReaderLocator {
    const pattern = options.hasText;
    return new ReaderLocator(
      this.nodes.filter((node) => {
        const text =
          node.kind === "reader-link" || node.kind === "reader-heading"
            ? node.text
            : "";
        return typeof pattern === "string" ? text.includes(pattern) : pattern.test(text);
      }),
      this.page,
    );
  }

  nth(index: number): ReaderLocator {
    return new ReaderLocator(this.nodes[index] ? [this.nodes[index]!] : [], this.page);
  }

  first(): ReaderLocator {
    return this.nth(0);
  }

  async count(): Promise<number> {
    return this.nodes.length;
  }

  async isVisible(): Promise<boolean> {
    const node = this.nodes[0];
    return node?.kind === "reader-link" || node?.kind === "reader-tab"
      ? node.visible
      : false;
  }

  async click(): Promise<void> {
    const node = this.nodes[0];
    if (node?.kind === "reader-link" || node?.kind === "reader-tab") {
      node.onClick();
    }
  }

  async innerText(): Promise<string> {
    const node = this.nodes[0];
    if (node?.kind === "cell") return node.text;
    throw new Error("Reader fixture innerText is only defined for cells.");
  }

  async getAttribute(name: string): Promise<string | null> {
    const node = this.nodes[0];
    if (node?.kind === "reader-table" && name === "class") return node.className;
    if (node?.kind === "cell" && name === "class") return node.className ?? null;
    return null;
  }
}

function tableReaderNode(rows: Row[]): ReaderTableNode {
  return { kind: "reader-table", className: "normalTable", rows };
}

const readerPage = new ReaderPageFixture();
const readerRows = await readYuantaCurrentDepositBalances(
  readerPage as never,
  "foreign",
  { observedAt, timeoutMs: 2_000 },
);
assert.equal(readerPage.summaryTabClicks, 1);
assert.equal(readerPage.clickedLink, "visible");
assert.deepEqual(
  readerRows.map((row) => ({ accountNumber: row.accountNumber, currency: row.currency })),
  [{ accountNumber: "0011223344556677", currency: "USD" }],
);

const source = await readFile(new URL("./yuanta-current-deposit-balances.ts", import.meta.url), "utf8");
assert.match(source, /waitForResponse/);
assert.match(source, /\/nib\/tx\/summary/u);
assert.match(source, /page\.frame\(\{ name: "fmain" \}\)/u);
assert.match(source, /目前臺幣存款總額/u);
assert.match(source, /目前外幣存款總額/u);
assert.match(source, /isVisible()/u);
assert.doesNotMatch(source, /\bfetch\s*\(/u);
assert.doesNotMatch(source, /click\(\{\s*force:/u);

console.log("yuanta-current-deposit-balances.check passed");
