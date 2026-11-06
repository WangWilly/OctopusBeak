import type { Page, Response } from "playwright";
import type { WorkflowContextWith } from "./workflow-executor.ts";
import { esunCreditCardWorkflow } from "../../workflows/esun-credit-card-statements.ts";
import { ESUN_SOURCE } from "./server/sources/esun.ts";
import { runVerifiedEntry } from "./server/verified-entry.ts";
import { withBoundProducts } from "./product-collection.fixtures.ts";
import type { EsunPortalPageReply, EsunPortalReply } from "../preview-sources/esun-portal.ts";

/** The redesigned card-summary endpoint the workflow waits on for current used credit. */
export const ESUN_CARD_SUMMARY_URL =
  "https://ebank.esunbank.com.tw/esb/mib-ccm-portal/ccmA1/ccmA1001/home/getCardSummary";

/** A 200 card-summary reply: its JSON body and response headers. */
export type EsunCardSummaryReply = Readonly<{ body: unknown; headers: Readonly<Record<string, string>> }>;

/** The past-year timeline the card-transactions popup requests. */
export const ESUN_TIMELINE_URL = "https://ebank.esunbank.com.tw/GW/creditLastYear/getFilterResult";
const summaryEndpoint = "https://ebank.esunbank.com.tw/GW/creditBill/getSummaryResult";

function monthAtOffset(now: Date, offset: number): { year: string; month: string; day: string } {
  const date = new Date(now.getFullYear(), now.getMonth() - offset, 1);
  const day = Math.min(now.getDate(), new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate());
  return {
    year: String(date.getFullYear()),
    month: String(date.getMonth() + 1).padStart(2, "0"),
    day: String(day).padStart(2, "0"),
  };
}

function jsonResponse(value: unknown, url: string, status = 200): Response {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return byteResponse(bytes, url, status);
}

function cardSummaryResponse(reply: EsunCardSummaryReply): Response {
  const bytes = new TextEncoder().encode(JSON.stringify(reply.body));
  return {
    status: () => 200,
    url: () => ESUN_CARD_SUMMARY_URL,
    request: () => ({ method: () => "POST" }),
    body: async () => Buffer.from(bytes),
    headers: () => ({ ...reply.headers }),
  } as unknown as Response;
}

function byteResponse(bytes: Uint8Array, url: string, status = 200): Response {
  return {
    status: () => status,
    url: () => url,
    request: () => ({ method: () => "POST" }),
    body: async () => Buffer.from(bytes),
    headers: () => ({}),
  } as unknown as Response;
}

function timelineValue(now: Date, monthCount = 13, cursor = 4): unknown {
  return {
    body: {
      rtnCode: "S",
      cursor,
      transList: Array.from({ length: monthCount }, (_, offset) => {
        const month = monthAtOffset(now, offset);
        return {
          year: month.year,
          month: month.month,
          transDetailList: [{
            merchantName: `Synthetic purchase ${offset}`,
            paymentCurrency: "TWD",
            paymentAmount: 100 + offset,
            transCurrency: "TWD",
            transAmount: 100 + offset,
            cardNo: "1234-****-****-5678",
            statusName: offset === 0 ? "已入帳" : "未入帳",
            transMonthDay: `${month.month}${month.day}`,
          }],
        };
      }),
    },
  };
}

function issuerSummary(period: string): unknown {
  const [year, month] = period.split("/").map(Number);
  const lastDay = new Date(year!, month!, 0).getDate();
  const dueDate = new Date(year!, month!, 20);
  return {
    body: {
      rtnCode: "S",
      billInfo: {
        billDate: `${year}${String(month).padStart(2, "0")}${String(lastDay).padStart(2, "0")}`,
        paymentDueDate: `${dueDate.getFullYear()}${String(dueDate.getMonth() + 1).padStart(2, "0")}20`,
        billTotalInfoList: [{ billTotalCurrency: "TWD", billTotalAmount: 3200 }],
        minimumPaymentInfoList: [{ minimumPaymentCurrency: "TWD", minimumPaymentAmount: 200 }],
      },
    },
  };
}

export function createPage(options: {
  timelineBytes?: Uint8Array;
  timelineTimeout?: boolean;
  monthCount?: number;
  cursor?: number;
  /** Serves the first timeline page at this URL and status instead of a 200 from ESUN_TIMELINE_URL. */
  timelineUrl?: string;
  timelineStatus?: number;
  /** The host the card popups open on, and so the host their history replies are declared on. */
  popupHost?: string;
  portal?: (path: string, requestBody: Readonly<Record<string, unknown>>) => EsunPortalReply | EsunPortalPageReply;
  /** Serves getCardSummary as HTTP 200 with this reply; without it the summary answers 204. */
  cardSummary?: EsunCardSummaryReply;
} = {}): Page {
  const now = new Date(2026, 8, 25);
  const newestPeriod = monthAtOffset(now, 1);
  const oldestPeriod = monthAtOffset(now, 2);
  const periods = [
    `${newestPeriod.year}/${newestPeriod.month}`,
    `${oldestPeriod.year}/${oldestPeriod.month}`,
  ];
  const summaryUrl = summaryEndpoint.replace("ebank.esunbank.com.tw", options.popupHost ?? "ebank.esunbank.com.tw");
  const responses = [
    ...options.timelineTimeout ? [] : [options.timelineBytes
      ? byteResponse(options.timelineBytes, options.timelineUrl ?? ESUN_TIMELINE_URL, options.timelineStatus)
      : jsonResponse(
        timelineValue(now, options.monthCount, options.cursor),
        options.timelineUrl ?? ESUN_TIMELINE_URL,
        options.timelineStatus,
      )],
    jsonResponse(issuerSummary(periods[1]!), summaryUrl),
    jsonResponse(issuerSummary(periods[0]!), summaryUrl),
  ];
  const inputValues = new Map<string, string>();
  const makeLocator = (selector: string) => ({
    waitFor: async () => undefined,
    click: async () => undefined,
    fill: async (value: string) => { inputValues.set(selector, value); },
    inputValue: async () => inputValues.get(selector) ?? "",
    isVisible: async () => true,
    allTextContents: async () => selector === ".info-scrollable li" ? periods : [],
    first() { return this; },
    last() { return this; },
    nth() { return this; },
    evaluate: async () => undefined,
    boundingBox: async () => ({ x: 1, y: 1, width: 640, height: 480 }),
  });
  const popup = {
    url: () => `https://${options.popupHost ?? "ebank.esunbank.com.tw"}/IESC/cardTrans`,
    waitForURL: async () => undefined,
    waitForResponse: async (predicate: (response: Response) => boolean) => {
      const index = responses.findIndex((response) => predicate(response));
      if (index < 0 && options.timelineTimeout)
        throw Object.assign(new Error("page.waitForResponse: Timeout 30000ms exceeded."), { name: "TimeoutError" });
      if (index < 0) throw new Error("Unexpected E.SUN response waiter.");
      return responses.splice(index, 1)[0]!;
    },
    locator: (selector: string) => makeLocator(selector),
    getByText: () => ({ click: async () => undefined, isVisible: async () => true }),
    close: async () => undefined,
  };
  const page = {
    url: () => "https://ebank.esunbank.com.tw/index.jsp",
    getByText: () => ({
      isVisible: async () => true,
      waitFor: async () => undefined,
      click: async () => undefined,
    }),
    waitForEvent: async () => popup,
    waitForResponse: async (predicate: (response: Response) => boolean) => {
      const response = options.cardSummary
        ? cardSummaryResponse(options.cardSummary)
        : { url: () => ESUN_CARD_SUMMARY_URL, status: () => 204 } as unknown as Response;
      if (predicate(response)) return response;
      throw new Error("Optional current-credit response not present.");
    },
    locator: (selector: string) => makeLocator(selector),
    getByRole: (_role: string, options: { name?: string } = {}) => ({
      click: async () => undefined,
      isVisible: async () => options.name !== "確定登入",
    }),
    goto: async () => undefined,
    on: () => undefined,
    waitForFunction: async () => undefined,
    evaluate: async (_inPage: unknown, call: { path: string; requestBody: Readonly<Record<string, unknown>> }) => {
      if (!options.portal) throw new Error("The E.SUN portal was called without an attached product.");
      return pageReply(options.portal(call.path, call.requestBody));
    },
  };
  return page as unknown as Page;
}

/** What the signed-in page hands back for a reply the portal fake describes. */
function pageReply(reply: EsunPortalReply | EsunPortalPageReply): EsunPortalPageReply {
  if (reply.kind === "json")
    return { kind: "body", httpStatus: reply.httpStatus, base64: Buffer.from(reply.text, "utf8").toString("base64"), date: reply.date };
  if (reply.kind === "non-json")
    return { kind: "body", httpStatus: reply.httpStatus, base64: Buffer.from("<html></html>", "utf8").toString("base64"), date: null };
  return reply;
}

/** Runs E.SUN as the executor does: the Product collection run bound to ESUN_SOURCE and this input. */
export function runEsun(context: WorkflowContextWith<"financialCommit", "previewWrite">, input: unknown) {
  return runVerifiedEntry(ESUN_SOURCE, esunCreditCardWorkflow, withBoundProducts(context, ESUN_SOURCE, input), input);
}

