import type { Worker } from "node:worker_threads";
import type { AssetsPageDto } from "../src/lib/assets/types.ts";
import type { LiabilitiesPageDto } from "../src/lib/liabilities/types.ts";
import type { OverviewPageDto } from "../src/lib/overview/types.ts";
import type { SpendingLoadInput } from "../src/lib/spending/server/store.ts";
import type { DataReadOptions } from "../src/lib/shared-shell/data-version.ts";
import type { DashboardBlockKey } from "../src/lib/shared-shell/block-load-state.ts";
import type {
  SpendingCandidateActionInput,
  SpendingConfirmActionInput,
  SpendingPairingCandidatesInput,
  SpendingPairingCandidatesResult,
  SpendingLinkActionInput,
  SpendingPageDto,
  SpendingPurchaseActionResult,
} from "../src/lib/spending/model.ts";

export type FinancialPageRequest =
  | { id: number; page: "overview"; options?: DataReadOptions }
  | { id: number; page: "assets"; options?: DataReadOptions }
  | { id: number; page: "liabilities"; options?: DataReadOptions }
  | { id: number; page: "spending"; input?: SpendingLoadInput; options?: DataReadOptions }
  | {
    id: number;
    page: "block";
    target: "overview" | "assets" | "liabilities" | "spending" | "automation";
    block: DashboardBlockKey;
    options?: DataReadOptions;
  }
  | { id: number; page: "spending-pairing"; input: SpendingPairingCandidatesInput }
  | { id: number; page: "spending-action"; action: "confirmCandidate" | "denyCandidate" | "revokeLink"; input: SpendingConfirmActionInput | SpendingCandidateActionInput | SpendingLinkActionInput };

export type FinancialPageResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string };

type WorkerPort = Pick<Worker, "on" | "postMessage" | "terminate">;

const WORKER_CLOSED_MESSAGE = "Financial page worker is closed.";

export type FinancialPageWorkerClient = {
  load(page: "overview", options?: DataReadOptions): Promise<OverviewPageDto>;
  load(page: "assets", options?: DataReadOptions): Promise<AssetsPageDto>;
  load(page: "liabilities", options?: DataReadOptions): Promise<LiabilitiesPageDto>;
  load(page: "spending", input?: SpendingLoadInput, options?: DataReadOptions): Promise<SpendingPageDto>;
  loadBlock(
    page: "overview" | "assets" | "liabilities" | "spending" | "automation",
    block: DashboardBlockKey,
    options?: DataReadOptions,
  ): Promise<unknown>;
  rankPairingCandidates(input: SpendingPairingCandidatesInput): Promise<SpendingPairingCandidatesResult>;
  confirmCandidate(input: SpendingConfirmActionInput): Promise<SpendingPurchaseActionResult>;
  denyCandidate(input: SpendingCandidateActionInput): Promise<SpendingPurchaseActionResult>;
  revokeLink(input: SpendingLinkActionInput): Promise<SpendingPurchaseActionResult>;
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
    page: "overview" | "assets" | "liabilities" | "spending",
    inputOrOptions?: SpendingLoadInput | DataReadOptions,
    spendingOptions?: DataReadOptions,
  ): Promise<unknown> {
    if (closed) return Promise.reject(new Error(WORKER_CLOSED_MESSAGE));
    const id = nextId++;
    const input = page === "spending" ? inputOrOptions as SpendingLoadInput | undefined : undefined;
    const options = page === "spending" ? spendingOptions : inputOrOptions as DataReadOptions | undefined;
    const request: FinancialPageRequest = page === "spending"
      ? { id, page, ...(input ? { input } : {}), ...(options ? { options } : {}) }
      : { id, page, ...(options ? { options } : {}) };
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage(request);
    });
  }

  function loadBlock(
    page: "overview" | "assets" | "liabilities" | "spending" | "automation",
    block: DashboardBlockKey,
    options?: DataReadOptions,
  ): Promise<unknown> {
    if (closed) return Promise.reject(new Error(WORKER_CLOSED_MESSAGE));
    const id = nextId++;
    const request: FinancialPageRequest = { id, page: "block", target: page, block, options };
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage(request);
    });
  }

  function action(
    actionName: Extract<FinancialPageRequest, { page: "spending-action" }>["action"],
    input: SpendingConfirmActionInput | SpendingCandidateActionInput | SpendingLinkActionInput,
  ): Promise<SpendingPurchaseActionResult> {
    if (closed) return Promise.reject(new Error(WORKER_CLOSED_MESSAGE));
    const id = nextId++;
    const request: FinancialPageRequest = {
      id,
      page: "spending-action",
      action: actionName,
      input,
    };
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage(request);
    }) as Promise<SpendingPurchaseActionResult>;
  }

  function rankPairingCandidates(
    input: SpendingPairingCandidatesInput,
  ): Promise<SpendingPairingCandidatesResult> {
    if (closed) return Promise.reject(new Error(WORKER_CLOSED_MESSAGE));
    const id = nextId++;
    const request: FinancialPageRequest = { id, page: "spending-pairing", input };
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage(request);
    }) as Promise<SpendingPairingCandidatesResult>;
  }

  return {
    load: load as FinancialPageWorkerClient["load"],
    loadBlock,
    rankPairingCandidates,
    confirmCandidate: (input) => action("confirmCandidate", input),
    denyCandidate: (input) => action("denyCandidate", input),
    revokeLink: (input) => action("revokeLink", input),
    close: () => {
      if (closePromise) return closePromise;
      closed = true;
      rejectPending(new Error(WORKER_CLOSED_MESSAGE));
      closePromise = worker.terminate();
      return closePromise;
    },
  };
}
