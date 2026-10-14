import type { Page } from "playwright";
import type { PortalReply, PortalTransport } from "./probe.ts";
import { safeRequestPath } from "./report.ts";

export const PORTAL_HOST = "ebank.esunbank.com.tw";
const MAX_OBSERVED_REQUESTS = 80;

type PortalState = { uuid?: string; txnFlowToken?: string };

/** Runs inside the page: the portal SPA keeps its session key and flow token on `window.mibApiService`. */
async function postPortalInPage(
  input: Readonly<{ path: string; requestBody: Readonly<Record<string, unknown>>; resetFlow: boolean }>,
): Promise<PortalReply> {
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
  let json: unknown;
  try {
    json = JSON.parse(await response.text());
  } catch {
    return { kind: "non-json", httpStatus: response.status };
  }
  const flowToken = (json as { txnFlowToken?: unknown } | null)?.txnFlowToken;
  if (typeof flowToken === "string" && flowToken) state.txnFlowToken = flowToken;
  return { kind: "json", httpStatus: response.status, json };
}

export async function waitForPortalSession(page: Page, timeout = 30_000) {
  await page.waitForFunction(
    () => Boolean((window as Window & { mibApiService?: PortalState }).mibApiService?.uuid),
    undefined,
    { timeout },
  ).catch(() => undefined);
}

export function createPageTransport(page: Page, signal: AbortSignal): PortalTransport {
  return async (path, requestBody, resetFlow) => {
    signal.throwIfAborted();
    if (new URL(page.url()).hostname !== PORTAL_HOST) return { kind: "portal-session-missing" };
    return await page.evaluate(postPortalInPage, { path, requestBody, resetFlow });
  };
}

/** Records `METHOD path status` for the portal's own XHR and fetch calls; never query strings or bodies. */
export function observePortalRequests(page: Page) {
  const seen = new Set<string>();
  page.on("response", (response) => {
    const request = response.request();
    if (request.resourceType() !== "xhr" && request.resourceType() !== "fetch") return;
    const url = new URL(response.url());
    if (url.hostname !== PORTAL_HOST || seen.size >= MAX_OBSERVED_REQUESTS) return;
    seen.add(`${request.method()} ${safeRequestPath(url.pathname)} ${response.status()}`);
  });
  return () => [...seen].sort();
}
