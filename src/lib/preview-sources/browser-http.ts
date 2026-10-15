import type { Page } from "playwright";
import { BrowserRuntimeConfigurationError } from "../automation/server/browser-runtime.ts";
import { SourceAccessChallengeError, SourceUnavailableError } from "../automation/source-access.ts";
import { stripOriginOnPausedRequests } from "../../workflows/einvoice-app-transport.ts";
import type { PreviewWorkflowContext } from "./workflow.ts";

export type PreviewHttpRequest = Readonly<{
  method: "GET" | "POST";
  url: string;
  headers?: Readonly<Record<string, string>>;
  body?: string;
  credentials?: "include" | "same-origin" | "omit";
}>;

export type PreviewHttpResponse = Readonly<{
  status: number;
  headers: Readonly<Record<string, string>>;
  text: string;
}>;

export type PreviewHttp = (request: PreviewHttpRequest) => Promise<PreviewHttpResponse>;

export type PreviewHttpSession = Readonly<{
  /** The page the requests run in, opened at `pageUrl` (ADR 0044 browser transport). */
  pageUrl: string;
  /**
   * A native App sends no Origin or Referer. When set, both are removed at the
   * CDP layer from requests whose URL matches this pattern (ADR 0043).
   */
  stripOriginFor?: string;
}>;

export type PreviewImageDecoder = (image: Buffer) => Promise<Buffer>;

export type PreviewHttpOpener = <T>(
  context: PreviewWorkflowContext,
  session: PreviewHttpSession,
  use: (http: PreviewHttp, decodeImage: PreviewImageDecoder) => Promise<T>,
) => Promise<T>;

const CLOUDFLARE_CHALLENGE = /<title>Just a moment\.\.\.<\/title>|\/cdn-cgi\/challenge-platform\//u;

/** Transport failures every preview source treats alike; anything else goes back to the source. */
export function classifyTransport(response: PreviewHttpResponse): PreviewHttpResponse {
  if (response.status === 0 || response.status === 429 || response.status >= 500) throw new SourceUnavailableError();
  if (response.status === 403 && CLOUDFLARE_CHALLENGE.test(response.text)) throw new SourceAccessChallengeError();
  return response;
}

async function inPageFetch(page: Page, request: PreviewHttpRequest): Promise<PreviewHttpResponse> {
  return page.evaluate(async ({ method, url, headers, body, credentials }) => {
    try {
      const response = await fetch(url, { method, headers, body, credentials, redirect: "manual" });
      const readable: Record<string, string> = {};
      response.headers.forEach((value, name) => { readable[name] = value; });
      return { status: response.type === "opaqueredirect" ? 0 : response.status, headers: readable, text: await response.text() };
    } catch (error) {
      return { status: 0, headers: {}, text: String(error) };
    }
  }, {
    method: request.method,
    url: request.url,
    headers: { ...request.headers },
    body: request.body,
    credentials: request.credentials ?? "same-origin",
  });
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function sniffImageType(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (bytes.subarray(0, 2).toString("latin1") === "BM") return "image/bmp";
  if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

export async function decodeImageToPng(page: Page, bytes: Buffer): Promise<Buffer> {
  const mediaType = sniffImageType(bytes);
  if (mediaType === "image/png") return bytes;
  if (!mediaType) throw new Error("The CAPTCHA image is not a PNG, JPEG, GIF, BMP, or WebP image.");
  const dataUrl = await page.evaluate(async (source) => {
    const image = new Image();
    image.src = source;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    canvas.getContext("2d")!.drawImage(image, 0, 0);
    return canvas.toDataURL("image/png");
  }, `data:${mediaType};base64,${bytes.toString("base64")}`);
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
}

export function pageHttp(context: PreviewWorkflowContext, page: Page, rewriteFailed: () => boolean = () => false): PreviewHttp {
  return async (request) => {
    context.signal.throwIfAborted();
    const response = await inPageFetch(page, request);
    if (rewriteFailed()) throw new BrowserRuntimeConfigurationError("request-header-rewrite-failed");
    return classifyTransport(response);
  };
}

export const browserHttp: PreviewHttpOpener = (context, session, use) =>
  context.browser.withPage(async (page) => {
    let rewriteFailed = false;
    const cdp = session.stripOriginFor ? await page.context().newCDPSession(page) : null;
    if (cdp) {
      await cdp.send("Fetch.enable", { patterns: [{ urlPattern: session.stripOriginFor, requestStage: "Request" }] });
      stripOriginOnPausedRequests(cdp as never, () => { rewriteFailed = true; });
    }
    try {
      await page.goto(session.pageUrl, { waitUntil: "domcontentloaded" }).catch(() => undefined);
      return await use(pageHttp(context, page, () => rewriteFailed), (image) => decodeImageToPng(page, image));
    } finally {
      await cdp?.detach().catch(() => undefined);
    }
  });
