import { randomUUID } from "node:crypto";
import { canonicalDigest } from "../ledger/canonical/canonical-digest.ts";
import { CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS } from "../ledger/canonical/current-deposit-route-contracts.ts";
import type {
  CurrentDepositBalanceCaptureInput,
  CurrentDepositExactAmount,
} from "../ledger/pglite/current-deposit-admission.ts";
import type { Locator } from "playwright";

import { parseProviderDecimal, type ProviderDecimalPolicy } from "../lib/shared-money/exact-money.ts";
import {
  type ProviderResponse,
  type ProviderResponseDeclaration,
  type ProviderEvidence,
  type VerifiedProviderResponse,
} from "./provider-response.ts";
import { ifFound, type FrameScope } from "./frame-scope.ts";
import { fubonIsoCurrency } from "./fubon-currency.ts";
import type { FubonEbankSite } from "./fubon-ebank-site.ts";
import type { ProviderResponseReader } from "./provider-response-reader.ts";
import { collapseSourceWhitespace } from "../lib/automation/source-text.ts";
import {
  assembleCurrentDepositCapture,
  CURRENT_DEPOSIT_BALANCE_STAGING,
  type CurrentBalanceCaptureMatching,
  type CurrentDepositBalanceEntry,
  type CurrentStateSnapshotDeclaration,
} from "./current-state-snapshot-capture.ts";

/**
 * Fubon current deposits are rendered by the authenticated 我的存款 page.
 * The query is a provider snapshot and does not represent transaction rows.
 */
const CONTRACT = CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS["fubon/domestic-deposit/current-balance-v1"];
const FUBON_CURRENT_DEPOSIT_BALANCE_TABLE_ID =
  "form1:resultGrid_DataGridBody" as const;
const FUBON_CURRENT_DEPOSIT_BALANCE_TABLE_SELECTOR =
  'table[id="form1:resultGrid_DataGridBody"]' as const;
const FUBON_CURRENT_DEPOSIT_HEADER_READY_TIMEOUT_MS = 5_000;

export const FUBON_CURRENT_DEPOSIT_HEADERS = [
  "帳號",
  "帳戶暱稱",
  "存款類別",
  "分行",
  "幣別",
  "即時餘額",
  "可用餘額",
  "存單號碼",
  "到期日",
  "功能",
] as const;

type FubonCurrentDepositExactDecimal = Readonly<{
  coefficient: string;
  scale: number;
  /** The source cell after surrounding whitespace/NBSP cleanup. */
  sourceLexeme: string;
}>;

/** The 我的存款 page navigation; Fubon never constrained its method, query or content type. */
export const FUBON_CURRENT_DEPOSIT_RESPONSE: ProviderResponseDeclaration<"required"> = {
  label: "Fubon current deposit",
  host: CONTRACT.endpointHost,
  endpoints: [{
    path: CONTRACT.endpointPath,
    search: /^(?:\?.*)?$/u,
  }],
  cacheControl: CONTRACT.requiredCacheTokens,
  providerDate: "required",
};

export type FubonCurrentDepositBalanceRow = Readonly<{
  source: "fubon";
  /** Complete fourteen-digit provider account lexeme, including leading zeroes. */
  accountNumber: string;
  accountNickname: string;
  depositType: string;
  branchName: string;
  currency: string;
  currencySourceLexeme: string;
  /** 即時餘額 remains distinct from 可用餘額. */
  instantBalance: FubonCurrentDepositExactDecimal;
  availableBalance: FubonCurrentDepositExactDecimal;
  effectiveAt: string;
  providerHttpDate: string;
  observedAt: string;
  sourceEvidence: Readonly<{
    endpoint: typeof CONTRACT.endpointPath;
    status: 200;
    cacheControl: string;
    contractVersion: typeof CONTRACT.contractVersion;
  }>;
}>;

type FubonCurrentDepositSnapshotInput = Readonly<{
  rows: readonly (readonly string[])[];
  response: VerifiedProviderResponse<"required">;
}>;

const FUBON_AMOUNT: ProviderDecimalPolicy = {
  internalWhitespace: "strip",
  grouping: "thousands",
  digits: "decimal",
};

function parseBalance(value: string, label: string): FubonCurrentDepositExactDecimal {
  const sourceLexeme = collapseSourceWhitespace(value);
  const amount = parseProviderDecimal(sourceLexeme, FUBON_AMOUNT);
  if (!amount) {
    throw new Error(`Fubon current deposit ${label} is not an exact decimal.`);
  }
  return { ...amount, sourceLexeme };
}

function parseAccount(value: string): string {
  const normalized = collapseSourceWhitespace(value);
  if (!/^\d{14}$/u.test(normalized)) {
    throw new Error("Fubon current deposit account must be a full fourteen-digit value.");
  }
  return normalized;
}

function parseCurrency(value: string, rowIndex: number): {
  value: string;
  sourceLexeme: string;
} {
  const sourceLexeme = collapseSourceWhitespace(value);
  const currency = fubonIsoCurrency(sourceLexeme);
  if (currency === null) {
    throw new Error(`Fubon current deposit row ${rowIndex} currency is invalid.`);
  }
  return { value: currency, sourceLexeme };
}

/** Parse the ten visible contract columns. Hidden/internal cells are excluded by the DOM reader. */
export function parseFubonCurrentDepositBalanceSnapshot(
  input: FubonCurrentDepositSnapshotInput,
): readonly FubonCurrentDepositBalanceRow[] {
  const { response } = input;
  if (input.rows.length === 0) {
    throw new Error("Fubon current deposit table has no account rows.");
  }

  const seenAccountCurrencies = new Set<string>();
  const rows: FubonCurrentDepositBalanceRow[] = [];
  for (let rowIndex = 0; rowIndex < input.rows.length; rowIndex += 1) {
    const values = input.rows[rowIndex]!;
    if (values.length !== FUBON_CURRENT_DEPOSIT_HEADERS.length) {
      throw new Error(
        `Fubon current deposit row ${rowIndex} must have exactly 10 visible cells.`,
      );
    }
    const accountNumber = parseAccount(values[0] ?? "");
    const parsedCurrency = parseCurrency(values[4] ?? "", rowIndex);
    const accountCurrency = `${accountNumber}\0${parsedCurrency.value}`;
    if (seenAccountCurrencies.has(accountCurrency)) {
      throw new Error(`Fubon current deposit has duplicate account row ${rowIndex}.`);
    }
    seenAccountCurrencies.add(accountCurrency);
    rows.push({
      source: "fubon",
      accountNumber,
      accountNickname: collapseSourceWhitespace(values[1]),
      depositType: collapseSourceWhitespace(values[2]),
      branchName: collapseSourceWhitespace(values[3]),
      currency: parsedCurrency.value,
      currencySourceLexeme: parsedCurrency.sourceLexeme,
      instantBalance: parseBalance(values[5] ?? "", `row ${rowIndex} instant balance`),
      availableBalance: parseBalance(values[6] ?? "", `row ${rowIndex} available balance`),
      effectiveAt: response.providerDate.effectiveAt,
      providerHttpDate: response.providerDate.raw,
      observedAt: response.observedAt,
      sourceEvidence: {
        endpoint: CONTRACT.endpointPath,
        status: 200,
        cacheControl: response.cacheControl,
        contractVersion: CONTRACT.contractVersion,
      },
    });
  }
  return rows;
}

async function readCellTexts(frames: FrameScope, row: Locator, selector: string): Promise<string[]> {
  const cells = row.locator(selector);
  const count = await cells.count();
  const values: string[] = [];
  for (let index = 0; index < count; index += 1) {
    values.push(collapseSourceWhitespace(await frames.withSignal((signal) => cells.nth(index).innerText({ signal }))));
  }
  return values;
}

async function readClass(frames: FrameScope, locator: Locator): Promise<Set<string>> {
  return new Set(
    collapseSourceWhitespace(await frames.withSignal((signal) => locator.getAttribute("class", { signal })))
      .split(/\s+/u)
      .filter(Boolean),
  );
}

function isCurrentDepositHeader(cells: readonly string[]): boolean {
  return (
    cells.length === FUBON_CURRENT_DEPOSIT_HEADERS.length &&
    cells.every((value, index) => value === FUBON_CURRENT_DEPOSIT_HEADERS[index])
  );
}

async function tableHasCurrentDepositHeader(frames: FrameScope, table: Locator): Promise<boolean> {
  const rows = table.locator("tr");
  const rowCount = await rows.count();
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const cells = await readCellTexts(
      frames,
      rows.nth(rowIndex),
      "th:not(.hide), td:not(.hide)",
    );
    if (isCurrentDepositHeader(cells)) return true;
  }
  return false;
}

/**
 * Read the observed table's visible data cells through Locator APIs. The
 * table must contain exactly twelve TD cells per data row: ten visible
 * contract cells followed by two cells marked `.hide`. This explicit shape
 * prevents hidden internals and unrelated aggregate tables from entering the
 * evidence.
 */
export async function readFubonCurrentDepositTableCells(
  frames: FrameScope,
  table: Locator,
): Promise<readonly (readonly string[])[]> {
  if ((await frames.withSignal((signal) => table.getAttribute("id", { signal }))) !== FUBON_CURRENT_DEPOSIT_BALANCE_TABLE_ID) {
    throw new Error("Fubon current deposit table id is unexpected.");
  }
  const classes = await readClass(frames, table);
  if (!classes.has("tb_bkBody") || !classes.has("m10")) {
    throw new Error("Fubon current deposit table classes are unexpected.");
  }

  const rows = table.locator("tr");
  const rowCount = await rows.count();
  let headerFound = false;
  const dataRows: string[][] = [];

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const row = rows.nth(rowIndex);
    if ((await row.locator("table").count()) !== 0) {
      throw new Error(`Fubon current deposit row ${rowIndex} contains a nested table.`);
    }
    const cells = await readCellTexts(frames, row, "th:not(.hide), td:not(.hide)");
    if (
      !headerFound &&
      isCurrentDepositHeader(cells)
    ) {
      headerFound = true;
      continue;
    }
    if (!headerFound) continue;

    const headerCount = await row.locator("th").count();
    const allDataCount = await row.locator("td").count();
    if (allDataCount === 0 && headerCount > 0) continue;
    if (headerCount !== 0 || allDataCount !== 12) {
      throw new Error(
        `Fubon current deposit data row ${rowIndex} must contain 12 TD cells.`,
      );
    }
    const visibleCells = row.locator("td:not(.hide)");
    const hiddenCells = row.locator("td.hide");
    if ((await visibleCells.count()) !== 10 || (await hiddenCells.count()) !== 2) {
      throw new Error(
        `Fubon current deposit data row ${rowIndex} must contain 10 visible and 2 hidden TD cells.`,
      );
    }
    dataRows.push(await readCellTexts(frames, row, "td:not(.hide)"));
  }

  if (!headerFound) {
    throw new Error("Fubon current deposit table headers are not recognized.");
  }
  return dataRows;
}

function findExactControl(
  frames: FrameScope,
  text: string,
  timeoutMs: number,
): Promise<Locator> {
  const matcher = new RegExp(`^\\s*${text}\\s*$`, "u");
  return frames.firstVisible(
    (scope) => scope.locator("a, button").filter({ hasText: matcher }),
    `Fubon control "${text}"`,
    { timeoutMs },
  );
}

async function findCurrentDepositTable(frames: FrameScope, timeoutMs: number): Promise<Locator> {
  const deadline = Date.now() + timeoutMs;
  const table = await frames.until(async () => {
    for (const scope of frames.scopes()) {
      const table = scope.locator(FUBON_CURRENT_DEPOSIT_BALANCE_TABLE_SELECTOR);
      if ((await table.count().catch(() => 0)) === 1) return table;
    }
    return null;
  }, "Could not find Fubon current deposit table.", { timeoutMs });
  // The table can attach before its header row renders; give the header a grace period, then let the parser decide.
  await ifFound(frames.until(
    () => tableHasCurrentDepositHeader(frames, table),
    "Timed out waiting for the Fubon current deposit header.",
    { timeoutMs: Math.min(Math.max(0, deadline - Date.now()), FUBON_CURRENT_DEPOSIT_HEADER_READY_TIMEOUT_MS) },
  ));
  return table;
}

/** The current-state table 我的存款 renders, before decoding. */
export type FubonCurrentDepositTable = Readonly<{
  evidence: Extract<ProviderEvidence, { kind: "cells" }>;
  response: ProviderResponse;
}>;

/**
 * Navigate through 存款交易查詢 → 我的存款 and read the current table
 * through `reader`, which refuses a page response that fails its checks.
 */
export async function readFubonCurrentDepositBalanceTable(
  site: FubonEbankSite,
  reader: ProviderResponseReader,
  input: Readonly<{ timeoutMs?: number }> = {},
): Promise<FubonCurrentDepositTable> {
  const { frames } = site;
  const timeoutMs = input.timeoutMs ?? 60_000;
  const depositMenu = await findExactControl(frames, "存款交易查詢", timeoutMs);
  await frames.withSignal((signal) => depositMenu.click({ signal }));
  const myDeposit = await findExactControl(frames, "我的存款", timeoutMs);
  // The page's own response carries the HTTP Date and Cache-Control evidence; the rendered table is the evidence.
  const { response } = await reader.witness(frames, FUBON_CURRENT_DEPOSIT_RESPONSE, {
    timeoutMs,
    trigger: () => frames.withSignal((signal) => myDeposit.click({ signal })),
  });
  const table = await findCurrentDepositTable(frames, timeoutMs);
  return {
    evidence: { kind: "cells", rows: await readFubonCurrentDepositTableCells(frames, table) },
    response,
  };
}

/** The admitted Fubon statement identity a current balance joins. */
export type ExistingFubonFinancialCapture = Readonly<{
  identity: Readonly<{
    sourceConnectionKey: string;
    identityEpochKey: string;
    subjectDigest: string;
    accountNo: string;
    sourceAccountKey?: string;
    accountNumber?: Readonly<{ value: string }> | null;
  }>;
}>;

/** Preserve the provider's full account-number evidence while joining the
 * current snapshot to the existing hashed canonical account identity. */
function buildFubonCurrentDepositBalanceCapture(
  row: FubonCurrentDepositBalanceRow,
  financialCapture: ExistingFubonFinancialCapture,
): CurrentDepositBalanceCaptureInput {
  const identity = financialCapture.identity;
  if (identity.accountNumber?.value !== row.accountNumber)
    throw new Error(
      "Fubon current deposit account does not match the existing full account-number evidence.",
    );
  const sourceAccountKey = identity.sourceAccountKey ?? identity.accountNo;
  const route = "fubon/domestic-deposit/current-balance-v1" as const;
  const contract = CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS[route];
  const amountPairs: readonly [
    "ledger" | "available",
    string,
    CurrentDepositExactAmount,
  ][] = [
    ["ledger", "即時餘額", row.instantBalance],
    ["available", "可用餘額", row.availableBalance],
  ];
  const entries: CurrentDepositBalanceEntry[] = amountPairs.map(
    ([balanceKind, sourceField, balance]) => ({
      sourceRecordKey: canonicalDigest(
        "fubon-current-deposit-source-record-v1",
        sourceAccountKey,
        row.currency,
        balanceKind,
        row.effectiveAt,
        balance.coefficient,
        String(balance.scale),
      ),
      providerKey: canonicalDigest(
        "fubon-current-deposit-provider-record-v1",
        row.accountNumber,
        row.currency,
        balanceKind,
        row.effectiveAt,
      ),
      observationKey: canonicalDigest(
        "fubon-current-deposit-observation-v1",
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
        accountNickname: row.accountNickname,
        depositType: row.depositType,
        branchName: row.branchName,
        currencySourceLexeme: row.currencySourceLexeme,
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
      integrationNamespace: "fubon",
      sourceConnectionKey: identity.sourceConnectionKey,
      identityEpochKey: identity.identityEpochKey,
      stream: "domestic-deposit",
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
        source: "fubon-current-deposit-summary",
        sourceRowCount: 1,
        balanceFieldCount: entries.length,
      },
    },
  }, entries);
}

/**
 * Fubon keys a balance by the full account number (ADR 0049). A capture
 * without account number evidence is left out of the index, and a row with
 * no admitted capture is excluded so the run reports
 * `account-number-evidence-missing`. The first capture under a number wins.
 */
const fubonCurrentBalanceCaptureMatching: CurrentBalanceCaptureMatching<
  Readonly<{ accountNumber: string }>,
  ExistingFubonFinancialCapture
> = {
  captureKey: (capture) => capture.identity.accountNumber?.value || undefined,
  rowKey: (row) => row.accountNumber,
  duplicates: "first-wins",
  sameIdentity: (kept, candidate) =>
    kept.identity.sourceConnectionKey === candidate.identity.sourceConnectionKey &&
    kept.identity.identityEpochKey === candidate.identity.identityEpochKey &&
    (kept.identity.sourceAccountKey ?? kept.identity.accountNo) ===
      (candidate.identity.sourceAccountKey ?? candidate.identity.accountNo) &&
    kept.identity.subjectDigest === candidate.identity.subjectDigest,
  ambiguousMessage: "Fubon current deposit identities are ambiguous across financial captures.",
  unmatched: { kind: "exclude" },
};

/**
 * Fubon reads every currency for the USD-coded reconciliation, then stages
 * only TWD rows, so it calls the module's read and stage halves separately.
 */
export const fubonCurrentBalanceSnapshot: CurrentStateSnapshotDeclaration<
  FubonCurrentDepositTable,
  FubonCurrentDepositBalanceRow,
  ExistingFubonFinancialCapture
> = {
  product: "current-balance",
  response: FUBON_CURRENT_DEPOSIT_RESPONSE,
  parse: (decoded, response) => parseFubonCurrentDepositBalanceSnapshot({ rows: decoded.rows, response }),
  kind: CURRENT_DEPOSIT_BALANCE_STAGING,
  matching: fubonCurrentBalanceCaptureMatching,
  build: buildFubonCurrentDepositBalanceCapture,
};
