import type { Page } from "playwright";
import { fail } from "../lib/preview-sources/source-kit.ts";
import type { ProviderResponse, ProviderResponseDeclaration } from "./provider-response.ts";
import type { ProviderBodyAcquisition, ProviderResponseReader } from "./provider-response-reader.ts";
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
  /** The web-service response the page requests as it loads; the site waits for it from before navigating. */
  response: ProviderResponseDeclaration;
  /** Whether this scope shows the page. A route without one is ready once its response arrives. */
  ready?(scope: BrowserScope): Promise<boolean>;
}>;

/** A response an in-page POST observed, with its raw body, undecoded. */
export type SinopacMmaResponse = Readonly<{ response: ProviderResponse; bytes: Uint8Array }>;

/** A POST's body and headers; without headers it is sent as MMA's form-encoded XHR. */
export type SinopacMmaPostInit = Readonly<{
  body?: string;
  headers?: Readonly<Record<string, string>>;
  referrer?: string;
}>;

/**
 * The signed-in SinoPac MMA site (ADR 0104): one frame scope shared by every
 * SinoPac read, the deposit pages as routes, and one same-origin POST.
 */
export type SinopacMmaSite = Readonly<{
  frames: FrameScope;
  /**
   * Open a deposit page from any signed-in page and return the JSON response
   * its load requested, read through the reader but not yet accepted.
   */
  open(route: SinopacMmaRoute, reader: ProviderResponseReader): Promise<ProviderBodyAcquisition<"json">>;
  /** POST from inside the signed-in MMA page and return the response it observed. */
  post(path: string, init?: SinopacMmaPostInit): Promise<SinopacMmaResponse>;
}>;

type SiteContext = Readonly<{ signal: AbortSignal }>;

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
    open: async (route, reader) => {
      // MMA answers no-store; the reader reads the body as soon as the response arrives, before the page settles.
      const { response, evidence } = await reader.acquire(frames, route.response, {
        evidence: "json",
        timeoutMs: ROUTE_TIMEOUT_MS,
        trigger: async () => {
          await frames.withSignal((signal) =>
            page.goto(route.url, { waitUntil: "domcontentloaded", timeout: ROUTE_TIMEOUT_MS, signal }));
        },
      });
      await frames.settle();
      if (route.ready) await showing(route.ready, route.description);
      return { response, evidence };
    },
    post: async (path, init = {}) => {
      context.signal.throwIfAborted();
      if (originOf(page.url()) !== SINOPAC_MMA_ORIGIN) fail("unexpected-response", "the signed-in page is not on the MMA origin");
      const request = {
        method: "POST",
        headers: { ...(init.headers ?? MMA_FORM_HEADERS) },
        body: init.body ?? "",
        ...(init.referrer === undefined ? {} : { referrer: init.referrer }),
      };
      const reply = await frames.race(page.evaluate(async ({ url, init }) => {
        const response = await fetch(url, { credentials: "same-origin", ...init });
        const bytes = new Uint8Array(await response.arrayBuffer());
        let binary = "";
        for (let index = 0; index < bytes.length; index += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
        }
        const headers: Record<string, string> = {};
        response.headers.forEach((value, name) => {
          headers[name] = value;
        });
        return { url: response.url, status: response.status, headers, base64: btoa(binary) };
      }, { url: `${SINOPAC_MMA_ORIGIN}${path}`, init: request }));
      return {
        bytes: Buffer.from(reply.base64, "base64"),
        response: { url: reply.url, status: reply.status, method: request.method, headers: reply.headers },
      };
    },
  };
  return Object.freeze(site);
}
