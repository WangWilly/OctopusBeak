import { createHash } from "node:crypto";
import type {
  PreviewCard,
  PreviewCreditAccount,
  PreviewCreditCollection,
  PreviewPurchase,
  PreviewStatement,
  PreviewTimeDeposit,
  PreviewTimeDepositCollection,
} from "../ledger/pglite/preview-financial-data.ts";
import type { PreviewLoan, PreviewLoanCollection } from "../ledger/pglite/preview-loan.ts";
import type {
  PreviewProductAbsence,
  PreviewProductCollectors,
  PreviewProductHandle,
} from "../lib/preview-sources/product-collection.ts";
import {
  currencyCode,
  decimalSum,
  exactDecimal,
  fail,
  isZeroDecimal,
  localDate,
  observedAt,
  optionalText,
  parseSourceJson,
  record,
  records,
  text,
  type SourceRecord,
} from "../lib/preview-sources/source-kit.ts";

/** One provider response as the page port captured it. */
export type CathayPreviewResponse = Readonly<{
  endpoint: string;
  status: number;
  text: string;
  /** The HTTP `Date` header, when readable. */
  date: string | null;
}>;

/** What C0101_BillOverview shows: its own card-status and latest-bill requests, and the page text. */
export type CathayCardOverview = Readonly<{
  cardStatus: CathayPreviewResponse;
  latestBill: CathayPreviewResponse | null;
  text: string;
}>;

export const CATHAY_CARD_ENDPOINTS = {
  recentBill: "C_BILL_Q_RecentBillInfo",
  billInfo: "C_BILL_Q_BillInfo",
  history: "C_BILL_Q_HistoryBillList",
  detail: "C_BILL_Q_RecentBillDetail",
} as const;

export type CathayCardEndpoint = (typeof CATHAY_CARD_ENDPOINTS)[keyof typeof CATHAY_CARD_ENDPOINTS];

/** The signed-in Cathay page, as the attached collectors need it. */
export type CathayAttachedPreviewPort = Readonly<{
  cardOverview(): Promise<CathayCardOverview>;
  /** POSTs `/OnlineBankingApi/ClientCard/Api/ClientCard/<endpoint>` with the session's JWT and customer id. */
  cardApi(endpoint: CathayCardEndpoint, content?: Readonly<Record<string, string>>): Promise<CathayPreviewResponse>;
  /** The page's own `B_ACCT_Q_DepositOverview` response from the NT-dollar account overview. */
  domesticOverview(): Promise<CathayPreviewResponse>;
  /** The loan overview page (`L0101_LoanInq`), read from its rendered DOM. */
  loanOverview(): Promise<CathayLoanOverview>;
}>;

/** One loan on the L0101 overview, each field the page text under its label, or `null` when the page shows none. */
export type CathayLoanRow = Readonly<{
  /** The heading of the section that lists the loan, such as `房屋貸款`. */
  section: string | null;
  /** The value under `貸款類別`, when the layout has one. */
  category: string | null;
  accountNumber: string | null;
  interestRate: string | null;
  paymentAmount: string | null;
  /** The value under `扣款日`: a date, or a status such as `未完成扣款`. */
  paymentDue: string | null;
  balance: string | null;
  /** The value under `期數`, such as `已繳 17 期，共 180 期`. */
  installments: string | null;
}>;

/** What the rendered L0101 overview shows. No request behind it is documented, so the page is read instead. */
export type CathayLoanOverview = Readonly<{
  /** The `貸款帳戶總覽` heading is present. */
  recognized: boolean;
  /** The page shows `目前無貸款資料`. */
  noLoanMessage: boolean;
  /** The value of the `幣別` line. */
  currency: string | null;
  /** The value of the `貸款總餘額` line. */
  totalBalance: string | null;
  rows: readonly CathayLoanRow[];
  /** The HTTP `Date` header of the page, when readable. */
  date: string | null;
}>;

const CURRENCY_ALIASES: Readonly<Record<string, string>> = { NTD: "TWD", "新臺幣": "TWD", "新台幣": "TWD", "臺幣": "TWD", "台幣": "TWD" };
const CARD_DIGITS = /卡片末四碼[：:]\s*(\d{4})/gu;
const CREDIT_LIMIT = /永久信用額度\s*(?:([A-Z]{3})\s*)?(-?[\d,]+(?:\.\d+)?)/u;
const AVAILABLE_CREDIT = /剩餘可用額度[^\d\-A-Z]{0,20}?(?:([A-Z]{3})\s*)?(-?[\d,]+(?:\.\d+)?)/u;
const CARRIED_FORWARD = "LastBillAmount";

/** A Cathay JSON envelope's `content`, only after HTTP 200, `returnCode` `0000`, and no `success: false`. */
function content(response: CathayPreviewResponse): SourceRecord {
  if (response.status !== 200) fail("unexpected-response", `${response.endpoint} answered HTTP ${response.status}`);
  const envelope = record(parseSourceJson(response.text, response.endpoint), response.endpoint);
  if (envelope.returnCode !== "0000" || envelope.success === false)
    fail("unexpected-response", `${response.endpoint} returned ${String(envelope.returnCode)}`);
  return record(envelope.content, `${response.endpoint} content`);
}

function day(value: unknown, field: string): string {
  return localDate(value, field).value.slice(0, 10);
}

function nextDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

/**
 * The C0101 card status. Cathay's own C0101 page treats `Invalid` as holding
 * no credit card; every other known status means the overview lists cards.
 */
function cardStatus(response: CathayPreviewResponse): "Valid" | "Positive" | "UnKnow" | "Invalid" {
  const status = content(response).cardStatus;
  if (status !== "Valid" && status !== "Positive" && status !== "UnKnow" && status !== "Invalid")
    fail("unexpected-response", "C_COM_Q_CardStatus cardStatus is unknown");
  return status;
}

function overviewAmount(pattern: RegExp, pageText: string, label: string): Readonly<{ amount: string; currency: string }> {
  const match = pattern.exec(pageText);
  if (!match) return fail("incomplete-data", `C0101 ${label} is missing`);
  return {
    amount: exactDecimal(match[2], `C0101 ${label}`),
    currency: currencyCode(match[1], `C0101 ${label}`, CURRENCY_ALIASES),
  };
}

function overviewCards(pageText: string): readonly PreviewCard[] {
  const lastFour = [...new Set([...pageText.matchAll(CARD_DIGITS)].map((match) => match[1]!))];
  if (lastFour.length === 0) fail("unexpected-response", "C0101 lists no card although cardStatus says cards exist");
  return lastFour.map((digits) => ({ sourceCardKey: `card-${digits}`, cardMask: `****-${digits}`, displayLabel: null }));
}

type Bill = Readonly<{ closingDate: string; billingPeriod: string }>;

function historyBills(response: CathayPreviewResponse): readonly Bill[] {
  const rows = records(content(response).historyBillInfoList, "C_BILL_Q_HistoryBillList historyBillInfoList");
  return rows.map((row, index) => {
    const closingDate = day(row.billDate, `historyBillInfoList[${index}].billDate`);
    return { closingDate, billingPeriod: closingDate.slice(0, 7) };
  });
}

type CurrencyBill = Readonly<{ currency: string; unpaid: string; paid: string }>;

function billSummary(value: unknown, field: string, currency: string): CurrencyBill {
  const summary = record(value, field);
  return {
    currency,
    unpaid: exactDecimal(summary.unPaidAmount, `${field}.unPaidAmount`),
    paid: exactDecimal(summary.paidAmount, `${field}.paidAmount`),
  };
}

function minimumPayment(billInfo: SourceRecord, currency: string): string | null {
  const rows = records(billInfo.currencyBillInfoList, "C_BILL_Q_BillInfo currencyBillInfoList")
    .filter((row) => row.currency === currency && row.currencyDataType === currency);
  if (rows.length > 1) fail("unexpected-response", `C_BILL_Q_BillInfo lists ${currency} twice`);
  return rows[0]?.currentMinPaymentAmount === undefined || rows[0].currentMinPaymentAmount === null
    ? null
    : exactDecimal(rows[0].currentMinPaymentAmount, `C_BILL_Q_BillInfo ${currency} currentMinPaymentAmount`);
}

type LatestBill = Readonly<{ dueDate: string | null; twdPaid: boolean }>;

function latestBill(response: CathayPreviewResponse | null): LatestBill {
  if (response === null) return { dueDate: null, twdPaid: false };
  const latest = content(response);
  const due = optionalText(latest.dueDate);
  const twd = latest.twdBillDetail === null || latest.twdBillDetail === undefined ? null : record(latest.twdBillDetail, "twdBillDetail");
  return { dueDate: due === null ? null : day(due, "C_CardInfo_Q_LatestBill dueDate"), twdPaid: twd?.payBillStatus === "Payed" };
}

/**
 * The current statement of one currency. A statement needs a due date and a
 * cycle start, which is the day after the previous closing date, so without
 * either it is not written. A foreign-currency statement's key names its
 * currency, so it stays distinct from the NT-dollar statement of the same period.
 */
function currentStatement(
  bill: CurrencyBill,
  closingDate: string,
  previousClosing: string | null,
  latest: LatestBill,
  minimum: string | null,
  noPaymentNeeded: boolean,
): PreviewStatement | null {
  if (latest.dueDate === null || previousClosing === null) return null;
  const unpaidZero = isZeroDecimal(bill.unpaid);
  const unpaidOwed = !unpaidZero && !bill.unpaid.startsWith("-");
  return {
    statementKey: bill.currency === "TWD" ? closingDate.slice(0, 7) : `${closingDate.slice(0, 7)}:${bill.currency}`,
    cycleStart: nextDay(previousClosing),
    cycleEnd: closingDate,
    closingDate,
    dueDate: latest.dueDate,
    amount: decimalSum([[1, bill.unpaid], [1, bill.paid]]),
    currency: bill.currency,
    minimumPayment: minimum,
    billingPeriod: closingDate.slice(0, 7),
    paidAmount: bill.paid,
    paid: unpaidOwed ? false : bill.currency === "TWD" && latest.twdPaid && unpaidZero ? true : null,
    noPaymentNeeded: bill.currency === "TWD" && noPaymentNeeded ? true : null,
  };
}

type TradeRow = Readonly<{
  statementKey: string;
  consumeDate: string;
  amount: string;
  description: string | null;
}>;

function billTrades(response: CathayPreviewResponse, bill: Bill): readonly TradeRow[] {
  const sections = records(content(response).twdBillDetailInfo, `${bill.billingPeriod} twdBillDetailInfo`);
  return sections.flatMap((section, sectionIndex) => {
    if (section.detailType === CARRIED_FORWARD) return [];
    if (section.tradeData === null || section.tradeData === undefined) return [];
    return records(section.tradeData, `${bill.billingPeriod} section ${sectionIndex} tradeData`).flatMap((trade, index) => {
      const field = `${bill.billingPeriod} section ${sectionIndex} trade ${index}`;
      const amount = exactDecimal(trade.amount, `${field} amount`);
      const currency = currencyCode(trade.currency, `${field} currency`, CURRENCY_ALIASES);
      if (currency !== "TWD") fail("unexpected-response", `${field} names ${currency} inside the NT-dollar bill`);
      if (isZeroDecimal(amount)) return [];
      return [{
        statementKey: bill.billingPeriod,
        consumeDate: day(text(trade.consumeDate, `${field} consumeDate`), `${field} consumeDate`),
        amount,
        description: optionalText(trade.transDesc),
      }];
    });
  });
}

/**
 * Billed purchases. Cathay names no direction field, so the sign decides only
 * when the collection holds both signs: a positive amount is a charge and a
 * negative one a refund or payment, as the bill shows them. Otherwise every
 * direction is unknown.
 */
function purchases(trades: readonly TradeRow[]): readonly PreviewPurchase[] {
  const signed = trades.some((trade) => trade.amount.startsWith("-")) && trades.some((trade) => !trade.amount.startsWith("-"));
  const occurrences = new Map<string, number>();
  return trades.map((trade) => {
    const identity = `${trade.statementKey}:${trade.consumeDate}:${trade.amount}:${digest(trade.description ?? "")}`;
    const occurrence = (occurrences.get(identity) ?? 0) + 1;
    occurrences.set(identity, occurrence);
    return {
      sourceRowKey: `${identity}:${occurrence}`,
      amount: trade.amount,
      currency: "TWD",
      direction: signed ? trade.amount.startsWith("-") ? "inflow" : "outflow" : "unknown",
      posting: { status: "posted", billing: "billed", postingDate: null },
      consumedAt: { precision: "day", value: trade.consumeDate },
      sourceCardKey: null,
      statementKey: trade.statementKey,
      bankReference: null,
      description: trade.description,
    };
  });
}

/**
 * Cathay credit cards: one NT-dollar account. Cathay pools the credit limit in
 * NT dollars, so the used-credit balance, the permanent credit limit minus the
 * available credit, already covers foreign spending. A foreign-currency bill
 * is only a statement in its own currency on that account, never an account
 * of its own, which would count that spending twice.
 */
export async function collectCathayCreditCards(
  port: CathayAttachedPreviewPort,
  collectedAt: string,
): Promise<PreviewCreditCollection | PreviewProductAbsence> {
  const overview = await port.cardOverview();
  if (cardStatus(overview.cardStatus) === "Invalid") return { absent: "not_held" };
  const cards = overviewCards(overview.text);
  const limit = overviewAmount(CREDIT_LIMIT, overview.text, "credit limit");
  const available = overviewAmount(AVAILABLE_CREDIT, overview.text, "available credit");
  if (limit.currency !== "TWD" || available.currency !== "TWD")
    fail("unexpected-response", "C0101 credit limit is not in NT dollars");
  const latest = latestBill(overview.latestBill);

  const recent = content(await port.cardApi(CATHAY_CARD_ENDPOINTS.recentBill));
  const billInfo = content(await port.cardApi(CATHAY_CARD_ENDPOINTS.billInfo));
  const history = historyBills(await port.cardApi(CATHAY_CARD_ENDPOINTS.history));
  const closingDate = day(recent.recentBillDate, "C_BILL_Q_RecentBillInfo recentBillDate");
  const previousClosing = history.map((bill) => bill.closingDate).filter((date) => date < closingDate).sort().at(-1) ?? null;
  const bills = [...history];
  if (!bills.some((bill) => bill.closingDate === closingDate)) bills.unshift({ closingDate, billingPeriod: closingDate.slice(0, 7) });

  const trades: TradeRow[] = [];
  for (const bill of bills) {
    trades.push(...billTrades(await port.cardApi(CATHAY_CARD_ENDPOINTS.detail, { billDate: bill.closingDate }), bill));
  }

  const noPaymentNeeded = overview.text.includes("無需繳費");
  const twdBill = billSummary(recent.twBillInfo, "twBillInfo", "TWD");
  const statements = [currentStatement(twdBill, closingDate, previousClosing, latest, minimumPayment(billInfo, "TWD"), noPaymentNeeded)];
  if (recent.foreignBillInfo !== null && recent.foreignBillInfo !== undefined) {
    const foreignCurrency = currencyCode(record(recent.foreignBillInfo, "foreignBillInfo").currency, "foreignBillInfo currency", CURRENCY_ALIASES);
    if (foreignCurrency === "TWD") fail("unexpected-response", "foreignBillInfo is in NT dollars");
    const foreignBill = billSummary(recent.foreignBillInfo, "foreignBillInfo", foreignCurrency);
    statements.push(currentStatement(foreignBill, closingDate, previousClosing, latest, minimumPayment(billInfo, foreignCurrency), false));
  }
  const account: PreviewCreditAccount = {
    sourceAccountKey: "card-portfolio:TWD",
    displayLabel: "國泰世華信用卡",
    currency: "TWD",
    creditLimit: limit.amount,
    cards,
    balances: [{
      amount: decimalSum([[1, limit.amount], [-1, available.amount]]),
      currency: "TWD",
      observedAt: observedAt(overview.cardStatus.date, collectedAt),
      basis: { kind: "credit-limit-minus-available", creditLimit: limit.amount, availableCredit: available.amount },
    }],
    purchases: purchases(trades),
    statements: statements.filter((statement) => statement !== null),
  };
  return { collectedAt, accounts: [account] };
}

const TIME_DEPOSIT_RATE_FIELDS = ["interestRate", "rate"] as const;
const TIME_DEPOSIT_MATURITY_FIELDS = ["dueDate", "maturityDate"] as const;

function firstPresent(row: SourceRecord, fields: readonly string[]): unknown {
  const field = fields.find((name) => row[name] !== undefined && row[name] !== null && row[name] !== "");
  return field === undefined ? undefined : row[field];
}

/**
 * NT-dollar time deposits from the account overview's `timeDepositData`. The
 * list counts as complete only when its own `queryStatus` is `Success`, or
 * `NoData` with no rows, and its rows add up to `totalAccountBalance` when
 * the overview sends one.
 */
export async function collectCathayTimeDeposits(
  port: CathayAttachedPreviewPort,
  collectedAt: string,
): Promise<PreviewTimeDepositCollection> {
  const response = await port.domesticOverview();
  if (response.status !== 200) fail("unexpected-response", `${response.endpoint} answered HTTP ${response.status}`);
  const envelope = record(parseSourceJson(response.text, response.endpoint), response.endpoint);
  if (envelope.success !== true) fail("unexpected-response", `${response.endpoint} was not successful`);
  const section = record(record(envelope.content, "overview content").timeDepositData, "timeDepositData");
  const rows = section.datas === undefined || section.datas === null ? [] : records(section.datas, "timeDepositData.datas");
  if (section.queryStatus === "NoData" && rows.length === 0) return { collectedAt, completeness: "complete", deposits: [] };
  if (section.queryStatus !== "Success") fail("incomplete-data", `timeDepositData queryStatus is ${String(section.queryStatus)}`);

  const reported = observedAt(optionalText(envelope.systemTime) ?? response.date, collectedAt);
  const deposits = rows.map((row, index): PreviewTimeDeposit => {
    const field = `timeDepositData.datas[${index}]`;
    const accountNo = text(row.accountNo, `${field}.accountNo`);
    const currency = row.currency === undefined || row.currency === null
      ? "TWD"
      : currencyCode(row.currency, `${field}.currency`, CURRENCY_ALIASES);
    const balance = exactDecimal(row.accountBalance, `${field}.accountBalance`);
    const rate = firstPresent(row, TIME_DEPOSIT_RATE_FIELDS);
    const maturity = firstPresent(row, TIME_DEPOSIT_MATURITY_FIELDS);
    const principal = firstPresent(row, ["principal"]);
    return {
      sourceAccountKey: `time-deposit:${accountNo}`,
      displayLabel: `國泰世華定存 ${accountNo.slice(-4)}`,
      currency,
      balances: [{ kind: "current", amount: balance, currency, observedAt: reported }],
      principal: principal === undefined ? null : exactDecimal(principal, `${field}.principal`),
      interestRate: rate === undefined ? null : exactDecimal(rate, `${field}.interestRate`),
      maturityDate: maturity === undefined ? null : day(maturity, `${field}.dueDate`),
    };
  });
  if (new Set(deposits.map((deposit) => deposit.sourceAccountKey)).size !== deposits.length)
    fail("unexpected-response", "timeDepositData repeats an account number");
  if (section.totalAccountBalance !== undefined && section.totalAccountBalance !== null) {
    if (deposits.some((deposit) => deposit.currency !== "TWD")) fail("unexpected-response", "timeDepositData mixes currencies under one total");
    const total = exactDecimal(section.totalAccountBalance, "timeDepositData.totalAccountBalance");
    const sum = decimalSum(deposits.map((deposit) => [1, deposit.balances[0]!.amount] as const));
    if (!isZeroDecimal(decimalSum([[1, sum], [-1, total]])))
      fail("incomplete-data", "timeDepositData rows do not add up to totalAccountBalance");
  }
  return { collectedAt, completeness: "complete", deposits };
}

const LOAN_AMOUNT = /^(?:(NT\$|NTD|TWD)\s*)?\$?\s*(-?[\d,]+(?:\.\d+)?)$/u;
const LOAN_RATE = /^(\d+(?:\.\d+)?)\s*%$/u;
const LOAN_INSTALLMENTS = /^已繳\s*([\d,]+)\s*期[，,]?\s*共\s*([\d,]+)\s*期$/u;
const SOURCE_DAY = /^(\d{2,4})[/-](\d{1,2})[/-](\d{1,2})$/u;

/** An L0101 amount such as `NT$ 123,456`; a currency prefix must agree with the page's `幣別`. */
function loanAmount(value: string | null, field: string, currency: string): string {
  const match = LOAN_AMOUNT.exec(value?.trim() ?? "");
  if (!match) return fail("malformed-amount", `L0101 ${field} is not an amount`);
  if (match[1] !== undefined && currency !== "TWD") fail("unexpected-response", `L0101 ${field} is in NT dollars, the page in ${currency}`);
  return exactDecimal(match[2], `L0101 ${field}`);
}

function optionalLoanAmount(value: string | null, field: string, currency: string): string | null {
  return optionalText(value) === null ? null : loanAmount(value, field, currency);
}

/** A Gregorian or ROC (民國) date as YYYY-MM-DD, or `null` for anything else, such as a payment status. */
function loanDay(value: string | null): string | null {
  const match = SOURCE_DAY.exec(value?.trim() ?? "");
  if (!match) return null;
  const year = match[1]!.length <= 3 ? Number(match[1]) + 1911 : Number(match[1]);
  return day(`${String(year).padStart(4, "0")}-${match[2]!.padStart(2, "0")}-${match[3]!.padStart(2, "0")}`, "L0101 扣款日");
}

/** `已繳 N 期，共 M 期`, or both `null` when the page shows no such text. */
function installments(value: string | null): Readonly<{ paid: number | null; total: number | null }> {
  const match = LOAN_INSTALLMENTS.exec(value?.replace(/\s+/gu, " ").trim() ?? "");
  if (!match) return { paid: null, total: null };
  return { paid: Number(match[1]!.replaceAll(",", "")), total: Number(match[2]!.replaceAll(",", "")) };
}

/** Only Cathay's own `房屋貸款` names a category; `其他貸款` may hold personal loans, so it names none. */
function loanCategory(row: CathayLoanRow): PreviewLoan["category"] {
  return row.category === "房屋貸款" || (row.category === null && row.section === "房屋貸款") ? "housing" : null;
}

/**
 * Loans from the L0101 overview, as all-set-tw reads it (`cathaybk/loan-overview.ts`, MIT). The
 * list is complete only when the parsed balances add up to the page's `貸款總餘額`, or the page
 * says it holds no loan; any other page fails the product rather than writing a list that may
 * miss a loan or misread a balance. The overview shows no original amount, opening date, or maturity.
 */
export async function collectCathayLoans(port: CathayAttachedPreviewPort, collectedAt: string): Promise<PreviewLoanCollection> {
  const overview = await port.loanOverview();
  if (!overview.recognized) fail("unexpected-response", "L0101 loan overview was not recognized");
  if (overview.rows.length === 0) {
    if (overview.noLoanMessage) return { collectedAt, completeness: "complete", loans: [] };
    fail("incomplete-data", "L0101 lists no loan and shows no no-loan message");
  }
  const currency = currencyCode(overview.currency, "L0101 幣別", CURRENCY_ALIASES);
  const balanceAt = observedAt(overview.date, collectedAt);
  const loans = overview.rows.map((row, index): PreviewLoan => {
    const field = `loan ${index + 1}`;
    const accountNumber = row.accountNumber?.replace(/[\s-]/gu, "") ?? "";
    if (!/^\d{8,20}$/u.test(accountNumber)) fail("unexpected-response", `L0101 ${field} shows no full account number`);
    const rate = optionalText(row.interestRate);
    const rateMatch = rate === null ? null : LOAN_RATE.exec(rate);
    if (rate !== null && rateMatch === null) fail("malformed-amount", `L0101 ${field} rate is not a percentage`);
    const paid = installments(row.installments);
    return {
      sourceAccountKey: accountNumber,
      displayLabel: `國泰世華貸款 ${accountNumber.slice(-4)}`,
      currency,
      category: loanCategory(row),
      outstandingBalance: { amount: loanAmount(row.balance, `${field} 貸款餘額`, currency), observedAt: balanceAt },
      originalAmount: null,
      interestRate: rateMatch === null ? null : exactDecimal(rateMatch[1], `L0101 ${field} rate`),
      paymentAmount: optionalLoanAmount(row.paymentAmount, `${field} 本期應繳金額`, currency),
      nextPaymentDate: loanDay(row.paymentDue),
      installmentsPaid: paid.paid,
      installmentsTotal: paid.total,
      openedOn: null,
      maturityDate: null,
    };
  });
  if (new Set(loans.map((loan) => loan.sourceAccountKey)).size !== loans.length)
    fail("unexpected-response", "L0101 repeats a loan account number");
  if (optionalText(overview.totalBalance) === null) fail("incomplete-data", "L0101 shows no 貸款總餘額");
  const total = loanAmount(overview.totalBalance, "貸款總餘額", currency);
  const sum = decimalSum(loans.map((loan) => [1, loan.outstandingBalance.amount] as const));
  if (!isZeroDecimal(decimalSum([[1, sum], [-1, total]]))) fail("incomplete-data", "L0101 loan balances do not add up to 貸款總餘額");
  return { collectedAt, completeness: "complete", loans };
}

/** Each collector reads through a port over its own product handle. */
export function cathayAttachedPreviewCollectors(
  portFor: (product: PreviewProductHandle) => CathayAttachedPreviewPort,
  now: () => string,
): PreviewProductCollectors {
  return {
    credit_card: (product) => collectCathayCreditCards(portFor(product), now()),
    time_deposit: (product) => collectCathayTimeDeposits(portFor(product), now()),
    loan: (product) => collectCathayLoans(portFor(product), now()),
  };
}
