import type {
  CathayAttachedPreviewPort,
  CathayCardEndpoint,
  CathayPreviewResponse,
} from "./cathay-attached-preview.ts";
import { previewCreditAccountId, type PreviewCreditCollection } from "../ledger/pglite/preview-credit.ts";
import { previewCreditAccountRow, previewSummaryMarkers } from "../ledger/pglite/preview-overview.ts";

export const CATHAY_PREVIEW_NOW = "2026-10-18T02:00:00.000Z";
const DATE = "Sun, 18 Oct 2026 01:59:58 GMT";

export const CATHAY_CARD_OVERVIEW_TEXT = [
  "信用卡總覽",
  "國泰卡 VISA",
  "卡片末四碼: 1234",
  "卡片末四碼: 5678",
  "永久信用額度 TWD 100,000",
  "剩餘可用額度 TWD 98,765.5",
].join("\n");

export const cathayEnvelope = (content: unknown) => JSON.stringify({ success: true, returnCode: "0000", content });

export const CATHAY_PREVIEW_RESPONSES = {
  cardStatus: `{"returnCode":"0000","content":{"cardStatus":"Valid"}}`,
  latestBill: cathayEnvelope({ dueDate: "2026-10-05", twdBillDetail: { payBillStatus: "UnPayed" } }),
  C_BILL_Q_RecentBillInfo: `{"success":true,"returnCode":"0000","content":{"recentBillDate":"2026-09-20","twBillInfo":{"unPaidAmount":1200,"paidAmount":34.5},"foreignBillInfo":{"currency":"USD","unPaidAmount":12.30,"paidAmount":0}}}`,
  C_BILL_Q_BillInfo: `{"success":true,"returnCode":"0000","content":{"currencyBillInfoList":[{"currency":"TWD","currencyDataType":"TWD","currentMinPaymentAmount":1000},{"currency":"USD","currencyDataType":"USD","currentMinPaymentAmount":12.30}]}}`,
  C_BILL_Q_HistoryBillList: cathayEnvelope({ historyBillInfoList: [
    { billDate: "2026-09-20", twdAmount: 900, usdAmount: null, billStatus: "fixture" },
    { billDate: "2026-08-20", twdAmount: 700, usdAmount: null, billStatus: "fixture" },
  ] }),
  "detail:2026-09-20": `{"success":true,"returnCode":"0000","content":{"twdBillDetailInfo":[{"detailType":"LastBillAmount","tradeData":[{"consumeDate":"2026-08-20","transDesc":"上期應繳","amount":700,"currency":"TWD"}]},{"detailType":"Consume","tradeData":[{"consumeDate":"2026-09-01","transDesc":"fixture shop","amount":500,"currency":"TWD"},{"consumeDate":"2026-09-01","transDesc":"fixture shop","amount":500,"currency":"TWD"},{"consumeDate":"2026-09-03","transDesc":"fixture refund","amount":-120.50,"currency":"TWD"},{"consumeDate":"2026-09-04","transDesc":"fee waived","amount":0,"currency":"TWD"}]}]}}`,
  "detail:2026-08-20": cathayEnvelope({ twdBillDetailInfo: [{ detailType: "Consume", tradeData: null }] }),
  domesticOverview: `{"success":true,"systemTime":"2026-10-18T09:59:58+08:00","content":{"depositData":{"queryStatus":"Success","datas":[]},"timeDepositData":{"queryStatus":"Success","totalAccountBalance":150000.00,"datas":[{"accountNo":"fixture-td-0001","accountBalance":100000.00,"interestRate":"1.725","dueDate":"2027-03-01"},{"accountNo":"fixture-td-0002","accountBalance":50000}]}}}`,
};

export type CathayPreviewResponses = Record<string, string | null>;

/** A signed-in Cathay page that answers from synthetic responses and records each one it served. */
export function fakeCathayAttachedPreviewPort(overrides: CathayPreviewResponses = {}) {
  const bodies: CathayPreviewResponses = { ...CATHAY_PREVIEW_RESPONSES, ...overrides };
  const seen: string[] = [];
  const respond = (key: string, endpoint: string): CathayPreviewResponse => {
    seen.push(key);
    const text = bodies[key];
    if (text === undefined || text === null) throw new Error(`no fixture for ${key}`);
    return { endpoint, status: 200, text, date: DATE };
  };
  const port: CathayAttachedPreviewPort = {
    async cardOverview() {
      return {
        cardStatus: respond("cardStatus", "/C_COM_Q_CardStatus"),
        latestBill: bodies.latestBill === null ? null : respond("latestBill", "/C_CardInfo_Q_LatestBill"),
        text: bodies.overviewText ?? CATHAY_CARD_OVERVIEW_TEXT,
      };
    },
    async cardApi(endpoint: CathayCardEndpoint, content = {}) {
      return respond(endpoint === "C_BILL_Q_RecentBillDetail" ? `detail:${content.billDate}` : endpoint, endpoint);
    },
    async domesticOverview() {
      return respond("domesticOverview", "/B_ACCT_Q_DepositOverview");
    },
  };
  return { port, seen };
}

/** The overview's totals markers for a written card collection, read the way the overview reads stored accounts. */
export function cathayCardTotals(collection: PreviewCreditCollection) {
  return previewSummaryMarkers(collection.accounts.map((account) => {
    const previewAccountId = previewCreditAccountId("cathay", account.sourceAccountKey);
    return previewCreditAccountRow({
      previewAccountId,
      sourceId: "cathay",
      institution: "cathay",
      product: "credit_card",
      displayLabel: account.displayLabel,
      currency: account.currency,
      creditLimit: account.creditLimit,
      cards: account.cards,
      lastCollectedAt: collection.collectedAt,
      latestBalance: account.balances.at(-1) ?? null,
    }, [], account.statements.map((statement) => ({ ...statement, previewAccountId })));
  }));
}
