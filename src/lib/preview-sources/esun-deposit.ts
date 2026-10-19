import { createHash } from "node:crypto";
import type {
  PreviewAccount,
  PreviewDepositCollection,
  PreviewDirection,
  PreviewTransaction,
} from "../../ledger/pglite/preview-financial-data.ts";
import type { EsunPortalReply, EsunPortalTransport } from "./esun-portal.ts";
import type { PreviewProductAbsence } from "./product-collection.ts";
import {
  currencyCode,
  exactDecimal,
  fail,
  localDate,
  observedAt,
  optionalText,
  parseSourceJson,
  record,
  records,
  taipeiMonthWindow,
  text,
  type SourceRecord,
} from "./source-kit.ts";

export type EsunDepositKind = "tw" | "fr";

export const ESUN_DEPOSIT_INIT_PATH = "mib-ctw-portal/ctw01/ctw01002/home/init";
export const ESUN_DEPOSIT_PREQUERY_PATHS: Readonly<Record<EsunDepositKind, string>> = {
  tw: "mib-ctw-portal/ctw01/ctw01002/home/preQueryTWTransactionDetail",
  fr: "mib-ctw-portal/ctw01/ctw01002/home/preQueryFRTransactionDetail",
};
export const ESUN_DEPOSIT_SEARCH_PATHS: Readonly<Record<EsunDepositKind, string>> = {
  tw: "mib-ctw-portal/ctw01/ctw01002/search/queryTWTransactionDetail",
  fr: "mib-ctw-portal/ctw01/ctw01002/search/queryFRTransactionDetail",
};
/** E.SUN answers `S001` for several notices; only this wording for the queried kind means no account. */
export const ESUN_DEPOSIT_NOT_HELD: Readonly<Record<EsunDepositKind, RegExp>> = {
  tw: /查無臺幣帳號|尚未開立臺幣帳戶/u,
  fr: /查無外幣帳號|尚未開立外幣帳戶/u,
};
export const ESUN_DEPOSIT_PAGE_SIZE = 100;
export const ESUN_DEPOSIT_MAX_PAGES = 20;
const HISTORY_MONTHS = 3;
const SUCCESS = "0000";
const NOT_HELD = "S001";
const KINDS: readonly EsunDepositKind[] = ["tw", "fr"];

type Portal = Readonly<{ body: SourceRecord; date: string | null }>;

async function call(
  transport: EsunPortalTransport,
  path: string,
  requestBody: Readonly<Record<string, unknown>>,
  resetFlow: boolean,
): Promise<Readonly<{ envelope: SourceRecord; date: string | null }>> {
  const reply: EsunPortalReply = await transport(path, requestBody, resetFlow);
  if (reply.kind !== "json") return fail("unexpected-response", `${path} answered ${reply.kind}`);
  if (reply.httpStatus !== 200) return fail("unexpected-response", `${path} answered HTTP ${reply.httpStatus}`);
  return { envelope: record(parseSourceJson(reply.text, path), path), date: reply.date };
}

async function portal(
  transport: EsunPortalTransport,
  path: string,
  requestBody: Readonly<Record<string, unknown>>,
  resetFlow = false,
): Promise<Portal> {
  const { envelope, date } = await call(transport, path, requestBody, resetFlow);
  if (envelope.resultCode !== SUCCESS) return fail("unexpected-response", `${path} answered a result code other than ${SUCCESS}`);
  return { body: record(envelope.resultBody, `${path}.resultBody`), date };
}

/** `null` when E.SUN states the person holds no account of this kind. */
async function prequery(transport: EsunPortalTransport, kind: EsunDepositKind, account: string | null): Promise<Portal | null> {
  await portal(transport, ESUN_DEPOSIT_INIT_PATH, {}, true);
  const path = ESUN_DEPOSIT_PREQUERY_PATHS[kind];
  const { envelope, date } = await call(transport, path, { account }, false);
  if (account === null && envelope.resultCode === NOT_HELD && typeof envelope.resultDescription === "string"
    && ESUN_DEPOSIT_NOT_HELD[kind].test(envelope.resultDescription)) return null;
  if (envelope.resultCode !== SUCCESS) return fail("unexpected-response", `${path} answered a result code other than ${SUCCESS}`);
  return { body: record(envelope.resultBody, `${path}.resultBody`), date };
}

function listedAccounts(body: SourceRecord, kind: EsunDepositKind, field: string): readonly string[] {
  const listField = kind === "tw" ? "twAccountList" : "frAccountList";
  const listed = records(body[listField], `${field}.${listField}`)
    .map((entry, index) => text(entry.accountNo, `${field}.${listField}[${index}].accountNo`));
  const current = optionalText(body.demandDeptAcc);
  const accounts = [...new Set(current ? [current, ...listed] : listed)];
  if (accounts.length === 0) return fail("unexpected-response", `${field} lists no account`);
  return accounts;
}

type Balance = Readonly<{ currency: string; amount: string }>;

function balances(body: SourceRecord, kind: EsunDepositKind, field: string): readonly Balance[] {
  if (kind === "tw") {
    const info = record(body.twCurrInfo, `${field}.twCurrInfo`);
    // The NT-dollar query serves NT-dollar accounts only and names no currency.
    const currency = info.currency === undefined ? "TWD" : currencyCode(info.currency, `${field}.twCurrInfo.currency`);
    return [{ currency, amount: exactDecimal(info.realBalance, `${field}.twCurrInfo.realBalance`) }];
  }
  const list = records(body.currInfoList, `${field}.currInfoList`);
  if (list.length === 0) return fail("unexpected-response", `${field}.currInfoList is empty`);
  const result = list.map((entry, index) => ({
    currency: currencyCode(entry.currency, `${field}.currInfoList[${index}].currency`),
    amount: exactDecimal(entry.totalAmount, `${field}.currInfoList[${index}].totalAmount`),
  }));
  if (new Set(result.map((entry) => entry.currency)).size !== result.length)
    return fail("unexpected-response", `${field}.currInfoList repeats a currency`);
  return result;
}

function detailRows(body: SourceRecord, field: string): readonly SourceRecord[] {
  if (body.queryDeptTxDtlResult === undefined || body.queryDeptTxDtlResult === null) return [];
  const result = record(body.queryDeptTxDtlResult, `${field}.queryDeptTxDtlResult`);
  return records(result.detailListData, `${field}.queryDeptTxDtlResult.detailListData`)
    .flatMap((group, index) => records(group.detailInfo, `${field}.queryDeptTxDtlResult.detailListData[${index}].detailInfo`));
}

const slashDate = (date: string) => date.replaceAll("-", "/");

async function searchRows(
  transport: EsunPortalTransport,
  kind: EsunDepositKind,
  account: string,
  window: Readonly<{ start: string; end: string }>,
): Promise<readonly SourceRecord[]> {
  const path = ESUN_DEPOSIT_SEARCH_PATHS[kind];
  const rows: SourceRecord[] = [];
  let previous: string | null = null;
  for (let page = 0; page < ESUN_DEPOSIT_MAX_PAGES; page += 1) {
    const { body } = await portal(transport, path, {
      account,
      startDate: slashDate(window.start),
      endDate: slashDate(window.end),
      startIndex: page * ESUN_DEPOSIT_PAGE_SIZE + 1,
      count: ESUN_DEPOSIT_PAGE_SIZE,
      customerInputHashtag: [],
    });
    const pageRows = detailRows(body, path);
    if (pageRows.length > ESUN_DEPOSIT_PAGE_SIZE) return fail("incomplete-data", `${path} returned more rows than requested`);
    const fingerprint = JSON.stringify(pageRows);
    // A portal that ignores startIndex would answer the first page forever.
    if (pageRows.length > 0 && fingerprint === previous) return fail("incomplete-data", `${path} repeated a page`);
    previous = fingerprint;
    rows.push(...pageRows);
    if (pageRows.length < ESUN_DEPOSIT_PAGE_SIZE) return rows;
  }
  return fail("incomplete-data", `${path} has more than ${ESUN_DEPOSIT_MAX_PAGES} pages`);
}

const DIRECTIONS: Readonly<Record<string, PreviewDirection>> = { CR: "inflow", DR: "outflow" };

function direction(value: unknown, field: string): PreviewDirection {
  if (value === undefined || value === null || value === "") return "unknown";
  const code = typeof value === "string" ? value.trim().toUpperCase() : "";
  return DIRECTIONS[code] ?? fail("unexpected-response", `${field} is not a debit or credit code`);
}

function transactionsFrom(
  rows: readonly SourceRecord[],
  field: string,
  currencies: readonly string[],
): ReadonlyMap<string, PreviewTransaction[]> {
  const byCurrency = new Map(currencies.map((currency) => [currency, [] as PreviewTransaction[]]));
  const occurrences = new Map<string, number>();
  for (const [index, row] of rows.entries()) {
    const rowField = `${field}[${index}]`;
    const currency = row.currency === undefined || row.currency === null || row.currency === ""
      ? currencies.length === 1 ? currencies[0]! : fail("missing-currency", `${rowField}.currency is missing for a multi-currency account`)
      : currencyCode(row.currency, `${rowField}.currency`);
    const target = byCurrency.get(currency) ?? fail("unexpected-response", `${rowField}.currency is not a currency of the account`);
    const rowDirection = direction(row.debitCredit, `${rowField}.debitCredit`);
    const amount = exactDecimal(row.amount, `${rowField}.amount`);
    if (rowDirection !== "unknown" && amount.startsWith("-"))
      return fail("malformed-amount", `${rowField}.amount is signed beside a debit or credit code`);
    const time = optionalText(row.txTime);
    const postedAt = localDate(time ? `${text(row.txDate, `${rowField}.txDate`)} ${time}` : row.txDate, `${rowField}.txDate`);
    const balance = row.balance === undefined || row.balance === null || row.balance === "" ? "" : exactDecimal(row.balance, `${rowField}.balance`);
    const descriptions = [optionalText(row.detailTitle), optionalText(row.passbookRemark)].filter((entry) => entry !== null);
    // E.SUN rows carry no transaction id, so the key is the row's content plus its occurrence order.
    const identity = [postedAt.value, currency, rowDirection, amount, balance, ...descriptions].join("\u0000");
    const occurrence = (occurrences.get(identity) ?? 0) + 1;
    occurrences.set(identity, occurrence);
    target.push({
      sourceRowKey: `${postedAt.value.slice(0, 10)}:${createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 16)}:${occurrence}`,
      amount,
      currency,
      direction: rowDirection,
      postedAt,
      description: descriptions.length > 0 ? [...new Set(descriptions)].join(" · ") : null,
    });
  }
  return byCurrency;
}

function label(accountNo: string, alias: string | null, currency: string): string {
  const last4 = accountNo.replace(/\D/gu, "").slice(-4);
  return `玉山銀行 ${alias ?? "存款帳戶"}${last4 ? ` ${last4}` : ""}${currency === "TWD" ? "" : ` (${currency})`}`;
}

async function kindAccounts(
  transport: EsunPortalTransport,
  kind: EsunDepositKind,
  now: string,
): Promise<readonly PreviewAccount[] | null> {
  const first = await prequery(transport, kind, null);
  if (first === null) return null;
  const field = ESUN_DEPOSIT_PREQUERY_PATHS[kind];
  const window = taipeiMonthWindow(now, HISTORY_MONTHS);
  const accounts: PreviewAccount[] = [];
  for (const accountNo of listedAccounts(first.body, kind, field)) {
    const current = optionalText(first.body.demandDeptAcc) === accountNo ? first : await prequery(transport, kind, accountNo);
    if (current === null || optionalText(current.body.demandDeptAcc) !== accountNo)
      return fail("unexpected-response", `${field} answered another account than the one queried`);
    const accountBalances = balances(current.body, kind, field);
    const asOf = observedAt(current.date, now);
    const rows = await searchRows(transport, kind, accountNo, window);
    if (rows.length === 0 && detailRows(current.body, field).length > 0)
      return fail("incomplete-data", `${ESUN_DEPOSIT_SEARCH_PATHS[kind]} is empty while the pre-query lists transactions`);
    const transactions = transactionsFrom(rows, ESUN_DEPOSIT_SEARCH_PATHS[kind], accountBalances.map((entry) => entry.currency));
    const alias = optionalText(current.body.accountAlias);
    for (const { currency, amount } of accountBalances) {
      accounts.push({
        sourceAccountKey: `${accountNo}:${currency}`,
        displayLabel: label(accountNo, alias, currency),
        currency,
        type: "depository",
        balances: [{ kind: "current", amount, currency, observedAt: asOf }],
        transactions: transactions.get(currency) ?? [],
      });
    }
  }
  return accounts;
}

/**
 * E.SUN NT-dollar and foreign-currency demand deposits, read through the
 * signed-in `/esb/` portal. Each kind starts a fresh `home/init` task flow.
 * Both kinds answering E.SUN's no-account notice is the only `not_held`.
 */
export async function collectEsunDeposits(
  transport: EsunPortalTransport,
  now: string,
): Promise<PreviewDepositCollection | PreviewProductAbsence> {
  const accounts: PreviewAccount[] = [];
  let held = false;
  for (const kind of KINDS) {
    const found = await kindAccounts(transport, kind, now);
    if (found === null) continue;
    held = true;
    accounts.push(...found);
  }
  if (!held) return { absent: "not_held" };
  if (new Set(accounts.map((account) => account.sourceAccountKey)).size !== accounts.length)
    return fail("unexpected-response", "an E.SUN account and currency repeat across the deposit queries");
  return { collectedAt: now, accounts };
}
