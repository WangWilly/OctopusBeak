import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  hncbCurrentBalanceSnapshot,
  HNCB_CURRENT_DEPOSIT_BALANCE_TRANSACTION,
  HNCB_CURRENT_DEPOSIT_HEADERS,
  HNCB_CURRENT_DEPOSIT_OVERVIEW_HEADERS,
  HNCB_CURRENT_DEPOSIT_OVERVIEW_TRANSACTION,
  HNCB_CURRENT_DEPOSIT_RESPONSE,
  parseHncbCurrentDepositBalanceSnapshot,
  parseHncbCurrentDepositOverviewSnapshot,
  readHncbCurrentDepositDetailCells,
  readHncbCurrentDepositOverviewCells,
  type ExistingHncbFinancialCapture,
  type HncbCurrentDepositTable,
} from "./hncb-current-deposit-balances.ts";
import {
  hncbCurrentDepositDetailRow,
  hncbCurrentDepositDetailTable,
} from "./hncb-current-deposit-balances.fixtures.ts";
import { captureCurrentStateSnapshots } from "./current-state-snapshot-capture.ts";
import { snapshotCheckProduct, stagedBalanceRequest } from "./current-state-snapshot-capture.fixtures.ts";
import { HNCB_TRX_DISPATCHER_PATH } from "./hncb-netbank-site.ts";
import { verifyProviderResponse, type ProviderResponse } from "./provider-response.ts";

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

const rawResponse = (
  overrides: Partial<ProviderResponse> = {},
): ProviderResponse => ({
  url: `https://netbank.hncb.com.tw${HNCB_TRX_DISPATCHER_PATH}?trx=${HNCB_CURRENT_DEPOSIT_BALANCE_TRANSACTION}`,
  status: 200,
  method: "GET",
  headers: {
    date: "Tue, 08 Sep 2026 13:43:07 GMT",
    "cache-control": "no-store",
  },
  ...overrides,
});

const rawOverviewResponse = (
  overrides: Partial<ProviderResponse> = {},
): ProviderResponse => ({
  url: `https://netbank.hncb.com.tw${HNCB_TRX_DISPATCHER_PATH}?trx=${HNCB_CURRENT_DEPOSIT_OVERVIEW_TRANSACTION}&state=prompt&time_str=20260909135527`,
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
const verify = (raw: ProviderResponse) =>
  verifyProviderResponse(HNCB_CURRENT_DEPOSIT_RESPONSE, raw, observedAt);
const response = (overrides: Partial<ProviderResponse> = {}) => verify(rawResponse(overrides));
const overviewResponse = (overrides: Partial<ProviderResponse> = {}) =>
  verify(rawOverviewResponse(overrides));
const rowAAccountNumber = ["0012", "3456", "7890", "12"].join("");
const formattedAccountNumber = ["0012", "3456", "7890"].join("");
const overviewTwdAccountNumber = ["1662", "1234", "5684"].join("");
const overviewBlankCurrencyAccountNumber = ["1669", "1234", "5670"].join("");
const rowA = [
  "PII-SHOULD-NOT-ESCAPE",
  rowAAccountNumber,
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
});
assert.equal(parsed.length, 2);
assert.equal(parsed[0]?.accountNumber, rowAAccountNumber);
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
});
assert.equal(parsedFormattedAndUnavailable.length, 1);
assert.equal(parsedFormattedAndUnavailable[0]?.accountNumber, formattedAccountNumber);
assert.equal(parsedFormattedAndUnavailable[0]?.currency, "TWD");

const partiallyUnavailable = unavailableBalanceRow.map((value, index) =>
  index === 10 ? "0" : value,
);
assert.throws(
  () =>
    parseHncbCurrentDepositBalanceSnapshot({
      rows: [partiallyUnavailable],
      response: response(),
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
const parsedTable = parseHncbCurrentDepositBalanceSnapshot({
  rows: await readHncbCurrentDepositDetailCells(currentTable as never),
  response: response(),
});
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
    overviewTwdAccountNumber,
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
    overviewBlankCurrencyAccountNumber,
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
const parsedOverview = parseHncbCurrentDepositOverviewSnapshot({
  rows: await readHncbCurrentDepositOverviewCells(overviewTable as never),
  response: overviewResponse(),
});
assert.equal(parsedOverview.length, 2);
assert.equal(parsedOverview[0]?.currency, "TWD");
assert.equal(parsedOverview[0]?.ledger.coefficient, "1138900");
assert.equal(parsedOverview[1]?.accountNumber, overviewBlankCurrencyAccountNumber);
assert.equal(parsedOverview[1]?.currency, "");
assert.equal(parsedOverview[1]?.currencyResolution, "missing");
assert.equal(parsedOverview[1]?.ledger.coefficient, "0");
assert.equal(parsedOverview[1]?.available.coefficient, "0");
assert.equal(parsedOverview[1]?.sourceEvidence.url, rawOverviewResponse().url);

const malformedOverviewHeader = overviewParentHeader();
malformedOverviewHeader.cells[4]!.attributes = { colspan: "1" };
await assert.rejects(
  () =>
    readHncbCurrentDepositOverviewCells(
      fixtureTable([malformedOverviewHeader, overviewSecondHeader(), ...overviewRows]) as never,
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
  () => readHncbCurrentDepositDetailCells(unmarkedSingleCell as never),
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
  () => readHncbCurrentDepositDetailCells(nestedTable as never),
  /headers are not recognized/u,
);

const overlong = fixtureTable([header(), data([...rowA, "unexpected"])]);
await assert.rejects(
  () => readHncbCurrentDepositDetailCells(overlong as never),
  /12 TD cells/u,
);

const snapshotInput = { rows: [rowA, rowB] } as const;
assert.throws(
  () =>
    response({
      url: `https://netbank.hncb.com.tw${HNCB_TRX_DISPATCHER_PATH}?trx=other`,
    }),
  /endpoint is unexpected/u,
);
assert.throws(
  () =>
    response({
      url: `https://netbank.hncb.com.tw${HNCB_TRX_DISPATCHER_PATH}?trx=other&trx=${HNCB_CURRENT_DEPOSIT_BALANCE_TRANSACTION}`,
    }),
  /endpoint is unexpected/u,
  "only the first trx parameter names the transaction",
);
assert.equal(
  response({
    url: `https://netbank.hncb.com.tw${HNCB_TRX_DISPATCHER_PATH}?state=prompt&trx=${HNCB_CURRENT_DEPOSIT_BALANCE_TRANSACTION}`,
  }).url.searchParams.get("state"),
  "prompt",
);
assert.throws(() => response({ method: "POST" }), /method is not GET/u);
assert.throws(
  () =>
    response({
      headers: {
        date: "Tue, 08 Sep 2026 13:43:07 GMT",
        "cache-control": "private",
      },
    }),
  /Cache-Control: no-store/u,
);
assert.throws(
  () =>
    overviewResponse({
      headers: {
        date: "Wed, 09 Sep 2026 05:57:04 GMT",
        "cache-control": "no-store",
        "content-type": "application/json",
      },
    }),
  /content type is unexpected/u,
);
assert.equal(
  response().contentType,
  "",
  "the 活期存款 page carries no Content-Type requirement",
);
assert.throws(
  () =>
    parseHncbCurrentDepositBalanceSnapshot({
      ...snapshotInput,
      response: overviewResponse(),
    }),
  /transaction is unexpected/u,
);
assert.throws(
  () =>
    parseHncbCurrentDepositOverviewSnapshot({
      rows: [],
      response: response(),
    }),
  /transaction is unexpected/u,
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

{
  const { CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS } = await import("../ledger/canonical/current-deposit-route-contracts.ts");
  const detail = CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS["hncb/domestic-deposit/current-balance-v1"];
  const overview = CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS["hncb/domestic-deposit/current-balance-overview-v1"];
  for (const contract of [detail, overview]) {
    assert.equal(contract.endpointHost, HNCB_CURRENT_DEPOSIT_RESPONSE.host, "both HNCB routes share the declared host");
    assert.deepEqual(contract.requiredCacheTokens, HNCB_CURRENT_DEPOSIT_RESPONSE.cacheControl, "both HNCB routes share the declared cache tokens");
  }
  assert.deepEqual(
    HNCB_CURRENT_DEPOSIT_RESPONSE.endpoints.map((endpoint) => endpoint.path),
    [overview.endpointPath, detail.endpointPath],
    "each HNCB endpoint is its route's contract path",
  );
}

const detailAccountNumber = ["0001", "0002", "0003"].join("");
/** An admitted HNCB statement identity carrying full account-number evidence. */
function admittedIdentity(accountNumber: string, currency?: string): ExistingHncbFinancialCapture {
  return {
    identity: {
      sourceConnectionKey: "sha256:hncb-current-connection",
      identityEpochKey: "sha256:hncb-current-epoch",
      subjectDigest: "sha256:hncb-current-subject",
      accountNo: accountNumber,
      accountNumber: { value: accountNumber },
      ...(currency ? { currency } : {}),
    },
  };
}

/** Drive the declaration over one acquired HNCB table for the admitted captures. */
function snapshot(
  table: HncbCurrentDepositTable,
  captures: readonly ExistingHncbFinancialCapture[],
  now: string,
) {
  return captureCurrentStateSnapshots(hncbCurrentBalanceSnapshot, {
    captures,
    acquire: async () => table,
    product: snapshotCheckProduct({ now }),
  });
}

{
  const detailIdentity = admittedIdentity(detailAccountNumber);
  const staged = await snapshot(
    hncbCurrentDepositDetailTable([hncbCurrentDepositDetailRow(detailAccountNumber, "1.00", "0.90")]),
    [detailIdentity],
    "2026-09-01T12:00:00+08:00",
  );
  assert.equal(staged.matched[0]?.capture, detailIdentity);
  assert.deepEqual(staged.items.map((item) => [item.product, item.itemKey]), [
    ["current-balance", `current-balance:domestic-deposit:${detailAccountNumber}`],
  ]);
  const request = stagedBalanceRequest(staged.items[0]);
  assert.equal(request.capture.routeKey, "hncb/domestic-deposit/current-balance-v1");
  assert.equal(request.capture.sourceConnectionKey, "sha256:hncb-current-connection");
  assert.equal(request.capture.identityEpoch, "sha256:hncb-current-epoch");
  assert.equal(request.capture.subjectDigest, "sha256:hncb-current-subject");
  assert.deepEqual([request.capture.scope.startDate, request.capture.scope.endDate], ["2026-09-01", "2026-09-01"]);
  assert.equal(request.account.sourceAccountKey, detailAccountNumber);
  assert.equal(request.account.currency, "TWD");
  assert.deepEqual(
    request.observations.map((observation) => [observation.balanceKind, observation.balance.coefficient, observation.balance.scale]),
    [["ledger", "100", 2], ["available", "90", 2]],
  );
  for (const observation of request.observations) {
    assert.equal(observation.effectiveAt, "2026-09-01T03:59:00.000Z");
    assert.equal(observation.evidenceSourceField, "HTTP Date");
    assert.equal(observation.evidenceSourceValue, "Tue, 01 Sep 2026 03:59:00 GMT");
  }
  assert.equal(request.capture.records.length, 2);
  assert.deepEqual(request.capture.records.map((record) => record.compact.sourceField), ["帳上餘額", "可用餘額"]);
  assert.equal(request.capture.records[0]?.compact.currencyResolution, "provider");
}

{
  const acquiredOverview = {
    view: "overview",
    evidence: {
      kind: "cells",
      rows: await readHncbCurrentDepositOverviewCells(overviewTable as never),
    },
    response: rawOverviewResponse(),
  } as const satisfies HncbCurrentDepositTable;
  const now = "2026-09-09T13:57:10+08:00";
  const blankCurrencyIdentity = admittedIdentity(overviewBlankCurrencyAccountNumber, "TWD");
  const staged = await snapshot(
    acquiredOverview,
    [admittedIdentity(overviewTwdAccountNumber, "TWD"), blankCurrencyIdentity],
    now,
  );
  assert.equal(staged.matched[1]?.capture, blankCurrencyIdentity);
  assert.equal(staged.matched[1]?.capture.identity.currency, "TWD");
  assert.deepEqual(staged.items.map((item) => [item.product, item.itemKey]), [
    ["current-balance", `current-balance:domestic-deposit:${overviewTwdAccountNumber}`],
    ["current-balance", `current-balance:domestic-deposit:${overviewBlankCurrencyAccountNumber}`],
  ]);
  const request = stagedBalanceRequest(staged.items[1]);
  assert.equal(request.capture.routeKey, "hncb/domestic-deposit/current-balance-overview-v1");
  assert.deepEqual([request.capture.scope.startDate, request.capture.scope.endDate], ["2026-09-09", "2026-09-09"]);
  assert.equal(request.account.sourceAccountKey, overviewBlankCurrencyAccountNumber);
  assert.equal(request.account.currency, "TWD");
  assert.deepEqual(request.capture.records.map((record) => record.compact.sourceField), ["帳上餘額", "原幣"]);
  assert.equal(request.capture.records[0]?.compact.currencyResolution, "canonical-account");
  assert.equal(request.capture.records[0]?.compact.canonicalCurrency, "TWD");
  assert.equal(request.observations[0]?.evidenceEndpoint, rawOverviewResponse().url, "the overview keeps the URL it was read from");
  assert.equal(request.observations[0]?.effectiveAt, "2026-09-09T05:57:04.000Z");

  await assert.rejects(
    snapshot(
      acquiredOverview,
      [admittedIdentity(overviewTwdAccountNumber, "TWD"), admittedIdentity(overviewBlankCurrencyAccountNumber)],
      now,
    ),
    /cannot resolve blank currency/u,
    "a blank overview currency without an admitted canonical currency is refused",
  );
  await assert.rejects(
    snapshot(acquiredOverview, [admittedIdentity(overviewTwdAccountNumber, "TWD")], now),
    /^Error: HNCB current deposit snapshot contains an account without existing full account-number evidence\.$/u,
    "an overview row without an admitted capture rejects the snapshot",
  );
}

const source = await readFile(new URL("./hncb-current-deposit-balances.ts", import.meta.url), "utf8");
assert.doesNotMatch(source, /\bfetch\s*\(/u);

console.log("hncb-current-deposit-balances.check passed");
