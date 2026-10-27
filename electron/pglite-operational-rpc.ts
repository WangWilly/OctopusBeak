import type {
  AutomationPersistencePort,
  AutomationPersistenceProvider,
} from "../src/lib/automation/server/store.ts";
import type { ExchangeRatePersistencePort } from "../src/ledger/exchange-rates.ts";
import { isCommitAttemptReport } from "../src/lib/automation/commit-attempt.ts";
import type { PGliteMaicoinPersistencePort } from "../src/ledger/pglite/maicoin-operational.ts";
import { isPreviewProduct, type PGlitePreviewFinancialDataPort } from "../src/ledger/pglite/preview-financial-data.ts";
import {
  appendWorkflowFailureDiagnostic,
  isWorkflowFailureCorrelation,
  workflowFailureDiagnosticRepoRoot,
  WORKFLOW_FAILURE_DIAGNOSTICS_FILE_ENV,
  type WorkflowFailureCorrelation,
} from "../src/lib/automation/server/workflow-failure-diagnostics.ts";

/**
 * The operational worker protocol is deliberately method based.  There is no
 * SQL operation in its contract table, so renderer input can never become a database
 * statement or identifier.
 */
export const PGLITE_OPERATIONAL_RPC_VERSION = 1 as const;

type OperationalPorts = {
  automation: AutomationPersistencePort;
  exchangeRates: ExchangeRatePersistencePort;
  maicoin: PGliteMaicoinPersistencePort;
  preview: PGlitePreviewFinancialDataPort;
};
type OperationalDomain = keyof OperationalPorts;

export type PGliteOperationalDomains = AutomationPersistenceProvider & Omit<OperationalPorts, "automation">;

export type PGliteOperationalOperation = {
  [Domain in OperationalDomain]: `${Domain}.${keyof OperationalPorts[Domain] & string}`;
}[OperationalDomain];

export type PGliteOperationalRequest = {
  readonly kind: "pglite-operational-request";
  readonly version: typeof PGLITE_OPERATIONAL_RPC_VERSION;
  readonly id: number;
  readonly operation: PGliteOperationalOperation | string;
  readonly args: readonly unknown[];
  readonly diagnosticContext?: WorkflowFailureCorrelation;
};

export type PGliteOperationalResponse =
  | {
    readonly kind: "pglite-operational-response";
    readonly version: typeof PGLITE_OPERATIONAL_RPC_VERSION;
    readonly id: number;
    readonly ok: true;
    readonly value: unknown;
  }
  | {
    readonly kind: "pglite-operational-response";
    readonly version: typeof PGLITE_OPERATIONAL_RPC_VERSION;
    readonly id: number;
    readonly ok: false;
    readonly code: "invalid-request" | "operation-failed" | "worker-closed";
    readonly message: string;
  };

export class PGliteOperationalError extends Error {
  readonly code: "invalid-request" | "operation-failed" | "worker-closed";

  constructor(
    code: "invalid-request" | "operation-failed" | "worker-closed",
  ) {
    super(
      code === "invalid-request"
        ? "Invalid PGlite operational request."
        : code === "worker-closed"
          ? "PGlite operational worker is closed."
          : "PGlite operational operation failed.",
    );
    this.name = "PGliteOperationalError";
    this.code = code;
  }
}

type RpcPort = {
  on(event: "message", listener: (value: unknown) => void): unknown;
  off(event: "message", listener: (value: unknown) => void): unknown;
  postMessage(value: unknown): void;
};

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validRequest(value: unknown): value is PGliteOperationalRequest {
  if (!plainRecord(value)) return false;
  return value.kind === "pglite-operational-request"
    && value.version === PGLITE_OPERATIONAL_RPC_VERSION
    && typeof value.id === "number"
    && Number.isSafeInteger(value.id)
    && value.id >= 0
    && typeof value.operation === "string"
    && Array.isArray(value.args)
    && (value.diagnosticContext === undefined || isWorkflowFailureCorrelation(value.diagnosticContext));
}

function operationFailure(
  id: number,
  code: "invalid-request" | "operation-failed" | "worker-closed",
): PGliteOperationalResponse {
  const message = code === "invalid-request"
    ? "Invalid PGlite operational request."
    : code === "worker-closed"
      ? "PGlite operational worker is closed."
      : "PGlite operational operation failed.";
  return {
    kind: "pglite-operational-response",
    version: PGLITE_OPERATIONAL_RPC_VERSION,
    id,
    ok: false,
    code,
    message,
  };
}

function stringValue(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 10_000;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function dateValue(value: unknown): boolean {
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  if (typeof value !== "string" || value.length === 0) return false;
  return !Number.isNaN(Date.parse(value));
}

function stringFields(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return plainRecord(value) && fields.every((field) => stringValue(value[field]));
}

function hasOnlyFields(value: unknown, allowedFields: readonly string[]): value is Record<string, unknown> {
  return plainRecord(value)
    && Object.keys(value).every((field) => allowedFields.includes(field));
}

const CREATE_TASK_RUN_FIELDS = [
  "taskId", "kind", "status", "attempt", "maxAttempts", "startedAt",
  "finishedAt", "progress", "humanAssistanceContract",
  "scheduledAtUtc",
] as const;
const TASK_RUN_UPDATE_FIELDS = [
  "attempt", "maxAttempts", "progress", "terminationMode", "humanAssistanceContract",
  "appWorkflowOutcome", "browserRuntime",
] as const;
const TASK_RUN_TRANSITION_FIELDS = [...TASK_RUN_UPDATE_FIELDS, "status", "finishedAt"] as const;

function previewVisibility(value: unknown): boolean {
  return hasOnlyFields(value, ["visible"]) && Array.isArray(value.visible)
    && (value.visible as unknown[]).length <= 100
    && (value.visible as unknown[]).every((entry) => hasOnlyFields(entry, ["sourceId", "product"])
      && stringValue(entry.sourceId) && isPreviewProduct(entry.product));
}

type OperationalContract = Readonly<{
  /** True when the worker may hand these arguments to the port method. */
  accepts(args: readonly unknown[]): boolean;
  /** Rebuild accepted arguments the port needs in another shape. */
  decode?(args: readonly unknown[]): readonly unknown[];
}>;

/** Every named operational method and the arguments the worker accepts for it. */
export const PGLITE_OPERATIONAL_CONTRACTS: Readonly<Record<PGliteOperationalOperation, OperationalContract>> = Object.freeze({
  "automation.createTaskRun": {
    accepts: (args) => args.length === 1
      && hasOnlyFields(args[0], CREATE_TASK_RUN_FIELDS)
      && stringFields(args[0], ["taskId", "kind", "status", "startedAt"])
      && finiteNumber((args[0] as Record<string, unknown>).attempt)
      && finiteNumber((args[0] as Record<string, unknown>).maxAttempts),
  },
  "automation.updateTaskRun": {
    accepts: (args) => args.length === 2 && stringValue(args[0]) && hasOnlyFields(args[1], TASK_RUN_UPDATE_FIELDS),
  },
  "automation.transitionTaskRunToActive": {
    accepts: (args) => args.length === 2 && stringValue(args[0]) && hasOnlyFields(args[1], TASK_RUN_TRANSITION_FIELDS),
  },
  "automation.transitionTaskRunToTerminal": {
    accepts: (args) => args.length === 2 && stringValue(args[0]) && hasOnlyFields(args[1], TASK_RUN_TRANSITION_FIELDS),
  },
  "automation.updateHumanAssistanceContract": {
    accepts: (args) => args.length === 2 && stringValue(args[0]) && plainRecord(args[1]),
  },
  "automation.updateHumanAssistanceCompletion": {
    accepts: (args) => args.length === 2 && stringValue(args[0]) && stringValue(args[1]),
  },
  "automation.taskRunById": { accepts: (args) => args.length === 1 && stringValue(args[0]) },
  "automation.activeTaskRuns": { accepts: (args) => args.length === 0 },
  "automation.latestTaskRuns": { accepts: (args) => args.length === 0 },
  "automation.todayTaskRunIds": {
    accepts: (args) => args.length === 1 && plainRecord(args[0])
      && dateValue(args[0].startUtc) && dateValue(args[0].endUtc),
    decode: (args) => {
      const value = args[0] as { startUtc: Date | string; endUtc: Date | string };
      return [{
        startUtc: value.startUtc instanceof Date ? value.startUtc : new Date(value.startUtc),
        endUtc: value.endUtc instanceof Date ? value.endUtc : new Date(value.endUtc),
      }];
    },
  },
  "automation.hasSuccessfulTaskRunSince": {
    accepts: (args) => args.length === 2 && stringValue(args[0]) && stringValue(args[1]),
  },
  "automation.hasOccurrenceBeenAttempted": {
    accepts: (args) => args.length === 2 && stringValue(args[0]) && stringValue(args[1]),
  },
  "automation.recentTaskRuns": {
    accepts: (args) => args.length === 0
      || (args.length === 1 && Number.isSafeInteger(args[0]) && (args[0] as number) >= 0),
  },
  "automation.appendRunEvent": {
    accepts: (args) => args.length === 1 && stringFields(args[0], ["runId", "stage", "code", "occurredAt"])
      && ["preparation", "authentication", "collection", "decoding", "validation", "commit", "finalization"].includes(String((args[0] as Record<string, unknown>).stage))
      && (args[0] as Record<string, unknown>).code!.toString().length <= 64,
  },
  "automation.recordCommitAttempt": {
    accepts: (args) => args.length === 2 && stringValue(args[0]) && isCommitAttemptReport(args[1]),
  },
  "automation.commitAttempts": { accepts: (args) => args.length === 1 && stringValue(args[0]) },
  "automation.pruneRunEvents": {
    accepts: (args) => args.length === 1 && stringValue(args[0]) && dateValue(args[0]),
  },
  "automation.upsertTaskPrerequisiteNotice": {
    accepts: (args) => args.length === 1
      && stringFields(args[0], ["taskId", "prerequisiteId", "taskRunId", "detectedAt"]),
  },
  "automation.activeTaskPrerequisiteNotices": { accepts: (args) => args.length === 0 },
  "automation.allTaskPrerequisiteNotices": { accepts: (args) => args.length === 0 },
  "automation.resolveTaskPrerequisiteNotices": { accepts: (args) => args.length === 3 && args.every(stringValue) },
  "exchangeRates.readExchangeRates": {
    accepts: (args) => args.length === 0
      || (args.length === 1 && Array.isArray(args[0]) && (args[0] as unknown[]).every(stringValue)),
  },
  "exchangeRates.upsertExchangeRates": {
    accepts: (args) => args.length === 1 && Array.isArray(args[0]) && (args[0] as unknown[]).every((row) =>
      stringFields(row, ["rateDate", "currency", "source", "fetchedAt"])
      && finiteNumber((row as Record<string, unknown>).twdPerUnit),
    ),
  },
  "maicoin.startRun": {
    accepts: (args) => args.length === 1
      && stringFields(args[0], ["syncRunId", "startedAt", "subAccount"])
      && Array.isArray((args[0] as Record<string, unknown>).walletTypes)
      && ((args[0] as Record<string, unknown>).walletTypes as unknown[]).every(stringValue)
      && Number.isSafeInteger((args[0] as Record<string, unknown>).statementLimit)
      && plainRecord((args[0] as Record<string, unknown>).record),
  },
  "maicoin.appendSnapshots": {
    accepts: (args) => args.length === 1 && Array.isArray(args[0]) && (args[0] as unknown[]).length <= 100
      && (args[0] as unknown[]).every((row) => stringFields(row,
        ["snapshotId", "syncRunId", "capturedAt", "subAccount", "walletType", "currency", "rawAccountJson"])),
  },
  "maicoin.appendStatementRows": {
    accepts: (args) => args.length === 1 && Array.isArray(args[0]) && (args[0] as unknown[]).length <= 100
      && (args[0] as unknown[]).every((row) => stringFields(row,
        ["statementId", "syncRunId", "capturedAt", "endpoint", "rowType", "externalId", "rawPayloadJson"])),
  },
  "maicoin.finishRun": {
    accepts: (args) => args.length === 1 && stringFields(args[0], ["syncRunId", "finishedAt"])
      && plainRecord((args[0] as Record<string, unknown>).record),
  },
  "preview.write": {
    accepts: (args) => args.length === 1 && hasOnlyFields(args[0], ["sourceId", "institution", "product", "collection"])
      && stringFields(args[0], ["sourceId", "institution", "product"])
      && plainRecord((args[0] as Record<string, unknown>).collection),
  },
  "preview.deleteAll": { accepts: (args) => args.length === 0 },
  "preview.accounts": { accepts: (args) => args.length === 1 && previewVisibility(args[0]) },
  "preview.transactions": {
    accepts: (args) => args.length === 2 && previewVisibility(args[0]) && stringValue(args[1]),
  },
  "preview.creditAccounts": { accepts: (args) => args.length === 1 && previewVisibility(args[0]) },
  "preview.purchases": {
    accepts: (args) => args.length === 2 && previewVisibility(args[0]) && stringValue(args[1]),
  },
  "preview.statements": {
    accepts: (args) => args.length === 2 && previewVisibility(args[0]) && stringValue(args[1]),
  },
} satisfies Record<PGliteOperationalOperation, OperationalContract>);

export const PGLITE_OPERATIONAL_OPERATIONS = Object.freeze(
  Object.keys(PGLITE_OPERATIONAL_CONTRACTS) as PGliteOperationalOperation[],
);

export function isPGliteOperationalOperation(value: unknown): value is PGliteOperationalOperation {
  return typeof value === "string" && Object.hasOwn(PGLITE_OPERATIONAL_CONTRACTS, value);
}

function postResponse(port: RpcPort, response: PGliteOperationalResponse): void {
  try {
    port.postMessage(response);
  } catch {
    // A closing worker may reject a response after the operation itself has
    // completed.  The client has its own bounded close path.
  }
}

function operationParts(operation: PGliteOperationalOperation): [OperationalDomain, string] {
  return operation.split(".") as [OperationalDomain, string];
}

function invokeOperation(
  provider: PGliteOperationalDomains,
  operation: PGliteOperationalOperation,
  args: readonly unknown[],
): Promise<unknown> {
  const [domain, method] = operationParts(operation);
  const port = provider[domain] as unknown as Record<string, (...args: readonly unknown[]) => Promise<unknown>>;
  return port[method]!(...(PGLITE_OPERATIONAL_CONTRACTS[operation].decode?.(args) ?? args));
}

export type PGliteOperationalRpcServer = {
  close(): Promise<void>;
};

/** Install the allowlisted operational command/query server in the worker. */
export function createPGliteOperationalRpcServer(
  port: RpcPort,
  provider: PGliteOperationalDomains,
): PGliteOperationalRpcServer {
  let closed = false;
  const active = new Set<Promise<void>>();
  const onMessage = (value: unknown): void => {
    if (!validRequest(value)) return;
    if (closed) {
      postResponse(port, operationFailure(value.id, "worker-closed"));
      return;
    }
    const operation = value.operation;
    if (!isPGliteOperationalOperation(operation) || !PGLITE_OPERATIONAL_CONTRACTS[operation].accepts(value.args)) {
      postResponse(port, operationFailure(value.id, "invalid-request"));
      return;
    }
    const work = Promise.resolve()
      .then(() => invokeOperation(provider, operation, value.args))
      .then(
        (result) => postResponse(port, {
          kind: "pglite-operational-response",
          version: PGLITE_OPERATIONAL_RPC_VERSION,
          id: value.id,
          ok: true,
          value: result,
        }),
        async (error: unknown) => {
          if (value.diagnosticContext) {
            await appendWorkflowFailureDiagnostic(process.env[WORKFLOW_FAILURE_DIAGNOSTICS_FILE_ENV], {
              workflowId: value.diagnosticContext.workflowId,
              taskRunId: value.diagnosticContext.taskRunId,
              source: "operational-rpc",
              errorCode: "workflow-failed",
              operation,
              error,
            }, { repoRoot: workflowFailureDiagnosticRepoRoot() });
          }
          postResponse(port, operationFailure(value.id, "operation-failed"));
        },
      )
      .then(() => undefined);
    active.add(work);
    void work.finally(() => active.delete(work)).catch(() => undefined);
  };
  port.on("message", onMessage);
  let closePromise: Promise<void> | undefined;
  return {
    close() {
      if (closePromise) return closePromise;
      closed = true;
      port.off("message", onMessage);
      closePromise = Promise.all([...active]).then(() => undefined);
      return closePromise;
    },
  };
}

type RpcPending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
};

export type PGliteOperationalRpcClient = {
  request<K extends PGliteOperationalOperation>(
    operation: K,
    args: readonly unknown[],
  ): Promise<unknown>;
  provider: PGliteOperationalDomains;
  close(error?: Error): void;
};

/** Client proxy with durable rejection for every request still in flight. */
export function createPGliteOperationalRpcClient(
  port: RpcPort,
  ready?: Promise<void>,
  diagnosticContext?: WorkflowFailureCorrelation,
): PGliteOperationalRpcClient {
  const pending = new Map<number, RpcPending>();
  let nextId = 1;
  let closed = false;
  const onMessage = (value: unknown): void => {
    if (!plainRecord(value)
      || value.kind !== "pglite-operational-response"
      || value.version !== PGLITE_OPERATIONAL_RPC_VERSION
      || typeof value.id !== "number"
      || !Number.isSafeInteger(value.id)
      || typeof value.ok !== "boolean") return;
    const request = pending.get(value.id);
    if (!request) return;
    pending.delete(value.id);
    if (value.ok === true) {
      request.resolve(value.value);
      return;
    }
    const code = value.code === "invalid-request"
      || value.code === "worker-closed"
      || value.code === "operation-failed"
      ? value.code
      : "operation-failed";
    request.reject(new PGliteOperationalError(code));
  };
  port.on("message", onMessage);

  const request = <K extends PGliteOperationalOperation>(
    operation: K,
    args: readonly unknown[],
  ): Promise<unknown> => {
    if (closed) return Promise.reject(new Error("PGlite operational worker is closed."));
    return new Promise((resolve, reject) => {
      const send = () => {
        if (closed) {
          reject(new Error("PGlite operational worker is closed."));
          return;
        }
        const id = nextId++;
        pending.set(id, { resolve, reject });
        try {
          port.postMessage({
            kind: "pglite-operational-request",
            version: PGLITE_OPERATIONAL_RPC_VERSION,
            id,
            operation,
            args,
            ...(diagnosticContext ? { diagnosticContext } : {}),
          } satisfies PGliteOperationalRequest);
        } catch (error) {
          pending.delete(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };
      if (ready) {
        void ready.then(send, (error) => reject(error instanceof Error ? error : new Error(String(error))));
      } else {
        send();
      }
    });
  };

  const domains: Record<string, Record<string, (...args: readonly unknown[]) => Promise<unknown>>> = {};
  for (const operation of PGLITE_OPERATIONAL_OPERATIONS) {
    const [domain, method] = operationParts(operation);
    (domains[domain] ??= {})[method] = (...args) => request(operation, args);
  }

  const close = (error = new Error("PGlite operational worker is closed.")): void => {
    if (closed) return;
    closed = true;
    port.off("message", onMessage);
    for (const item of pending.values()) item.reject(error);
    pending.clear();
  };

  return {
    request,
    // The contract table names every port method, so the derived object is each port in full.
    provider: Object.freeze(domains) as unknown as PGliteOperationalDomains,
    close,
  };
}
