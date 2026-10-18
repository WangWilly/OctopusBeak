import type { Page } from "playwright";
import type { PortalTransport } from "./probe.ts";
import { safeRequestPath } from "../../src/lib/preview-sources/response-shape.ts";
import {
  createEsunPortalTransport,
  ESUN_PORTAL_HOST,
  waitForEsunPortalSession,
} from "../../src/lib/preview-sources/esun-portal.ts";

const MAX_OBSERVED_REQUESTS = 80;

export const waitForPortalSession = waitForEsunPortalSession;

export function createPageTransport(page: Page, signal: AbortSignal): PortalTransport {
  const transport = createEsunPortalTransport(page, signal);
  return async (path, requestBody, resetFlow) => {
    const reply = await transport(path, requestBody, resetFlow);
    return reply.kind === "json" ? { kind: "json", httpStatus: reply.httpStatus, json: JSON.parse(reply.text) } : reply;
  };
}

export function observePortalRequests(page: Page) {
  const seen = new Set<string>();
  page.on("response", (response) => {
    const request = response.request();
    if (request.resourceType() !== "xhr" && request.resourceType() !== "fetch") return;
    const url = new URL(response.url());
    if (url.hostname !== ESUN_PORTAL_HOST || seen.size >= MAX_OBSERVED_REQUESTS) return;
    seen.add(`${request.method()} ${safeRequestPath(url.pathname)} ${response.status()}`);
  });
  return () => [...seen].sort();
}
