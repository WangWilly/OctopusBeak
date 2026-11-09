/**
 * Provider response reader (ADR 0112): the one way a run obtains a provider
 * response. It waits for the declared response the source's action triggers,
 * checks the transport facts before it reads the body, reads the body only
 * while the run continues, stamps the run clock and accepts the response
 * inside the caller's validation. Banks pass the declaration, the trigger and
 * the request the response must answer; nothing else touches Playwright's
 * response or headers.
 */
import type { APIResponse, Request, Response } from "playwright";
import type { ProductCollectionHandle } from "../lib/automation/product-collection.ts";
import type { SourceTextPort } from "../lib/automation/source-text.ts";
import { taipeiInstant } from "../lib/time/timezone.ts";
import { FRAME_SCOPE_TIMEOUT_MS, type FrameScope } from "./frame-scope.ts";
import {
  acceptProviderResponse,
  isDeclaredProviderResponse,
  verifyProviderResponse,
  type AcceptedProviderResponse,
  type ProviderAcquisition,
  type ProviderDateRule,
  type ProviderResponse,
  type ProviderResponseDeclaration,
} from "./provider-response.ts";

/** The request a captured response answered, as the source sent it. */
export type ProviderRequest = Readonly<{ url: string; method: string; postData: string | null }>;

/** A body the reader reads from a response: JSON, or text in the endpoint's charset. */
export type ProviderBodyKind = "json" | "text";

/** The raw body of one kind, as `ProviderEvidence` names it. */
export type ProviderBodyEvidence<Kind extends ProviderBodyKind = ProviderBodyKind> = Kind extends "json"
  ? Readonly<{ kind: "json"; bytes: Uint8Array }>
  : Readonly<{ kind: "text"; bytes: Uint8Array }>;

export type ProviderBodyAcquisition<Kind extends ProviderBodyKind = ProviderBodyKind> = Readonly<{
  response: ProviderResponse;
  evidence: ProviderBodyEvidence<Kind>;
}>;

/** A response the reader waited for, with the request it answered and what the trigger returned. */
export type ProviderCapture<Kind extends ProviderBodyKind, Triggered> = ProviderBodyAcquisition<Kind> & Readonly<{
  request: ProviderRequest;
  triggered: Triggered;
}>;

export type CapturedProviderResponse<
  Kind extends ProviderBodyKind,
  DateRule extends ProviderDateRule,
  Triggered,
> = AcceptedProviderResponse<ProviderBodyAcquisition<Kind>, DateRule> & Readonly<{
  request: ProviderRequest;
  triggered: Triggered;
}>;

/** A response the reader sees while it waits, for a source whose wait is wider than its declared endpoint. */
export type ProviderReply = Readonly<{
  url: string;
  status: number;
  /** Whether this hop redirects onward, so a later response ends its chain. */
  redirectsOnward: boolean;
  request: ProviderRequest;
  /** The first request of the redirect chain this response ends; the request itself when it was not redirected. */
  chainStart: ProviderRequest;
}>;

/** Which responses the reader waits for. */
export type ProviderWaitOptions = Readonly<{
  /** Which request the response must answer, beyond the endpoint it is waited for at. */
  request?: (request: ProviderRequest) => boolean;
  /**
   * Wait for more than the declared endpoint, such as any host on the
   * history path or the end of a redirect chain, so the declaration refuses
   * the reply by name instead of the wait running out. Absent waits for the
   * declared endpoint and method.
   */
  waitFor?: (reply: ProviderReply) => boolean;
  /** How long to wait for the response. A response that never arrives is a collection failure. */
  timeoutMs?: number;
}>;

export type ProviderTriggerOptions<Triggered> = ProviderWaitOptions & Readonly<{
  /**
   * The source's action that makes the provider send the response: a click, a
   * navigation or an in-page fetch. The reader arms its wait first. `replied`
   * aborts once the response has arrived or the read has failed, so an action
   * that repeats until then, such as scrolling a timeline, returns; the reader
   * waits for the trigger to settle and a trigger that throws fails the read.
   */
  trigger: (replied: AbortSignal) => Promise<Triggered>;
}>;

export type ProviderCaptureOptions<Kind extends ProviderBodyKind, Triggered> = ProviderTriggerOptions<Triggered> &
  Readonly<{ evidence: Kind }>;

/** A response whose transport facts passed, for a source whose evidence is the page it witnesses. */
export type ProviderWitness<Triggered> = Readonly<{
  response: ProviderResponse;
  request: ProviderRequest;
  triggered: Triggered;
}>;

/** A response the source may or may not receive while it does other reads. */
export type ProviderWatch<Kind extends ProviderBodyKind> = Readonly<{
  /**
   * The response, once the source is done with its other reads: waits up to
   * `graceMs` more for one that has not arrived, and resolves to null when
   * none does or its status is the declared absent one. A refused transport
   * still fails inside validation.
   */
  settle(graceMs: number): Promise<(ProviderBodyAcquisition<Kind> & Readonly<{ request: ProviderRequest }>) | null>;
}>;

export type ProviderWatchOptions<Kind extends ProviderBodyKind> = ProviderWaitOptions & Readonly<{
  evidence: Kind;
  /** A status that means the provider has nothing to send, such as 204. */
  absentStatus?: number;
}>;

/**
 * Waits for the response that ends a redirect chain that reached the
 * endpoint: the chain either started with a `method` request to a URL
 * containing `path`, or its final request is one. A hop that redirects onward
 * is not the end; a chain that leaves the endpoint surfaces as its last
 * response, for the declaration to refuse, and a chain that arrives from
 * elsewhere still counts.
 */
export function endsRequestChainFrom(path: string, method: string): (reply: ProviderReply) => boolean {
  return (reply) => !reply.redirectsOnward &&
    [reply.chainStart, reply.request].some((request) => request.url.includes(path) && request.method === method);
}

/** What the reader needs from the run, a product's handle or a source's own read. */
export type ProviderResponsePorts = Readonly<{
  /** The run clock, an RFC3339 instant. */
  now: () => string;
  text: SourceTextPort;
  /**
   * The validation a refused response fails inside: a product's
   * `validate`, so the product fails as a validation failure (ADR 0106), or
   * `WITHOUT_PRODUCT_VALIDATION` for a read no product owns yet.
   */
  validate: ProductCollectionHandle["validate"];
}>;

/** For a read a source makes before any product collects, such as fetching its session. */
export const WITHOUT_PRODUCT_VALIDATION: ProductCollectionHandle["validate"] = async (check) => await check();

/** The Source reader (ADR 0116): the reader for a read a source makes before any product collects. */
export function sourceReader(run: Readonly<{ now: () => string; text: SourceTextPort }>): ProviderResponseReader {
  return providerResponseReader({ now: () => run.now(), text: run.text, validate: WITHOUT_PRODUCT_VALIDATION });
}

export type ProviderResponseReader = Readonly<{
  /** Wait for the declared response the trigger causes, read its body and accept it. */
  capture<Kind extends ProviderBodyKind, DateRule extends ProviderDateRule, Triggered = void>(
    scope: FrameScope,
    declaration: ProviderResponseDeclaration<DateRule>,
    options: ProviderCaptureOptions<Kind, Triggered>,
  ): Promise<CapturedProviderResponse<Kind, DateRule, Triggered>>;
  /**
   * The capture without the accept, for a caller that accepts the response
   * later, such as the snapshot module. The transport is still checked
   * before the body is read.
   */
  acquire<Kind extends ProviderBodyKind, Triggered = void>(
    scope: FrameScope,
    declaration: ProviderResponseDeclaration,
    options: ProviderCaptureOptions<Kind, Triggered>,
  ): Promise<ProviderCapture<Kind, Triggered>>;
  /**
   * Wait for the response and check its transport facts without reading its
   * body, for a source that reads its evidence from the page the response
   * carried, then accepts it with `accept`.
   */
  witness<Triggered = void>(
    scope: FrameScope,
    declaration: ProviderResponseDeclaration,
    options: ProviderTriggerOptions<Triggered>,
  ): Promise<ProviderWitness<Triggered>>;
  /** Check the transport of a response the source already holds, without reading its body. */
  witnessFrom(scope: FrameScope, declaration: ProviderResponseDeclaration, response: Response): Promise<ProviderResponse>;
  /** Start waiting now for a response the provider may send while the source does other reads. */
  watch<Kind extends ProviderBodyKind>(
    scope: FrameScope,
    declaration: ProviderResponseDeclaration,
    options: ProviderWatchOptions<Kind>,
  ): ProviderWatch<Kind>;
  /**
   * Read a response the source already holds: one a navigation returned, a
   * routed request's `route.fetch()`, or an `APIRequestContext` reply, which
   * has no request, so its method is passed.
   */
  acquireFrom<Kind extends ProviderBodyKind>(
    scope: FrameScope,
    declaration: ProviderResponseDeclaration,
    reply: Response | Readonly<{ reply: APIResponse; method: string }>,
    evidence: Kind,
  ): Promise<ProviderBodyAcquisition<Kind>>;
  /**
   * Stamp the run clock and accept an acquisition inside the caller's
   * validation. For evidence the reader did not read itself: DOM cells or
   * markup, or a body an in-page fetch returned.
   */
  accept<Acquired extends ProviderAcquisition, DateRule extends ProviderDateRule>(
    declaration: ProviderResponseDeclaration<DateRule>,
    acquired: Acquired,
  ): Promise<AcceptedProviderResponse<Acquired, DateRule>>;
}>;

function requestFacts(request: Request): ProviderRequest {
  return { url: request.url(), method: request.method(), postData: request.postData() };
}

function replyFacts(response: Response): ProviderReply {
  const request = response.request();
  let start = request;
  for (let previous = start.redirectedFrom(); previous; previous = previous.redirectedFrom()) start = previous;
  const status = response.status();
  return {
    url: response.url(),
    status,
    redirectsOnward: status >= 300 && status < 400 && response.headers().location !== undefined,
    request: requestFacts(request),
    chainStart: requestFacts(start),
  };
}

export function providerResponseReader(ports: ProviderResponsePorts): ProviderResponseReader {
  const observedAt = () => taipeiInstant(ports.now());

  const transportOf = async (scope: FrameScope, response: Response): Promise<ProviderResponse> => ({
    url: response.url(),
    status: response.status(),
    method: response.request().method(),
    headers: await scope.race(response.allHeaders()),
  });

  // A refused transport is a validation failure, and its body is never read.
  const checkTransport = async (declaration: ProviderResponseDeclaration, response: ProviderResponse) => {
    const at = observedAt();
    await ports.validate(() => verifyProviderResponse(declaration, response, at));
  };

  const readBody = async <Kind extends ProviderBodyKind>(
    scope: FrameScope,
    declaration: ProviderResponseDeclaration,
    response: ProviderResponse,
    body: () => Promise<Buffer>,
    kind: Kind,
  ): Promise<ProviderBodyAcquisition<Kind>> => {
    await checkTransport(declaration, response);
    const bytes = new Uint8Array(await scope.race(body()));
    // The kind is the caller's own, which the distributive type cannot see.
    return { response, evidence: { kind, bytes } as ProviderBodyEvidence<Kind> };
  };

  const waitFor = (
    scope: FrameScope,
    declaration: ProviderResponseDeclaration,
    options: ProviderWaitOptions,
    stop: AbortSignal,
  ): Promise<Response> => scope.withSignal((signal) => scope.page.waitForResponse(
    (response) => {
      const reply = replyFacts(response);
      const waited = options.waitFor
        ? options.waitFor(reply)
        : isDeclaredProviderResponse(declaration, reply.url, reply.request.method);
      return waited && (options.request?.(reply.request) ?? true);
    },
    { timeout: options.timeoutMs ?? FRAME_SCOPE_TIMEOUT_MS, signal: AbortSignal.any([signal, stop]) },
  ));

  /**
   * Arm the wait, run the trigger, and read the response as soon as it
   * arrives, while the trigger may still be settling: a no-store body, such
   * as SinoPac MMA's, is gone once its page moves on.
   */
  const triggered = async <Triggered, Read>(
    scope: FrameScope,
    declaration: ProviderResponseDeclaration,
    options: ProviderTriggerOptions<Triggered>,
    read: (response: Response) => Promise<Read>,
  ): Promise<readonly [Triggered, Read]> => {
    scope.signal.throwIfAborted();
    const settled = new AbortController();
    const replied = new AbortController();
    try {
      const reading = waitFor(scope, declaration, options, settled.signal).then((response) => {
        replied.abort();
        return read(response);
      });
      // A trigger that throws first fails the read; the wait is then abandoned, not left unhandled.
      reading.catch(() => undefined);
      return await Promise.all([scope.race(options.trigger(replied.signal)), reading]);
    } finally {
      // A read that timed out or failed also ends a trigger that repeats until the reply.
      replied.abort();
      settled.abort();
    }
  };

  const readCaptured = async <Kind extends ProviderBodyKind>(
    scope: FrameScope,
    declaration: ProviderResponseDeclaration,
    response: Response,
    kind: Kind,
  ) => ({
    ...(await readBody(scope, declaration, await transportOf(scope, response), () => response.body(), kind)),
    request: requestFacts(response.request()),
  });

  const witnessed = async (scope: FrameScope, declaration: ProviderResponseDeclaration, response: Response) => {
    const transport = await transportOf(scope, response);
    await checkTransport(declaration, transport);
    return { response: transport, request: requestFacts(response.request()) };
  };

  const acquire: ProviderResponseReader["acquire"] = async (scope, declaration, options) => {
    const [value, acquired] = await triggered(
      scope, declaration, options, (response) => readCaptured(scope, declaration, response, options.evidence));
    return { ...acquired, triggered: value };
  };

  const accept: ProviderResponseReader["accept"] = async (declaration, acquired) => {
    const at = observedAt();
    return await ports.validate(() => acceptProviderResponse(declaration, acquired, { observedAt: at, text: ports.text }));
  };

  return Object.freeze({
    acquire,
    accept,
    witness: async (scope, declaration, options) => {
      const [value, seen] = await triggered(scope, declaration, options, (response) => witnessed(scope, declaration, response));
      return { ...seen, triggered: value };
    },
    witnessFrom: async (scope, declaration, response) => {
      scope.signal.throwIfAborted();
      return (await witnessed(scope, declaration, response)).response;
    },
    watch: (scope, declaration, options) => {
      const stop = new AbortController();
      const arrived = waitFor(scope, declaration, options, stop.signal).then(
        (response) => response,
        (error: unknown) => {
          // A cancelled run still stops the source; a reply that never came is absent.
          if (scope.signal.aborted) throw error;
          return null;
        },
      );
      arrived.catch(() => undefined);
      return Object.freeze({
        settle: async (graceMs) => {
          try {
            const response = await scope.race(Promise.race([arrived, scope.pause(graceMs).then(() => null)]));
            if (!response || response.status() === options.absentStatus) return null;
            return await readCaptured(scope, declaration, response, options.evidence);
          } finally {
            stop.abort();
          }
        },
      });
    },
    acquireFrom: async (scope, declaration, held, evidence) => {
      scope.signal.throwIfAborted();
      if ("reply" in held) {
        const { reply, method } = held;
        const transport = { url: reply.url(), status: reply.status(), method, headers: reply.headers() };
        return await readBody(scope, declaration, transport, () => reply.body(), evidence);
      }
      return await readBody(scope, declaration, await transportOf(scope, held), () => held.body(), evidence);
    },
    capture: async (scope, declaration, options) => {
      const { request, triggered: value, ...acquired } = await acquire(scope, declaration, options);
      return { ...(await accept(declaration, acquired)), request, triggered: value };
    },
  });
}
