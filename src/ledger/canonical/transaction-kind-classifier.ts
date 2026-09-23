/**
 * SQLite-free bank transaction classifier shared by the canonical and PGlite
 * enrichment writers.  The persistence modules add relation-aware evidence;
 * this function is deliberately limited to provider description rules.
 */
export type TransactionKindClassifierInput = Readonly<{
  direction: "inflow" | "outflow";
  description?: string | null;
  sourcePayload?: string | null;
  integrationNamespace?: string;
  stream?: string;
}>;

export function classifyBankTransactionKind(input: TransactionKindClassifierInput): Readonly<{
  value: string;
  evidenceKind: "bank-rule";
  sourceField: string;
}> {
  const text = [input.description, input.sourcePayload]
    .filter((value): value is string => Boolean(value && value.trim()))
    .join(" ")
    .toLowerCase();
  const sourceValue = input.description ?? input.sourcePayload ?? "";
  const direction = input.direction;
  const structured = input.description?.replace(/\s+/gu, "") ?? "";
  if (
    input.integrationNamespace === "fubon" &&
    input.stream === "domestic-deposit" &&
    direction === "outflow" &&
    /^(?:行動|網路)?繳費·(?:繳)?[^·]+信用卡(?:款|費)[^·]*$/u.test(structured)
  )
    return { value: "payment.credit_card", evidenceKind: "bank-rule", sourceField: "source_description" };
  if (
    input.integrationNamespace === "fubon" &&
    input.stream === "domestic-deposit" &&
    direction === "outflow" &&
    (input.description?.split("·", 1)[0]?.replace(/\s+/gu, "") ?? "") === "放款繳款"
  )
    return { value: "payment.loan", evidenceKind: "bank-rule", sourceField: "source_description" };
  if (
    input.integrationNamespace === "yuanta" &&
    input.stream === "domestic-deposit" &&
    direction === "outflow" &&
    /^\s*轉帳支取\s*·\s*\d{16}\s+YT\d{2}\s+FS\d{8}\s+約定申購\s+\d{5}\s+174\s+FISB\s*$/iu.test(input.description ?? "")
  )
    return { value: "investment.trade.buy", evidenceKind: "bank-rule", sourceField: "source_description" };
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
