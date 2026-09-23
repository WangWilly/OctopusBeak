import type { IpcMain, WebContents } from "electron";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import {
  type DataViewErrorCode,
  type DataViewErrorEvent,
  type DataViewRowsEvent,
  type DataViewSubscribeRequest,
  type DataViewSubscribeResult,
  type DataViewUnsubscribeRequest,
  type DataViewUnsubscribeResult,
} from "../src/lib/desktop/api.ts";
import {
  createPGliteViewWorkerClient,
  type PGliteViewWorkerClient,
} from "./pglite-view-worker-client.ts";

export const DATA_VIEWS_SUBSCRIBE_CHANNEL = "data-views:subscribe" as const;
export const DATA_VIEWS_UNSUBSCRIBE_CHANNEL = "data-views:unsubscribe" as const;
export const DATA_VIEWS_ROWS_CHANNEL = "data-views:rows" as const;
export const DATA_VIEWS_ERROR_CHANNEL = "data-views:error" as const;

export type PGliteViewIpcOptions = {
  /** The only database directory this worker may open. */
  dataDir: string;
  workerPath?: string;
  /** Injection seam for protocol tests; production creates the dedicated worker. */
  worker?: Pick<PGliteViewWorkerClient, "subscribe" | "onError" | "close">;
  /** A shared operational runtime closes this worker after IPC teardown. */
  workerOwned?: boolean;
};

type IpcMainBridge = Pick<IpcMain, "handle" | "removeHandler">;

type OwnedSubscription = {
  requestId: string;
  subscriptionId: string;
  sender: WebContents;
  cancelled: boolean;
  stop?: () => Promise<void>;
};

type SenderSubscriptions = {
  sender: WebContents;
  subscriptions: Map<string, OwnedSubscription>;
  onDestroyed: () => void;
  onNavigate: () => void;
};

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalidResult<T extends { ok: false; code: DataViewErrorCode; message: string }>(
  code: DataViewErrorCode,
  message: string,
): T {
  return { ok: false, code, message } as T;
}

function safeSend(sender: WebContents, channel: string, value: DataViewRowsEvent | DataViewErrorEvent): void {
  if (sender.isDestroyed()) return;
  try {
    sender.send(channel, value);
  } catch {
    // A renderer can disappear between isDestroyed and send.
  }
}

async function stopSafely(stop: (() => Promise<void>) | undefined): Promise<void> {
  if (!stop) return;
  try {
    await stop();
  } catch {
    // Sender teardown must remain best effort after the worker or renderer fails.
  }
}

const WORKER_UNAVAILABLE_MESSAGE = "The PGlite data worker is unavailable.";
const SUBSCRIPTION_FAILED_MESSAGE = "The named data view subscription failed.";

function validateSubscribeRequest(value: unknown): DataViewSubscribeRequest | undefined {
  if (!plainRecord(value)) return undefined;
  if (typeof value.requestId !== "string" || value.requestId.length === 0 || value.requestId.length > 200)
    return undefined;
  if (typeof value.view !== "string" || value.view.length === 0 || value.view.length > 200)
    return undefined;
  if (!plainRecord(value.params)) return undefined;
  return {
    requestId: value.requestId,
    view: value.view,
    params: value.params,
  };
}

function validateUnsubscribeRequest(value: unknown): DataViewUnsubscribeRequest | undefined {
  if (!plainRecord(value)) return undefined;
  if (typeof value.requestId !== "string" || value.requestId.length === 0 || value.requestId.length > 200)
    return undefined;
  if (typeof value.subscriptionId !== "string" || value.subscriptionId.length === 0 || value.subscriptionId.length > 200)
    return undefined;
  return {
    requestId: value.requestId,
    subscriptionId: value.subscriptionId,
  };
}

/** Main-process bridge for the named PGlite view worker. */
export function registerPGliteViewIpc(
  options: PGliteViewIpcOptions,
  bridge: IpcMainBridge,
) {
  if (!options.dataDir || typeof options.dataDir !== "string") {
    throw new TypeError("PGlite view IPC requires an explicit data directory.");
  }

  const worker = options.worker ?? createPGliteViewWorkerClient(
    new Worker(options.workerPath ?? join(__dirname, "pglite-view-worker.cjs"), {
      workerData: { dataDir: options.dataDir },
    }),
  );
  const workerOwned = options.workerOwned ?? true;
  const owners = new Map<number, SenderSubscriptions>();
  let workerFailure: Error | undefined;
  let closed = false;
  let nextSubscriptionId = 1;
  let closePromise: Promise<void> | undefined;

  const cleanupOwner = async (owner: SenderSubscriptions): Promise<void> => {
    if (owners.get(owner.sender.id) !== owner) return;
    owners.delete(owner.sender.id);
    owner.sender.removeListener("destroyed", owner.onDestroyed);
    owner.sender.removeListener("did-navigate", owner.onNavigate);
    const subscriptions = [...owner.subscriptions.values()];
    owner.subscriptions.clear();
    for (const subscription of subscriptions) subscription.cancelled = true;
    await Promise.all(subscriptions.map((subscription) => stopSafely(subscription.stop)));
  };

  const ownerFor = (sender: WebContents): SenderSubscriptions => {
    const existing = owners.get(sender.id);
    if (existing) return existing;
    const owner: SenderSubscriptions = {
      sender,
      subscriptions: new Map(),
      onDestroyed: () => { void cleanupOwner(owner); },
      onNavigate: () => { void cleanupOwner(owner); },
    };
    owners.set(sender.id, owner);
    sender.once("destroyed", owner.onDestroyed);
    sender.on("did-navigate", owner.onNavigate);
    return owner;
  };

  const reportWorkerFailure = (error: Error): void => {
    if (workerFailure) return;
    workerFailure = error;
    for (const owner of [...owners.values()]) {
      for (const subscription of owner.subscriptions.values()) {
        subscription.cancelled = true;
        safeSend(owner.sender, DATA_VIEWS_ERROR_CHANNEL, {
          requestId: subscription.requestId,
          subscriptionId: subscription.subscriptionId,
          code: "worker-unavailable",
          message: WORKER_UNAVAILABLE_MESSAGE,
        });
        void stopSafely(subscription.stop);
      }
      owner.subscriptions.clear();
      void cleanupOwner(owner);
    }
  };
  const removeWorkerErrorListener = worker.onError(reportWorkerFailure);

  const subscribe = async (event: { sender: WebContents }, value: unknown): Promise<DataViewSubscribeResult> => {
    if (closed) return invalidResult("worker-disabled", "PGlite view IPC is closed.");
    const request = validateSubscribeRequest(value);
    if (!request) return invalidResult("invalid-request", "Invalid named view subscription request.");
    if (workerFailure) return invalidResult("worker-unavailable", WORKER_UNAVAILABLE_MESSAGE);
    const owner = ownerFor(event.sender);
    if (owner.subscriptions.has(request.requestId)) {
      return invalidResult("duplicate-subscription", "The renderer already owns this subscription request.");
    }
    const subscription: OwnedSubscription = {
      requestId: request.requestId,
      subscriptionId: `${event.sender.id}:${nextSubscriptionId++}`,
      sender: event.sender,
      cancelled: false,
    };
    owner.subscriptions.set(request.requestId, subscription);
    try {
      const stop = await worker.subscribe(
        request.view,
        request.params,
        (rows) => {
          if (!subscription.cancelled) {
            safeSend(owner.sender, DATA_VIEWS_ROWS_CHANNEL, {
              requestId: subscription.requestId,
              subscriptionId: subscription.subscriptionId,
              rows,
            });
          }
        },
        () => {
          if (!subscription.cancelled) {
            safeSend(owner.sender, DATA_VIEWS_ERROR_CHANNEL, {
              requestId: subscription.requestId,
              subscriptionId: subscription.subscriptionId,
              code: "subscription-failed",
              message: SUBSCRIPTION_FAILED_MESSAGE,
            });
          }
        },
      );
      if (subscription.cancelled || owners.get(owner.sender.id) !== owner) {
        await stopSafely(stop);
        return invalidResult("subscription-failed", "The subscription owner was closed.");
      }
      subscription.stop = stop;
      return { ok: true, subscriptionId: subscription.subscriptionId };
    } catch {
      if (owner.subscriptions.get(request.requestId) === subscription) owner.subscriptions.delete(request.requestId);
      if (owner.subscriptions.size === 0) await cleanupOwner(owner);
      return invalidResult(
        workerFailure ? "worker-unavailable" : "subscription-failed",
        workerFailure ? WORKER_UNAVAILABLE_MESSAGE : SUBSCRIPTION_FAILED_MESSAGE,
      );
    }
  };

  const unsubscribe = async (event: { sender: WebContents }, value: unknown): Promise<DataViewUnsubscribeResult> => {
    if (closed) return invalidResult("worker-disabled", "PGlite view IPC is closed.");
    const request = validateUnsubscribeRequest(value);
    if (!request) return invalidResult("invalid-request", "Invalid named view unsubscribe request.");
    const owner = owners.get(event.sender.id);
    const subscription = owner?.subscriptions.get(request.requestId);
    if (!owner || !subscription || subscription.subscriptionId !== request.subscriptionId) {
      return invalidResult("invalid-request", "The subscription is not owned by this renderer.");
    }
    owner.subscriptions.delete(request.requestId);
    subscription.cancelled = true;
    await stopSafely(subscription.stop);
    if (owner.subscriptions.size === 0) await cleanupOwner(owner);
    return { ok: true };
  };

  bridge.handle(DATA_VIEWS_SUBSCRIBE_CHANNEL, subscribe);
  bridge.handle(DATA_VIEWS_UNSUBSCRIBE_CHANNEL, unsubscribe);

  return {
    async close() {
      if (closePromise) return closePromise;
      closed = true;
      bridge.removeHandler(DATA_VIEWS_SUBSCRIBE_CHANNEL);
      bridge.removeHandler(DATA_VIEWS_UNSUBSCRIBE_CHANNEL);
      removeWorkerErrorListener();
      closePromise = (async () => {
        await Promise.all([...owners.values()].map((owner) => cleanupOwner(owner)));
        if (workerOwned) await worker.close();
      })();
      return closePromise;
    },
  };
}

export type PGliteViewIpcRegistration = ReturnType<typeof registerPGliteViewIpc>;
