import { randomUUID } from "node:crypto";
import { canonicalDigest } from "../ledger/canonical/canonical-digest.ts";
import {
  CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS,
  type CurrentDepositAuthorityRoute,
} from "../ledger/canonical/current-deposit-route-contracts.ts";
import type {
  CurrentDepositBalanceCaptureInput,
  CurrentDepositExactAmount,
} from "../ledger/pglite/current-deposit-admission.ts";
import type { Locator } from "playwright";

import { deriveYuantaDomesticDepositAccountKey } from "../ledger/canonical/yuanta-deposit-account-key.ts";
import { parseProviderDecimal, type ProviderDecimalPolicy } from "../lib/shared-money/exact-money.ts";
import {
  type ProviderResponse,
  type ProviderResponseDeclaration,
  type ProviderEvidence,
  type VerifiedProviderResponse,
} from "./provider-response.ts";
import { ifFound, type BrowserScope, type FrameScope } from "./frame-scope.ts";
import type { ProviderResponseReader } from "./provider-response-reader.ts";
import type { YuantaEbankSite, YuantaRoute } from "./yuanta-ebank-site.ts";
import { collapseSourceWhitespace } from "../lib/automation/source-text.ts";
import {
  assembleCurrentDepositCapture,
  CURRENT_DEPOSIT_BALANCE_STAGING,
  type CurrentBalanceCaptureMatching,
  type CurrentDepositBalanceEntry,
  type CurrentStateSnapshotDeclaration,
} from "./current-state-snapshot-capture.ts";

/**
 * Yuanta's current deposit summary is a source snapshot.  It is reached from
 * the authenticated summary page by clicking the matching `活期明細` link and
 * causes this POST to be rendered in the fmain frame.
 *
 * One POST serves both tables, so the declaration reads the domestic route's
 * contract; a check pins that the foreign route's contract agrees.
 */
const CONTRACT = CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS["yuanta/domestic-deposit/current-balance-v1"];
export const YUANTA_CURRENT_DEPOSIT_BALANCE_METHOD = "POST" as const;

export const YUANTA_CURRENT_DEPOSIT_DOMESTIC_HEADERS = [
  "產品名稱",
  "分行名稱",
  "帳號",
  "利率",
  "可用餘額",
  "帳面餘額",
] as const;

export const YUANTA_CURRENT_DEPOSIT_FOREIGN_HEADERS = [
  "分行名稱",
  "產品名稱",
  "幣別",
  "帳號",
  "可用餘額",
  "帳面餘額",
  "參考匯率",
  "臺幣市值",
] as const;

type YuantaCurrentDepositKind = "domestic" | "foreign";
type YuantaCurrentDepositStream =
  | "domestic-deposit"
  | "foreign-currency-deposit";

/** Exact source decimal plus the normalized storage representation. */
type YuantaCurrentDepositExactDecimal = Readonly<{
  coefficient: string;
  scale: number;
  /** The source cell after surrounding whitespace/NBSP cleanup. */
  sourceLexeme: string;
}>;

/** The summary card's POST, for both the domestic and the foreign table; Yuanta never constrained its query. */
export const YUANTA_CURRENT_DEPOSIT_RESPONSE: ProviderResponseDeclaration<"required"> = {
  label: "Yuanta current deposit",
  host: CONTRACT.endpointHost,
  endpoints: [{
    path: CONTRACT.endpointPath,
    method: YUANTA_CURRENT_DEPOSIT_BALANCE_METHOD,
    search: /^(?:\?.*)?$/u,
  }],
  cacheControl: CONTRACT.requiredCacheTokens,
  providerDate: "required",
};

type YuantaCurrentDepositBalanceRow = Readonly<{
  source: "yuanta";
  kind: YuantaCurrentDepositKind;
  stream: YuantaCurrentDepositStream;
  /** The complete provider account lexeme, including leading zeroes. */
  accountNumber: string;
  /** Domestic accounts retain the existing digest key; FX keeps its source key. */
  sourceAccountKey: string;
  currency: string;
  available: YuantaCurrentDepositExactDecimal;
  ledger: YuantaCurrentDepositExactDecimal;
  /** Provider HTTP Date, normalized to RFC3339 for typed time use. */
  effectiveAt: string;
  /** Raw provider HTTP Date retained for source-lineage evidence. */
  providerHttpDate: string;
  /** The run's time of observing the response. */
  observedAt: string;
  sourceEvidence: Readonly<{
    endpoint: typeof CONTRACT.endpointPath;
    method: typeof YUANTA_CURRENT_DEPOSIT_BALANCE_METHOD;
    status: 200;
    cacheControl: string;
    contractVersion: typeof CONTRACT.contractVersion;
  }>;
}>;

type YuantaCurrentDepositSnapshotInput = Readonly<{
  kind: YuantaCurrentDepositKind;
  rows: readonly (readonly string[])[];
  response: VerifiedProviderResponse<"required">;
}>;

const SUMMARY_HEADING: Record<YuantaCurrentDepositKind, string> = {
  domestic: "目前臺幣存款總額",
  foreign: "目前外幣存款總額",
};

const YUANTA_AMOUNT: ProviderDecimalPolicy = {
  internalWhitespace: "strip",
  grouping: "thousands",
  digits: "decimal",
};

function parseExactDecimal(
  value: string,
  label: string,
): YuantaCurrentDepositExactDecimal {
  const sourceLexeme = collapseSourceWhitespace(value);
  const amount = parseProviderDecimal(sourceLexeme, YUANTA_AMOUNT);
  if (!amount) {
    throw new Error(`Yuanta current deposit ${label} is not an exact decimal.`);
  }
  return { ...amount, sourceLexeme };
}

function parseCurrency(value: string, label: string): string {
  const normalized = collapseSourceWhitespace(value).toUpperCase();
  // Yuanta's live pages use Traditional Chinese currency labels while its
  // transaction sources expose the corresponding ISO codes. Keep this
  // source-specific alias set explicit and fail closed for other labels.
  const aliases: Readonly<Record<string, string>> = {
    日幣: "JPY",
    日圓: "JPY",
    美元: "USD",
    美金: "USD",
  };
  const canonical = aliases[normalized] ?? normalized;
  if (!/^[A-Z]{3}$/u.test(canonical)) {
    throw new Error(`Yuanta current deposit ${label} currency is invalid.`);
  }
  return canonical;
}

function parseAccount(value: string, label: string): string {
  const normalized = collapseSourceWhitespace(value);
  if (!/^\d{6,24}$/u.test(normalized)) {
    throw new Error(`Yuanta current deposit ${label} account is invalid.`);
  }
  return normalized;
}

function expectedHeaders(kind: YuantaCurrentDepositKind): readonly string[] {
  return kind === "domestic"
    ? YUANTA_CURRENT_DEPOSIT_DOMESTIC_HEADERS
    : YUANTA_CURRENT_DEPOSIT_FOREIGN_HEADERS;
}

function expectedStream(
  kind: YuantaCurrentDepositKind,
): YuantaCurrentDepositStream {
  return kind === "domestic"
    ? "domestic-deposit"
    : "foreign-currency-deposit";
}

/**
 * Parse table data after the DOM reader has identified the exact provider
 * header. Footer totals are intentionally outside this input and therefore
 * cannot become balance facts.
 */
export function parseYuantaCurrentDepositBalanceSnapshot(
  input: YuantaCurrentDepositSnapshotInput,
): readonly YuantaCurrentDepositBalanceRow[] {
  const { response } = input;
  const headers = expectedHeaders(input.kind);
  const rows: YuantaCurrentDepositBalanceRow[] = [];
  const seen = new Set<string>();

  if (input.rows.length === 0) {
    throw new Error("Yuanta current deposit table has no account rows.");
  }

  for (let rowIndex = 0; rowIndex < input.rows.length; rowIndex += 1) {
    const values = input.rows[rowIndex]!;
    if (values.length !== headers.length) {
      throw new Error(
        `Yuanta current deposit row ${rowIndex} must have ${headers.length} cells.`,
      );
    }

    const accountNumber = parseAccount(
      values[input.kind === "domestic" ? 2 : 3] ?? "",
      `row ${rowIndex}`,
    );
    const currency =
      input.kind === "domestic"
        ? "TWD"
        : parseCurrency(values[2] ?? "", `row ${rowIndex}`);
    const available = parseExactDecimal(
      values[4] ?? "",
      `row ${rowIndex} available balance`,
    );
    const ledger = parseExactDecimal(
      values[5] ?? "",
      `row ${rowIndex} ledger balance`,
    );
    const sourceAccountKey =
      input.kind === "domestic"
        ? deriveYuantaDomesticDepositAccountKey(accountNumber)
        : accountNumber;
    const duplicateKey = `${sourceAccountKey}\u0000${currency}`;
    if (seen.has(duplicateKey)) {
      throw new Error(
        `Yuanta current deposit has duplicate account/currency row ${rowIndex}.`,
      );
    }
    seen.add(duplicateKey);

    rows.push({
      source: "yuanta",
      kind: input.kind,
      stream: expectedStream(input.kind),
      accountNumber,
      sourceAccountKey,
      currency,
      available,
      ledger,
      effectiveAt: response.providerDate.effectiveAt,
      providerHttpDate: response.providerDate.raw,
      observedAt: response.observedAt,
      sourceEvidence: {
        endpoint: CONTRACT.endpointPath,
        method: YUANTA_CURRENT_DEPOSIT_BALANCE_METHOD,
        status: 200,
        cacheControl: response.cacheControl,
        contractVersion: CONTRACT.contractVersion,
      },
    });
  }

  return rows;
}

async function readCellTexts(row: Locator, selector: string): Promise<string[]> {
  const cells = row.locator(selector);
  const count = await cells.count();
  const values: string[] = [];
  for (let index = 0; index < count; index += 1) {
    values.push(collapseSourceWhitespace(await cells.nth(index).innerText()));
  }
  return values;
}

async function tableClass(table: Locator): Promise<Set<string>> {
  return new Set(collapseSourceWhitespace(await table.getAttribute("class")).split(/\s+/u).filter(Boolean));
}

/**
 * Read one live DOM table's balance rows through Locator APIs, without
 * replaying its POST. Footer totals are left out.
 */
export async function readYuantaCurrentDepositTableCells(
  table: Locator,
  kind: YuantaCurrentDepositKind,
): Promise<readonly (readonly string[])[]> {
  const classes = await tableClass(table);
  if (!classes.has("normalTable")) {
    throw new Error("Yuanta current deposit table is missing normalTable.");
  }
  if (kind === "domestic" && !classes.has("botM2")) {
    throw new Error("Yuanta domestic current deposit table is missing botM2.");
  }

  const expected = expectedHeaders(kind);
  const rows = table.locator("tr");
  const rowCount = await rows.count();
  let headerFound = false;
  const dataRows: string[][] = [];

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const row = rows.nth(rowIndex);
    if ((await row.locator("table").count()) !== 0) {
      throw new Error(`Yuanta current deposit row ${rowIndex} contains a nested table.`);
    }
    const cells = await readCellTexts(row, "th, td");
    if (!headerFound && cells.length === expected.length && cells.every((value, index) => value === expected[index])) {
      headerFound = true;
      continue;
    }
    if (!headerFound) continue;

    const headerCells = row.locator("th");
    const dataCells = row.locator("td");
    const headerCount = await headerCells.count();
    const dataCount = await dataCells.count();

    // The observed footer is composed of TH cells and is deliberately not a
    // balance row. A missing footer is valid for this parser.
    if (dataCount === 0 && headerCount > 0) continue;
    if (dataCount !== expected.length || headerCount !== 0) {
      throw new Error(
        `Yuanta current deposit data row ${rowIndex} has an unexpected shape.`,
      );
    }
    dataRows.push(await readCellTexts(row, "td"));
  }

  if (!headerFound) {
    throw new Error("Yuanta current deposit table headers are not recognized.");
  }
  return dataRows;
}

const FOREIGN_SUMMARY_TAB = "#submenuAreaFX";

async function firstVisibleIn(locator: Locator): Promise<Locator | null> {
  const count = await locator.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }
  return null;
}

/** The visible `活期明細` link on this kind's summary card, searched up from its heading. */
async function summaryDetailsLink(
  scope: BrowserScope,
  kind: YuantaCurrentDepositKind,
): Promise<Locator | null> {
  const headings = scope
    .locator("h1, h2, h3, h4, h5, h6, [role='heading']")
    .filter({ hasText: new RegExp(`^\\s*${SUMMARY_HEADING[kind]}\\s*$`, "u") });
  const headingCount = await headings.count().catch(() => 0);
  for (let index = 0; index < headingCount; index += 1) {
    let container = headings.nth(index);
    for (let depth = 0; depth < 6; depth += 1) {
      const link = await firstVisibleIn(
        container.locator("a").filter({ hasText: /^\s*活期明細\s*$/u }),
      );
      if (link) return link;
      container = container.locator("xpath=..");
    }
  }
  return null;
}

/**
 * The authenticated summary page, reached with or without a cid. The FX card
 * is behind the foreign-currency summary tab, so the foreign summary is ready
 * once its tab or its details link shows.
 */
function currentDepositSummaryRoute(kind: YuantaCurrentDepositKind): YuantaRoute {
  return {
    path: "summary",
    description: `the Yuanta ${kind} current deposit summary`,
    cid: "optional",
    ready: async (scope) =>
      (await summaryDetailsLink(scope, kind)) !== null ||
      (kind === "foreign" && (await firstVisibleIn(scope.locator(FOREIGN_SUMMARY_TAB))) !== null),
  };
}

function findCurrentDepositTable(
  frames: FrameScope,
  kind: YuantaCurrentDepositKind,
  timeoutMs: number,
): Promise<Locator> {
  const expected = expectedHeaders(kind);
  return frames.until(async () => {
    for (const scope of frames.scopes()) {
      const tables = scope.locator("table.normalTable");
      const count = await tables.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const table = tables.nth(index);
        const classes = await tableClass(table).catch(() => new Set<string>());
        if (kind === "domestic" && !classes.has("botM2")) continue;
        const rows = table.locator("tr");
        const rowCount = await rows.count().catch(() => 0);
        for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
          const values = await readCellTexts(rows.nth(rowIndex), "th, td").catch(
            () => [],
          );
          if (
            values.length === expected.length &&
            values.every((value, cellIndex) => value === expected[cellIndex])
          ) {
            return table;
          }
        }
      }
    }
    return null;
  }, `Could not find Yuanta ${kind} current deposit table.`, { timeoutMs });
}

/** The current-state table the summary card opens, before decoding. */
export type YuantaCurrentDepositTable = Readonly<{
  evidence: Extract<ProviderEvidence, { kind: "cells" }>;
  response: ProviderResponse;
}>;

/**
 * Open the authenticated summary page, follow the kind's summary card and
 * read the resulting current-state table. The card's POST is observed through
 * `reader`, which checks its transport; this function never fetches or replays
 * the provider request. The evidence is the rendered table's cells, accepted
 * later with that reply's transport by the current-state snapshot.
 */
export async function readYuantaCurrentDepositBalanceTable(
  site: YuantaEbankSite,
  kind: YuantaCurrentDepositKind,
  reader: ProviderResponseReader,
  input: Readonly<{ timeoutMs?: number }> = {},
): Promise<YuantaCurrentDepositTable> {
  const timeoutMs = input.timeoutMs ?? 60_000;
  const { frames } = site;
  // The run leaves fmain on the last product page; the summary route brings back the cards.
  await site.open(currentDepositSummaryRoute(kind));
  if (kind === "foreign") {
    const tab = await ifFound(frames.firstVisible(
      (scope) => scope.locator(FOREIGN_SUMMARY_TAB),
      "Yuanta foreign-currency summary tab",
      { timeoutMs: Math.min(timeoutMs, 5_000) },
    ));
    if (tab) await frames.withSignal((signal) => tab.click({ signal }));
  }
  const link = await frames.until(async () => {
    for (const scope of frames.scopes()) {
      const found = await summaryDetailsLink(scope, kind);
      if (found) return found;
    }
    return null;
  }, `Could not find Yuanta ${kind} current deposit details link.`, { timeoutMs });
  const { response } = await reader.witness(frames, YUANTA_CURRENT_DEPOSIT_RESPONSE, {
    timeoutMs,
    trigger: () => frames.withSignal((signal) => link.click({ signal })),
  });
  const table = await findCurrentDepositTable(frames, kind, timeoutMs);
  return {
    evidence: { kind: "cells", rows: await frames.race(readYuantaCurrentDepositTableCells(table, kind)) },
    response,
  };
}

/** The admitted Yuanta statement identity a current balance joins. */
export type ExistingYuantaFinancialCapture = Readonly<{
  identity: Readonly<{
    sourceConnectionKey: string;
    identityEpochKey: string;
    subjectDigest: string;
    accountNo: string;
    sourceAccountKey?: string;
  }>;
}>;

/**
 * What differs between the domestic and foreign current balances. The digest
 * namespaces are literals, never derived from the route contracts (ADR 0123,
 * ADR 0124).
 */
const YUANTA_CURRENT_BALANCE_KINDS = {
  domestic: {
    stream: "domestic-deposit",
    route: "yuanta/domestic-deposit/current-balance-v1",
    label: "Yuanta",
    sourceRecordNamespace: "yuanta-current-deposit-source-record-v1",
    providerRecordNamespace: "yuanta-current-deposit-provider-record-v1",
    observationNamespace: "yuanta-current-deposit-observation-v1",
    compactCurrencyKey: "currencySourceLexeme",
    unmatchedMessage:
      "Yuanta current deposit snapshot contains an account without exactly one existing financial identity.",
  },
  foreign: {
    stream: "foreign-currency-deposit",
    route: "yuanta/foreign-currency/current-balance-v1",
    label: "Yuanta foreign",
    sourceRecordNamespace: "yuanta-foreign-current-deposit-source-record-v1",
    providerRecordNamespace: "yuanta-foreign-current-deposit-provider-record-v1",
    observationNamespace: "yuanta-foreign-current-deposit-observation-v1",
    compactCurrencyKey: "currency",
    unmatchedMessage:
      "Yuanta foreign current deposit snapshot contains an account without an existing financial identity.",
  },
} as const satisfies Record<YuantaCurrentDepositKind, Readonly<{
  stream: YuantaCurrentDepositStream;
  route: CurrentDepositAuthorityRoute;
  label: string;
  sourceRecordNamespace: string;
  providerRecordNamespace: string;
  observationNamespace: string;
  compactCurrencyKey: string;
  unmatchedMessage: string;
}>>;

/**
 * Build the current-balance capture only after the ordinary financial
 * admission has supplied the existing identity.  The provider's HTTP Date
 * is the only effective-time authority here; observedAt is retained solely
 * as the local knowledge time.
 */
function buildYuantaCurrentDepositBalanceCapture(
  kind: YuantaCurrentDepositKind,
  row: YuantaCurrentDepositBalanceRow,
  financialCapture: ExistingYuantaFinancialCapture,
): CurrentDepositBalanceCaptureInput {
  const spec = YUANTA_CURRENT_BALANCE_KINDS[kind];
  if (row.kind !== kind || row.stream !== spec.stream)
    throw new Error(`Yuanta ${kind} current-balance row has the wrong stream.`);
  const identity = financialCapture.identity;
  const sourceAccountKey = identity.sourceAccountKey ?? identity.accountNo;
  const route = spec.route;
  const contract = CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS[route];
  const amountPairs: readonly [
    "ledger" | "available",
    string,
    CurrentDepositExactAmount,
  ][] = [
    ["ledger", "帳面餘額", row.ledger],
    ["available", "可用餘額", row.available],
  ];
  const entries: CurrentDepositBalanceEntry[] = amountPairs.map(
    ([balanceKind, sourceField, balance]) => ({
      sourceRecordKey: canonicalDigest(
        spec.sourceRecordNamespace,
        sourceAccountKey,
        row.currency,
        balanceKind,
        row.effectiveAt,
        balance.coefficient,
        String(balance.scale),
      ),
      providerKey: canonicalDigest(
        spec.providerRecordNamespace,
        row.accountNumber,
        row.currency,
        balanceKind,
        row.effectiveAt,
      ),
      observationKey: canonicalDigest(
        spec.observationNamespace,
        sourceAccountKey,
      ),
      balanceKind,
      sourceField,
      currency: row.currency,
      value: balance,
      time: {
        effectiveAt: row.effectiveAt,
        effectiveTimeBasis: "provider-http-date",
        effectiveTimeRuleVersion: contract.contractVersion,
        sourceField: "HTTP Date",
        sourceValue: row.providerHttpDate,
        contractVersion: contract.contractVersion,
      },
      timeInRecord: false,
      compact: {
        accountNumber: row.accountNumber,
        sourceAccountKey,
        [spec.compactCurrencyKey]: row.currency,
        effectiveAt: row.effectiveAt,
        effectiveTimeSourceField: "HTTP Date",
        effectiveTimeSourceValue: row.providerHttpDate,
        sourceEvidence: { ...row.sourceEvidence },
      },
    }),
  );
  return assembleCurrentDepositCapture({
    captureId: randomUUID(),
    authorityRoute: route,
    contractVersion: contract.contractVersion,
    subjectDigest: identity.subjectDigest,
    identity: {
      integrationNamespace: "yuanta",
      sourceConnectionKey: identity.sourceConnectionKey,
      identityEpochKey: identity.identityEpochKey,
      stream: spec.stream,
      sourceAccountKey,
    },
    observedAt: row.observedAt,
    scope: {
      startDate: row.effectiveAt.slice(0, 10),
      endDate: row.effectiveAt.slice(0, 10),
    },
    providerResponse: {
      endpoint: `https://${contract.endpointHost}${row.sourceEvidence.endpoint}`,
      status: 200,
      cacheControl: row.sourceEvidence.cacheControl,
    },
    page: {
      metadata: {
        source: "yuanta-current-deposit-summary",
        sourceRowCount: 1,
        balanceFieldCount: entries.length,
      },
    },
  }, entries);
}

/**
 * Yuanta keys a balance by the source account key alone, with no currency:
 * one admitted foreign account matches its row in every currency. A row with
 * no admitted capture fails the run. The first capture under a key wins.
 */
function yuantaCurrentBalanceCaptureMatching(
  kind: YuantaCurrentDepositKind,
): CurrentBalanceCaptureMatching<Readonly<{ sourceAccountKey: string }>, ExistingYuantaFinancialCapture> {
  const spec = YUANTA_CURRENT_BALANCE_KINDS[kind];
  return {
    captureKey: ({ identity }) => identity.sourceAccountKey ?? identity.accountNo,
    rowKey: (row) => row.sourceAccountKey,
    duplicates: "first-wins",
    sameIdentity: (kept, candidate) =>
      kept.identity.sourceConnectionKey === candidate.identity.sourceConnectionKey &&
      kept.identity.identityEpochKey === candidate.identity.identityEpochKey &&
      kept.identity.subjectDigest === candidate.identity.subjectDigest,
    ambiguousMessage: `${spec.label} current deposit identities are ambiguous across financial captures.`,
    unmatched: { kind: "throw", message: spec.unmatchedMessage },
  };
}

function yuantaCurrentBalanceDeclaration(
  kind: YuantaCurrentDepositKind,
): CurrentStateSnapshotDeclaration<
  YuantaCurrentDepositTable,
  YuantaCurrentDepositBalanceRow,
  ExistingYuantaFinancialCapture
> {
  return {
    product: "current-balance",
    response: YUANTA_CURRENT_DEPOSIT_RESPONSE,
    parse: (decoded, response) => parseYuantaCurrentDepositBalanceSnapshot({ kind, rows: decoded.rows, response }),
    kind: CURRENT_DEPOSIT_BALANCE_STAGING,
    matching: yuantaCurrentBalanceCaptureMatching(kind),
    build: (row, capture) => buildYuantaCurrentDepositBalanceCapture(kind, row, capture),
  };
}

export const yuantaCurrentBalanceSnapshot = yuantaCurrentBalanceDeclaration("domestic");
export const yuantaForeignCurrentBalanceSnapshot = yuantaCurrentBalanceDeclaration("foreign");
