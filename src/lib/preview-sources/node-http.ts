import { classifyTransport, sniffImageType, type PreviewHttp, type PreviewHttpOpener } from "./browser-http.ts";

const REQUEST_TIMEOUT_MS = 45_000;

/**
 * A plain Node HTTP transport for a source whose ADR 0044 probe showed its
 * hosts accept a non-browser client. Each opened session keeps its own
 * cookie jar, as a page would, and drops it when the session ends.
 */
export const nodeHttp: PreviewHttpOpener = async (context, _session, use) => {
  const cookies = new Map<string, string>();
  const http: PreviewHttp = async (request) => {
    context.signal.throwIfAborted();
    const headers = new Headers(request.headers);
    if (request.credentials !== "omit" && cookies.size > 0)
      headers.set("Cookie", [...cookies].map(([name, value]) => `${name}=${value}`).join("; "));
    let response: Response;
    try {
      response = await fetch(request.url, {
        method: request.method,
        headers,
        body: request.body,
        redirect: "manual",
        signal: AbortSignal.any([context.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      });
    } catch (error) {
      context.signal.throwIfAborted();
      return classifyTransport({ status: 0, headers: {}, text: String(error) });
    }
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";", 1)[0]!;
      const separator = pair.indexOf("=");
      if (separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (value) cookies.set(name, value);
      else cookies.delete(name);
    }
    const readable: Record<string, string> = {};
    response.headers.forEach((value, name) => { readable[name] = value; });
    const status = response.status >= 300 && response.status < 400 ? 0 : response.status;
    return classifyTransport({ status, headers: readable, text: await response.text() });
  };
  return use(http, async (image) => {
    if (sniffImageType(image) !== "image/png") throw new Error("The Node transport decodes PNG images only.");
    return image;
  });
};
