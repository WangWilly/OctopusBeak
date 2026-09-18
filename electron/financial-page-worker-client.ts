import type { Worker } from "node:worker_threads";
import type { AssetsPageDto } from "../src/lib/assets/types.ts";
import type { LiabilitiesPageDto } from "../src/lib/liabilities/types.ts";
import type { OverviewPageDto } from "../src/lib/overview/types.ts";
import type { SpendingLoadInput } from "../src/lib/spending/server/store.ts";
import type { FinancialQueryCutoff } from "../src/lib/shared-ledger/server/financial-query.ts";
import type { FinancialSection } from "../src/lib/shared-ledger/financial-section.ts";
import type {
  OverviewPrimarySection,
  OverviewSecondarySection,
} from "../src/lib/overview/types.ts";
import type {
  AssetsPrimarySection,
  AssetsSecondarySection,
} from "../src/lib/assets/types.ts";
import type {
  LiabilitiesPrimarySection,
  LiabilitiesSecondarySection,
} from "../src/lib/liabilities/types.ts";
import type {
  SpendingPrimarySection,
  SpendingSecondarySection,
} from "../src/lib/spending/model.ts";
import type {
  SpendingCandidateActionInput,
  SpendingConfirmActionInput,
  SpendingLinkActionInput,
  SpendingPageDto,
  SpendingPurchaseActionResult,
} from "../src/lib/spending/model.ts";
import {
  financialPerformanceTelemetry,
  type FinancialPerformanceOperation,
} from "../src/lib/performance/financial-performance-telemetry.ts";

export type FinancialPageRequest =
  | { id: number; page: "overview"; input?: FinancialPageLoadInput; requestToken?: string }
  | { id: number; page: "assets"; input?: FinancialPageLoadInput; requestToken?: string }
  | { id: number; page: "liabilities"; input?: FinancialPageLoadInput; requestToken?: string }
  | { id: number; page: "spending"; input?: SpendingLoadInput; requestToken?: string }
  | { id: number; page: "overview-section"; section: FinancialSection; input?: FinancialPageLoadInput; requestToken?: string }
  | { id: number; page: "assets-section"; section: FinancialSection; input?: FinancialPageLoadInput; requestToken?: string }
  | { id: number; page: "liabilities-section"; section: FinancialSection; input?: FinancialPageLoadInput; requestToken?: string }
  | { id: number; page: "spending-section"; section: FinancialSection; input?: SpendingLoadInput; requestToken?: string }
  | { id: number; page: "spending-action"; action: "confirmCandidate" | "denyCandidate" | "revokeLink"; input: SpendingConfirmActionInput | SpendingCandidateActionInput | SpendingLinkActionInput };

export type FinancialPageResponse =
  | { id: number; ok: true; value: unknown; requestToken?: string }
  | { id: number; ok: false; error: string; requestToken?: string };

type WorkerPort = Pick<Worker, "on" | "postMessage" | "terminate">;

export type FinancialPageLoadInput = Readonly<{
  cutoff?: FinancialQueryCutoff;
}>;

export type FinancialPageRequestToken = string;

export type FinancialSectionPage = "overview" | "assets" | "liabilities" | "spending";
export type FinancialSectionResult =
  | OverviewPrimarySection
  | OverviewSecondarySection
  | AssetsPrimarySection
  | AssetsSecondarySection
  | LiabilitiesPrimarySection
  | LiabilitiesSecondarySection
  | SpendingPrimarySection
  | SpendingSecondarySection;

const WORKER_CLOSED_MESSAGE = "Financial page worker is closed.";
const FINANCIAL_READ_QUEUE_LIMIT = 32;

class FinancialReadCancelledError extends Error {
  constructor() {
    super("Financial page read was cancelled.");
    this.name = "FinancialReadCancelledError";
  }
}

function servedKnowledgePoint(value: unknown): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const candidate = record.knowledgePoint ??
    (record.canonical && typeof record.canonical === "object" && !Array.isArray(record.canonical)
      ? (record.canonical as Record<string, unknown>).knowledgePoint
      : undefined);
  return typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0
    ? candidate
    : null;
}

export type FinancialPageWorkerClient = {
  load(page: "overview", input?: FinancialPageLoadInput, requestToken?: FinancialPageRequestToken): Promise<OverviewPageDto>;
  load(page: "assets", input?: FinancialPageLoadInput, requestToken?: FinancialPageRequestToken): Promise<AssetsPageDto>;
  load(page: "liabilities", input?: FinancialPageLoadInput, requestToken?: FinancialPageRequestToken): Promise<LiabilitiesPageDto>;
  load(page: "spending", input?: SpendingLoadInput, requestToken?: FinancialPageRequestToken): Promise<SpendingPageDto>;
  loadSection(
    page: "overview",
    section: "primary",
    input?: FinancialPageLoadInput,
    requestToken?: FinancialPageRequestToken,
  ): Promise<OverviewPrimarySection>;
  loadSection(
    page: "overview",
    section: "secondary",
    input?: FinancialPageLoadInput,
    requestToken?: FinancialPageRequestToken,
  ): Promise<OverviewSecondarySection>;
  loadSection(
    page: "overview",
    section: FinancialSection,
    input?: FinancialPageLoadInput,
    requestToken?: FinancialPageRequestToken,
  ): Promise<OverviewPrimarySection | OverviewSecondarySection>;
  loadSection(
    page: "assets",
    section: "primary",
    input?: FinancialPageLoadInput,
    requestToken?: FinancialPageRequestToken,
  ): Promise<AssetsPrimarySection>;
  loadSection(
    page: "assets",
    section: "secondary",
    input?: FinancialPageLoadInput,
    requestToken?: FinancialPageRequestToken,
  ): Promise<AssetsSecondarySection>;
  loadSection(
    page: "assets",
    section: FinancialSection,
    input?: FinancialPageLoadInput,
    requestToken?: FinancialPageRequestToken,
  ): Promise<AssetsPrimarySection | AssetsSecondarySection>;
  loadSection(
    page: "liabilities",
    section: "primary",
    input?: FinancialPageLoadInput,
    requestToken?: FinancialPageRequestToken,
  ): Promise<LiabilitiesPrimarySection>;
  loadSection(
    page: "liabilities",
    section: "secondary",
    input?: FinancialPageLoadInput,
    requestToken?: FinancialPageRequestToken,
  ): Promise<LiabilitiesSecondarySection>;
  loadSection(
    page: "liabilities",
    section: FinancialSection,
    input?: FinancialPageLoadInput,
    requestToken?: FinancialPageRequestToken,
  ): Promise<LiabilitiesPrimarySection | LiabilitiesSecondarySection>;
  loadSection(
    page: "spending",
    section: "primary",
    input?: SpendingLoadInput,
    requestToken?: FinancialPageRequestToken,
  ): Promise<SpendingPrimarySection>;
  loadSection(
    page: "spending",
    section: "secondary",
    input?: SpendingLoadInput,
    requestToken?: FinancialPageRequestToken,
  ): Promise<SpendingSecondarySection>;
  loadSection(
    page: "spending",
    section: FinancialSection,
    input?: SpendingLoadInput,
    requestToken?: FinancialPageRequestToken,
  ): Promise<SpendingPrimarySection | SpendingSecondarySection>;
  confirmCandidate(input: SpendingConfirmActionInput): Promise<SpendingPurchaseActionResult>;
  denyCandidate(input: SpendingCandidateActionInput): Promise<SpendingPurchaseActionResult>;
  revokeLink(input: SpendingLinkActionInput): Promise<SpendingPurchaseActionResult>;
  cancel(requestToken: FinancialPageRequestToken): void;
  close(): Promise<number>;
};

export function createFinancialPageWorkerClient(
  worker: WorkerPort,
): FinancialPageWorkerClient {
  let nextId = 1;
  let closed = false;
  let closePromise: Promise<number> | null = null;
  type PendingRequest = {
    request: FinancialPageRequest;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    cutoff?: number;
    telemetry: FinancialPerformanceOperation;
    kind: "read" | "mutation";
    requestToken?: FinancialPageRequestToken;
    cancelled: boolean;
  };
  const pending = new Map<number, PendingRequest>();
  const readQueue: number[] = [];
  const cancelledActiveReads = new Map<number, FinancialPageRequestToken>();
  let activeReadId: number | null = null;

  const finishCancelled = (request: PendingRequest) => {
    const response = request.telemetry.startSpan("worker-response");
    const error = new FinancialReadCancelledError();
    response.finish("error", { error });
    request.reject(error);
  };

  const dispatchNextRead = () => {
    if (closed || activeReadId !== null) return;
    const nextId = readQueue.shift();
    if (nextId === undefined) return;
    const request = pending.get(nextId);
    if (!request || request.kind !== "read" || request.cancelled) {
      dispatchNextRead();
      return;
    }
    activeReadId = nextId;
    const workerRequest = request.request as FinancialPageRequest;
    const dispatch = request.telemetry.startSpan("worker-dispatch");
    try {
      worker.postMessage(workerRequest);
      dispatch.finish();
    } catch (error) {
      activeReadId = null;
      pending.delete(nextId);
      dispatch.finish("error", { error });
      request.reject(error instanceof Error ? error : new Error(String(error)));
      dispatchNextRead();
    }
  };

  const rejectPending = (error: Error) => {
    for (const request of pending.values()) {
      const response = request.telemetry.startSpan("worker-response");
      response.finish("error", { error });
      request.reject(error);
    }
    pending.clear();
    readQueue.length = 0;
    cancelledActiveReads.clear();
    activeReadId = null;
  };

  worker.on("message", (message: FinancialPageResponse) => {
    const request = pending.get(message.id);
    if (!request) {
      const cancelledToken = cancelledActiveReads.get(message.id);
      if (cancelledToken !== undefined && cancelledToken !== message.requestToken) return;
      if (cancelledToken !== undefined) cancelledActiveReads.delete(message.id);
      if (activeReadId === message.id) {
        activeReadId = null;
        dispatchNextRead();
      }
      return;
    }
    if (
      request.kind === "read" &&
      request.requestToken !== message.requestToken
    ) return;
    pending.delete(message.id);
    if (activeReadId === message.id) activeReadId = null;
    const response = request.telemetry.startSpan("worker-response");
    if (request.cancelled) {
      response.finish("error", { error: new FinancialReadCancelledError() });
      dispatchNextRead();
      return;
    }
    if (message.ok) {
      const served = servedKnowledgePoint(message.value);
      if (
        request.cutoff !== undefined &&
        served !== request.cutoff
      ) {
        const error = new Error("canonical-cutoff-unavailable");
        response.finish("error", { error });
        request.reject(error);
        dispatchNextRead();
        return;
      }
      response.finish("success", {
        knowledgePointDistance: request.cutoff === undefined || served === null
          ? null
          : Math.abs(served - request.cutoff),
      });
      request.resolve(message.value);
    }
    else {
      const error = new Error(message.error);
      response.finish("error", { error });
      request.reject(error);
    }
    dispatchNextRead();
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
    input?: SpendingLoadInput | FinancialPageLoadInput,
    requestToken?: FinancialPageRequestToken,
  ): Promise<unknown> {
    if (closed) return Promise.reject(new Error(WORKER_CLOSED_MESSAGE));
    if (readQueue.length >= FINANCIAL_READ_QUEUE_LIMIT) {
      return Promise.reject(new Error("Financial page read queue is full."));
    }
    const id = nextId++;
    const request: FinancialPageRequest = input
      ? { id, page, input, ...(requestToken === undefined ? {} : { requestToken }) } as FinancialPageRequest
      : { id, page, ...(requestToken === undefined ? {} : { requestToken }) } as FinancialPageRequest;
    const telemetry = financialPerformanceTelemetry.startOperation("financial-load");
    const cutoff = input && "cutoff" in input
      ? input.cutoff?.knowledgePoint
      : undefined;
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, {
        request,
        resolve,
        reject,
        cutoff,
        telemetry,
        kind: "read",
        requestToken,
        cancelled: false,
      });
      readQueue.push(id);
      dispatchNextRead();
    });
  }

  function loadSection(
    page: FinancialSectionPage,
    section: FinancialSection,
    input?: SpendingLoadInput | FinancialPageLoadInput,
    requestToken?: FinancialPageRequestToken,
  ): Promise<FinancialSectionResult> {
    if (closed) return Promise.reject(new Error(WORKER_CLOSED_MESSAGE));
    if (readQueue.length >= FINANCIAL_READ_QUEUE_LIMIT) {
      return Promise.reject(new Error("Financial page read queue is full."));
    }
    const id = nextId++;
    const sectionPage = `${page}-section` as FinancialPageRequest["page"];
    const request = {
      id,
      page: sectionPage,
      section,
      ...(input === undefined ? {} : { input }),
      ...(requestToken === undefined ? {} : { requestToken }),
    } as FinancialPageRequest;
    const telemetry = financialPerformanceTelemetry.startOperation("financial-load");
    const cutoff = input && "cutoff" in input
      ? input.cutoff?.knowledgePoint
      : undefined;
    return new Promise<FinancialSectionResult>((resolve, reject) => {
      pending.set(id, {
        request,
        resolve: resolve as unknown as (value: unknown) => void,
        reject,
        cutoff,
        telemetry,
        kind: "read",
        requestToken,
        cancelled: false,
      });
      readQueue.push(id);
      dispatchNextRead();
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
    const telemetry = financialPerformanceTelemetry.startOperation("spending-action");
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, {
        request,
        resolve,
        reject,
        telemetry,
        kind: "mutation",
        cancelled: false,
      });
      const dispatch = telemetry.startSpan("worker-dispatch");
      try {
        worker.postMessage(request);
        dispatch.finish();
      } catch (error) {
        pending.delete(id);
        dispatch.finish("error", { error });
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    }) as Promise<SpendingPurchaseActionResult>;
  }

  function cancel(requestToken: FinancialPageRequestToken): void {
    if (closed) return;
    for (const [id, request] of pending) {
      if (request.kind !== "read" || request.requestToken !== requestToken) continue;
      request.cancelled = true;
      pending.delete(id);
      if (activeReadId === id && request.requestToken !== undefined) {
        cancelledActiveReads.set(id, request.requestToken);
      }
      finishCancelled(request);
    }
    for (let index = readQueue.length - 1; index >= 0; index -= 1) {
      if (!pending.has(readQueue[index])) readQueue.splice(index, 1);
    }
    dispatchNextRead();
  }

  return {
    load: load as FinancialPageWorkerClient["load"],
    loadSection: loadSection as FinancialPageWorkerClient["loadSection"],
    confirmCandidate: (input) => action("confirmCandidate", input),
    denyCandidate: (input) => action("denyCandidate", input),
    revokeLink: (input) => action("revokeLink", input),
    cancel,
    close: () => {
      if (closePromise) return closePromise;
      closed = true;
      rejectPending(new Error(WORKER_CLOSED_MESSAGE));
      closePromise = worker.terminate();
      return closePromise;
    },
  };
}
