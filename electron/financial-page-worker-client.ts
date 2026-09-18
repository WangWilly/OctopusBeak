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
  | { id: number; page: "overview"; input?: FinancialPageLoadInput }
  | { id: number; page: "assets"; input?: FinancialPageLoadInput }
  | { id: number; page: "liabilities"; input?: FinancialPageLoadInput }
  | { id: number; page: "spending"; input?: SpendingLoadInput }
  | { id: number; page: "overview-section"; section: FinancialSection; input?: FinancialPageLoadInput }
  | { id: number; page: "assets-section"; section: FinancialSection; input?: FinancialPageLoadInput }
  | { id: number; page: "liabilities-section"; section: FinancialSection; input?: FinancialPageLoadInput }
  | { id: number; page: "spending-section"; section: FinancialSection; input?: SpendingLoadInput }
  | { id: number; page: "spending-action"; action: "confirmCandidate" | "denyCandidate" | "revokeLink"; input: SpendingConfirmActionInput | SpendingCandidateActionInput | SpendingLinkActionInput };

export type FinancialPageResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string };

type WorkerPort = Pick<Worker, "on" | "postMessage" | "terminate">;

export type FinancialPageLoadInput = Readonly<{
  cutoff?: FinancialQueryCutoff;
}>;

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
  load(page: "overview", input?: FinancialPageLoadInput): Promise<OverviewPageDto>;
  load(page: "assets", input?: FinancialPageLoadInput): Promise<AssetsPageDto>;
  load(page: "liabilities", input?: FinancialPageLoadInput): Promise<LiabilitiesPageDto>;
  load(page: "spending", input?: SpendingLoadInput): Promise<SpendingPageDto>;
  loadSection(
    page: "overview",
    section: "primary",
    input?: FinancialPageLoadInput,
  ): Promise<OverviewPrimarySection>;
  loadSection(
    page: "overview",
    section: "secondary",
    input?: FinancialPageLoadInput,
  ): Promise<OverviewSecondarySection>;
  loadSection(
    page: "overview",
    section: FinancialSection,
    input?: FinancialPageLoadInput,
  ): Promise<OverviewPrimarySection | OverviewSecondarySection>;
  loadSection(
    page: "assets",
    section: "primary",
    input?: FinancialPageLoadInput,
  ): Promise<AssetsPrimarySection>;
  loadSection(
    page: "assets",
    section: "secondary",
    input?: FinancialPageLoadInput,
  ): Promise<AssetsSecondarySection>;
  loadSection(
    page: "assets",
    section: FinancialSection,
    input?: FinancialPageLoadInput,
  ): Promise<AssetsPrimarySection | AssetsSecondarySection>;
  loadSection(
    page: "liabilities",
    section: "primary",
    input?: FinancialPageLoadInput,
  ): Promise<LiabilitiesPrimarySection>;
  loadSection(
    page: "liabilities",
    section: "secondary",
    input?: FinancialPageLoadInput,
  ): Promise<LiabilitiesSecondarySection>;
  loadSection(
    page: "liabilities",
    section: FinancialSection,
    input?: FinancialPageLoadInput,
  ): Promise<LiabilitiesPrimarySection | LiabilitiesSecondarySection>;
  loadSection(
    page: "spending",
    section: "primary",
    input?: SpendingLoadInput,
  ): Promise<SpendingPrimarySection>;
  loadSection(
    page: "spending",
    section: "secondary",
    input?: SpendingLoadInput,
  ): Promise<SpendingSecondarySection>;
  loadSection(
    page: "spending",
    section: FinancialSection,
    input?: SpendingLoadInput,
  ): Promise<SpendingPrimarySection | SpendingSecondarySection>;
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
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      cutoff?: number;
      telemetry: FinancialPerformanceOperation;
    }
  >();

  const rejectPending = (error: Error) => {
    for (const request of pending.values()) {
      const response = request.telemetry.startSpan("worker-response");
      response.finish("error", { error });
      request.reject(error);
    }
    pending.clear();
  };

  worker.on("message", (message: FinancialPageResponse) => {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    const response = request.telemetry.startSpan("worker-response");
    if (message.ok) {
      const served = servedKnowledgePoint(message.value);
      if (
        request.cutoff !== undefined &&
        served !== request.cutoff
      ) {
        const error = new Error("canonical-cutoff-unavailable");
        response.finish("error", { error });
        request.reject(error);
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
  ): Promise<unknown> {
    if (closed) return Promise.reject(new Error(WORKER_CLOSED_MESSAGE));
    const id = nextId++;
    const request: FinancialPageRequest = input
      ? { id, page, input } as FinancialPageRequest
      : { id, page } as FinancialPageRequest;
    const telemetry = financialPerformanceTelemetry.startOperation("financial-load");
    const cutoff = input && "cutoff" in input
      ? input.cutoff?.knowledgePoint
      : undefined;
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject, cutoff, telemetry });
      const dispatch = telemetry.startSpan("worker-dispatch");
      try {
        worker.postMessage(request);
        dispatch.finish();
      } catch (error) {
        pending.delete(id);
        dispatch.finish("error", { error });
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  function loadSection(
    page: FinancialSectionPage,
    section: FinancialSection,
    input?: SpendingLoadInput | FinancialPageLoadInput,
  ): Promise<FinancialSectionResult> {
    if (closed) return Promise.reject(new Error(WORKER_CLOSED_MESSAGE));
    const id = nextId++;
    const sectionPage = `${page}-section` as FinancialPageRequest["page"];
    const request = {
      id,
      page: sectionPage,
      section,
      ...(input === undefined ? {} : { input }),
    } as FinancialPageRequest;
    const telemetry = financialPerformanceTelemetry.startOperation("financial-load");
    const cutoff = input && "cutoff" in input
      ? input.cutoff?.knowledgePoint
      : undefined;
    return new Promise<FinancialSectionResult>((resolve, reject) => {
      pending.set(id, {
        resolve: resolve as unknown as (value: unknown) => void,
        reject,
        cutoff,
        telemetry,
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
      pending.set(id, { resolve, reject, telemetry });
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

  return {
    load: load as FinancialPageWorkerClient["load"],
    loadSection: loadSection as FinancialPageWorkerClient["loadSection"],
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
