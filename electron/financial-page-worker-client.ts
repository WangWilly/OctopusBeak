import type { Worker } from "node:worker_threads";
import type { AssetsPageDto } from "../src/lib/assets/types.ts";
import type { LiabilitiesPageDto } from "../src/lib/liabilities/types.ts";
import type { OverviewPageDto } from "../src/lib/overview/types.ts";
import type { SpendingLoadInput } from "../src/lib/spending/server/store.ts";
import type { SpendingPageDto } from "../src/lib/spending/model.ts";

export type FinancialPageRequest =
  | { id: number; page: "overview" }
  | { id: number; page: "assets" }
  | { id: number; page: "liabilities" }
  | { id: number; page: "spending"; input?: SpendingLoadInput };

export type FinancialPageResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string };

type WorkerPort = Pick<Worker, "on" | "postMessage" | "terminate">;

const WORKER_CLOSED_MESSAGE = "Financial page worker is closed.";

export type FinancialPageWorkerClient = {
  load(page: "overview"): Promise<OverviewPageDto>;
  load(page: "assets"): Promise<AssetsPageDto>;
  load(page: "liabilities"): Promise<LiabilitiesPageDto>;
  load(page: "spending", input?: SpendingLoadInput): Promise<SpendingPageDto>;
  close(): Promise<number>;
};

export function createFinancialPageWorkerClient(
  worker: WorkerPort,
): FinancialPageWorkerClient {
  let nextId = 1;
  let closed = false;
  let closePromise: Promise<number> | null = null;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  const rejectPending = (error: Error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };

  worker.on("message", (message: FinancialPageResponse) => {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.ok) request.resolve(message.value);
    else request.reject(new Error(message.error));
  });
  worker.on("error", (error) => rejectPending(
    error instanceof Error ? error : new Error(String(error)),
  ));
  worker.on("exit", (code) => {
    if (!closed || pending.size > 0)
      rejectPending(new Error(`Financial page worker exited with code ${code}.`));
  });

  function load(
    page: FinancialPageRequest["page"],
    input?: SpendingLoadInput,
  ): Promise<unknown> {
    if (closed) return Promise.reject(new Error(WORKER_CLOSED_MESSAGE));
    const id = nextId++;
    const request: FinancialPageRequest = page === "spending"
      ? { id, page, ...(input ? { input } : {}) }
      : { id, page };
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage(request);
    });
  }

  return {
    load: load as FinancialPageWorkerClient["load"],
    close: () => {
      if (closePromise) return closePromise;
      closed = true;
      rejectPending(new Error(WORKER_CLOSED_MESSAGE));
      closePromise = worker.terminate();
      return closePromise;
    },
  };
}
