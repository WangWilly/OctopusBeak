import type {
  AutomationPersistencePort,
  AutomationPersistenceProvider,
} from "../src/lib/automation/server/store.ts";
import type { ExchangeRatePersistencePort } from "../src/ledger/exchange-rates.ts";
import type { PGliteMaicoinPersistencePort } from "../src/ledger/pglite/maicoin-operational.ts";

/**
 * The operational worker protocol is deliberately method based.  There is no
 * SQL operation in this list, so renderer input can never become a database
 * statement or identifier.
 */
export const PGLITE_OPERATIONAL_RPC_VERSION = 1 as const;

const AUTOMATION_METHODS = [
  "createTaskRun",
  "updateTaskRun",
  "transitionTaskRunToActive",
  "transitionTaskRunToTerminal",
  "updateHumanAssistanceContract",
  "updateHumanAssistanceCompletion",
  "taskRunById",
  "activeTaskRuns",
  "latestTaskRuns",
  "todayTaskRunIds",
  "hasSuccessfulTaskRunSince",
  "hasOccurrenceBeenAttempted",
  "recentTaskRuns",
  "appendRunEvent",
  "pruneRunEvents",
  "upsertTaskPrerequisiteNotice",
  "activeTaskPrerequisiteNotices",
  "allTaskPrerequisiteNotices",
  "resolveTaskPrerequisiteNotices",
] as const satisfies readonly (keyof AutomationPersistencePort & string)[];

const EXCHANGE_RATE_METHODS = [
  "readExchangeRates",
  "upsertExchangeRates",
] as const satisfies readonly (keyof ExchangeRatePersistencePort & string)[];

const MAICOIN_METHODS = [
  "startRun", "appendSnapshots", "appendStatementRows", "finishRun",
] as const satisfies readonly (keyof PGliteMaicoinPersistencePort & string)[];

export type PGliteOperationalOperation =
  | `automation.${(typeof AUTOMATION_METHODS)[number]}`
  | `exchangeRates.${(typeof EXCHANGE_RATE_METHODS)[number]}`
  | `maicoin.${(typeof MAICOIN_METHODS)[number]}`;

export type PGliteOperationalRequest = {
  readonly kind: "pglite-operational-request";
  readonly version: typeof PGLITE_OPERATIONAL_RPC_VERSION;
  readonly id: number;
  readonly operation: PGliteOperationalOperation | string;
  readonly args: readonly unknown[];
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

const ALL_OPERATIONS = new Set<string>([
  ...AUTOMATION_METHODS.map((method) => `automation.${method}`),
  ...EXCHANGE_RATE_METHODS.map((method) => `exchangeRates.${method}`),
  ...MAICOIN_METHODS.map((method) => `maicoin.${method}`),
]);

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
    && Array.isArray(value.args);
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
  "finishedAt", "exitCode", "signal", "progress", "humanAssistanceContract",
  "scheduledAtUtc",
] as const;
const TASK_RUN_UPDATE_FIELDS = [
  "status", "attempt", "maxAttempts", "finishedAt", "exitCode", "signal",
  "progress", "terminationMode", "humanAssistanceContract", "appWorkflowOutcome",
] as const;

function validOperationalArgs(operation: PGliteOperationalOperation, args: readonly unknown[]): boolean {
  switch (operation) {
    case "automation.createTaskRun":
      return args.length === 1
        && hasOnlyFields(args[0], CREATE_TASK_RUN_FIELDS)
        && stringFields(args[0], ["taskId", "kind", "status", "startedAt"])
        && finiteNumber((args[0] as Record<string, unknown>).attempt)
        && finiteNumber((args[0] as Record<string, unknown>).maxAttempts);
    case "automation.updateTaskRun":
      return args.length === 2 && stringValue(args[0]) && hasOnlyFields(args[1], TASK_RUN_UPDATE_FIELDS);
    case "automation.transitionTaskRunToActive":
    case "automation.transitionTaskRunToTerminal":
      return args.length === 2 && stringValue(args[0]) && hasOnlyFields(args[1], TASK_RUN_UPDATE_FIELDS);
    case "automation.updateHumanAssistanceContract":
      return args.length === 2 && stringValue(args[0]) && plainRecord(args[1]);
    case "automation.updateHumanAssistanceCompletion":
      return args.length === 2 && stringValue(args[0]) && stringValue(args[1]);
    case "automation.taskRunById":
      return args.length === 1 && stringValue(args[0]);
    case "automation.activeTaskRuns":
    case "automation.latestTaskRuns":
    case "automation.activeTaskPrerequisiteNotices":
    case "automation.allTaskPrerequisiteNotices":
      return args.length === 0;
    case "automation.todayTaskRunIds":
      return args.length === 1 && plainRecord(args[0])
        && dateValue(args[0].startUtc) && dateValue(args[0].endUtc);
    case "automation.hasSuccessfulTaskRunSince":
      return args.length === 2 && stringValue(args[0]) && stringValue(args[1]);
    case "automation.hasOccurrenceBeenAttempted":
      return args.length === 2 && stringValue(args[0]) && stringValue(args[1]);
    case "automation.recentTaskRuns":
      return args.length === 0 || (args.length === 1 && Number.isSafeInteger(args[0]) && (args[0] as number) >= 0);
    case "automation.appendRunEvent":
      return args.length === 1 && stringFields(args[0], ["runId", "stage", "code", "occurredAt"])
        && ["preparation", "authentication", "collection", "decoding", "validation", "commit", "finalization"].includes(String((args[0] as Record<string, unknown>).stage))
        && (args[0] as Record<string, unknown>).code!.toString().length <= 64;
    case "automation.pruneRunEvents":
      return args.length === 1 && stringValue(args[0]) && dateValue(args[0]);
    case "automation.upsertTaskPrerequisiteNotice":
      return args.length === 1 && stringFields(args[0], ["taskId", "prerequisiteId", "taskRunId", "detectedAt"]);
    case "automation.resolveTaskPrerequisiteNotices":
      return args.length === 3 && args.every(stringValue);
    case "exchangeRates.readExchangeRates":
      return args.length === 0 || (args.length === 1 && Array.isArray(args[0]) && (args[0] as unknown[]).every(stringValue));
    case "exchangeRates.upsertExchangeRates":
      return args.length === 1 && Array.isArray(args[0]) && (args[0] as unknown[]).every((row) =>
        stringFields(row, ["rateDate", "currency", "source", "fetchedAt"])
        && finiteNumber((row as Record<string, unknown>).twdPerUnit),
      );
    case "maicoin.startRun":
      return args.length === 1
        && stringFields(args[0], ["syncRunId", "startedAt", "subAccount"])
        && Array.isArray((args[0] as Record<string, unknown>).walletTypes)
        && ((args[0] as Record<string, unknown>).walletTypes as unknown[]).every(stringValue)
        && Number.isSafeInteger((args[0] as Record<string, unknown>).statementLimit)
        && plainRecord((args[0] as Record<string, unknown>).record);
    case "maicoin.appendSnapshots":
      return args.length === 1 && Array.isArray(args[0]) && (args[0] as unknown[]).length <= 100
        && (args[0] as unknown[]).every((row) => stringFields(row,
          ["snapshotId", "syncRunId", "capturedAt", "subAccount", "walletType", "currency", "rawAccountJson"]));
    case "maicoin.appendStatementRows":
      return args.length === 1 && Array.isArray(args[0]) && (args[0] as unknown[]).length <= 100
        && (args[0] as unknown[]).every((row) => stringFields(row,
          ["statementId", "syncRunId", "capturedAt", "endpoint", "rowType", "externalId", "rawPayloadJson"]));
    case "maicoin.finishRun":
      return args.length === 1 && stringFields(args[0], ["syncRunId", "finishedAt"])
        && plainRecord((args[0] as Record<string, unknown>).record);
    default:
      return false;
  }
}

function postResponse(port: RpcPort, response: PGliteOperationalResponse): void {
  try {
    port.postMessage(response);
  } catch {
    // A closing worker may reject a response after the operation itself has
    // completed.  The client has its own bounded close path.
  }
}

async function invokeOperation(
  provider: AutomationPersistenceProvider & { exchangeRates: ExchangeRatePersistencePort; maicoin: PGliteMaicoinPersistencePort },
  operation: PGliteOperationalOperation,
  args: readonly unknown[],
): Promise<unknown> {
  const [namespace, method] = operation.split(".") as ["automation" | "exchangeRates" | "maicoin", string];
  if (namespace === "automation") {
    switch (method) {
      case "createTaskRun": return provider.automation.createTaskRun(args[0] as Parameters<AutomationPersistencePort["createTaskRun"]>[0]);
      case "updateTaskRun": return provider.automation.updateTaskRun(
        args[0] as Parameters<AutomationPersistencePort["updateTaskRun"]>[0],
        args[1] as Parameters<AutomationPersistencePort["updateTaskRun"]>[1],
      );
      case "transitionTaskRunToActive": return provider.automation.transitionTaskRunToActive(
        args[0] as Parameters<AutomationPersistencePort["transitionTaskRunToActive"]>[0],
        args[1] as Parameters<AutomationPersistencePort["transitionTaskRunToActive"]>[1],
      );
      case "transitionTaskRunToTerminal": return provider.automation.transitionTaskRunToTerminal(
        args[0] as Parameters<AutomationPersistencePort["transitionTaskRunToTerminal"]>[0],
        args[1] as Parameters<AutomationPersistencePort["transitionTaskRunToTerminal"]>[1],
      );
      case "updateHumanAssistanceContract": return provider.automation.updateHumanAssistanceContract(
        args[0] as Parameters<AutomationPersistencePort["updateHumanAssistanceContract"]>[0],
        args[1] as Parameters<AutomationPersistencePort["updateHumanAssistanceContract"]>[1],
      );
      case "updateHumanAssistanceCompletion": return provider.automation.updateHumanAssistanceCompletion(
        args[0] as Parameters<AutomationPersistencePort["updateHumanAssistanceCompletion"]>[0],
        args[1] as Parameters<AutomationPersistencePort["updateHumanAssistanceCompletion"]>[1],
      );
      case "taskRunById": return provider.automation.taskRunById(
        args[0] as Parameters<AutomationPersistencePort["taskRunById"]>[0],
      );
      case "activeTaskRuns": return provider.automation.activeTaskRuns();
      case "latestTaskRuns": return provider.automation.latestTaskRuns();
      case "todayTaskRunIds": return provider.automation.todayTaskRunIds(
        (() => {
          const value = args[0] as { startUtc: Date | string; endUtc: Date | string };
          return {
            startUtc: value.startUtc instanceof Date ? value.startUtc : new Date(value.startUtc),
            endUtc: value.endUtc instanceof Date ? value.endUtc : new Date(value.endUtc),
          } as Parameters<AutomationPersistencePort["todayTaskRunIds"]>[0];
        })(),
      );
      case "hasSuccessfulTaskRunSince": return provider.automation.hasSuccessfulTaskRunSince(
        args[0] as Parameters<AutomationPersistencePort["hasSuccessfulTaskRunSince"]>[0],
        args[1] as Parameters<AutomationPersistencePort["hasSuccessfulTaskRunSince"]>[1],
      );
      case "hasOccurrenceBeenAttempted": return provider.automation.hasOccurrenceBeenAttempted(
        args[0] as Parameters<AutomationPersistencePort["hasOccurrenceBeenAttempted"]>[0],
        args[1] as Parameters<AutomationPersistencePort["hasOccurrenceBeenAttempted"]>[1],
      );
      case "recentTaskRuns": return provider.automation.recentTaskRuns(
        args[0] as Parameters<AutomationPersistencePort["recentTaskRuns"]>[0],
      );
      case "appendRunEvent": return provider.automation.appendRunEvent(
        args[0] as Parameters<AutomationPersistencePort["appendRunEvent"]>[0],
      );
      case "pruneRunEvents": return provider.automation.pruneRunEvents(
        args[0] as Parameters<AutomationPersistencePort["pruneRunEvents"]>[0],
      );
      case "upsertTaskPrerequisiteNotice": return provider.automation.upsertTaskPrerequisiteNotice(
        args[0] as Parameters<AutomationPersistencePort["upsertTaskPrerequisiteNotice"]>[0],
      );
      case "activeTaskPrerequisiteNotices": return provider.automation.activeTaskPrerequisiteNotices();
      case "allTaskPrerequisiteNotices": return provider.automation.allTaskPrerequisiteNotices();
      case "resolveTaskPrerequisiteNotices": return provider.automation.resolveTaskPrerequisiteNotices(
        args[0] as Parameters<AutomationPersistencePort["resolveTaskPrerequisiteNotices"]>[0],
        args[1] as Parameters<AutomationPersistencePort["resolveTaskPrerequisiteNotices"]>[1],
        args[2] as Parameters<AutomationPersistencePort["resolveTaskPrerequisiteNotices"]>[2],
      );
      default: throw new Error("Unknown operational automation operation.");
    }
  }
  if (namespace === "maicoin") {
    switch (method) {
      case "startRun": return provider.maicoin.startRun(args[0] as Parameters<PGliteMaicoinPersistencePort["startRun"]>[0]);
      case "appendSnapshots": return provider.maicoin.appendSnapshots(args[0] as Parameters<PGliteMaicoinPersistencePort["appendSnapshots"]>[0]);
      case "appendStatementRows": return provider.maicoin.appendStatementRows(args[0] as Parameters<PGliteMaicoinPersistencePort["appendStatementRows"]>[0]);
      case "finishRun": return provider.maicoin.finishRun(args[0] as Parameters<PGliteMaicoinPersistencePort["finishRun"]>[0]);
      default: throw new Error("Unknown MaiCoin operational operation.");
    }
  }
  switch (method) {
    case "readExchangeRates": return provider.exchangeRates.readExchangeRates(
      args[0] as Parameters<ExchangeRatePersistencePort["readExchangeRates"]>[0],
    );
    case "upsertExchangeRates": return provider.exchangeRates.upsertExchangeRates(
      args[0] as Parameters<ExchangeRatePersistencePort["upsertExchangeRates"]>[0],
    );
    default: throw new Error("Unknown operational exchange-rate operation.");
  }
}

export type PGliteOperationalRpcServer = {
  close(): Promise<void>;
};

/** Install the allowlisted operational command/query server in the worker. */
export function createPGliteOperationalRpcServer(
  port: RpcPort,
  provider: AutomationPersistenceProvider & { exchangeRates: ExchangeRatePersistencePort; maicoin: PGliteMaicoinPersistencePort },
): PGliteOperationalRpcServer {
  let closed = false;
  const active = new Set<Promise<void>>();
  const onMessage = (value: unknown): void => {
    if (!validRequest(value)) return;
    if (closed) {
      postResponse(port, operationFailure(value.id, "worker-closed"));
      return;
    }
    if (!ALL_OPERATIONS.has(value.operation)) {
      postResponse(port, operationFailure(value.id, "invalid-request"));
      return;
    }
    const operation = value.operation as PGliteOperationalOperation;
    if (!validOperationalArgs(operation, value.args)) {
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
        (error: unknown) => postResponse(
          port,
          operationFailure(value.id, "operation-failed"),
        ),
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
  provider: AutomationPersistenceProvider & { exchangeRates: ExchangeRatePersistencePort; maicoin: PGliteMaicoinPersistencePort };
  close(error?: Error): void;
};

function operationName<K extends keyof AutomationPersistencePort>(namespace: "automation", method: K): PGliteOperationalOperation {
  return `${namespace}.${String(method)}` as PGliteOperationalOperation;
}

function exchangeOperationName<K extends keyof ExchangeRatePersistencePort>(method: K): PGliteOperationalOperation {
  return `exchangeRates.${String(method)}` as PGliteOperationalOperation;
}

function maicoinOperationName<K extends keyof PGliteMaicoinPersistencePort>(method: K): PGliteOperationalOperation {
  return `maicoin.${String(method)}` as PGliteOperationalOperation;
}

/** Client proxy with durable rejection for every request still in flight. */
export function createPGliteOperationalRpcClient(
  port: RpcPort,
  ready?: Promise<void>,
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

  function automationMethod<K extends keyof AutomationPersistencePort>(
    method: K,
    args: Parameters<AutomationPersistencePort[K]>,
  ): Promise<Awaited<ReturnType<AutomationPersistencePort[K]>>> {
    return request(operationName("automation", method), args) as Promise<Awaited<ReturnType<AutomationPersistencePort[K]>>>;
  }

  function exchangeMethod<K extends keyof ExchangeRatePersistencePort>(
    method: K,
    args: Parameters<ExchangeRatePersistencePort[K]>,
  ): Promise<Awaited<ReturnType<ExchangeRatePersistencePort[K]>>> {
    return request(exchangeOperationName(method), args) as Promise<Awaited<ReturnType<ExchangeRatePersistencePort[K]>>>;
  }

  function maicoinMethod<K extends keyof PGliteMaicoinPersistencePort>(
    method: K,
    args: Parameters<PGliteMaicoinPersistencePort[K]>,
  ): Promise<Awaited<ReturnType<PGliteMaicoinPersistencePort[K]>>> {
    return request(maicoinOperationName(method), args) as Promise<Awaited<ReturnType<PGliteMaicoinPersistencePort[K]>>>;
  }

  const automation: AutomationPersistencePort = {
    createTaskRun: (...args) => automationMethod("createTaskRun", args),
    updateTaskRun: (...args) => automationMethod("updateTaskRun", args),
    transitionTaskRunToActive: (...args) => automationMethod("transitionTaskRunToActive", args),
    transitionTaskRunToTerminal: (...args) => automationMethod("transitionTaskRunToTerminal", args),
    updateHumanAssistanceContract: (...args) => automationMethod("updateHumanAssistanceContract", args),
    updateHumanAssistanceCompletion: (...args) => automationMethod("updateHumanAssistanceCompletion", args),
    taskRunById: (...args) => automationMethod("taskRunById", args),
    activeTaskRuns: (...args) => automationMethod("activeTaskRuns", args),
    latestTaskRuns: (...args) => automationMethod("latestTaskRuns", args),
    todayTaskRunIds: (...args) => automationMethod("todayTaskRunIds", args),
    hasSuccessfulTaskRunSince: (...args) => automationMethod("hasSuccessfulTaskRunSince", args),
    hasOccurrenceBeenAttempted: (...args) => automationMethod("hasOccurrenceBeenAttempted", args),
    recentTaskRuns: (...args) => automationMethod("recentTaskRuns", args),
    appendRunEvent: (...args) => automationMethod("appendRunEvent", args),
    pruneRunEvents: (...args) => automationMethod("pruneRunEvents", args),
    upsertTaskPrerequisiteNotice: (...args) => automationMethod("upsertTaskPrerequisiteNotice", args),
    activeTaskPrerequisiteNotices: (...args) => automationMethod("activeTaskPrerequisiteNotices", args),
    allTaskPrerequisiteNotices: (...args) => automationMethod("allTaskPrerequisiteNotices", args),
    resolveTaskPrerequisiteNotices: (...args) => automationMethod("resolveTaskPrerequisiteNotices", args),
  };
  const exchangeRates: ExchangeRatePersistencePort = {
    readExchangeRates: (...args) => exchangeMethod("readExchangeRates", args),
    upsertExchangeRates: (...args) => exchangeMethod("upsertExchangeRates", args),
  };
  const maicoin: PGliteMaicoinPersistencePort = {
    startRun: (...args) => maicoinMethod("startRun", args),
    appendSnapshots: (...args) => maicoinMethod("appendSnapshots", args),
    appendStatementRows: (...args) => maicoinMethod("appendStatementRows", args),
    finishRun: (...args) => maicoinMethod("finishRun", args),
  };

  const close = (error = new Error("PGlite operational worker is closed.")): void => {
    if (closed) return;
    closed = true;
    port.off("message", onMessage);
    for (const item of pending.values()) item.reject(error);
    pending.clear();
  };

  return {
    request,
    provider: Object.freeze({ automation, exchangeRates, maicoin }),
    close,
  };
}
