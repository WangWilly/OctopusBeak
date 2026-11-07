/**
 * The one fake Playwright `Response` a check hands a scripted page, carrying
 * only what the Provider response reader reads (ADR 0112): the URL, status,
 * request, headers and body. A check that drives a real browser routes
 * synthetic replies instead.
 */
import type { Response } from "playwright";

export type FakeProviderReply = Readonly<{
  url: string;
  status?: number;
  method?: string;
  postData?: string | null;
  headers?: Readonly<Record<string, string>>;
  body: string | Uint8Array;
  /** Called when the reader reads the body, so a check can assert a refused reply's body was never read. */
  onBodyRead?: () => void;
}>;

export function fakeProviderReply(reply: FakeProviderReply): Response {
  const method = reply.method ?? "GET";
  const request = {
    url: () => reply.url,
    method: () => method,
    postData: () => reply.postData ?? null,
  };
  const fake = {
    url: () => reply.url,
    status: () => reply.status ?? 200,
    request: () => request,
    allHeaders: async () => ({ ...reply.headers }),
    body: async () => {
      reply.onBodyRead?.();
      return Buffer.from(reply.body);
    },
  };
  // A check fakes only the reader's slice of Response; the reader reads nothing else.
  return fake as unknown as Response;
}
