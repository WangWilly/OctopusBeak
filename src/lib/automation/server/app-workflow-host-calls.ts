import { randomUUID } from "node:crypto";
import {
  createHumanAssistanceContract,
  type HumanAssistanceCompletionStatus,
  type HumanAssistanceContractInput,
} from "../human-assistance.ts";
import { hasValidRunEventMeaning, type WorkflowRunEvent } from "../run-event.ts";
import { isCommitAttemptReport, type CommitAttemptReport } from "../commit-attempt.ts";
import { WORKFLOW_STAGES } from "../task-row.ts";
import { WORKFLOW_PROGRESS_STATEMENT_TYPE_IDS } from "../workflow-executor.ts";
import type { TdccIssuedSession, TdccSessionLease, TdccSignInLease } from "../../../workflows/tdcc-session.ts";
import {
  AppWorkflowWorkerProtocolError,
  APP_WORKFLOW_WORKER_PROTOCOL_VERSION,
  boundedJson,
  exactKeys,
  isRecord,
  type HostCallFrame,
  type HostCallReplyFrame,
} from "./app-workflow-worker-protocol.ts";

/**
 * Host calls (ADR 0072): what a workflow worker asks of the host. Each method
 * is declared once in HOST_CALL_CONTRACTS; the worker's HostCallClient and the
 * host's HostCallDispatcher are the only code that sends, correlates, admits or
 * answers one.
 */

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const SAFE_CODE = /^[a-z][a-z0-9-]{0,63}$/u;
const CONNECTION_KEY = /^sha256:[A-Za-z0-9_-]{43}$/u;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const stages = new Set<WorkflowRunEvent["stage"]>(WORKFLOW_STAGES);
const progressActivities = new Set(["query", "download"]);
const progressStatementTypes = new Set<string>(WORKFLOW_PROGRESS_STATEMENT_TYPE_IDS);
const completionStatuses = new Set<Exclude<HumanAssistanceCompletionStatus, "pending">>([
  "entered", "verified", "failed",
]);

function invalid(): never {
  throw new AppWorkflowWorkerProtocolError();
}

function boundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function nullableBoundedText(value: unknown, maxLength: number) {
  return value === null || boundedText(value, maxLength);
}

function validTdccSession(value: unknown): value is TdccIssuedSession {
  return isRecord(value)
    && exactKeys(value, ["tokenId", "richUrl", "issuedAt"])
    && nullableBoundedText(value.tokenId, 512)
    && nullableBoundedText(value.richUrl, 2_048)
    && typeof value.issuedAt === "string"
    && ISO_INSTANT.test(value.issuedAt);
}

function validTdccSessionLease(value: unknown): value is TdccSessionLease {
  if (!isRecord(value)) return false;
  if (value.status === "device-registration-required") return exactKeys(value, ["status"]);
  return value.status === "ready"
    && exactKeys(value, ["status", "connection", "device", "session"])
    && isRecord(value.connection)
    && exactKeys(value.connection, ["sourceConnectionKey", "identityEpochKey"])
    && typeof value.connection.sourceConnectionKey === "string"
    && CONNECTION_KEY.test(value.connection.sourceConnectionKey)
    && typeof value.connection.identityEpochKey === "string"
    && CONNECTION_KEY.test(value.connection.identityEpochKey)
    && isRecord(value.device)
    && exactKeys(value.device, ["deviceId", "devType", "devModel"])
    && boundedText(value.device.deviceId, 64)
    && boundedText(value.device.devType, 64)
    && boundedText(value.device.devModel, 64)
    && (value.session === null || validTdccSession(value.session));
}

function validTdccSignInLease(value: unknown): value is TdccSignInLease {
  if (!isRecord(value)) return false;
  if (value.status === "device-registration-required") return exactKeys(value, ["status"]);
  return value.status === "ready"
    && exactKeys(value, ["status", "details"])
    && isRecord(value.details)
    && exactKeys(value.details, ["userId", "password"])
    && boundedText(value.details.userId, 64)
    && boundedText(value.details.password, 256);
}

const contractKeys = [
  "stageId", "title", "targets", "contextRegions", "completion", "focus", "challengeKind",
  "challengeImageRegion", "challengeAudioSource", "charset", "imagePreprocessing",
  "ocrPageSegmentationMode", "ocrAttemptPlan", "solveAcceptancePolicy",
  "solverConfidenceThreshold", "expectedAnswerLength", "prompt",
] as const;

function allowNestedKeys(value: unknown, keys: readonly string[]): boolean {
  return isRecord(value) && Object.keys(value).every((key) => keys.includes(key));
}

function validRect(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (!allowNestedKeys(value, ["x", "y", "width", "height"])) return false;
  const rect = value as Record<string, unknown>;
  return ["x", "y", "width", "height"].every((key) => typeof rect[key] === "number" && Number.isFinite(rect[key]));
}

function validHumanContract(value: unknown): value is HumanAssistanceContractInput {
  if (!allowNestedKeys(value, contractKeys)) return false;
  const contract = value as HumanAssistanceContractInput;
  if (!Array.isArray(contract.targets) || !Array.isArray(contract.contextRegions)) return false;
  if (!contract.targets.every((target) => allowNestedKeys(target, ["id", "label", "semanticId", "modes", "rect"]))) return false;
  if (!contract.contextRegions.every((region) => allowNestedKeys(region, ["id", "label", "semanticId", "rect"]))) return false;
  if (!contract.targets.every((target) => validRect(target.rect))) return false;
  if (!contract.contextRegions.every((region) => validRect(region.rect))) return false;
  if (!allowNestedKeys(contract.completion, ["mode", "targetIds", "status"])) return false;
  if (!allowNestedKeys(contract.focus, ["targetId", "contextRegionIds", "initialZoom"])) return false;
  if (contract.challengeImageRegion !== undefined && (
    !allowNestedKeys(contract.challengeImageRegion, ["id", "label", "semanticId", "rect"])
    || !validRect(contract.challengeImageRegion.rect)
  )) return false;
  if (contract.challengeAudioSource !== undefined && !allowNestedKeys(contract.challengeAudioSource, ["id", "label", "semanticId"])) return false;
  if (contract.solveAcceptancePolicy !== undefined && !allowNestedKeys(contract.solveAcceptancePolicy, ["mode", "conflictResolution"])) return false;
  if (contract.ocrAttemptPlan !== undefined && !contract.ocrAttemptPlan.every((plan) => allowNestedKeys(plan, ["imagePreprocessing", "ocrPageSegmentationMode", "ocrOutputStage", "ocrCharacterSegmentation"]))) return false;
  try {
    createHumanAssistanceContract(contract, 1);
    return boundedJson(contract);
  } catch {
    return false;
  }
}

function validEvent(value: unknown): value is WorkflowRunEvent {
  if (!isRecord(value) || !exactKeys(value, ["runId", "stage", "outcome", "code", "occurredAt"], [
    "signal", "completed", "total", "activity", "statementType", "retrying",
  ])) return false;
  if (
    typeof value.runId !== "string"
    || !SAFE_ID.test(value.runId)
    || typeof value.stage !== "string"
    || !stages.has(value.stage as WorkflowRunEvent["stage"])
    || typeof value.code !== "string"
    || !SAFE_CODE.test(value.code)
    || !hasValidRunEventMeaning(value)
    || typeof value.occurredAt !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value.occurredAt)
    || !Number.isFinite(Date.parse(value.occurredAt))
  ) return false;
  for (const key of ["completed", "total"] as const) {
    if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0 || Number(value[key]) > 1_000_000_000)) return false;
  }
  if (value.completed !== undefined && value.total !== undefined && Number(value.completed) > Number(value.total)) return false;
  if (value.activity !== undefined
    && (typeof value.activity !== "string" || !progressActivities.has(value.activity))) return false;
  if (value.statementType !== undefined
    && (typeof value.statementType !== "string" || !progressStatementTypes.has(value.statementType))) return false;
  if (value.retrying !== undefined && typeof value.retrying !== "boolean") return false;
  return true;
}

/** An acknowledgement carries no result; it travels as `null`. */
function parseAcknowledgement(value: unknown): void {
  if (value !== null) invalid();
}

export type ExchangeRateProgress = Readonly<{
  phaseCode: "load-request" | "sync" | "complete";
  completed: number;
  total: number;
  percent: number;
}>;

export type TdccSessionOperation = "open" | "sign-in-details";

/** The request and result of each host call. */
export type HostCalls = {
  event: { request: Readonly<{ event: WorkflowRunEvent }>; result: void };
  exchangeRateProgress: { request: ExchangeRateProgress; result: void };
  commitAttempt: { request: Readonly<{ attempt: CommitAttemptReport }>; result: void };
  humanAssistance: {
    request: Readonly<{ contract: HumanAssistanceContractInput }>;
    result: Readonly<{ status: Exclude<HumanAssistanceCompletionStatus, "pending"> }>;
  };
  tdccSession: {
    request: Readonly<{ operation: TdccSessionOperation }>;
    result: TdccSessionLease | TdccSignInLease;
  };
  tdccSessionRotated: { request: Readonly<{ session: TdccIssuedSession }>; result: void };
};

export type HostCallMethod = keyof HostCalls;
export type HostCallRequest<M extends HostCallMethod> = HostCalls[M]["request"];
export type HostCallResult<M extends HostCallMethod> = HostCalls[M]["result"];

/** Calls in one lane run one at a time; the worker queues them and the host refuses an overlap. */
export type HostCallLane = "acknowledged" | "assistance" | "tdcc";

type RequestContract<M extends HostCallMethod> = Readonly<{
  kind: "request";
  lane: HostCallLane;
  maxPerRun: number;
  /**
   * "drop": a stop abandons the call; the host races it against the stop and
   * does not answer, and the worker stops waiting. "answer" (ADR 0056): the
   * stop does not abandon it; the host is not raced, answers while stopping,
   * and the worker keeps waiting until the run ends.
   */
  duringStop: "drop" | "answer";
  /** The code a failed handler answers with; without one, a failed handler is a protocol failure. */
  failureCode?: "event-persistence-failed";
  parseRequest(value: unknown): HostCallRequest<M>;
  parseResult(value: unknown, request: HostCallRequest<M>): HostCallResult<M>;
}>;

/** One-way: the host keeps only the newest and writes it when the run ends, even a run that stops or crashes. */
type NotifyContract<M extends HostCallMethod> = Readonly<{
  kind: "notify";
  coalesce: "latest";
  parseRequest(value: unknown): HostCallRequest<M>;
}>;

export type HostCallContract<M extends HostCallMethod> = RequestContract<M> | NotifyContract<M>;

export const HOST_CALL_CONTRACTS: Readonly<{ [M in HostCallMethod]: HostCallContract<M> }> = Object.freeze({
  event: {
    kind: "request",
    lane: "acknowledged",
    maxPerRun: 512,
    duringStop: "drop",
    failureCode: "event-persistence-failed",
    parseRequest(value) {
      if (!isRecord(value) || !exactKeys(value, ["event"]) || !validEvent(value.event)) invalid();
      return value as HostCallRequest<"event">;
    },
    parseResult: parseAcknowledgement,
  },
  exchangeRateProgress: {
    kind: "request",
    lane: "acknowledged",
    maxPerRun: 64,
    duringStop: "drop",
    failureCode: "event-persistence-failed",
    parseRequest(value) {
      if (
        !isRecord(value) || !exactKeys(value, ["phaseCode", "completed", "total", "percent"])
        || (value.phaseCode !== "load-request" && value.phaseCode !== "sync" && value.phaseCode !== "complete")
        || !Number.isSafeInteger(value.completed) || Number(value.completed) < 0 || Number(value.completed) > 3
        || value.total !== 3
        || !Number.isSafeInteger(value.percent) || Number(value.percent) < 0 || Number(value.percent) > 100
      ) invalid();
      return value as HostCallRequest<"exchangeRateProgress">;
    },
    parseResult: parseAcknowledgement,
  },
  commitAttempt: {
    kind: "request",
    lane: "acknowledged",
    maxPerRun: 128,
    duringStop: "answer",
    failureCode: "event-persistence-failed",
    parseRequest(value) {
      if (!isRecord(value) || !exactKeys(value, ["attempt"]) || !isCommitAttemptReport(value.attempt)) invalid();
      return value as HostCallRequest<"commitAttempt">;
    },
    parseResult: parseAcknowledgement,
  },
  humanAssistance: {
    kind: "request",
    lane: "assistance",
    maxPerRun: Number.POSITIVE_INFINITY,
    duringStop: "drop",
    parseRequest(value) {
      if (!isRecord(value) || !exactKeys(value, ["contract"]) || !validHumanContract(value.contract)) invalid();
      return value as HostCallRequest<"humanAssistance">;
    },
    parseResult(value) {
      if (
        !isRecord(value) || !exactKeys(value, ["status"])
        || !completionStatuses.has(value.status as Exclude<HumanAssistanceCompletionStatus, "pending">)
      ) invalid();
      return value as HostCallResult<"humanAssistance">;
    },
  },
  tdccSession: {
    kind: "request",
    lane: "tdcc",
    maxPerRun: 8,
    duringStop: "drop",
    parseRequest(value) {
      if (!isRecord(value) || !exactKeys(value, ["operation"])
        || (value.operation !== "open" && value.operation !== "sign-in-details")) invalid();
      return value as HostCallRequest<"tdccSession">;
    },
    parseResult(value, request) {
      if (!(request.operation === "open" ? validTdccSessionLease(value) : validTdccSignInLease(value))) invalid();
      return value as HostCallResult<"tdccSession">;
    },
  },
  tdccSessionRotated: {
    kind: "notify",
    coalesce: "latest",
    parseRequest(value) {
      if (!isRecord(value) || !exactKeys(value, ["session"]) || !validTdccSession(value.session)) invalid();
      return value as HostCallRequest<"tdccSessionRotated">;
    },
  },
});

function isHostCallMethod(value: string): value is HostCallMethod {
  return Object.hasOwn(HOST_CALL_CONTRACTS, value);
}

const STOPPED = Symbol("stopped");

/** Thrown by a host handler that refuses a request it received; the host treats it as a protocol failure. */
export class HostCallRefusal extends Error {
  constructor() {
    super("The host refused a host call.");
    this.name = "HostCallRefusal";
  }
}

/** The host's answer to each method; a method without a handler is not available to this run. */
export type HostCallHandlers = Readonly<{
  [M in HostCallMethod]?: (request: HostCallRequest<M>, signal: AbortSignal) => HostCallResult<M> | Promise<HostCallResult<M>>;
}>;

export type HostCallDispatcherOptions = Readonly<{
  handlers: HostCallHandlers;
  /** Aborts when the run is stopped; handlers receive it. */
  signal: AbortSignal;
  /** True once the run is stopping or has reported its terminal frame: "drop" calls are then ignored. */
  stopping(): boolean;
  /** True once the run's outcome is settled; nothing is answered after that. */
  settled(): boolean;
  post(frame: HostCallReplyFrame): void;
  protocolFailure(): void;
}>;

export type HostCallDispatcher = Readonly<{
  receive(frame: HostCallFrame): void;
  /** True when no call is waiting for its answer, so the worker may report its terminal frame. */
  idle(): boolean;
  /** Writes each coalesced notification. Call once, when the run ends. */
  close(): void;
}>;

/** The host side of the host-call channel for one run. */
export function createHostCallDispatcher(options: HostCallDispatcherOptions): HostCallDispatcher {
  const seen = new Set<string>();
  const counts = new Map<HostCallMethod, number>();
  const busy = new Map<HostCallLane, Readonly<{ callId: string; duringStop: "drop" | "answer" }>>();
  const latest = new Map<HostCallMethod, unknown>();
  let flush: ReturnType<typeof setImmediate> | undefined;

  // A stop abandons every "drop" call, so a lane it held is free for an "answer" call.
  options.signal.addEventListener("abort", () => {
    for (const [lane, call] of busy) if (call.duringStop === "drop") busy.delete(lane);
  }, { once: true });

  const writeLatest = () => {
    if (flush) clearImmediate(flush);
    flush = undefined;
    const pending = [...latest];
    latest.clear();
    for (const [method, request] of pending) {
      try {
        (options.handlers[method] as ((request: unknown, signal: AbortSignal) => void) | undefined)?.(request, options.signal);
      } catch { /* a failed write leaves the previous value; the next run replaces it */ }
    }
  };

  // A "drop" call stops being awaited when the run stops, so a handler still
  // waiting, such as Human assistance waiting for a person, holds nothing here.
  const raceStop = <T>(answer: Promise<T>) => new Promise<T>((resolve, reject) => {
    if (options.signal.aborted) {
      reject(STOPPED);
      return;
    }
    const onStop = () => reject(STOPPED);
    options.signal.addEventListener("abort", onStop, { once: true });
    answer.then(resolve, reject).finally(() => options.signal.removeEventListener("abort", onStop));
  });

  const reply = (contract: RequestContract<HostCallMethod>, frame: HostCallReplyFrame) => {
    if (options.settled()) return;
    if (contract.duringStop === "drop" && options.stopping()) return;
    try {
      options.post(frame);
    } catch {
      options.protocolFailure();
    }
  };

  return {
    receive(frame) {
      if (!isHostCallMethod(frame.method)) {
        options.protocolFailure();
        return;
      }
      const method = frame.method;
      const contract = HOST_CALL_CONTRACTS[method] as HostCallContract<HostCallMethod>;
      let request: unknown;
      try {
        request = contract.parseRequest(frame.request);
      } catch {
        options.protocolFailure();
        return;
      }
      const stopping = options.stopping();
      if (stopping && contract.kind === "request" && contract.duringStop === "drop") return;
      const handler = options.handlers[method] as ((request: unknown, signal: AbortSignal) => unknown) | undefined;
      if (seen.has(frame.callId) || !handler) {
        if (!stopping) options.protocolFailure();
        return;
      }
      seen.add(frame.callId);

      if (contract.kind === "notify") {
        latest.set(method, request);
        flush ??= setImmediate(writeLatest);
        return;
      }
      const count = counts.get(method) ?? 0;
      if (busy.has(contract.lane) || count >= contract.maxPerRun) {
        options.protocolFailure();
        return;
      }
      counts.set(method, count + 1);
      const call = { callId: frame.callId, duringStop: contract.duringStop };
      busy.set(contract.lane, call);
      const release = () => {
        if (busy.get(contract.lane) === call) busy.delete(contract.lane);
      };

      void (async () => {
        let result: unknown;
        try {
          const answer = Promise.resolve().then(() => handler(request, options.signal));
          result = await (contract.duringStop === "drop" ? raceStop(answer) : answer);
        } catch (error) {
          if (error === STOPPED) return;
          release();
          if (error instanceof HostCallRefusal || !contract.failureCode) {
            if (!options.stopping()) options.protocolFailure();
            return;
          }
          reply(contract, {
            protocolVersion: APP_WORKFLOW_WORKER_PROTOCOL_VERSION,
            kind: "reply",
            callId: frame.callId,
            ok: false,
            code: contract.failureCode,
          });
          return;
        }
        release();
        const answer = result === undefined ? null : result;
        try {
          // The host checks its own answer too, so a lease carrying a secret it should not never reaches the worker.
          contract.parseResult(answer, request as never);
        } catch {
          options.protocolFailure();
          return;
        }
        reply(contract, {
          protocolVersion: APP_WORKFLOW_WORKER_PROTOCOL_VERSION,
          kind: "reply",
          callId: frame.callId,
          ok: true,
          result: answer,
        });
      })();
    },
    idle: () => busy.size === 0,
    close: writeLatest,
  };
}

export type HostCallClientOptions = Readonly<{
  post(frame: HostCallFrame): void;
  /** Aborts when the run is cancelled or the channel fails. */
  signal: AbortSignal;
  abortError(): Error;
  protocolFailure(): void;
}>;

export type HostCallClient = Readonly<{
  call<M extends Exclude<HostCallMethod, "tdccSessionRotated">>(method: M, request: HostCallRequest<M>): Promise<HostCallResult<M>>;
  notify<M extends "tdccSessionRotated">(method: M, request: HostCallRequest<M>): void;
  receive(frame: HostCallReplyFrame): void;
  /** Rejects every call still waiting. Call once, when the run ends. */
  close(): void;
}>;

type PendingCall = Readonly<{
  contract: RequestContract<HostCallMethod>;
  request: unknown;
  resolve(value: unknown): void;
  reject(error: Error): void;
}>;

/** The worker side of the host-call channel for one run. */
export function createHostCallClient(options: HostCallClientOptions): HostCallClient {
  const pending = new Map<string, PendingCall>();
  const lanes = new Map<HostCallLane, Promise<unknown>>();

  options.signal.addEventListener("abort", () => {
    for (const [callId, call] of pending) {
      if (call.contract.duringStop !== "drop") continue;
      pending.delete(callId);
      call.reject(options.abortError());
    }
  }, { once: true });

  const send = (contract: RequestContract<HostCallMethod>, method: HostCallMethod, request: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      if (contract.duringStop === "drop" && options.signal.aborted) {
        reject(options.abortError());
        return;
      }
      const callId = randomUUID();
      pending.set(callId, { contract, request, resolve, reject });
      try {
        options.post({ protocolVersion: APP_WORKFLOW_WORKER_PROTOCOL_VERSION, kind: "call", callId, method, request });
      } catch {
        pending.delete(callId);
        reject(new AppWorkflowWorkerProtocolError());
      }
    });

  return {
    call(method, request) {
      const contract = HOST_CALL_CONTRACTS[method] as RequestContract<HostCallMethod>;
      const previous = lanes.get(contract.lane) ?? Promise.resolve();
      const result = previous.then(() => send(contract, method, request));
      lanes.set(contract.lane, result.catch(() => undefined));
      return result as Promise<HostCallResult<typeof method>>;
    },
    notify(method, request) {
      try {
        options.post({ protocolVersion: APP_WORKFLOW_WORKER_PROTOCOL_VERSION, kind: "call", callId: randomUUID(), method, request });
      } catch { /* an unsendable notification leaves the host's previous value */ }
    },
    receive(frame) {
      const call = pending.get(frame.callId);
      if (!call) {
        options.protocolFailure();
        return;
      }
      pending.delete(frame.callId);
      if (!frame.ok) {
        if (frame.code !== call.contract.failureCode) {
          call.reject(new AppWorkflowWorkerProtocolError());
          options.protocolFailure();
          return;
        }
        call.reject(new Error(frame.code));
        return;
      }
      let result: unknown;
      try {
        result = call.contract.parseResult(frame.result, call.request as never);
      } catch {
        call.reject(new AppWorkflowWorkerProtocolError());
        options.protocolFailure();
        return;
      }
      call.resolve(result);
    },
    close() {
      for (const call of pending.values()) call.reject(options.abortError());
      pending.clear();
    },
  };
}
