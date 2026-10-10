import type { CDPSession, Page } from "playwright";
import { BrowserRuntimeConfigurationError } from "../lib/automation/server/browser-runtime.ts";
import {
  ProviderProtocolOutdatedError,
  SourceAccessChallengeError,
  SourceUnavailableError,
} from "../lib/automation/source-access.ts";
import {
  decryptLoginData,
  EINVOICE_APP_BIG_HOST,
  EINVOICE_APP_BUILD,
  EINVOICE_APP_MIDDLE_HOST,
  EINVOICE_APP_VERSION,
  encryptLoginData,
  parseLoginSession,
  randomClientCode,
  serverTimeOffset,
  signInvoiceJwt,
  type EInvoiceAppSession,
} from "./einvoice-app-protocol.ts";

// The E-Invoice App hosts sit behind Cloudflare bot protection that admits a
// real browser's TLS but rejects bare HTTP clients. All requests therefore run
// as in-page fetch. The query host additionally rejects any request carrying an
// Origin header (a native App sends none), so Origin and Referer are stripped at
// the CDP network layer before each request is continued.

export type AppInvoiceHeader = Readonly<{
  rowNum?: string;
  invPeriod?: string;
  invNum?: string;
  invoiceTime?: string;
  invStatus?: string;
  cardType?: string;
  cardNo?: string;
  sellerBan?: string;
  sellerName?: string;
  sellerAddress?: string;
  buyerBan?: string;
  invDonatable?: boolean;
  amount?: string;
  currency?: string;
  donateMark?: string;
  npoBan?: string;
  // Observed live: the ROC year ("115"), a 1-based month, the day of the
  // month, and `time` as epoch milliseconds, all as strings.
  invDate?: {
    year?: string;
    month?: string;
    date?: string;
    day?: string;
    hours?: string;
    minutes?: string;
    seconds?: string;
    time?: string;
    timezoneOffset?: string;
  };
}>;

export type AppInvoiceItem = Readonly<{
  rowNum?: string;
  description?: string;
  quantity?: string;
  unitPrice?: string;
  amount?: string;
}>;

export type AppHeaderQuery = {
  code: string;
  msg: string;
  details: readonly AppInvoiceHeader[];
};

export type AppDetailQuery = {
  code: string;
  msg: string;
  details: readonly AppInvoiceItem[];
};

type PausedRequestCdp = Readonly<{
  on(event: "Fetch.requestPaused", handler: (event: any) => Promise<void>): unknown;
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
}>;

/** Continues each paused request without its Origin and Referer headers. */
export function stripOriginOnPausedRequests(cdp: PausedRequestCdp, onRewriteFailed: () => void): void {
  cdp.on("Fetch.requestPaused", async (event) => {
    const headers = Object.entries((event.request.headers ?? {}) as Record<string, string>)
      .filter(([name]) => !["origin", "referer"].includes(name.toLowerCase()))
      .map(([name, value]) => ({ name, value }));
    try {
      await cdp.send("Fetch.continueRequest", { requestId: event.requestId, headers });
    } catch {
      // Continuing with the original headers would send Origin, which the
      // query host rejects; fail the request and report the rewrite instead.
      onRewriteFailed();
      await cdp.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "Aborted" }).catch(() => undefined);
    }
  });
}

/** Strips Origin/Referer from every einvoice request at the network layer. */
export async function installEinvoiceOriginStripping(page: Page, onRewriteFailed: () => void): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Fetch.enable", {
    patterns: [{ urlPattern: "*einvoice*", requestStage: "Request" }],
  });
  stripOriginOnPausedRequests(cdp as unknown as PausedRequestCdp, onRewriteFailed);
  return cdp;
}

// Status 0 stands for a request that never got an HTTP response.
async function inPagePost(
  page: Page,
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; text: string }> {
  return page.evaluate(
    async ({ url, headers, body }) => {
      try {
        const response = await fetch(url, { method: "POST", headers, body });
        return { status: response.status, text: await response.text() };
      } catch (error) {
        return { status: 0, text: String(error) };
      }
    },
    { url, headers, body },
  );
}

const CLOUDFLARE_CHALLENGE = /<title>Just a moment\.\.\.<\/title>|\/cdn-cgi\/challenge-platform\//u;

/** Posts one App request and classifies transport-level failures as typed source errors. */
async function postAppJson(
  page: Page,
  operation: string,
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<Record<string, unknown>> {
  const response = await inPagePost(page, url, headers, body);
  if (response.status === 0 || response.status >= 500) throw new SourceUnavailableError();
  if (response.status === 403 && CLOUDFLARE_CHALLENGE.test(response.text)) throw new SourceAccessChallengeError();
  // The query host's answer to a request that still carries Origin.
  if (response.status === 403 && /Invalid CORS request/u.test(response.text))
    throw new BrowserRuntimeConfigurationError("request-header-rewrite-failed");
  if (response.status !== 200)
    throw new Error(`E-Invoice App ${operation} failed with HTTP ${response.status}.`);
  const parsed = (() => {
    try {
      return JSON.parse(response.text) as unknown;
    } catch {
      return undefined;
    }
  })();
  const record = asRecord(parsed);
  if (!record) throw new ProviderProtocolOutdatedError();
  return record;
}

const EINVOICE_APP_QUERY_SUCCESS_CODE = "200";
// 參數錯誤: the server no longer accepts the request this workflow builds.
const EINVOICE_APP_PARAMETER_REJECTED_CODE = "903";

const jsonHeaders = {
  Accept: "application/json",
  "Content-Type": "application/json; charset=utf-8",
  appver: EINVOICE_APP_VERSION,
  appbn: String(EINVOICE_APP_BUILD),
  platform: "android",
  version: EINVOICE_APP_VERSION,
};

const formHeaders = {
  Accept: "application/json",
  "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
  appver: EINVOICE_APP_VERSION,
  appbn: String(EINVOICE_APP_BUILD),
  platform: "android",
  version: EINVOICE_APP_VERSION,
};

/** Signs in to the App protocol and returns the parsed session. */
export async function loginEinvoiceApp(
  page: Page,
  phone: string,
  password: string,
  deviceId: string,
  signal?: AbortSignal,
): Promise<EInvoiceAppSession> {
  signal?.throwIfAborted();
  const inner = {
    type: 0,
    account: phone,
    password,
    carrier_code: "",
    ckey: randomClientCode(),
    device: {
      os: "a",
      os_version: "15",
      model: "Android",
      pdid: `a:${deviceId}`,
      ptoken: "",
      appver: EINVOICE_APP_VERSION,
      appbn: EINVOICE_APP_BUILD,
      lang: "zh",
      ccs: "tw",
    },
    ts: Math.floor(Date.now() / 1000),
    pdid: `a:${deviceId}`,
  };
  const { ldata, context } = encryptLoginData(inner);
  const body = await postAppJson(
    page,
    "login",
    `${EINVOICE_APP_MIDDLE_HOST}/mid/v1/login`,
    jsonHeaders,
    JSON.stringify({ ldata }),
  );
  // A rejection's meaning (wrong password, locked account, busy server) is not
  // established for any result code, so it stays an untyped sign-in failure.
  if (body.result !== 0)
    throw new Error(
      `E-Invoice App login rejected (result ${String(body.result)}).`,
    );
  // An accepted login whose session cannot be opened means the envelope moved.
  try {
    if (typeof body.payload !== "string") throw new Error("missing payload");
    return parseLoginSession(decryptLoginData(body.payload, context));
  } catch {
    throw new ProviderProtocolOutdatedError();
  }
}

/** Queries one header page. Returns the envelope plus parsed rows. */
export async function queryEinvoiceHeaders(
  page: Page,
  session: EInvoiceAppSession,
  startDate: string,
  endDate: string,
  pageNo: number,
  signal?: AbortSignal,
): Promise<AppHeaderQuery> {
  signal?.throwIfAborted();
  const request = {
    version: "1.0",
    cardType: "3J0002",
    cardNo: session.carrierCode ?? "",
    action: "carrierInvChk",
    startDate,
    endDate,
    onlyWinningInv: "A",
    page: pageNo,
  };
  const jwt = signInvoiceJwt(
    request,
    session,
    Math.floor(Date.now() / 1000) + serverTimeOffset(session) - 10,
  );
  const body = await postAppJson(
    page,
    "header query",
    `${EINVOICE_APP_BIG_HOST}/einvoice/carriers/query-invoices-header`,
    formHeaders,
    new URLSearchParams({ einvoiceJwt: jwt }).toString(),
  );
  // Rejections come back as a top-level envelope without carrierQueryList.
  const carrierQueryList = asRecord(body.carrierQueryList);
  const { code, msg } = requireSuccessEnvelope("header", carrierQueryList ?? body);
  const details = Array.isArray(carrierQueryList?.details)
    ? (carrierQueryList.details as AppInvoiceHeader[])
    : [];
  return { code, msg, details };
}

/** Queries one invoice's line items. */
export async function queryEinvoiceDetail(
  page: Page,
  session: EInvoiceAppSession,
  invNum: string,
  invDate: string,
  signal?: AbortSignal,
): Promise<AppDetailQuery> {
  signal?.throwIfAborted();
  const request = {
    version: "1.0",
    cardType: "3J0002",
    cardNo: session.carrierCode ?? "",
    action: "carrierInvDetail",
    invNum,
    invDate,
  };
  const jwt = signInvoiceJwt(
    request,
    session,
    Math.floor(Date.now() / 1000) + serverTimeOffset(session) - 10,
  );
  const body = await postAppJson(
    page,
    "detail query",
    `${EINVOICE_APP_BIG_HOST}/einvoice/carriers/query-invoices-details`,
    formHeaders,
    new URLSearchParams({ einvoiceJwt: jwt }).toString(),
  );
  const { code, msg } = requireSuccessEnvelope("detail", body);
  const details = Array.isArray(body.details) ? (body.details as AppInvoiceItem[]) : [];
  return { code, msg, details };
}

// An empty `details` only means "no rows" under a success code. Any other
// envelope (session expiry, throttling, a rejected signature) carries no rows
// either, so reading it as data would end paging early or admit an invoice
// with no items.
function requireSuccessEnvelope(
  query: "header" | "detail",
  envelope: Record<string, unknown> | undefined,
): { code: string; msg: string } {
  const code = stringValue(envelope?.code);
  const msg = stringValue(envelope?.msg);
  if (code === EINVOICE_APP_PARAMETER_REJECTED_CODE) throw new ProviderProtocolOutdatedError();
  if (code !== EINVOICE_APP_QUERY_SUCCESS_CODE)
    throw new Error(`E-Invoice App ${query} query rejected (code ${code || "(missing)"}: ${msg}).`);
  return { code, msg };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

/** The App protocol operations, bound to a page by a source's `open`. */
export type EinvoiceAppClient = {
  login(phone: string, password: string, deviceId: string, signal?: AbortSignal): Promise<EInvoiceAppSession>;
  queryHeaders(session: EInvoiceAppSession, startDate: string, endDate: string, pageNo: number, signal?: AbortSignal): Promise<AppHeaderQuery>;
  queryDetail(session: EInvoiceAppSession, invNum: string, invDate: string, signal?: AbortSignal): Promise<AppDetailQuery>;
};

export type EinvoiceAppSource = {
  open(page: Page): Promise<{ client: EinvoiceAppClient; close: () => Promise<void> }>;
};

/** The production source: a real browser that passes Cloudflare and strips Origin. */
export const liveEinvoiceAppSource: EinvoiceAppSource = {
  async open(page: Page) {
    let rewriteFailed = false;
    const cdp = await installEinvoiceOriginStripping(page, () => { rewriteFailed = true; });
    // A request failed by the rewrite surfaces in the page as a network error;
    // report it as the rewrite failure it is.
    const guarded = async <T>(run: () => Promise<T>): Promise<T> => {
      try {
        const result = await run();
        if (rewriteFailed) throw new BrowserRuntimeConfigurationError("request-header-rewrite-failed");
        return result;
      } catch (error) {
        if (rewriteFailed) throw new BrowserRuntimeConfigurationError("request-header-rewrite-failed");
        throw error;
      }
    };
    await page.goto(EINVOICE_APP_MIDDLE_HOST, { waitUntil: "domcontentloaded" }).catch(() => undefined);
    let onBig = false;
    const ensureBig = async () => {
      if (onBig) return;
      await page.goto(EINVOICE_APP_BIG_HOST, { waitUntil: "domcontentloaded" }).catch(() => undefined);
      onBig = true;
    };
    const client: EinvoiceAppClient = {
      login: (phone, password, deviceId, signal) =>
        guarded(() => loginEinvoiceApp(page, phone, password, deviceId, signal)),
      queryHeaders: async (session, startDate, endDate, pageNo, signal) => {
        await ensureBig();
        return guarded(() => queryEinvoiceHeaders(page, session, startDate, endDate, pageNo, signal));
      },
      queryDetail: async (session, invNum, invDate, signal) => {
        await ensureBig();
        return guarded(() => queryEinvoiceDetail(page, session, invNum, invDate, signal));
      },
    };
    return {
      client,
      close: async () => {
        await cdp.detach().catch(() => undefined);
      },
    };
  },
};
