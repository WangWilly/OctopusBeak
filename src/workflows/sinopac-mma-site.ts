import type { Page } from "playwright";
import type { SourceTextPort } from "../lib/automation/source-text.ts";
import { fail } from "../lib/preview-sources/source-kit.ts";
import type { ProviderResponse } from "./current-state-snapshot-capture.ts";
import { frameScope, type BrowserScope, type FrameScope } from "./frame-scope.ts";

export const SINOPAC_MMA_ORIGIN = "https://mma.sinopac.com";
const ROUTE_TIMEOUT_MS = 60_000;
/** The headers MMA's own pages send with their form-encoded web-service POSTs. */
const MMA_FORM_HEADERS: Readonly<Record<string, string>> = {
  Accept: "application/json, text/javascript, */*; q=0.01",
  "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
  "X-Requested-With": "XMLHttpRequest",
};

/** One deposit page on the MMA site and the web-service response its load requests. */
export type SinopacMmaRoute = Readonly<{
  url: string;
  description: string;
  /** Whether a response is the one the page requests as it loads; the site waits for it from before navigating. */
  response(url: string, method: string): boolean;
  /** Whether this scope shows the page. A route without one is ready once its response arrives. */
  ready?(scope: BrowserScope): Promise<boolean>;
}>;

/** The response a route's page requested, with its raw body. */
export type SinopacMmaPageResponse = Readonly<{ response: ProviderResponse; bytes: Uint8Array }>;

/** A POST's body and headers; without headers it is sent as MMA's form-encoded XHR. */
export type SinopacMmaPostInit = Readonly<{
  body?: string;
  headers?: Readonly<Record<string, string>>;
  referrer?: string;
  /** Checks the reply's URL, status and content type before its body is decoded; throws to refuse it. */
  accept?(reply: Readonly<{ url: string; status: number; contentType: string }>): void;
}>;

/** A POST's reply, its body decoded strictly as UTF-8. */
export type SinopacMmaReply = Readonly<{
  url: string;
  status: number;
  contentType: string;
  date: string | null;
  text: string;
}>;

/**
 * The signed-in SinoPac MMA site (ADR 0104): one frame scope shared by every
 * SinoPac read, the deposit pages as routes, and one same-origin POST.
 */
export type SinopacMmaSite = Readonly<{
  frames: FrameScope;
  /** Open a deposit page from any signed-in page and return the response its load requested. */
  open(route: SinopacMmaRoute): Promise<SinopacMmaPageResponse>;
  /** POST from inside the signed-in MMA page and decode the reply strictly as UTF-8. */
  post(path: string, init?: SinopacMmaPostInit): Promise<SinopacMmaReply>;
}>;

type SiteContext = Readonly<{ signal: AbortSignal; text: SourceTextPort }>;

const originOf = (href: string): string | null => {
  try {
    return new URL(href).origin;
  } catch {
    return null;
  }
};

export function sinopacMmaSite(page: Page, context: SiteContext): SinopacMmaSite {
  const frames = frameScope(page, context.signal);

  const showing = (ready: NonNullable<SinopacMmaRoute["ready"]>, description: string) =>
    frames.until(async () => {
      for (const scope of frames.scopes()) {
        if (await ready(scope)) return scope;
      }
      return null;
    }, `Could not find ${description} in any frame.`, { timeoutMs: ROUTE_TIMEOUT_MS });

  const site: SinopacMmaSite = {
    frames,
    open: async (route) => {
      // MMA answers no-store, so the body is read as soon as the response arrives, before the page settles.
      const responded = frames.withSignal(async (signal): Promise<SinopacMmaPageResponse> => {
        const response = await page.waitForResponse(
          (candidate) => route.response(candidate.url(), candidate.request().method()),
          { timeout: ROUTE_TIMEOUT_MS, signal },
        );
        const [bytes, headers] = await Promise.all([response.body(), response.allHeaders()]);
        return {
          bytes,
          response: { url: response.url(), status: response.status(), method: response.request().method(), headers },
        };
      });
      void responded.catch(() => undefined);
      await frames.withSignal((signal) =>
        page.goto(route.url, { waitUntil: "domcontentloaded", timeout: ROUTE_TIMEOUT_MS, signal }));
      await frames.settle();
      if (route.ready) await showing(route.ready, route.description);
      return await responded;
    },
    post: async (path, init = {}) => {
      context.signal.throwIfAborted();
      if (originOf(page.url()) !== SINOPAC_MMA_ORIGIN) fail("unexpected-response", "the signed-in page is not on the MMA origin");
      const reply = await frames.race(page.evaluate(async ({ url, init }) => {
        const response = await fetch(url, { method: "POST", credentials: "same-origin", ...init });
        const bytes = new Uint8Array(await response.arrayBuffer());
        let binary = "";
        for (let index = 0; index < bytes.length; index += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
        }
        return {
          url: response.url,
          status: response.status,
          contentType: response.headers.get("content-type") ?? "",
          date: response.headers.get("date"),
          base64: btoa(binary),
        };
      }, {
        url: `${SINOPAC_MMA_ORIGIN}${path}`,
        init: {
          headers: { ...(init.headers ?? MMA_FORM_HEADERS) },
          body: init.body ?? "",
          ...(init.referrer === undefined ? {} : { referrer: init.referrer }),
        },
      }));
      init.accept?.({ url: reply.url, status: reply.status, contentType: reply.contentType });
      const text = context.text.decode(Buffer.from(reply.base64, "base64"), "utf-8");
      context.text.assertIntact(text);
      return { url: reply.url, status: reply.status, contentType: reply.contentType, date: reply.date, text };
    },
  };
  return Object.freeze(site);
}
