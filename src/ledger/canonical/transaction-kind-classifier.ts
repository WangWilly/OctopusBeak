/**
 * SQLite-free bank transaction classifier shared by the canonical and PGlite
 * enrichment writers.  The persistence modules add relation-aware evidence;
 * this function is deliberately limited to provider description rules.
 */
export type TransactionKindClassifierInput = Readonly<{
  direction: "inflow" | "outflow";
  description?: string | null;
  sourcePayload?: string | null;
  /**
   * The Institution that maintains the account. Institution-specific label
   * rules key on it, so they also read that bank's rows an Intermediary
   * source such as TDCC reports.
   */
  institutionKey?: string;
  stream?: string;
}>;

/**
 * A machine token a payload carries beside its text: a digest, an id, a date,
 * a number, a version or contract name. Its letters are not words, so a
 * keyword rule must not read them: a base64 digest can hold `fee` or `ach`.
 */
const MACHINE_TOKEN = /^[\x21-\x7e]*[\d:_\-/=.+][\x21-\x7e]*$/u;

/**
 * The human text in a source payload: its string values, never its keys,
 * without machine tokens. A key such as `feeAmount` names a field, not what
 * the row is. A payload that is not JSON is text as it stands.
 */
function payloadText(payload: string | null | undefined): string {
  if (!payload) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return payload;
  }
  const values = (value: unknown): string[] =>
    typeof value === "string" ? (MACHINE_TOKEN.test(value) ? [] : [value])
      : value && typeof value === "object" ? Object.values(value).flatMap(values)
      : [];
  return values(parsed).join(" ");
}

/**
 * A bank's own label for a row: the description's first `·` part, without
 * whitespace or the Debit/Credit marker a foreign-currency statement puts
 * before it. Label rules match it whole, so a word elsewhere in the text, a
 * merchant name or a note, never reads as the label.
 */
function bankLabel(description: string | null | undefined): string {
  return (description?.split("·", 1)[0] ?? "").replace(/\s+/gu, "").replace(/^(?:debit|credit)/iu, "");
}

/**
 * Labels whose words say what the row is. A currency exchange moves money
 * into the person's own other-currency account; a separate exchange fee row
 * has its own label, such as 換匯手續費, and stays a fee.
 */
const CURRENCY_EXCHANGE_LABEL = /^(?:手機|行動|網路|網銀)?換匯$/u;

/**
 * Whether a bank row carries a bank's currency exchange label (ADR 0140). A
 * fee written after the label, such as 換匯 · 手續費, is a fee, not the exchange.
 */
export function carriesCurrencyExchangeLabel(description: string | null | undefined): boolean {
  return CURRENCY_EXCHANGE_LABEL.test(bankLabel(description)) && !/(手續費|服務費|fee)/iu.test(description ?? "");
}
const INVESTMENT_SETTLEMENT_LABEL = /^(?:複委託|交割股款)$/u;
const DIVIDEND_LABEL = /^(?:[A-Za-z][A-Za-z0-9.]{0,9}息|.{0,6}配息)$/u;
const DEPOSIT_INTEREST_LABEL = /^(?:存款|活存)息$/u;

export function classifyBankTransactionKind(input: TransactionKindClassifierInput): Readonly<{
  value: string;
  evidenceKind: "bank-rule";
  sourceField: string;
}> {
  const text = [input.description, payloadText(input.sourcePayload)]
    .filter((value): value is string => Boolean(value && value.trim()))
    .join(" ")
    .toLowerCase();
  const direction = input.direction;
  const structured = input.description?.replace(/\s+/gu, "") ?? "";
  const label = bankLabel(input.description);
  if (
    input.institutionKey === "fubon" &&
    input.stream === "domestic-deposit" &&
    direction === "outflow" &&
    /^(?:行動|網路)?繳費·(?:繳)?[^·]+信用卡(?:款|費)[^·]*$/u.test(structured)
  )
    return { value: "payment.credit_card", evidenceKind: "bank-rule", sourceField: "source_description" };
  if (
    input.institutionKey === "fubon" &&
    input.stream === "domestic-deposit" &&
    direction === "outflow" &&
    (input.description?.split("·", 1)[0]?.replace(/\s+/gu, "") ?? "") === "放款繳款"
  )
    return { value: "payment.loan", evidenceKind: "bank-rule", sourceField: "source_description" };
  if (
    input.institutionKey === "yuanta-bank" &&
    input.stream === "domestic-deposit" &&
    direction === "outflow" &&
    /^\s*轉帳支取\s*·\s*\d{16}\s+YT\d{2}\s+FS\d{8}\s+約定申購\s+\d{5}\s+174\s+FISB\s*$/iu.test(input.description ?? "")
  )
    return { value: "investment.trade.buy", evidenceKind: "bank-rule", sourceField: "source_description" };
  if (carriesCurrencyExchangeLabel(input.description))
    return { value: "transfer.internal", evidenceKind: "bank-rule", sourceField: "source_description" };
  if (INVESTMENT_SETTLEMENT_LABEL.test(label))
    return {
      value: direction === "outflow" ? "transfer.investment_contribution" : "transfer.investment_withdrawal",
      evidenceKind: "bank-rule",
      sourceField: "source_description",
    };
  if (direction === "inflow" && DIVIDEND_LABEL.test(label))
    return { value: "income.dividend", evidenceKind: "bank-rule", sourceField: "source_description" };
  if (direction === "inflow" && DEPOSIT_INTEREST_LABEL.test(label))
    return { value: "interest.earned", evidenceKind: "bank-rule", sourceField: "source_description" };
  if (/(自轉|自動轉帳|本人(?:帳戶|轉帳|匯款)|同名(?:轉帳|帳戶)|自有帳戶|轉入本人|轉出本人)/u.test(text))
    return { value: "transfer.internal", evidenceKind: "bank-rule", sourceField: "source_kind" };
  if (/(匯款|電匯|跨行|ach|wire|swift|remittance|轉出至|轉入自)/iu.test(text))
    return { value: "transfer.external", evidenceKind: "bank-rule", sourceField: "source_kind" };
  if (/(繳卡|卡費|信用卡繳|credit\s*card\s*(?:payment|bill)|card\s*payment)/iu.test(text))
    return { value: "payment.credit_card", evidenceKind: "bank-rule", sourceField: "source_kind" };
  if (/(還款|還本|房貸|信貸|車貸|貸款繳|loan\s*(?:payment|repayment))/iu.test(text))
    return { value: "payment.loan", evidenceKind: "bank-rule", sourceField: "source_kind" };
  if (/(提款|提領|atm|自動櫃員機|cash\s*withdrawal)/iu.test(text))
    return { value: "cash.withdrawal", evidenceKind: "bank-rule", sourceField: "source_kind" };
  if (/(現金存入|現金存款|現金入帳|cash\s*deposit)/iu.test(text) && direction === "inflow")
    return { value: "cash.deposit", evidenceKind: "bank-rule", sourceField: "source_kind" };
  if (/(股票|證券|etf|基金|共同基金|信託|複委託|美股|台股|投資|brokerage|security)/iu.test(text)) {
    if (/(複委託扣|投資(?:帳戶)?扣|證券(?:戶)?扣)/u.test(text) && direction === "outflow")
      return { value: "transfer.investment_contribution", evidenceKind: "bank-rule", sourceField: "source_kind" };
    if (/(複委託入|投資(?:帳戶)?入|證券(?:戶)?入)/u.test(text) && direction === "inflow")
      return { value: "transfer.investment_withdrawal", evidenceKind: "bank-rule", sourceField: "source_kind" };
    if (/(賣出|賣股|sell|贖回)/iu.test(text))
      return { value: "investment.trade.sell", evidenceKind: "bank-rule", sourceField: "source_kind" };
    if (direction === "outflow" && /(買股|買股票|股票買|申購|買基金|buy)/iu.test(text))
      return { value: "investment.trade.buy", evidenceKind: "bank-rule", sourceField: "source_kind" };
  }
  if (/(手續費|服務費|管理費|費用|fee|commission)/iu.test(text))
    return {
      value: /投資|證券|股票|基金|複委託|commission/iu.test(text)
        ? "fee.investment"
        : /信用卡|卡片|card/iu.test(text) ? "fee.card" : "fee.bank",
      evidenceKind: "bank-rule",
      sourceField: "source_kind",
    };
  if (/(利息|interest)/iu.test(text))
    return { value: direction === "inflow" ? "interest.earned" : "interest.charged", evidenceKind: "bank-rule", sourceField: "source_kind" };
  if (/(退款|退刷|退回|refund)/iu.test(text))
    return { value: "refund", evidenceKind: "bank-rule", sourceField: "source_kind" };
  if (/(沖銷|撤銷|作廢|reversal|void)/iu.test(text))
    return { value: "reversal", evidenceKind: "bank-rule", sourceField: "source_kind" };
  if (/(貸款撥款|撥款|loan\s*disbursement)/iu.test(text) && direction === "inflow")
    return { value: "loan.disbursement", evidenceKind: "bank-rule", sourceField: "source_kind" };
  if (/(薪資|薪水|工資|salary|payroll)/iu.test(text) && direction === "inflow")
    return { value: "income.employment.salary", evidenceKind: "bank-rule", sourceField: "source_kind" };
  if (/(獎金|bonus)/iu.test(text) && direction === "inflow")
    return { value: "income.employment.bonus", evidenceKind: "bank-rule", sourceField: "source_kind" };
  if (/(股息|股利|dividend)/iu.test(text) && direction === "inflow")
    return { value: "income.dividend", evidenceKind: "bank-rule", sourceField: "source_kind" };
  if (/(租金|rental)/iu.test(text) && direction === "inflow")
    return { value: "income.rental", evidenceKind: "bank-rule", sourceField: "source_kind" };
  if (/(稅|稅款|tax)/iu.test(text))
    return { value: direction === "inflow" ? "tax.refund" : "tax.payment", evidenceKind: "bank-rule", sourceField: "source_kind" };
  return {
    value: direction === "outflow" ? "purchase" : "receipt",
    evidenceKind: "bank-rule",
    sourceField: "source_kind",
  };
}

/**
 * A credit-card inflow is a refund, a reversal, a reward, or a bill payment
 * credit, and its direction alone cannot tell which. The issuer's own label
 * can, so this matches the issuer's phrasing rather than any word a merchant
 * name may also hold: 中華電信繳費 or GOOGLE PAYMENT is a merchant's credit.
 * A refund label is left to the direction fallback, which already reads it
 * as a refund, so it returns null for that and for a label naming nothing.
 */
const CARD_REFUND_LABEL = /(退款|退貨|退刷|刷退|退費|退回|refund)/u;
const CARD_REVERSAL_LABEL = /(沖正|沖銷|沖回|reversal)/u;
const CARD_REWARD_LABEL = /(現金回饋|紅利回饋|回饋金|cashback)/u;
const CARD_PAYMENT_LABEL = /(^繳款|網路繳款|行動銀行繳款|行動繳款|^自動扣繳|atm繳款|臨櫃繳款|超商繳款|感謝您?的?繳款|paymentthankyou|thankyouforyourpayment|paymentreceived)/u;

export function classifyCreditCardInflowKind(description: string | null | undefined): Readonly<{
  value: "reversal" | "income.reward" | "payment.credit_card";
  evidenceKind: "bank-rule";
  sourceField: "source_description";
}> | null {
  const text = description?.replace(/[\s\-–—:：]+/gu, "").toLowerCase() ?? "";
  if (CARD_REFUND_LABEL.test(text)) return null;
  const value = CARD_REVERSAL_LABEL.test(text) ? "reversal"
    : CARD_REWARD_LABEL.test(text) ? "income.reward"
    : CARD_PAYMENT_LABEL.test(text) ? "payment.credit_card"
    : null;
  return value === null ? null : { value, evidenceKind: "bank-rule", sourceField: "source_description" };
}

/**
 * A credit-card outflow is a purchase unless the issuer itself charged it:
 * interest, or a fee for the card. The issuer writes such a charge as its own
 * line whose whole label names it, such as 循環利息, 年費 or 國外交易服務費,
 * sometimes with a reference in brackets before or after it. So the label
 * must be one of these words whole: a merchant whose name merely holds one,
 * such as a shop's 會員年費, 息壤咖啡 or FEEDBACK STORE, stays a purchase.
 */
const CARD_INTEREST_LABEL = /^(?:(?:循環(?:信用)?|預借現金|分期(?:付款)?|延滯|遲延)?利息|循環息|(?:purchase|cashadvance)?interest(?:charges?)?|financecharges?)$/u;
const CARD_FEE_LABEL = new RegExp(
  "^(?:"
    + "(?:信用卡|卡片|正卡|附卡)?年費"
    + "|(?:國外|海外|境外)(?:交易|刷卡|消費)?(?:授權結匯)?(?:手續費|服務費)"
    + "|(?:預借現金|分期(?:付款)?|掛失|補發卡?|補卡|逾期)?手續費"
    + "|滯納金|違約金"
    + "|(?:annual|membership|late(?:payment)?|cashadvance|overlimit|returnedpayment)fees?"
    + "|(?:foreign|international|overseas)(?:transaction|currency|purchase)?(?:service)?fees?"
    + ")$",
  "u",
);

/** The issuer's label on a card line: its first `·` part, without whitespace or a bracketed reference before or after it. */
function cardLabel(description: string | null | undefined): string {
  return (description?.normalize("NFKC").split("·", 1)[0] ?? "")
    .replace(/\s+/gu, "")
    .replace(/^\([^()]*\)/u, "")
    .replace(/\([^()]*\)$/u, "")
    .toLowerCase();
}

export function classifyCreditCardOutflowKind(description: string | null | undefined): Readonly<{
  value: "interest.charged" | "fee.card";
  evidenceKind: "bank-rule";
  sourceField: "source_description";
}> | null {
  const label = cardLabel(description);
  const value = CARD_INTEREST_LABEL.test(label) ? "interest.charged"
    : CARD_FEE_LABEL.test(label) ? "fee.card"
    : null;
  return value === null ? null : { value, evidenceKind: "bank-rule", sourceField: "source_description" };
}
