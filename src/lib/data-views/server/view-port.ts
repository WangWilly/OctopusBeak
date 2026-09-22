import type { MessagePort } from "node:worker_threads";

type Port = Pick<MessagePort, "on" | "off" | "postMessage">;
type Stop = () => Promise<void>;
type ViewSource<View extends string> = {
  subscribe<Row>(view: View, params: object, onRows: (rows: Row[]) => void): Promise<Stop>;
};

type Request =
  | { kind: "subscribe"; id: number; view: string; params: object }
  | { kind: "unsubscribe"; id: number };
type Response =
  | { kind: "ready"; id: number }
  | { kind: "stopped"; id: number }
  | { kind: "rows"; id: number; rows: unknown[] }
  | { kind: "error"; id: number; code: "subscription-failed" };

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
  const subscriptions = new Map<number, { cancelled: boolean; stop?: Stop }>();
  let closed = false;
  const onMessage = (value: unknown) => {
    if (closed || !isRequest(value)) return;
    const request = value;
    if (request.kind === "subscribe") {
      if (subscriptions.has(request.id)) return;
      const subscription: { cancelled: boolean; stop?: Stop } = { cancelled: false };
      subscriptions.set(request.id, subscription);
      void source.subscribe(request.view as View, request.params, (rows) => {
        if (!closed && !subscription.cancelled) port.postMessage({ kind: "rows", id: request.id, rows } satisfies Response);
      }).then((stop) => {
        if (closed || subscription.cancelled) void stop();
        else {
          subscription.stop = stop;
          port.postMessage({ kind: "ready", id: request.id } satisfies Response);
        }
      }).catch(() => {
        subscriptions.delete(request.id);
        if (!closed && !subscription.cancelled) port.postMessage({ kind: "error", id: request.id, code: "subscription-failed" } satisfies Response);
      });
    } else {
      const subscription = subscriptions.get(request.id);
      subscriptions.delete(request.id);
      if (subscription) subscription.cancelled = true;
      void (subscription?.stop?.() ?? Promise.resolve()).then(() => {
        if (!closed) port.postMessage({ kind: "stopped", id: request.id } satisfies Response);
      });
    }
  };
  port.on("message", onMessage);
  return {
    async close() {
      closed = true;
      port.off("message", onMessage);
      await Promise.all([...subscriptions.values()].map((subscription) => {
        subscription.cancelled = true;
        return subscription.stop?.();
      }));
      subscriptions.clear();
    },
  };
}

/** Client for the restricted named-view wire protocol. */
export function createViewPortClient(port: Port) {
  let nextId = 1;
  let closed = false;
  const listeners = new Map<number, (rows: unknown[]) => void>();
  const pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  const onMessage = (value: unknown) => {
    if (typeof value !== "object" || value === null) return;
    const response = value as Response;
    if (!Number.isSafeInteger(response.id) || response.id < 1) return;
    if (response.kind === "rows") {
      if (Array.isArray(response.rows)) listeners.get(response.id)?.(response.rows);
    }
    else {
      if (!["ready", "stopped", "error"].includes(response.kind)) return;
      const key = `${response.kind === "stopped" ? "unsubscribe" : "subscribe"}:${response.id}`;
      const request = pending.get(key);
      if (!request) return;
      pending.delete(key);
      if (response.kind === "error") request.reject(new Error(response.code === "subscription-failed" ? response.code : "Invalid view response"));
      else request.resolve();
    }
  };
  port.on("message", onMessage);

  function roundTrip(request: Request): Promise<void> {
    return new Promise((resolve, reject) => {
      pending.set(`${request.kind}:${request.id}`, { resolve, reject });
      port.postMessage(request);
    });
  }

  return {
    async subscribe<Row>(view: string, params: object, onRows: (rows: Row[]) => void): Promise<Stop> {
      if (closed) throw new Error("View port is closed");
      const id = nextId++;
      listeners.set(id, onRows as (rows: unknown[]) => void);
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
    async close() {
      if (closed) return;
      const ids = [...listeners.keys()];
      await Promise.all(ids.map((id) => roundTrip({ kind: "unsubscribe", id })));
      closed = true;
      listeners.clear();
      for (const request of pending.values()) request.reject(new Error("View port is closed"));
      pending.clear();
      port.off("message", onMessage);
    },
  };
}
