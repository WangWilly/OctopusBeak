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

export type ProviderCaptureOptions<Kind extends ProviderBodyKind, Triggered> = Readonly<{
  evidence: Kind;
  /**
   * The source's action that makes the provider send the response: a click, a
   * navigation or an in-page fetch. The reader arms its wait first. `replied`
   * aborts once the response has arrived or the read has failed, so an action
   * that repeats until then, such as scrolling a timeline, returns; the reader
   * waits for the trigger to settle and a trigger that throws fails the read.
   */
  trigger: (replied: AbortSignal) => Promise<Triggered>;
  /** Which request the response must answer, beyond the declared endpoint and method. */
  request?: (request: ProviderRequest) => boolean;
  /** How long to wait for the response. A response that never arrives is a collection failure. */
  timeoutMs?: number;
}>;

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

export function providerResponseReader(ports: ProviderResponsePorts): ProviderResponseReader {
  const observedAt = () => taipeiInstant(ports.now());

  // A refused transport is a validation failure, and its body is never read.
  const readBody = async <Kind extends ProviderBodyKind>(
    scope: FrameScope,
    declaration: ProviderResponseDeclaration,
    response: ProviderResponse,
    body: () => Promise<Buffer>,
    kind: Kind,
  ): Promise<ProviderBodyAcquisition<Kind>> => {
    const at = observedAt();
    await ports.validate(() => verifyProviderResponse(declaration, response, at));
    const bytes = new Uint8Array(await scope.race(body()));
    // The kind is the caller's own, which the distributive type cannot see.
    return { response, evidence: { kind, bytes } as ProviderBodyEvidence<Kind> };
  };

  const acquire: ProviderResponseReader["acquire"] = async (scope, declaration, options) => {
    scope.signal.throwIfAborted();
    const settled = new AbortController();
    const replied = new AbortController();
    try {
      const waiting = scope.withSignal((signal) => scope.page.waitForResponse(
        (response) => {
          const request = response.request();
          return isDeclaredProviderResponse(declaration, response.url(), request.method()) &&
            (options.request?.(requestFacts(request)) ?? true);
        },
        { timeout: options.timeoutMs ?? FRAME_SCOPE_TIMEOUT_MS, signal: AbortSignal.any([signal, settled.signal]) },
      )).then((response) => {
        replied.abort();
        return response;
      });
      // A trigger that throws first fails the read; the wait is then abandoned, not left unhandled.
      waiting.catch(() => undefined);
      const [triggered, response] = await Promise.all([scope.race(options.trigger(replied.signal)), waiting]);
      const transport: ProviderResponse = {
        url: response.url(),
        status: response.status(),
        method: response.request().method(),
        headers: await scope.race(response.allHeaders()),
      };
      const acquired = await readBody(scope, declaration, transport, () => response.body(), options.evidence);
      return { ...acquired, request: requestFacts(response.request()), triggered };
    } finally {
      // A read that timed out or failed also ends a trigger that repeats until the reply.
      replied.abort();
      settled.abort();
    }
  };

  const accept: ProviderResponseReader["accept"] = async (declaration, acquired) => {
    const at = observedAt();
    return await ports.validate(() => acceptProviderResponse(declaration, acquired, { observedAt: at, text: ports.text }));
  };

  return Object.freeze({
    acquire,
    accept,
    acquireFrom: async (scope, declaration, held, evidence) => {
      scope.signal.throwIfAborted();
      if ("reply" in held) {
        const { reply, method } = held;
        const transport = { url: reply.url(), status: reply.status(), method, headers: reply.headers() };
        return await readBody(scope, declaration, transport, () => reply.body(), evidence);
      }
      const transport: ProviderResponse = {
        url: held.url(),
        status: held.status(),
        method: held.request().method(),
        headers: await scope.race(held.allHeaders()),
      };
      return await readBody(scope, declaration, transport, () => held.body(), evidence);
    },
    capture: async (scope, declaration, options) => {
      const { request, triggered, ...acquired } = await acquire(scope, declaration, options);
      return { ...(await accept(declaration, acquired)), request, triggered };
    },
  });
}
