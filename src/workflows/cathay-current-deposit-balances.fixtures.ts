import type { Page, Response } from "playwright";
import {
  CATHAY_CURRENT_DEPOSIT_HOST,
  CATHAY_CURRENT_DOMESTIC_ENDPOINT_PATH,
  CATHAY_CURRENT_FOREIGN_ENDPOINT_PATH,
  type CathayCurrentDepositKind,
  type CathayCurrentDepositResponse,
} from "./cathay-current-deposit-balances.ts";
import { fakeProviderReply } from "./provider-response-reader.fixtures.ts";

/** A recorded Cathay overview response: the body as the provider sent it. */
export type CathayRecordedOverview = Readonly<{
  body: string;
  /** The HTTP Date header; within five minutes of the body's systemTime. */
  date: string;
  /** Domestic only: the twelve-digit account buttons the overview page renders. */
  uiAccounts?: readonly string[];
  /** How many overview POSTs one click triggers; the reader accepts only one. */
  posts?: number;
}>;

/**
 * Amounts are JSON number literals written as the provider writes them, such
 * as `1000.00`, so the parser's lexeme evidence keeps their scale.
 */
export function cathayDomesticOverviewBody(
  systemTime: string,
  rows: readonly Readonly<{ ui: string; ledger: string; available: string }>[],
): string {
  const datas = rows.map((row) =>
    `{"accountType":"DemandDeposit","accountNo":"0000${row.ui}","accountName":"synthetic","accountNickName":"synthetic","accountBalance":${row.ledger},"avaliableBalance":${row.available},"datas":[]}`);
  return `{"success":true,"systemTime":"${systemTime}","content":{"depositData":{"queryStatus":"Success","datas":[${datas.join(",")}]},"timeDepositData":[]}}`;
}

export function cathayForeignOverviewBody(
  systemTime: string,
  rows: readonly Readonly<{ number: string; details: readonly Readonly<{ currency: string; balance: string }>[] }>[],
): string {
  const demand = rows.map((row) => {
    const details = row.details.map((detail) =>
      `{"currencyId":"${detail.currency}","currencyCode":"${detail.currency}","currency":"${detail.currency}","balance":${detail.balance},"equalTwdBalance":0,"dueDate":null}`);
    return `{"account":"${row.number}","nickName":"synthetic","demandType":"DemandDeposit","status":"Normal","details":[${details.join(",")}]}`;
  });
  return `{"success":true,"systemTime":"${systemTime}","content":{"isGetDemandAccountSuccess":true,"demandAccounts":[${demand.join(",")}],"depositAccounts":[]}}`;
}

/** What the page reader returns for a recorded overview. */
export function cathayOverviewAcquired(
  kind: CathayCurrentDepositKind,
  overview: CathayRecordedOverview,
): CathayCurrentDepositResponse {
  const path = kind === "domestic" ? CATHAY_CURRENT_DOMESTIC_ENDPOINT_PATH : CATHAY_CURRENT_FOREIGN_ENDPOINT_PATH;
  return {
    evidence: { kind: "json", bytes: new TextEncoder().encode(overview.body) },
    response: {
      url: `https://${CATHAY_CURRENT_DEPOSIT_HOST}${path}`,
      status: 200,
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", date: overview.date },
    },
    ...(overview.uiAccounts ? { uiAccountNumbers: overview.uiAccounts } : {}),
  };
}

function recordedResponse(path: string, overview: CathayRecordedOverview): Response {
  return fakeProviderReply({
    url: `https://${CATHAY_CURRENT_DEPOSIT_HOST}${path}`,
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8", date: overview.date },
    body: overview.body,
  });
}

/**
 * Cathay's signed-in page with its 臺幣/外幣 menus. Clicking an overview entry
 * delivers that overview's recorded response to the page's listeners, as the
 * provider's own POST would.
 */
export function cathayOverviewPage(
  base: object,
  overviews: Readonly<{ domestic?: CathayRecordedOverview; foreign?: CathayRecordedOverview }>,
): Page {
  const listeners = new Set<(response: Response) => void>();
  const deliver = (response: Response) => {
    for (const listener of [...listeners]) listener(response);
  };
  const overviewFor: Record<string, () => CathayRecordedOverview & Readonly<{ path: string }>> = {
    臺幣帳戶總覽: () => {
      if (!overviews.domestic) throw new Error("No recorded Cathay domestic overview.");
      return { ...overviews.domestic, path: CATHAY_CURRENT_DOMESTIC_ENDPOINT_PATH };
    },
    外幣帳戶總覽: () => {
      if (!overviews.foreign) throw new Error("No recorded Cathay foreign overview.");
      return { ...overviews.foreign, path: CATHAY_CURRENT_FOREIGN_ENDPOINT_PATH };
    },
  };
  const controls = ["臺幣", "外幣", ...Object.keys(overviewFor)];
  const control = (label: string) => ({
    isVisible: async () => true,
    click: async () => {
      const overview = overviewFor[label]?.();
      if (!overview) return;
      for (let post = 0; post < (overview.posts ?? 1); post += 1)
        deliver(recordedResponse(overview.path, overview));
    },
  });
  const uiButtons = overviews.domestic?.uiAccounts ?? [];
  return {
    ...base,
    frames: () => [],
    waitForTimeout: async () => undefined,
    on: (event: string, listener: (response: Response) => void) => {
      if (event === "response") listeners.add(listener);
    },
    off: (event: string, listener: (response: Response) => void) => {
      if (event === "response") listeners.delete(listener);
    },
    waitForResponse: (predicate: (response: Response) => boolean) =>
      new Promise<Response>((resolve) => {
        const listener = (response: Response) => {
          if (!predicate(response)) return;
          listeners.delete(listener);
          resolve(response);
        };
        listeners.add(listener);
      }),
    locator: (selector: string) => {
      if (selector === "table button") {
        return {
          count: async () => uiButtons.length,
          nth: (index: number) => ({ innerText: async () => uiButtons[index]! }),
        };
      }
      return {
        filter: ({ hasText }: { hasText: RegExp }) => {
          const found = controls.filter((label) => hasText.test(label));
          return { count: async () => found.length, nth: (index: number) => control(found[index]!) };
        },
      };
    },
  } as unknown as Page;
}
