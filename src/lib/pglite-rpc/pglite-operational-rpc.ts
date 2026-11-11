import type {
  AutomationPersistencePort,
  AutomationPersistenceProvider,
} from "../automation/server/store.ts";
import type { ExchangeRatePersistencePort } from "../../ledger/exchange-rates.ts";
import { isCommitAttemptReport } from "../automation/commit-attempt.ts";
import type { PGliteMaicoinPersistencePort } from "../../ledger/pglite/maicoin-operational.ts";
import { isPreviewProduct, type PGlitePreviewFinancialDataPort } from "../../ledger/pglite/preview-financial-data.ts";
import {
  appendWorkflowFailureDiagnostic,
  workflowFailureDiagnosticRepoRoot,
  WORKFLOW_FAILURE_DIAGNOSTICS_FILE_ENV,
  type WorkflowFailureCorrelation,
} from "../automation/server/workflow-failure-diagnostics.ts";
import {
  createWorkerCallClient,
  createWorkerCallServer,
  plainRecord,
  type WorkerPort,
} from "./pglite-worker-call.ts";

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
  "preview.loanAccounts": { accepts: (args) => args.length === 1 && previewVisibility(args[0]) },
} satisfies Record<PGliteOperationalOperation, OperationalContract>);

export const PGLITE_OPERATIONAL_OPERATIONS = Object.freeze(
  Object.keys(PGLITE_OPERATIONAL_CONTRACTS) as PGliteOperationalOperation[],
);

export function isPGliteOperationalOperation(value: unknown): value is PGliteOperationalOperation {
  return typeof value === "string" && Object.hasOwn(PGLITE_OPERATIONAL_CONTRACTS, value);
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

/**
 * Install the allowlisted operational command/query server in the worker.
 * Calls run as they arrive, not through the financial work scheduler: run
 * state, preview and MaiCoin writes must not wait behind background reads
 * (ADR 0118).
 */
export function createPGliteOperationalRpcServer(
  port: WorkerPort,
  provider: PGliteOperationalDomains,
): PGliteOperationalRpcServer {
  const server = createWorkerCallServer({
    port,
    request: { kind: "pglite-operational-request", version: PGLITE_OPERATIONAL_RPC_VERSION },
    refusal: operationFailure,
    start: ({ id, operation, args, diagnosticContext }) => {
      if (!isPGliteOperationalOperation(operation) || !PGLITE_OPERATIONAL_CONTRACTS[operation].accepts(args)) return undefined;
      return Promise.resolve()
        .then(() => invokeOperation(provider, operation, args))
        .then(
          (result): PGliteOperationalResponse => ({
            kind: "pglite-operational-response",
            version: PGLITE_OPERATIONAL_RPC_VERSION,
            id,
            ok: true,
            value: result,
          }),
          async (error: unknown) => {
            if (diagnosticContext) {
              await appendWorkflowFailureDiagnostic(process.env[WORKFLOW_FAILURE_DIAGNOSTICS_FILE_ENV], {
                workflowId: diagnosticContext.workflowId,
                taskRunId: diagnosticContext.taskRunId,
                source: "operational-rpc",
                errorCode: "workflow-failed",
                operation,
                error,
              }, { repoRoot: workflowFailureDiagnosticRepoRoot() });
            }
            return operationFailure(id, "operation-failed");
          },
        );
    },
  });
  return { close: server.close };
}

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
  port: WorkerPort,
  ready?: Promise<void>,
  diagnosticContext?: WorkflowFailureCorrelation,
): PGliteOperationalRpcClient {
  const client = createWorkerCallClient({
    port,
    ready,
    response: { kind: "pglite-operational-response", version: PGLITE_OPERATIONAL_RPC_VERSION },
    failure: (value) => new PGliteOperationalError(
      value.code === "invalid-request" || value.code === "worker-closed" ? value.code : "operation-failed",
    ),
    closed: () => new PGliteOperationalError("worker-closed"),
  });
  const request = <K extends PGliteOperationalOperation>(operation: K, args: readonly unknown[]): Promise<unknown> =>
    client.call((id) => ({
      kind: "pglite-operational-request",
      version: PGLITE_OPERATIONAL_RPC_VERSION,
      id,
      operation,
      args,
      ...(diagnosticContext ? { diagnosticContext } : {}),
    } satisfies PGliteOperationalRequest));
  return { request, provider: operationalProviderOver(request), close: client.close };
}

/**
 * Every operational port method, each sending its operation through `request`.
 * The contract table names every port method, so the derived object is each port in full.
 */
export function operationalProviderOver(
  request: (operation: PGliteOperationalOperation, args: readonly unknown[]) => Promise<unknown>,
): PGliteOperationalDomains {
  const domains: Record<string, Record<string, (...args: readonly unknown[]) => Promise<unknown>>> = {};
  for (const operation of PGLITE_OPERATIONAL_OPERATIONS) {
    const [domain, method] = operationParts(operation);
    (domains[domain] ??= {})[method] = (...args) => request(operation, args);
  }
  return Object.freeze(domains) as unknown as PGliteOperationalDomains;
}
