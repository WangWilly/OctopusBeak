import type { Page } from "playwright";
import {
  CATHAY_API_HOST,
  cathayApiResponse,
  fetchCathayApiSourceText,
  functionSeqNo,
  type CathayApiResponseDeclaration,
  type CathaySession,
} from "./cathay-statements.ts";
import type { PreviewProductHandle } from "../lib/preview-sources/product-collection.ts";
import { CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS } from "../ledger/canonical/current-deposit-route-contracts.ts";
import { CATHAY_CURRENT_DOMESTIC_UI_PATH } from "./cathay-current-deposit-balances.ts";
import {
  CATHAY_CARD_ENDPOINTS,
  type CathayAttachedPreviewPort,
  type CathayLoanOverview,
  type CathayLoanRow,
  type CathayPreviewResponse,
} from "./cathay-attached-preview.ts";
import { frameScope } from "./frame-scope.ts";
import type { AcceptedProviderResponse, ProviderResponseDeclaration } from "./provider-response.ts";
import type { ProviderBodyAcquisition } from "./provider-response-reader.ts";

const ORIGIN = `https://${CATHAY_API_HOST}`;
const CARD_OVERVIEW_URL = `${ORIGIN}/OnlineBanking/CQuery/C0101_BillOverview`;
const LOAN_OVERVIEW_URL = `${ORIGIN}/OnlineBanking/LoanInq/L0101_LoanInq`;
const CARD_API_PATH = "/OnlineBankingApi/ClientCard/Api/ClientCard/";
const TIMEOUT_MS = 60_000;
const LATEST_BILL_TIMEOUT_MS = 15_000;
const LOAN_SETTLE_TIMEOUT_MS = 15_000;

/** The card bills the collectors POST to themselves. */
const CATHAY_CARD_RESPONSE = cathayApiResponse(
  "Cathay credit card",
  Object.values(CATHAY_CARD_ENDPOINTS).map((endpoint) => `${CARD_API_PATH}${endpoint}`),
);

/** The NT-dollar account overview's own request, whose query string Cathay has never constrained. */
const CATHAY_DOMESTIC_OVERVIEW_RESPONSE = cathayApiResponse(
  "Cathay domestic overview",
  [CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS["cathay/domestic-deposit/current-balance-v1"].endpointPath],
  /^.*$/su,
);

/** The loan overview page, whose HTTP Date is when its balances were shown. */
const CATHAY_LOAN_OVERVIEW_RESPONSE: ProviderResponseDeclaration<"optional"> = {
  label: "Cathay loan overview",
  host: CATHAY_API_HOST,
  endpoints: [{ path: new URL(LOAN_OVERVIEW_URL).pathname, method: "GET", search: /^.*$/su }],
  cacheControl: [],
  providerDate: "optional",
};

/**
 * The card overview's own card-status and latest-bill responses. Only their
 * endpoint names are known, not their full paths, so each path is matched
 * by its suffix, as all-set-tw matches them.
 */
const CATHAY_CARD_STATUS_RESPONSE = cathayApiResponse("Cathay card overview", [/\/C_COM_Q_CardStatus$/u], /^.*$/su);
const CATHAY_LATEST_BILL_RESPONSE = cathayApiResponse("Cathay card overview", [/\/C_CardInfo_Q_LatestBill$/u], /^.*$/su);

/** The overview has settled once it lists a loan or says it holds none. */
function loanOverviewSettled(): boolean {
  const body = document.body?.innerText ?? "";
  return body.includes("貸款帳戶總覽") && (/目前無貸款資料/u.test(body) || /貸款帳號/u.test(body));
}

/**
 * Reads the L0101 overview in the page, in the two layouts all-set-tw documents: a table whose
 * header cells stack `貸款類別`/`貸款帳號`, `利率`, `本期應繳金額`/`扣款日`, `貸款餘額`/`期數`, and a
 * list per loan whose items pair a label with its value. Only text is returned; parsing is the collector's.
 */
function extractLoanOverview(): Omit<CathayLoanOverview, "date"> {
  const clean = (value: string | null | undefined) => value?.replace(/\s+/gu, " ").trim() || null;
  const lines = (document.body?.innerText ?? "").split("\n").map((line) => line.trim());
  const lineValue = (label: string) => {
    const line = lines.find((candidate) => candidate.startsWith(label));
    return line === undefined ? null : clean(line.slice(label.length).replace(/^[：:]/u, ""));
  };
  const headings = [...document.querySelectorAll("h1, h2, h3, h4, h5, h6, [role='heading']")];
  const sectionOf = (element: Element) =>
    clean(headings.filter((heading) => heading.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING).at(-1)?.textContent);
  const accountOf = (scope: Element) => {
    const anchor = scope.querySelector("a[href*='account=']");
    if (!anchor) return null;
    return clean(new URL(anchor.getAttribute("href") ?? "", location.href).searchParams.get("account")) ?? clean(anchor.textContent);
  };
  const paragraphs = (cell: Element | undefined) => cell ? [...cell.querySelectorAll("p")].map((p) => clean(p.textContent)) : [];
  const rows: CathayLoanRow[] = [];
  for (const table of document.querySelectorAll("table")) {
    const headers = [...table.querySelectorAll("thead th")].map((th) => clean(th.textContent) ?? "");
    const column = (label: string) => headers.findIndex((header) => header.includes(label));
    const [account, rate, payment, balance] = [column("貸款帳號"), column("利率"), column("本期應繳金額"), column("貸款餘額")];
    if (account < 0 || payment < 0 || balance < 0) continue;
    for (const tr of table.querySelectorAll("tbody tr")) {
      const cells = [...tr.children].filter((cell) => cell.tagName === "TD");
      if (cells.length !== headers.length) continue;
      const [paymentAmount = null, paymentDue = null] = paragraphs(cells[payment]);
      const [balanceAmount = null, ...rest] = paragraphs(cells[balance]);
      rows.push({
        section: sectionOf(table),
        category: null,
        accountNumber: accountOf(cells[account]!) ?? null,
        interestRate: rate < 0 ? null : paragraphs(cells[rate])[0] ?? null,
        paymentAmount,
        paymentDue,
        balance: balanceAmount,
        installments: rest.find((value) => value?.includes("期")) ?? null,
      });
    }
  }
  if (rows.length === 0) {
    for (const list of document.querySelectorAll("ul")) {
      const values = new Map<string, string | null>();
      for (const item of list.querySelectorAll(":scope > li")) {
        const groups = [...item.children];
        if (groups.length < 2) continue;
        const labels = [...groups[0]!.querySelectorAll("*")].filter((element) => element.children.length === 0).map((element) => clean(element.textContent));
        const shown = paragraphs(groups.at(-1));
        labels.forEach((label, index) => { if (label) values.set(label, shown[index] ?? null); });
      }
      const accountNumber = values.get("貸款帳號") ?? accountOf(list);
      if (accountNumber === null || !(values.has("貸款餘額") || values.has("本期應繳金額"))) continue;
      rows.push({
        section: sectionOf(list),
        category: values.get("貸款類別") ?? null,
        accountNumber,
        interestRate: values.get("利率") ?? null,
        paymentAmount: values.get("本期應繳金額") ?? null,
        paymentDue: values.get("扣款日") ?? null,
        balance: values.get("貸款餘額") ?? null,
        installments: values.get("期數") ?? null,
      });
    }
  }
  return {
    recognized: headings.some((heading) => heading.textContent?.includes("貸款帳戶總覽")),
    noLoanMessage: lines.some((line) => line.includes("目前無貸款資料")),
    currency: lineValue("幣別"),
    totalBalance: lineValue("貸款總餘額"),
    rows,
  };
}

function previewResponse(
  accepted: AcceptedProviderResponse<ProviderBodyAcquisition<"json">, "optional">,
): CathayPreviewResponse {
  return {
    endpoint: accepted.response.url.pathname,
    status: 200,
    text: accepted.evidence.text,
    date: accepted.response.providerDate?.raw ?? null,
  };
}

/**
 * The attached collectors' view of the signed-in Cathay page. Card bills go
 * through the same JWT POST and strict response check as the verified
 * statements; the card overview and the account overview are read from the
 * page's own requests, because their request bodies are not documented.
 */
export function playwrightCathayAttachedPreviewPort(
  page: Page,
  session: () => CathaySession,
  product: PreviewProductHandle,
): CathayAttachedPreviewPort {
  const scope = frameScope(page, product.signal);
  const { reader } = product;
  // An optional wait that times out or fails leaves the read to decide; a cancellation still stops it.
  const unlessCancelled = () => product.signal.throwIfAborted();
  const open = (url: string) =>
    scope.withSignal((signal) => page.goto(url, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS, signal }));
  const settled = (settles: () => boolean, timeout: number) =>
    scope.withSignal((signal) => page.waitForFunction(settles, undefined, { timeout, signal }))
      .then(() => undefined, unlessCancelled);

  return {
    async cardOverview() {
      // Both waits are armed before the navigation that sends both requests.
      const latest = reader.watch(scope, CATHAY_LATEST_BILL_RESPONSE, {
        evidence: "json",
        timeoutMs: LATEST_BILL_TIMEOUT_MS,
      });
      const cardStatus = previewResponse(await reader.capture(scope, CATHAY_CARD_STATUS_RESPONSE, {
        evidence: "json",
        trigger: async () => {
          await open(CARD_OVERVIEW_URL);
        },
        timeoutMs: TIMEOUT_MS,
      }));
      // The watch's own timeout ends the wait LATEST_BILL_TIMEOUT_MS after it was armed; the grace never outlasts it.
      const latestBill = await latest.settle(LATEST_BILL_TIMEOUT_MS);
      await settled(
        () => /卡片末四碼[：:]\s*\d{4}|立即(?:線上)?辦卡/u.test(document.body?.innerText ?? ""),
        LATEST_BILL_TIMEOUT_MS,
      );
      return {
        cardStatus,
        latestBill: latestBill
          ? previewResponse(await reader.accept(CATHAY_LATEST_BILL_RESPONSE, latestBill))
          : null,
        text: await scope.race(page.evaluate(() => document.body?.innerText ?? "")),
      };
    },
    async cardApi(endpoint, content = {}) {
      const path = `${CARD_API_PATH}${endpoint}`;
      const current = session();
      const text = await fetchCathayApiSourceText(page, CATHAY_CARD_RESPONSE, path, current.jwtToken, {
        functionSeqNo: functionSeqNo(),
        content: { customerId: current.customerId, ...content },
      }, product);
      return { endpoint: path, status: 200, text, date: null };
    },
    async domesticOverview() {
      return previewResponse(await reader.capture(scope, CATHAY_DOMESTIC_OVERVIEW_RESPONSE, {
        evidence: "json",
        trigger: async () => {
          await open(`${ORIGIN}${CATHAY_CURRENT_DOMESTIC_UI_PATH}`);
        },
        timeoutMs: TIMEOUT_MS,
      }));
    },
    async loanOverview() {
      const { response } = await reader.witness(scope, CATHAY_LOAN_OVERVIEW_RESPONSE, {
        trigger: async () => {
          await open(LOAN_OVERVIEW_URL);
        },
        timeoutMs: TIMEOUT_MS,
      });
      await settled(loanOverviewSettled, LOAN_SETTLE_TIMEOUT_MS);
      // The rows are read from the rendered page, which is the evidence the response's Date dates.
      const html = await scope.race(page.content());
      const accepted = await reader.accept(CATHAY_LOAN_OVERVIEW_RESPONSE, { response, evidence: { kind: "html", html } });
      return { ...await scope.race(page.evaluate(extractLoanOverview)), date: accepted.response.providerDate?.raw ?? null };
    },
  };
}
