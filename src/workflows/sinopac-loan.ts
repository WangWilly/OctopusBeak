import type { Page } from "playwright";
import type { PreviewLoan, PreviewLoanCollection } from "../ledger/pglite/preview-loan.ts";
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
  text,
  type SourceRecord,
} from "../lib/preview-sources/source-kit.ts";
import { frameScope } from "./frame-scope.ts";

/*
 * SinoPac loans, after all-set-tw's `sinopac/loan-protocol.ts` (MIT, commit 156e2eb), which calls
 * these web services on `m.sinopac.com`. That they also answer under the same paths on
 * `mma.sinopac.com`, in the verified workflow's session, is assumed, not observed: a reply that
 * looks like a missing endpoint fails the product with that reason.
 */
const MMA_ORIGIN = "https://mma.sinopac.com";
export const SINOPAC_LOAN_ACCOUNT_PATH = "/ws/bank/loan/ws_loanaccount.ashx";
export const SINOPAC_LOAN_INFO_PATH = "/ws/bank/loan/ws_loaninfo.ashx";
export const SINOPAC_LOAN_PAY_DETAIL_PATH = "/ws/bank/loan/ws_paydetail.ashx";

export type SinopacLoanResponse = Readonly<{ endpoint: string; status: number; date: string | null; text: string }>;

/** Same-origin form POSTs from the signed-in MMA page. */
export type SinopacLoanTransport = Readonly<{
  post(path: string, form: Readonly<Record<string, string>>): Promise<SinopacLoanResponse>;
}>;

export function sinopacLoanPageTransport(page: Page, signal: AbortSignal): SinopacLoanTransport {
  const scope = frameScope(page, signal);
  return {
    async post(path, form) {
      signal.throwIfAborted();
      if (new URL(page.url()).origin !== MMA_ORIGIN) fail("unexpected-response", "the signed-in page is not on the MMA origin");
      const response = await scope.race(page.evaluate(async ({ url, body }) => {
        const reply = await fetch(url, {
          method: "POST",
          credentials: "same-origin",
          headers: {
            Accept: "application/json, text/javascript, */*; q=0.01",
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "X-Requested-With": "XMLHttpRequest",
          },
          body,
        });
        return { status: reply.status, date: reply.headers.get("date"), text: await reply.text() };
      }, { url: `${MMA_ORIGIN}${path}`, body: new URLSearchParams(form).toString() }));
      signal.throwIfAborted();
      return { endpoint: path, ...response };
    },
  };
}

const CURRENCY_ALIASES: Readonly<Record<string, string>> = {
  "000": "TWD", NTD: "TWD", "臺幣": "TWD", "台幣": "TWD", "新臺幣": "TWD", "新台幣": "TWD",
};

const ASSUMED = "the MMA loan endpoint is assumed from all-set-tw's mobile host";

/** Text with SinoPac's inline HTML (`<br />`, `<font>`, entities) reduced to spaces. */
function plain(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return optionalText(value.replace(/<[^>]*>/gu, " ").replace(/&nbsp;|&#160;/giu, " ").replace(/\s+/gu, " "));
}

type Envelope = Readonly<{ subInfo: readonly SourceRecord[]; raw: SourceRecord }>;

/** A SUCCESS envelope. A 404 or a non-JSON page is how an endpoint missing from the MMA host answers. */
function envelope(response: SinopacLoanResponse): Envelope {
  if (response.status === 404) fail("unexpected-response", `${response.endpoint} answered HTTP 404, as a missing endpoint does; ${ASSUMED}`);
  if (response.status !== 200) fail("unexpected-response", `${response.endpoint} answered HTTP ${response.status}`);
  if (!/^\s*\[/u.test(response.text)) fail("unexpected-response", `${response.endpoint} answered with no JSON envelope, as a missing endpoint does; ${ASSUMED}`);
  const body = parseSourceJson(response.text, response.endpoint);
  if (!Array.isArray(body) || body.length !== 1) fail("unexpected-response", `${response.endpoint} is not a single envelope`);
  const raw = record(body[0], response.endpoint);
  const header = text(raw.Header, `${response.endpoint} Header`);
  const message = plain(raw.Message);
  if (header === "TIMEOUT" || /尚未登入|登入逾時/u.test(message ?? "")) fail("session-conflict", `${response.endpoint} reports the MMA session ended`);
  if (header !== "SUCCESS") fail("unexpected-response", `${response.endpoint} Header ${header}`);
  return { subInfo: records(raw.SubInfo, `${response.endpoint} SubInfo`), raw };
}

function amountOf(value: unknown, field: string): string {
  return exactDecimal(plain(value)?.replace(/%$/u, "") ?? undefined, field);
}

function optionalAmountOf(value: unknown, field: string): string | null {
  return plain(value) === null ? null : amountOf(value, field);
}

const SOURCE_DAY = /(\d{2,4})[/-](\d{1,2})[/-](\d{1,2})/gu;

/** Every Gregorian or ROC (民國) date in the text, as YYYY-MM-DD. */
function days(value: unknown, field: string): readonly string[] {
  return [...(plain(value) ?? "").matchAll(SOURCE_DAY)].map((match) => {
    const year = match[1]!.length <= 3 ? Number(match[1]) + 1911 : Number(match[1]);
    return localDate(`${String(year).padStart(4, "0")}-${match[2]!.padStart(2, "0")}-${match[3]!.padStart(2, "0")}`, field).value;
  });
}

function optionalDay(value: unknown, field: string): string | null {
  if (plain(value) === null) return null;
  const found = days(value, field);
  if (found.length !== 1) fail("unexpected-response", `${field} is not one date`);
  return found[0]!;
}

/** SinoPac's own `LoanKind`: `房屋` is housing, `信用` personal, any other kind other. */
function category(value: unknown): PreviewLoan["category"] {
  const kind = plain(value);
  if (kind === null) return null;
  return kind.includes("房屋") ? "housing" : kind.includes("信用") ? "personal" : "other";
}

/** The amount after the one `應繳金額` label in `TopInfo`, such as `應繳金額總計1,234`. */
function amountDue(topInfo: unknown): string | null {
  const shown = plain(topInfo);
  if (shown === null) return null;
  const parts = shown.split("應繳金額");
  if (parts.length !== 2) return null;
  const match = /^\s*[:：]?\s*(?:總計|合計)?\s*(?:NTD|TWD|NT\$|新臺幣|新台幣|臺幣|台幣)?\s*[:：]?\s*(\d[\d,]*(?:\.\d+)?)/u.exec(parts[1]!);
  return match ? exactDecimal(match[1], "ws_paydetail TopInfo 應繳金額") : null;
}

/** The end of the current interest period: `DataValue3`'s second date, only under the `計息起日計息止日` header. */
function interestPeriodEnd(detail: Envelope): string | null {
  const headers = Array.isArray(detail.raw.HeadInfo) ? records(detail.raw.HeadInfo, "ws_paydetail HeadInfo") : [];
  const labelled = headers.some((header) => header.FieldKey === "DataValue3" && plain(header.HeadText)?.replace(/\s/gu, "") === "計息起日計息止日");
  if (!labelled || detail.subInfo.length === 0) return null;
  const dates = days(detail.subInfo[0]!.DataValue3, "ws_paydetail DataValue3");
  return dates.length === 2 ? dates[1]! : null;
}

export type SinopacLoanCollectionInput = Readonly<{ transport: SinopacLoanTransport; collectedAt: string }>;

/**
 * Loans from `ws_loanaccount`, then `ws_loaninfo` and `ws_paydetail` per loan. The account list's
 * `RecordCount` is often absent, so the list cannot be shown complete: it is always `unproven`,
 * and a SinoPac loan is never closed by its absence.
 */
export async function collectSinopacLoans({ transport, collectedAt }: SinopacLoanCollectionInput): Promise<PreviewLoanCollection> {
  const list = envelope(await transport.post(SINOPAC_LOAN_ACCOUNT_PATH, {}));
  const loans: PreviewLoan[] = [];
  for (const [index, row] of list.subInfo.entries()) {
    const acctValue = text(row.AcctValue, `ws_loanaccount SubInfo[${index}] AcctValue`);
    const accountNumber = acctValue.replace(/[\s-]/gu, "");
    if (!/^\d{8,20}$/u.test(accountNumber)) fail("unexpected-response", `ws_loanaccount SubInfo[${index}] is no full account number`);
    const acctValueFormat = typeof row.AcctValueFormat === "string" ? row.AcctValueFormat : "";
    const infoResponse = await transport.post(SINOPAC_LOAN_INFO_PATH, { AcctValue: acctValue, AcctValueFormat: acctValueFormat });
    const info = envelope(infoResponse);
    if (info.subInfo.length !== 1) fail("unexpected-response", "ws_loaninfo does not describe exactly one loan");
    const terms = info.subInfo[0]!;
    const sent = (field: string) => plain(terms[field]) ?? "";
    const detail = envelope(await transport.post(SINOPAC_LOAN_PAY_DETAIL_PATH, {
      AcctValue: acctValue,
      AcctValueFormat: acctValueFormat,
      LoanAmt: sent("LoanAmt"),
      LoanBalance: sent("LoanBalance"),
      Sub1_Sub2: sent("Sub1_Sub2"),
      LoanKind: sent("LoanKind"),
      PayName: sent("PayName"),
      LNMAINACNO: acctValue,
      LNALTNO: sent("Sub1_Sub2"),
      CURRENCY: sent("Currency"),
    }));
    loans.push({
      sourceAccountKey: accountNumber,
      displayLabel: `永豐銀行貸款 ${accountNumber.slice(-4)}`,
      currency: currencyCode(plain(terms.Currency), "ws_loaninfo Currency", CURRENCY_ALIASES),
      category: category(terms.LoanKind),
      outstandingBalance: {
        amount: amountOf(terms.LoanBalance, "ws_loaninfo LoanBalance"),
        observedAt: observedAt(infoResponse.date, collectedAt),
      },
      originalAmount: optionalAmountOf(terms.LoanAmt, "ws_loaninfo LoanAmt"),
      interestRate: optionalAmountOf(terms.LoanRate, "ws_loaninfo LoanRate"),
      paymentAmount: amountDue(detail.raw.TopInfo),
      nextPaymentDate: interestPeriodEnd(detail),
      installmentsPaid: null,
      installmentsTotal: null,
      openedOn: optionalDay(terms.BeginLoanDate, "ws_loaninfo BeginLoanDate"),
      maturityDate: optionalDay(terms.MatureDate, "ws_loaninfo MatureDate"),
    });
  }
  if (new Set(loans.map((loan) => loan.sourceAccountKey)).size !== loans.length)
    fail("unexpected-response", "ws_loanaccount repeats a loan account number");
  return { collectedAt, completeness: "unproven", loans };
}
