import type { Page, Response } from "playwright";
import {
  cathayResponseMetadata,
  decodeCathayApiSourceResponse,
  fetchCathayApiSourceText,
  functionSeqNo,
  type CathaySession,
  type CathayStrictSourceOptions,
} from "./cathay-statements.ts";
import {
  CATHAY_CURRENT_DEPOSIT_HOST,
  CATHAY_CURRENT_DOMESTIC_ENDPOINT_PATH,
  CATHAY_CURRENT_DOMESTIC_UI_PATH,
} from "./cathay-current-deposit-balances.ts";
import type {
  CathayAttachedPreviewPort,
  CathayLoanOverview,
  CathayLoanRow,
  CathayPreviewResponse,
} from "./cathay-attached-preview.ts";

const ORIGIN = `https://${CATHAY_CURRENT_DEPOSIT_HOST}`;
const CARD_OVERVIEW_URL = `${ORIGIN}/OnlineBanking/CQuery/C0101_BillOverview`;
const LOAN_OVERVIEW_URL = `${ORIGIN}/OnlineBanking/LoanInq/L0101_LoanInq`;
const CARD_API_PATH = "/OnlineBankingApi/ClientCard/Api/ClientCard/";
const TIMEOUT_MS = 60_000;
const LATEST_BILL_TIMEOUT_MS = 15_000;
const LOAN_SETTLE_TIMEOUT_MS = 15_000;

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

function isPost(response: Response, matches: (path: string) => boolean): boolean {
  try {
    const url = new URL(response.url());
    return url.hostname === CATHAY_CURRENT_DEPOSIT_HOST && matches(url.pathname)
      && response.request().method().toUpperCase() === "POST";
  } catch {
    return false;
  }
}

async function captured(response: Response, source: CathayStrictSourceOptions): Promise<CathayPreviewResponse> {
  const metadata = await cathayResponseMetadata(response);
  const endpoint = new URL(metadata.url).pathname;
  const text = decodeCathayApiSourceResponse(metadata, endpoint, await response.body(), source.text);
  const date = Object.entries(metadata.headers).find(([name]) => name.toLowerCase() === "date")?.[1] ?? null;
  return { endpoint, status: metadata.status, text, date };
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
  source: CathayStrictSourceOptions,
): CathayAttachedPreviewPort {
  return {
    async cardOverview() {
      const status = page.waitForResponse((response) => isPost(response, (path) => path.endsWith("/C_COM_Q_CardStatus")), { timeout: TIMEOUT_MS });
      const latest = page.waitForResponse((response) => isPost(response, (path) => path.endsWith("/C_CardInfo_Q_LatestBill")), { timeout: LATEST_BILL_TIMEOUT_MS })
        .catch(() => null);
      status.catch(() => undefined);
      await page.goto(CARD_OVERVIEW_URL, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
      const cardStatus = await captured(await status, source);
      const latestResponse = await latest;
      await page.waitForFunction(
        () => /卡片末四碼[：:]\s*\d{4}|立即(?:線上)?辦卡/u.test(document.body?.innerText ?? ""),
        undefined,
        { timeout: LATEST_BILL_TIMEOUT_MS },
      ).catch(() => undefined);
      return {
        cardStatus,
        latestBill: latestResponse ? await captured(latestResponse, source) : null,
        text: await page.evaluate(() => document.body?.innerText ?? ""),
      };
    },
    async cardApi(endpoint, content = {}) {
      const path = `${CARD_API_PATH}${endpoint}`;
      const current = session();
      const text = await fetchCathayApiSourceText(page, path, current.jwtToken, {
        functionSeqNo: functionSeqNo(),
        content: { customerId: current.customerId, ...content },
      }, source);
      return { endpoint: path, status: 200, text, date: null };
    },
    async domesticOverview() {
      const response = page.waitForResponse((candidate) => isPost(candidate, (path) => path === CATHAY_CURRENT_DOMESTIC_ENDPOINT_PATH), { timeout: TIMEOUT_MS });
      response.catch(() => undefined);
      await page.goto(`${ORIGIN}${CATHAY_CURRENT_DOMESTIC_UI_PATH}`, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
      return await captured(await response, source);
    },
    async loanOverview() {
      const response = await page.goto(LOAN_OVERVIEW_URL, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
      await page.waitForFunction(loanOverviewSettled, undefined, { timeout: LOAN_SETTLE_TIMEOUT_MS }).catch(() => undefined);
      const date = response ? (await response.allHeaders())["date"] ?? null : null;
      return { ...await page.evaluate(extractLoanOverview), date };
    },
  };
}
