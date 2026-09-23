import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { IpcMainInvokeEvent } from "electron";
import {
  DATA_VIEWS_ERROR_CHANNEL,
  DATA_VIEWS_ROWS_CHANNEL,
  DATA_VIEWS_SUBSCRIBE_CHANNEL,
  DATA_VIEWS_UNSUBSCRIBE_CHANNEL,
  registerPGliteViewIpc,
} from "./pglite-ipc.ts";

class FakeSender extends EventEmitter {
  readonly id: number;
  destroyed = false;
  readonly sent: Array<{ channel: string; value: unknown }> = [];

  constructor(id: number) {
    super();
    this.id = id;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  send(channel: string, value: unknown): void {
    this.sent.push({ channel, value });
  }
}

test("PGlite IPC scopes subscriptions to senders and drains failures", async () => {
  type HandlerResult = { ok: boolean; code?: string; message?: string; subscriptionId?: string };
  type Handler = (event: { sender: FakeSender }, value: unknown) => Promise<HandlerResult>;
  type BridgeHandler = (event: IpcMainInvokeEvent, ...args: any[]) => unknown;
  const handlers = new Map<string, Handler>();
  const removed: string[] = [];
  const bridge = {
    handle(channel: string, handler: BridgeHandler) { handlers.set(channel, handler as unknown as Handler); },
    removeHandler(channel: string) { removed.push(channel); handlers.delete(channel); },
  };
  const stops = new Map<string, number>();
  const rowListeners = new Map<string, (rows: unknown[]) => void>();
  let workerFailure: ((error: Error) => void) | undefined;
  let workerClosed = false;
  const worker = {
    async subscribe<Row>(view: string, _params: object, onRows: (rows: Row[]) => void) {
      if (view === "broken") throw new Error("/private/raw/database/path");
      assert.equal(view, "system.health");
      const key = `${rowListeners.size + 1}`;
      rowListeners.set(key, onRows as (rows: unknown[]) => void);
      return async () => { stops.set(key, (stops.get(key) ?? 0) + 1); };
    },
    onError(listener: (error: Error) => void) {
      workerFailure = listener;
      return () => { workerFailure = undefined; };
    },
    async close() {
      workerClosed = true;
      return 0;
    },
  };
  const registration = registerPGliteViewIpc({ dataDir: "/tmp/pglite-ipc-check", worker }, bridge);
  const subscribe = handlers.get(DATA_VIEWS_SUBSCRIBE_CHANNEL);
  const unsubscribe = handlers.get(DATA_VIEWS_UNSUBSCRIBE_CHANNEL);
  assert.ok(subscribe);
  assert.ok(unsubscribe);
  const first = new FakeSender(11);
  const second = new FakeSender(12);

  const result = await subscribe({ sender: first }, {
    requestId: "request-1",
    view: "system.health",
    params: {},
  }) as { ok: true; subscriptionId: string };
  assert.equal(result.ok, true);
  assert.equal((await subscribe({ sender: first }, {
    requestId: "request-1",
    view: "system.health",
    params: {},
  })).code, "duplicate-subscription");
  assert.equal((await unsubscribe({ sender: second }, {
    requestId: "request-1",
    subscriptionId: result.subscriptionId,
  })).code, "invalid-request");
  rowListeners.get("1")?.([{ ready: true }]);
  assert.equal(first.sent[0]?.channel, DATA_VIEWS_ROWS_CHANNEL);
  assert.equal((await unsubscribe({ sender: first }, {
    requestId: "request-1",
    subscriptionId: result.subscriptionId,
  })).ok, true);
  assert.equal(stops.get("1"), 1);

  const failed = await subscribe({ sender: first }, {
    requestId: "request-failed",
    view: "broken",
    params: {},
  }) as { ok: false; code: string; message: string };
  assert.equal(failed.code, "subscription-failed");
  assert.equal(failed.message, "The named data view subscription failed.");
  assert.equal(first.listenerCount("did-navigate"), 0, "failed empty owners are cleaned up");

  const secondResult = await subscribe({ sender: first }, {
    requestId: "request-2",
    view: "system.health",
    params: {},
  }) as { ok: true; subscriptionId: string };
  first.emit("did-navigate");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(stops.get("2"), 1, "renderer navigation stops old page subscriptions");
  assert.equal(secondResult.ok, true);

  const thirdResult = await subscribe({ sender: second }, {
    requestId: "request-3",
    view: "system.health",
    params: {},
  }) as { ok: true; subscriptionId: string };
  workerFailure?.(new Error("worker gone"));
  assert.equal(second.sent.at(-1)?.channel, DATA_VIEWS_ERROR_CHANNEL);
  assert.equal((second.sent.at(-1)?.value as { code?: string }).code, "worker-unavailable");
  assert.equal(second.listenerCount("did-navigate"), 0, "worker failure removes empty renderer owners");
  assert.equal((await unsubscribe({ sender: second }, {
    requestId: "request-3",
    subscriptionId: thirdResult.subscriptionId,
  })).code, "invalid-request");

  await registration.close();
  assert.equal(workerClosed, true);
  assert.deepEqual(removed, [DATA_VIEWS_SUBSCRIBE_CHANNEL, DATA_VIEWS_UNSUBSCRIBE_CHANNEL]);
});
