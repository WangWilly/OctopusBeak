import type { Page } from "playwright";
import type { SourceTextPort } from "../automation/source-text.ts";
import { frameScope } from "../../workflows/frame-scope.ts";

export const ESUN_PORTAL_HOST = "ebank.esunbank.com.tw";

/**
 * One `/esb/` portal reply. `text` is the body decoded strictly as UTF-8, so
 * amounts can be read as source lexemes; `date` is the HTTP `Date` header when
 * the page can read it.
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

/** What the signed-in page hands back: the reply's bytes, never its text. */
export type EsunPortalPageReply =
  | Readonly<{ kind: "body"; httpStatus: number; base64: string; date: string | null }>
  | Readonly<{ kind: "network-error" }>
  | Readonly<{ kind: "portal-session-missing" }>;

type PortalState = { uuid?: string; txnFlowToken?: string };

/**
 * Runs inside the signed-in page. The portal threads `txnFlowToken` through a
 * task flow, and `home/init` starts a new flow with an empty token. The page
 * reads the token from a lenient decode of the reply; the reply's data is
 * decoded strictly outside the page.
 */
async function postPortalInPage(
  input: Readonly<{ path: string; requestBody: Readonly<Record<string, unknown>>; resetFlow: boolean }>,
): Promise<EsunPortalPageReply> {
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
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch {
    return { kind: "network-error" };
  }
  // The token is read even from a reply rejected outside the page; that reply fails the run before another post.
  try {
    const flowToken = (JSON.parse(new TextDecoder().decode(bytes)) as { txnFlowToken?: unknown } | null)?.txnFlowToken;
    if (typeof flowToken === "string" && flowToken) state.txnFlowToken = flowToken;
  } catch {
    // A reply that is not JSON carries no token; it is reported outside the page.
  }
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return { kind: "body", httpStatus: response.status, base64: btoa(binary), date: response.headers.get("date") };
}

/** A missing session is left to the transport to report; a cancelled run rejects with its reason. */
export async function waitForEsunPortalSession(page: Page, timeout = 30_000, signal?: AbortSignal): Promise<void> {
  await page.waitForFunction(
    () => Boolean((window as Window & { mibApiService?: PortalState }).mibApiService?.uuid),
    undefined,
    { timeout, signal },
  ).catch(() => signal?.throwIfAborted());
}

/**
 * Posts to the `/esb/` portal from the signed-in page, so the page's own
 * session and cookies apply. A body that does not decode as UTF-8 throws
 * `SourceTextIntegrityError`; one that decodes but is not JSON is `non-json`.
 */
export function createEsunPortalTransport(
  page: Page,
  context: Readonly<{ signal: AbortSignal; text: SourceTextPort }>,
): EsunPortalTransport {
  const frames = frameScope(page, context.signal);
  return async (path, requestBody, resetFlow) => {
    context.signal.throwIfAborted();
    if (new URL(page.url()).hostname !== ESUN_PORTAL_HOST) return { kind: "portal-session-missing" };
    const reply = await frames.race(page.evaluate(postPortalInPage, { path, requestBody, resetFlow }));
    if (reply.kind !== "body") return reply;
    const text = context.text.decode(Buffer.from(reply.base64, "base64"), "utf-8");
    context.text.assertIntact(text);
    try {
      JSON.parse(text);
    } catch {
      return { kind: "non-json", httpStatus: reply.httpStatus };
    }
    return { kind: "json", httpStatus: reply.httpStatus, text, date: reply.date };
  };
}
