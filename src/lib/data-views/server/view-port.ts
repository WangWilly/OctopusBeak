type Port = {
  on(event: "message", listener: (value: unknown) => void): unknown;
  off(event: "message", listener: (value: unknown) => void): unknown;
  postMessage(value: unknown): void;
};
export type ViewStop = () => Promise<void>;
type ViewSource<View extends string> = {
  subscribe(
    view: View,
    params: object,
    onRows: (rows: unknown[]) => void,
    onError?: (error: unknown) => void,
  ): Promise<ViewStop>;
};

type Request =
  | { kind: "subscribe"; id: number; view: string; params: object }
  | { kind: "unsubscribe"; id: number };
type Response =
  | { kind: "ready"; id: number }
  | { kind: "stopped"; id: number }
  | { kind: "rows"; id: number; rows: unknown[] }
  | { kind: "error"; id: number; code: "subscription-failed" | "duplicate-subscription" };

type Subscription = {
  cancelled: boolean;
  stop?: ViewStop;
  stopping?: Promise<void>;
};

function errorFrom(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function safePost(port: Port, response: Response): void {
  try {
    port.postMessage(response);
  } catch {
    // A worker can disappear while a subscription is being torn down.
  }
}

async function stopSafely(stop: ViewStop): Promise<void> {
  try {
    await stop();
  } catch {
    // A failed teardown must not become an unhandled rejection or strand the
    // wire-level unsubscribe request.
  }
}

function isRequest(value: unknown): value is Request {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Record<string, unknown>;
  if (!Number.isSafeInteger(request.id) || (request.id as number) < 1) return false;
  if (request.kind === "unsubscribe") return true;
  return request.kind === "subscribe" && typeof request.view === "string"
    && request.view.length > 0 && typeof request.params === "object"
    && request.params !== null && !Array.isArray(request.params);
}

/** Wire a named-view source to a worker MessagePort without exposing SQL. */
export function createViewPortServer<View extends string>(port: Port, source: ViewSource<View>) {
  const subscriptions = new Map<number, Subscription>();
  const initializations = new Set<Promise<void>>();
  let closed = false;
  let closePromise: Promise<void> | undefined;

  const stopSubscription = (subscription: Subscription): Promise<void> => {
    if (!subscription.stop) return Promise.resolve();
    if (!subscription.stopping) subscription.stopping = stopSafely(subscription.stop);
    return subscription.stopping;
  };

  const onMessage = (value: unknown) => {
    if (closed || !isRequest(value)) return;
    const request = value;
    if (request.kind === "subscribe") {
      if (subscriptions.has(request.id)) {
        safePost(port, { kind: "error", id: request.id, code: "duplicate-subscription" });
        return;
      }
      const subscription: Subscription = { cancelled: false };
      subscriptions.set(request.id, subscription);
      const initializing = Promise.resolve()
        .then(() => source.subscribe(
          request.view as View,
          request.params,
          (rows) => {
            if (!closed && !subscription.cancelled) safePost(port, { kind: "rows", id: request.id, rows });
          },
          () => {
            if (!closed && !subscription.cancelled) safePost(port, { kind: "error", id: request.id, code: "subscription-failed" });
          },
        ))
        .then(async (stop) => {
          subscription.stop = stop;
          if (closed || subscription.cancelled) {
            await stopSubscription(subscription);
          } else {
            safePost(port, { kind: "ready", id: request.id });
          }
        }, () => {
          if (subscriptions.get(request.id) === subscription) subscriptions.delete(request.id);
          if (!closed && !subscription.cancelled) {
            safePost(port, { kind: "error", id: request.id, code: "subscription-failed" });
          }
        });
      initializations.add(initializing);
      void initializing.then(
        () => initializations.delete(initializing),
        () => initializations.delete(initializing),
      );
    } else {
      const subscription = subscriptions.get(request.id);
      subscriptions.delete(request.id);
      if (subscription) subscription.cancelled = true;
      void (subscription ? stopSubscription(subscription) : Promise.resolve()).then(() => {
        if (!closed) safePost(port, { kind: "stopped", id: request.id });
      });
    }
  };
  port.on("message", onMessage);
  return {
    close() {
      if (closePromise) return closePromise;
      closed = true;
      port.off("message", onMessage);
      const active = [...subscriptions.values()];
      subscriptions.clear();
      for (const subscription of active) {
        subscription.cancelled = true;
      }
      closePromise = Promise.all([
        ...active.map((subscription) => stopSubscription(subscription)),
        ...initializations,
      ]).then(() => undefined);
      return closePromise;
    },
  };
}

/** Client for the restricted named-view wire protocol. */
export function createViewPortClient(port: Port) {
  let nextId = 1;
  let closed = false;
  const listeners = new Map<number, { rows: (rows: unknown[]) => void; error?: (error: Error) => void }>();
  const pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  let closePromise: Promise<void> | undefined;
  const onMessage = (value: unknown) => {
    if (typeof value !== "object" || value === null) return;
    const response = value as Response;
    if (!Number.isSafeInteger(response.id) || response.id < 1) return;
    if (response.kind === "rows") {
      if (Array.isArray(response.rows)) listeners.get(response.id)?.rows(response.rows);
    }
    else {
      if (!["ready", "stopped", "error"].includes(response.kind)) return;
      if (response.kind === "error") {
        const listener = listeners.get(response.id);
        const request = pending.get(`subscribe:${response.id}`);
        if (request) {
          pending.delete(`subscribe:${response.id}`);
          request.reject(new Error(response.code));
        } else {
          listener?.error?.(new Error(response.code));
        }
        return;
      }
      const key = `${response.kind === "stopped" ? "unsubscribe" : "subscribe"}:${response.id}`;
      const request = pending.get(key);
      if (!request) return;
      pending.delete(key);
      request.resolve();
    }
  };
  port.on("message", onMessage);

  function roundTrip(request: Request): Promise<void> {
    return new Promise((resolve, reject) => {
      const key = `${request.kind}:${request.id}`;
      pending.set(key, { resolve, reject });
      try {
        port.postMessage(request);
      } catch (error) {
        pending.delete(key);
        reject(errorFrom(error));
      }
    });
  }

  const postUnsubscribe = (id: number): void => {
    try {
      port.postMessage({ kind: "unsubscribe", id });
    } catch {
      // Closing is best-effort when the remote worker has already exited.
    }
  };

  return {
    async subscribe<Row>(view: string, params: object, onRows: (rows: Row[]) => void, onError?: (error: Error) => void): Promise<ViewStop> {
      if (closed) throw new Error("View port is closed");
      const id = nextId++;
      listeners.set(id, { rows: onRows as (rows: unknown[]) => void, error: onError });
      try {
        await roundTrip({ kind: "subscribe", id, view, params });
      } catch (error) {
        listeners.delete(id);
        throw error;
      }
      let stopped = false;
      return async () => {
        if (stopped) return;
        stopped = true;
        listeners.delete(id);
        if (!closed) await roundTrip({ kind: "unsubscribe", id });
      };
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      const ids = [...listeners.keys()];
      listeners.clear();
      const error = new Error("View port is closed");
      for (const request of pending.values()) request.reject(error);
      pending.clear();
      port.off("message", onMessage);
      for (const id of ids) postUnsubscribe(id);
      // Do not wait for stopped acknowledgements. The remote side may have
      // crashed, and all local callers are already settled above.
      closePromise = Promise.resolve();
      return closePromise;
    },
  };
}

export type ViewPortClient = ReturnType<typeof createViewPortClient>;
