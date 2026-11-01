import { createHash } from "node:crypto";
import type {
  PreviewAccount,
  PreviewDepositCollection,
  PreviewTransaction,
} from "../ledger/pglite/preview-financial-data.ts";
import { parseFubonCompositeAccountOption } from "../ledger/canonical/fubon-domestic-deposit-admission.ts";
import { collectionPeriod, taipeiToday } from "../lib/automation/collection-period.ts";
import type { PreviewProductAbsence, PreviewProductCollectors } from "../lib/preview-sources/product-collection.ts";
import {
  decimalSum,
  exactDecimal,
  fail,
  isZeroDecimal,
  localDate,
  observedAt,
} from "../lib/preview-sources/source-kit.ts";
import type { FubonCurrentDepositBalanceRow } from "./fubon-current-deposit-balances.ts";
import {
  fubonDepositQueries,
  type FubonDepositAccountOption,
  type FubonDepositQuery,
  type FubonParsedDepositStatement,
} from "./fubon-statements.ts";

/** The signed-in Fubon page, as the attached foreign-currency collector needs it. */
export type FubonAttachedPreviewPort = Readonly<{
  /** Every row of the 我的存款 table (CBOQU003), as the verified deposit product reads it. */
  balances(): Promise<readonly FubonCurrentDepositBalanceRow[]>;
  /** The CDSQU001 transaction query's `form1:comboAccount` options. */
  accountOptions(): Promise<readonly FubonDepositAccountOption[]>;
  /** Selects `option` and posts one query, with every result page. */
  statement(option: FubonDepositAccountOption, query: FubonDepositQuery): Promise<FubonParsedDepositStatement>;
}>;

// The verified deposit product's period: the only "180" and "180_365" pair the CDSQU001 form is known to accept.
const PERIOD = { lookBack: { months: 12, days: 1 }, maxWindow: { months: 6, days: 1 } } as const;
const DEMAND = /活/u;
const DAY = /^\d{4}\/\d{2}\/\d{2}$/u;
const TIME = /^\d{2}:\d{2}(?::\d{2})?$/u;

const last4 = (accountNumber: string) => accountNumber.slice(-4);
const amount = (cell: string, field: string) => cell.trim() === "" ? null : exactDecimal(cell, field);
const sameAmount = (left: string, right: string) => isZeroDecimal(decimalSum([[1, left], [-1, right]]));

/**
 * UNVERIFIED: no live foreign-currency account has been read. The option
 * value shape `<branch>-00<account>-<currency>-<type>` is the one the verified
 * deposit product parses; a foreign account is assumed to have its own
 * option with its ISO code.
 */
function optionFor(options: readonly FubonDepositAccountOption[], row: FubonCurrentDepositBalanceRow): FubonDepositAccountOption {
  const matches = options.filter((option) => {
    const composite = parseFubonCompositeAccountOption(option.value);
    return composite !== null && composite.accountSegment === `00${row.accountNumber}` && composite.currencyCode === row.currency;
  });
  if (matches.length === 0)
    return fail("incomplete-data", `the transaction query lists no ${row.currency} option for the account ending ${last4(row.accountNumber)}`);
  if (matches.length > 1)
    return fail("unexpected-response", `the transaction query lists the ${row.currency} account ending ${last4(row.accountNumber)} twice`);
  return matches[0]!;
}

type Row = Readonly<{ transaction: Omit<PreviewTransaction, "sourceRowKey">; balance: string; identity: string }>;

/** One result row in the verified parser's header order: 帳務日期, 交易時間, 摘要, 支出金額, 存入金額, 即時餘額, 附註. */
function statementRow(cells: readonly string[], currency: string, field: string): Row {
  if (cells.length !== 7) return fail("unexpected-response", `${field} has ${cells.length} cells, not 7`);
  const [date, time, summary, out, into, running, note] = cells.map((cell) => cell.trim()) as [string, string, string, string, string, string, string];
  if (!DAY.test(date)) return fail("unexpected-response", `${field} 帳務日期 is not a date`);
  if (time !== "" && !TIME.test(time)) return fail("unexpected-response", `${field} 交易時間 is not a time`);
  const outflow = amount(out, `${field} 支出金額`);
  const inflow = amount(into, `${field} 存入金額`);
  const nonzero = [outflow, inflow].filter((value) => value !== null && !isZeroDecimal(value));
  if (nonzero.length !== 1) return fail("unexpected-response", `${field} does not have exactly one nonzero 支出金額 or 存入金額`);
  const isInflow = inflow !== null && !isZeroDecimal(inflow);
  const value = (isInflow ? inflow : outflow)!.replace(/^-/u, "");
  const postedAt = localDate(time === "" ? date : `${date} ${time}`, `${field} 帳務日期`);
  const balance = exactDecimal(running, `${field} 即時餘額`);
  const description = [summary, note].filter((part) => part !== "").join(" ") || null;
  return {
    transaction: { amount: value, currency, direction: isInflow ? "inflow" : "outflow", postedAt, description },
    balance,
    identity: [postedAt.value, isInflow ? "in" : "out", value, balance, description ?? ""].join("\u0000"),
  };
}

/**
 * The query rows of one foreign account. UNVERIFIED: that a foreign option's
 * table uses the NT-dollar headers and amounts in the account's own currency
 * is assumed. The verified deposit product has seen a USD-coded option whose
 * rows were NT dollars, so the newest row's 即時餘額 must equal the account's
 * own 即時餘額 from 我的存款, or the product fails.
 */
function accountTransactions(
  row: FubonCurrentDepositBalanceRow,
  option: FubonDepositAccountOption,
  statements: readonly FubonParsedDepositStatement[],
): PreviewTransaction[] {
  const label = `the ${row.currency} account ending ${last4(row.accountNumber)}`;
  const rows: Row[] = [];
  for (const statement of statements) {
    for (const page of statement.pages) {
      if (page.selectedAccount.value !== option.value) return fail("unexpected-response", `a query page for ${label} shows another account`);
      // The pager parser cannot prove an empty page terminal; a lone empty page is an empty range.
      const emptyRange = statement.pages.length === 1 && page.rows.length === 0 && page.paginationAmbiguityReason === "terminal-proof-missing";
      if (page.paginationAmbiguous === true && !emptyRange) return fail("incomplete-data", `the query pages for ${label} may be incomplete`);
      for (const evidence of page.rows) rows.push(statementRow(evidence.cells, row.currency, `${label} page ${page.pageOrdinal} row ${evidence.rowOrdinal}`));
    }
  }
  const latest = rows.reduce<string | null>((newest, entry) =>
    newest === null || entry.transaction.postedAt.value > newest ? entry.transaction.postedAt.value : newest, null);
  const expected = exactDecimal(row.instantBalance.sourceLexeme, `${label} 即時餘額`);
  if (latest !== null && !rows.some((entry) => entry.transaction.postedAt.value === latest && sameAmount(entry.balance, expected)))
    return fail("unexpected-response", `the newest query row for ${label} does not show its ${row.currency} balance`);
  const occurrences = new Map<string, number>();
  return rows.map(({ transaction, identity }) => {
    const hash = createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 16);
    const occurrence = (occurrences.get(hash) ?? 0) + 1;
    occurrences.set(hash, occurrence);
    return { sourceRowKey: `${hash}:${occurrence}`, ...transaction };
  });
}

/**
 * Fubon foreign-currency demand deposits (ADR 0086): the non-TWD 活 rows of
 * 我的存款, with transactions from the CDSQU001 query of each account's own
 * option. Balances keep the verified page's HTTP `Date`.
 */
export async function collectFubonForeignCurrency(
  port: FubonAttachedPreviewPort,
  collectedAt: string,
): Promise<PreviewDepositCollection | PreviewProductAbsence> {
  const foreign = (await port.balances()).filter((row) => row.currency !== "TWD" && DEMAND.test(row.depositType));
  // 我的存款 lists every deposit account in one table, so no foreign 活 row is evidence of none.
  if (foreign.length === 0) return { absent: "not_held" };
  const options = await port.accountOptions();
  const queries = fubonDepositQueries(collectionPeriod({ today: taipeiToday(collectedAt), ...PERIOD }));
  const accounts: PreviewAccount[] = [];
  for (const row of foreign) {
    const option = optionFor(options, row);
    const statements: FubonParsedDepositStatement[] = [];
    for (const query of queries) statements.push(await port.statement(option, query));
    const asOf = observedAt(row.effectiveAt, collectedAt);
    accounts.push({
      sourceAccountKey: `${row.accountNumber}:${row.currency}`,
      displayLabel: `台北富邦外幣活存 ${last4(row.accountNumber)} (${row.currency})`,
      currency: row.currency,
      type: "depository",
      balances: [
        { kind: "current", amount: exactDecimal(row.instantBalance.sourceLexeme, "即時餘額"), currency: row.currency, observedAt: asOf },
        { kind: "available", amount: exactDecimal(row.availableBalance.sourceLexeme, "可用餘額"), currency: row.currency, observedAt: asOf },
      ],
      transactions: accountTransactions(row, option, statements),
    });
  }
  return { collectedAt, accounts };
}

export function fubonAttachedPreviewCollectors(port: FubonAttachedPreviewPort, now: () => string): PreviewProductCollectors {
  return { foreign_currency: () => collectFubonForeignCurrency(port, now()) };
}
