import { createHash } from "node:crypto";
import type { Frame, Locator, Page, Response } from "playwright";
import { FailureCodeError } from "../lib/automation/workflow-failures.ts";
import type { SourceTextPort } from "../lib/automation/source-text.ts";
import { frameScope, ifFound, type BrowserScope, type FrameScope } from "./frame-scope.ts";

export const YUANTA_EBANK_ORIGIN = "https://ebank.yuantabank.com.tw";
const YUANTA_CSV_MAX_BYTES = 25 * 1024 * 1024;
/** How long a route may take to render before the site falls back to menuaction(). */
const ROUTE_RENDER_TIMEOUT_MS = 15_000;
const SHELL_TIMEOUT_MS = 5_000;
const MENU_ACTION_TIMEOUT_MS = 10_000;

/** Where one product's page lives on the Yuanta eBank site. */
export type YuantaRoute = Readonly<{
  /** The route under /nib/tx/, with any query the page needs. */
  path: string;
  description: string;
  /** Whether this scope shows the product's page. It may throw a typed absence. */
  ready(scope: BrowserScope): Promise<boolean>;
  /** The provider's menu id, passed to menuaction() when the route does not render the page. */
  menuId?: string;
  /** A route that the signed-in session reaches without a cid. */
  cid?: "required" | "optional";
}>;

export type YuantaDuration =
  | Readonly<{ label: string }>
  | Readonly<{ customLabel: string; startDate: string; endDate: string }>;

export type YuantaCsvDownload = Readonly<{
  content: string;
  byteLength: number;
  contentDigest: `sha256:${string}`;
  contentDisposition: string;
  exportUrl: string;
}>;

/**
 * The signed-in Yuanta eBank site (ADR 0066): an fmenu/fmain frameset whose
 * pages are server-rendered routes bound to the session's cid.
 */
export type YuantaEbankSite = Readonly<{
  frames: FrameScope;
  cid(): Promise<string | null>;
  /** Open a product's page from any signed-in page and return the scope that shows it. */
  open(route: YuantaRoute): Promise<BrowserScope>;
  menuAction(path: string, menuId: string, timeoutMs?: number): Promise<void>;
  chooseDuration(scope: BrowserScope, duration: YuantaDuration): Promise<void>;
  /** Decode an HTML response strictly as UTF-8. */
  readHtml(response: Response): Promise<string>;
  /** Fetch a CSV export link's bytes in the page and decode them strictly as Big5. */
  readCsv(link: Locator): Promise<YuantaCsvDownload>;
}>;

type SiteContext = Readonly<{ signal: AbortSignal; text: SourceTextPort }>;

const cidFromUrl = (url: string): string | null => {
  const match = url.match(/[?&]cid=([^&]+)/u);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
};

export function yuantaRouteUrl(path: string, cid: string | null): string {
  const url = new URL(`/nib/tx/${path}`, YUANTA_EBANK_ORIGIN);
  if (cid) {
    url.searchParams.set("type", "page");
    url.searchParams.set("cid", cid);
  }
  return url.toString();
}

export function yuantaEbankSite(page: Page, context: SiteContext): YuantaEbankSite {
  const frames = frameScope(page, context.signal);

  const cid = async (): Promise<string | null> => {
    for (const scope of frames.scopes()) {
      const field = scope.locator('input[name="cid"]').first();
      if ((await frames.race(field.count().catch(() => 0))) === 0) continue;
      const value = (await frames.race(field.inputValue().catch(() => ""))).trim();
      if (value) return value;
    }
    for (const frame of page.frames()) {
      const value = cidFromUrl(frame.url());
      if (value) return value;
    }
    return cidFromUrl(page.url());
  };

  const showing = (route: YuantaRoute, timeoutMs?: number) =>
    frames.until(async () => {
      for (const scope of frames.scopes()) {
        if (await route.ready(scope)) return scope;
      }
      return null;
    }, `Could not find ${route.description} in any frame.`, { timeoutMs });

  const menuAction = async (path: string, menuId: string, timeoutMs = MENU_ACTION_TIMEOUT_MS) => {
    const scope = await frames.until(async () => {
      for (const candidate of frames.scopes()) {
        const exposed = await candidate
          .evaluate(() => typeof (window as { menuaction?: unknown }).menuaction === "function")
          .catch(() => false);
        if (exposed) return candidate;
      }
      return null;
    }, "Could not find YuanTa menuaction() in any frame.", { timeoutMs });
    await frames.race(scope.evaluate(({ action, id }) => {
      const menuaction = (window as { menuaction?: (action: string, id: string, flag: string) => void }).menuaction;
      if (typeof menuaction !== "function") throw new Error("YuanTa page did not expose menuaction().");
      menuaction(action, id, "N");
    }, { action: path, id: menuId }));
  };

  const fmain = async (): Promise<Frame> => {
    const frame = await ifFound(frames.frame("fmain", { timeoutMs: SHELL_TIMEOUT_MS }));
    if (!frame) throw new FailureCodeError("authentication-failed");
    return frame;
  };

  const site: YuantaEbankSite = {
    frames,
    cid,
    open: async (route) => {
      const content = await fmain();
      const sessionCid = await cid();
      if (sessionCid || route.cid === "optional") {
        await frames.race(content.goto(yuantaRouteUrl(route.path, sessionCid), { waitUntil: "domcontentloaded" }));
        await frames.settle(content);
        if (!route.menuId) return await showing(route);
        const rendered = await ifFound(showing(route, ROUTE_RENDER_TIMEOUT_MS));
        if (rendered) return rendered;
      } else if (!route.menuId) {
        throw new FailureCodeError("authentication-failed");
      }
      await menuAction(route.path, route.menuId);
      await frames.settle(content);
      return await showing(route);
    },
    menuAction,
    chooseDuration: async (scope, duration) => {
      const label = "label" in duration ? duration.label : duration.customLabel;
      const link = await frames.firstVisible(
        (candidate) => candidate.locator("#duration a").filter({ hasText: label }),
        `YuanTa date range link "${label}"`,
        { in: scope },
      );
      await frames.race(link.click({ force: true }));
      if ("customLabel" in duration) {
        await frames.race(scope.locator("#sdate").fill(duration.startDate));
        await frames.race(scope.locator("#edate").fill(duration.endDate));
      }
      if (scope !== page) await frames.settle(scope as Frame);
    },
    readHtml: async (response) => context.text.decode(await frames.race(response.body()), "utf-8"),
    readCsv: (link) => readYuantaBig5CsvFromAnchor(link, context.text, context.signal),
  };
  return Object.freeze(site);
}

type BrowserCsvResponse = Readonly<{
  status: number;
  byteLength: number;
  base64: string;
  contentDisposition: string;
  exportUrl: string;
}>;

/** Fetch an export link's CSV bytes inside the signed-in page and decode them strictly as Big5. */
export async function readYuantaBig5CsvFromAnchor(
  exportLink: Locator,
  text: SourceTextPort,
  signal: AbortSignal,
): Promise<YuantaCsvDownload> {
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("Yuanta CSV retrieval was canceled."),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  let response: BrowserCsvResponse;
  try {
    const read = exportLink.evaluate(
      async (element, maxBytes): Promise<BrowserCsvResponse> => {
        const anchor = element as HTMLAnchorElement;
        const href = anchor.getAttribute("href")?.trim();
        const documentUrl = new URL(anchor.ownerDocument.baseURI);
        const pageOrigin = anchor.ownerDocument.location.origin;
        let url: URL;
        let requestBody: URLSearchParams | undefined;
        if (
          /^javascript:void\(0\);?$/iu.test(href ?? "") &&
          /^\s*getDownload\(\s*['"]csv['"]\s*\)\s*;?\s*$/iu.test(anchor.getAttribute("onclick") ?? "")
        ) {
          const foreignForm = anchor.ownerDocument.querySelector('form[name="mform"]') as HTMLFormElement | null;
          const isForeignExport = foreignForm !== null &&
            /\/fxtransactiondetails$/iu.test(new URL(foreignForm.action, documentUrl).pathname);
          const form = isForeignExport
            ? foreignForm
            : anchor.ownerDocument.querySelector('form[name="jform"]') as HTMLFormElement | null;
          if (!form || form.method.toLowerCase() !== "post") {
            throw new Error("Yuanta CSV export form is unavailable.");
          }
          url = new URL(form.action, documentUrl);
          if (!(isForeignExport
            ? /\/fxtransactiondetails$/iu.test(url.pathname)
            : /\/transactiondetails$/iu.test(url.pathname))) {
            throw new Error("Yuanta CSV export form has an unexpected action.");
          }
          if (!isForeignExport) url.searchParams.set("method", "downloadcsv");
          requestBody = new URLSearchParams();
          for (const [name, value] of new FormData(form)) {
            if (typeof value !== "string") {
              throw new Error("Yuanta CSV export form contains a file input.");
            }
            requestBody.append(name, value);
          }
          if (isForeignExport) {
            const transactionType = anchor.ownerDocument.getElementById("txntype") as HTMLInputElement | null;
            if (!transactionType || transactionType.form !== form || !transactionType.name) {
              throw new Error("Yuanta foreign CSV export type is unavailable.");
            }
            requestBody.set(transactionType.name, "downloadcsv");
          }
        } else {
          if (!href || /^(?:javascript|data):/iu.test(href)) {
            throw new Error("Yuanta CSV link has no fetchable URL.");
          }
          url = new URL(href, documentUrl);
        }
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username.length > 0 ||
          url.password.length > 0 ||
          url.origin !== pageOrigin
        ) {
          throw new Error("Yuanta CSV link left the authenticated origin.");
        }

        const fetched = await fetch(url.href, {
          ...(requestBody ? { method: "POST", body: requestBody } : {}),
          mode: "same-origin",
          credentials: "same-origin",
          cache: "no-store",
          redirect: "follow",
        });
        if (new URL(fetched.url).origin !== pageOrigin) {
          throw new Error("Yuanta CSV redirected outside the authenticated origin.");
        }
        if (fetched.status !== 200 || !fetched.ok) {
          throw new Error("Yuanta CSV request did not return a complete response.");
        }
        const contentLength = fetched.headers.get("content-length");
        if (contentLength !== null) {
          if (!/^\d+$/u.test(contentLength)) {
            throw new Error("Yuanta CSV response length is invalid.");
          }
          const declaredLength = Number(contentLength);
          if (!Number.isSafeInteger(declaredLength) || declaredLength > maxBytes) {
            throw new Error("Yuanta CSV exceeded the in-memory size limit.");
          }
        }

        const reader = fetched.body?.getReader();
        if (!reader) throw new Error("Yuanta CSV response body is missing.");
        const chunks: Uint8Array[] = [];
        let byteLength = 0;
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            byteLength += next.value.byteLength;
            if (byteLength > maxBytes) {
              await reader.cancel().catch(() => undefined);
              throw new Error("Yuanta CSV exceeded the in-memory size limit.");
            }
            chunks.push(next.value);
          }
        } finally {
          reader.releaseLock();
        }
        const bytes = new Uint8Array(byteLength);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        let binary = "";
        for (let index = 0; index < bytes.length; index += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
        }
        return {
          status: fetched.status,
          byteLength,
          base64: btoa(binary),
          contentDisposition: fetched.headers.get("content-disposition") ?? "",
          exportUrl: fetched.url,
        };
      },
      YUANTA_CSV_MAX_BYTES,
    );
    response = await Promise.race([read, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
  signal.throwIfAborted();
  const bytes = Buffer.from(response.base64, "base64");
  if (bytes.byteLength !== response.byteLength) {
    throw new Error("Yuanta CSV response was incomplete in memory.");
  }
  return {
    content: text.decode(bytes, "big5"),
    byteLength: bytes.byteLength,
    contentDigest: `sha256:${createHash("sha256").update(bytes).digest("base64url")}`,
    contentDisposition: response.contentDisposition,
    exportUrl: response.exportUrl,
  };
}
