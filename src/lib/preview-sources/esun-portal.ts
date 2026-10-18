import type { Page } from "playwright";

export const ESUN_PORTAL_HOST = "ebank.esunbank.com.tw";

/**
 * One `/esb/` portal reply. `text` is the raw body, so amounts can be read as
 * source lexemes; `date` is the HTTP `Date` header when the page can read it.
 */
export type EsunPortalReply =
  | Readonly<{ kind: "json"; httpStatus: number; text: string; date: string | null }>
  | Readonly<{ kind: "non-json"; httpStatus: number }>
  | Readonly<{ kind: "network-error" }>
  | Readonly<{ kind: "portal-session-missing" }>;

export type EsunPortalTransport = (
  path: string,
  requestBody: Readonly<Record<string, unknown>>,
  resetFlow: boolean,
) => Promise<EsunPortalReply>;

type PortalState = { uuid?: string; txnFlowToken?: string };

/**
 * Runs inside the signed-in page. The portal threads `txnFlowToken` through a
 * task flow, and `home/init` starts a new flow with an empty token.
 */
async function postPortalInPage(
  input: Readonly<{ path: string; requestBody: Readonly<Record<string, unknown>>; resetFlow: boolean }>,
): Promise<EsunPortalReply> {
  const state = (window as Window & { mibApiService?: PortalState }).mibApiService;
  if (!state?.uuid) return { kind: "portal-session-missing" };
  if (input.resetFlow) state.txnFlowToken = "";
  const txnTime = new Date(Date.now() + 8 * 3_600_000).toISOString().replace("T", " ").slice(0, 19);
  let response: Response;
  try {
    response = await fetch(`/esb/${input.path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", uniqueKey: state.uuid },
      body: JSON.stringify({
        header: { txnTime, txnFlowToken: input.resetFlow ? "" : state.txnFlowToken ?? "" },
        requestBody: input.requestBody,
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return { kind: "network-error" };
  }
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: "non-json", httpStatus: response.status };
  }
  const flowToken = (json as { txnFlowToken?: unknown } | null)?.txnFlowToken;
  if (typeof flowToken === "string" && flowToken) state.txnFlowToken = flowToken;
  return { kind: "json", httpStatus: response.status, text, date: response.headers.get("date") };
}

export async function waitForEsunPortalSession(page: Page, timeout = 30_000): Promise<void> {
  await page.waitForFunction(
    () => Boolean((window as Window & { mibApiService?: PortalState }).mibApiService?.uuid),
    undefined,
    { timeout },
  ).catch(() => undefined);
}

/** Posts to the `/esb/` portal from the signed-in page, so the page's own session and cookies apply. */
export function createEsunPortalTransport(page: Page, signal: AbortSignal): EsunPortalTransport {
  return async (path, requestBody, resetFlow) => {
    signal.throwIfAborted();
    if (new URL(page.url()).hostname !== ESUN_PORTAL_HOST) return { kind: "portal-session-missing" };
    return await page.evaluate(postPortalInPage, { path, requestBody, resetFlow });
  };
}
