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

/** Wire a named-view source to a worker MessagePort without exposing SQL. */
export function createViewPortServer<View extends string>(port: Port, source: ViewSource<View>) {
  const stops = new Map<number, Stop>();
  let closed = false;
  const onMessage = (request: Request) => {
    if (closed) return;
    if (request.kind === "subscribe") {
      void source.subscribe(request.view as View, request.params, (rows) => {
        if (!closed) port.postMessage({ kind: "rows", id: request.id, rows } satisfies Response);
      }).then((stop) => {
        if (closed) void stop();
        else {
          stops.set(request.id, stop);
          port.postMessage({ kind: "ready", id: request.id } satisfies Response);
        }
      }).catch(() => {
        if (!closed) port.postMessage({ kind: "error", id: request.id, code: "subscription-failed" } satisfies Response);
      });
    } else {
      const stop = stops.get(request.id);
      stops.delete(request.id);
      void (stop?.() ?? Promise.resolve()).then(() => {
        if (!closed) port.postMessage({ kind: "stopped", id: request.id } satisfies Response);
      });
    }
  };
  port.on("message", onMessage);
  return {
    async close() {
      closed = true;
      port.off("message", onMessage);
      await Promise.all([...stops.values()].map((stop) => stop()));
      stops.clear();
    },
  };
}

/** Client for the restricted named-view wire protocol. */
export function createViewPortClient(port: Port) {
  let nextId = 1;
  let closed = false;
  const listeners = new Map<number, (rows: unknown[]) => void>();
  const pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
  const onMessage = (response: Response) => {
    if (response.kind === "rows") listeners.get(response.id)?.(response.rows);
    else {
      const request = pending.get(response.id);
      if (!request) return;
      pending.delete(response.id);
      if (response.kind === "error") request.reject(new Error(response.code));
      else request.resolve();
    }
  };
  port.on("message", onMessage);

  function roundTrip(request: Request): Promise<void> {
    return new Promise((resolve, reject) => {
      pending.set(request.id, { resolve, reject });
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
