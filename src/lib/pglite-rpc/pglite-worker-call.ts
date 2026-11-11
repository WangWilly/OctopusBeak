import {
  isWorkflowFailureCorrelation,
  type WorkflowFailureCorrelation,
} from "../automation/server/workflow-failure-diagnostics.ts";

/**
 * The call machinery shared by the PGlite worker's financial and operational
 * protocols. Each protocol keeps its own frame kinds, contract table, error
 * vocabulary and scheduling; this module correlates requests with responses
 * on the client and tracks the calls a server is running.
 */

/** A worker MessagePort, a socket adapter, or a test double. */
export type WorkerPort = {
  on(event: "message", listener: (value: unknown) => void): unknown;
  off(event: "message", listener: (value: unknown) => void): unknown;
  postMessage(value: unknown): void;
};

export function plainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** The frame kind and version a protocol stamps on its requests or responses. */
export type WorkerFrame = Readonly<{ kind: string; version: number }>;

const asError = (error: unknown): Error => error instanceof Error ? error : new Error(String(error));

/** Lets a caller abandon a call it already sent; the worker decides how it ends. */
export type WorkerCallCancellation = Readonly<{
  signal: AbortSignal;
  /** The rejection when the signal aborted before the request was sent. */
  cancelled(): Error;
  /** The frame that asks the worker to stop call `id`. */
  frame(id: number): unknown;
}>;

export type WorkerCallClient = Readonly<{
  /**
   * Send the request `build` makes for a fresh id once the worker is ready.
   * The call settles with the matching response, or with the close error.
   */
  call(build: (id: number) => unknown, cancellation?: WorkerCallCancellation): Promise<unknown>;
  /** Reject every pending and later call; the default error is `closed()`. */
  close(error?: Error): void;
}>;

type Pending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
};

/**
 * The client half: one id per call, responses of `response` kind matched by
 * id, responses for unknown ids ignored.
 */
export function createWorkerCallClient(options: Readonly<{
  port: WorkerPort;
  ready?: Promise<void>;
  response: WorkerFrame;
  /** The rejection for a response with `ok: false`. */
  failure(response: Record<string, unknown>): Error;
  /** The rejection for a call made or still pending once the client is closed. */
  closed(): Error;
}>): WorkerCallClient {
  const { port, ready, response } = options;
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let closed = false;
  const onMessage = (value: unknown): void => {
    if (!plainRecord(value)
      || value.kind !== response.kind
      || value.version !== response.version
      || !Number.isSafeInteger(value.id)
      || typeof value.ok !== "boolean") return;
    const request = pending.get(value.id as number);
    if (!request) return;
    pending.delete(value.id as number);
    if (value.ok === true) request.resolve(value.value);
    else request.reject(options.failure(value));
  };
  port.on("message", onMessage);

  const call = (build: (id: number) => unknown, cancellation?: WorkerCallCancellation): Promise<unknown> => {
    if (closed) return Promise.reject(options.closed());
    return new Promise((resolve, reject) => {
      const signal = cancellation?.signal;
      if (signal?.aborted) {
        reject(cancellation!.cancelled());
        return;
      }
      const send = () => {
        if (closed) {
          reject(options.closed());
          return;
        }
        if (signal?.aborted) {
          reject(cancellation!.cancelled());
          return;
        }
        const id = nextId++;
        const abort = () => {
          // Keep the call pending until the worker's terminal response: a
          // commit may have crossed the cancel frame, and then the caller
          // must receive its durable receipt.
          if (!pending.has(id)) return;
          try {
            port.postMessage(cancellation!.frame(id));
          } catch {
            // A disconnected peer is indeterminate, so surface the closure
            // rather than claiming the work stopped.
            pending.get(id)?.reject(options.closed());
            pending.delete(id);
          }
        };
        pending.set(id, {
          resolve: (value) => {
            signal?.removeEventListener("abort", abort);
            resolve(value);
          },
          reject: (error) => {
            signal?.removeEventListener("abort", abort);
            reject(error);
          },
        });
        signal?.addEventListener("abort", abort, { once: true });
        try {
          port.postMessage(build(id));
        } catch (error) {
          pending.get(id)?.reject(asError(error));
          pending.delete(id);
        }
      };
      if (ready) void ready.then(send, (error) => reject(asError(error)));
      else send();
    });
  };

  const close = (error = options.closed()): void => {
    if (closed) return;
    closed = true;
    port.off("message", onMessage);
    for (const item of pending.values()) item.reject(error);
    pending.clear();
  };
  return Object.freeze({ call, close });
}

/** A request envelope that passed the shared checks; its contract is not checked yet. */
export type WorkerCall = Readonly<{
  id: number;
  operation: string;
  args: readonly unknown[];
  diagnosticContext?: WorkflowFailureCorrelation;
}>;

export type WorkerCallServer = Readonly<{
  /** Keep close waiting for work that outlives the call that started it. */
  track(work: Promise<unknown>): void;
  /** Stop accepting calls, then wait for every call still running. */
  close(): Promise<void>;
}>;

/**
 * The server half: validates the request envelope, refuses calls after close
 * and calls that reuse an active id, runs each accepted call once, and posts
 * its response.
 */
export function createWorkerCallServer(options: Readonly<{
  port: WorkerPort;
  request: WorkerFrame;
  /** The response refusing call `id` without running it. */
  refusal(id: number, code: "invalid-request" | "worker-closed"): unknown;
  /**
   * Start an accepted call and resolve to its response frame, or return
   * undefined when the protocol's contract refuses it.
   */
  start(call: WorkerCall): Promise<unknown> | undefined;
  /** Frames that are not requests of this protocol, such as a cancel. */
  other?(value: unknown): void;
  /** Runs once when close begins, before waiting for active calls. */
  closing?(): void;
}>): WorkerCallServer {
  const { port, request } = options;
  let closed = false;
  const activeIds = new Set<number>();
  const active = new Set<Promise<unknown>>();
  const post = (response: unknown): void => {
    try {
      port.postMessage(response);
    } catch {
      // The client may close while an operation is finishing; it has its own
      // bounded close path.
    }
  };
  const track = (work: Promise<unknown>): void => {
    const settled = work.then(() => undefined, () => undefined);
    active.add(settled);
    void settled.finally(() => active.delete(settled));
  };
  const valid = (value: unknown): value is WorkerCall => plainRecord(value)
    && value.kind === request.kind
    && value.version === request.version
    && Number.isSafeInteger(value.id)
    && (value.id as number) >= 0
    && typeof value.operation === "string"
    && Array.isArray(value.args)
    && (value.diagnosticContext === undefined || isWorkflowFailureCorrelation(value.diagnosticContext));
  const onMessage = (value: unknown): void => {
    if (!valid(value)) {
      options.other?.(value);
      return;
    }
    if (closed) {
      post(options.refusal(value.id, "worker-closed"));
      return;
    }
    // The id is the response correlation key; a second call under an active
    // id would make its response ambiguous.
    if (activeIds.has(value.id)) {
      post(options.refusal(value.id, "invalid-request"));
      return;
    }
    const response = options.start(value);
    if (!response) {
      post(options.refusal(value.id, "invalid-request"));
      return;
    }
    activeIds.add(value.id);
    const work = response.then(post).finally(() => activeIds.delete(value.id));
    track(work);
  };
  port.on("message", onMessage);
  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    track,
    close() {
      if (closePromise) return closePromise;
      closed = true;
      port.off("message", onMessage);
      options.closing?.();
      closePromise = Promise.all([...active]).then(() => undefined);
      return closePromise;
    },
  });
}
