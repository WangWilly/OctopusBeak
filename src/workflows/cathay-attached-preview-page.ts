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
import type { CathayAttachedPreviewPort, CathayPreviewResponse } from "./cathay-attached-preview.ts";

const ORIGIN = `https://${CATHAY_CURRENT_DEPOSIT_HOST}`;
const CARD_OVERVIEW_URL = `${ORIGIN}/OnlineBanking/CQuery/C0101_BillOverview`;
const CARD_API_PATH = "/OnlineBankingApi/ClientCard/Api/ClientCard/";
const TIMEOUT_MS = 60_000;
const LATEST_BILL_TIMEOUT_MS = 15_000;

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
  };
}
