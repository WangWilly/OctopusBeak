import {
  createHumanAssistanceContract,
  type HumanAssistanceCompletionStatus,
  type HumanAssistanceContractInput,
} from "../human-assistance.ts";
import type { WorkflowRunEvent } from "../workflow-executor.ts";
import type { TypedWorkflowOutcomeSummary } from "./typed-workflow-outcome.ts";
import type { GmailOtpFallbackReason } from "../gmail-otp.ts";
import { TYPED_WORKFLOW_ERROR_CODES } from "../workflow-failures.ts";

export const APP_WORKFLOW_WORKER_PROTOCOL_VERSION = 2 as const;
export const APP_WORKFLOW_WORKER_MAX_FRAME_BYTES = 1_048_576;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const SAFE_WORKFLOW_ID = /^[a-z][a-z0-9-]{0,63}$/u;
const SAFE_CODE = /^[a-z][a-z0-9-]{0,63}$/u;
const SAFE_TARGET_ID = /^[A-Za-z0-9._:-]{1,200}$/u;
const PGLITE_TOKEN = /^[A-Za-z0-9_-]{32,128}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CATHAY_OTP = /^[A-Z]{4}-[0-9]{6}$/u;
const gmailOtpFallbackReasons = new Set<GmailOtpFallbackReason>([
  "disabled",
  "not-configured",
  "needs-authorization",
  "authorization-cancelled",
  "authorization-failed",
  "token-invalid",
  "gmail-request-failed",
  "no-candidate",
  "ambiguous-candidate",
  "stale-candidate",
  "malformed-candidate",
  "unauthenticated-candidate",
  "unauthenticated-google-results",
  "unauthenticated-cathay-alignment",
  "unauthenticated-hme-original-sender",
  "unauthenticated-hme-relay-auth",
  "unauthenticated-hme-relay-signature",
  "timeout",
  "protocol-error",
]);
const stages = new Set<WorkflowRunEvent["stage"]>([
  "preparation", "authentication", "collection", "decoding", "validation", "commit", "finalization",
]);
const completionStatuses = new Set<Exclude<HumanAssistanceCompletionStatus, "pending">>([
  "entered", "verified", "failed",
]);
const failureCodes = new Set([
  ...TYPED_WORKFLOW_ERROR_CODES,
  "worker-start-failed",
  "protocol-invalid",
]);

export type AppWorkflowWorkerStart = Readonly<{
  protocolVersion: typeof APP_WORKFLOW_WORKER_PROTOCOL_VERSION;
  workflowId: string;
  taskRunId: string;
  input: unknown;
  browserConnection?: Readonly<{ endpoint: string; targetId: string }>;
  pgliteRpc?: Readonly<{ endpoint: string; token: string }>;
}>;

export type AppWorkflowWorkerInboundFrame =
  | Readonly<{ protocolVersion: 2; kind: "cancel" }>
  | Readonly<{
    protocolVersion: 2;
    kind: "event-ack";
    eventId: string;
    ok: boolean;
    code?: "event-persistence-failed";
  }>
  | Readonly<{
    protocolVersion: 2;
    kind: "human-assistance-response";
    requestId: string;
    status: Exclude<HumanAssistanceCompletionStatus, "pending">;
  }>
  | CathayGmailOtpResponseFrame;

export type CathayGmailOtpOperation = "ensure-access" | "prepare-retrieval" | "retrieve";

export type CathayGmailOtpRequestFrame =
  | Readonly<{
    protocolVersion: 2;
    kind: "cathay-gmail-otp-request";
    requestId: string;
    operation: "ensure-access" | "prepare-retrieval";
  }>
  | Readonly<{
    protocolVersion: 2;
    kind: "cathay-gmail-otp-request";
    requestId: string;
    operation: "retrieve";
    boundaryId: string;
  }>;

export type CathayGmailOtpResponseFrame =
  | Readonly<{
    protocolVersion: 2;
    kind: "cathay-gmail-otp-response";
    requestId: string;
    operation: "ensure-access";
    status: "ready";
  }>
  | Readonly<{
    protocolVersion: 2;
    kind: "cathay-gmail-otp-response";
    requestId: string;
    operation: "prepare-retrieval";
    status: "prepared";
    boundaryId: string;
  }>
  | Readonly<{
    protocolVersion: 2;
    kind: "cathay-gmail-otp-response";
    requestId: string;
    operation: "retrieve";
    status: "found";
    otp: string;
  }>
  | Readonly<{
    protocolVersion: 2;
    kind: "cathay-gmail-otp-response";
    requestId: string;
    operation: CathayGmailOtpOperation;
    status: "fallback";
    reason: GmailOtpFallbackReason;
  }>;

export type AppWorkflowWorkerOutboundFrame =
  | Readonly<{
    protocolVersion: 2;
    kind: "event";
    eventId: string;
    event: WorkflowRunEvent;
  }>
  | Readonly<{
    protocolVersion: 2;
    kind: "human-assistance-request";
    requestId: string;
    contract: HumanAssistanceContractInput;
  }>
  | Readonly<{
    protocolVersion: 2;
    kind: "exchange-rate-progress";
    eventId: string;
    phaseCode: "load-request" | "sync" | "complete";
    completed: number;
    total: number;
    percent: number;
  }>
  | Readonly<{
    protocolVersion: 2;
    kind: "completed";
    taskRunId: string;
    summary: TypedWorkflowOutcomeSummary | null;
  }>
  | Readonly<{
    protocolVersion: 2;
    kind: "failed";
    taskRunId: string | null;
    errorCode: string;
  }>
  | Readonly<{ protocolVersion: 2; kind: "cancelled"; taskRunId: string }>
  | CathayGmailOtpRequestFrame;

export class AppWorkflowWorkerProtocolError extends Error {
  readonly code = "invalid-frame";

  constructor() {
    super("App workflow worker protocol rejected a frame.");
    this.name = "AppWorkflowWorkerProtocolError";
  }
}

function invalid(): never {
  throw new AppWorkflowWorkerProtocolError();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key))) return false;
  return Object.keys(value).every((key) => allowed.has(key));
}

function jsonDepthAndSize(value: unknown, depth = 0, seen = new Set<object>()): void {
  if (depth > 32) invalid();
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid();
    return;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) invalid();
    seen.add(value);
    for (const item of value) jsonDepthAndSize(item, depth + 1, seen);
    seen.delete(value);
    return;
  }
  if (!isRecord(value) || seen.has(value)) invalid();
  seen.add(value);
  for (const [key, item] of Object.entries(value)) {
    if (!key || key.length > 256) invalid();
    jsonDepthAndSize(item, depth + 1, seen);
  }
  seen.delete(value);
}

function boundedJson(value: unknown): boolean {
  try {
    jsonDepthAndSize(value);
    return Buffer.byteLength(JSON.stringify(value), "utf8") <= APP_WORKFLOW_WORKER_MAX_FRAME_BYTES;
  } catch {
    return false;
  }
}

function validLoopbackConnection(value: unknown): value is AppWorkflowWorkerStart["browserConnection"] {
  if (!isRecord(value) || !exactKeys(value, ["endpoint", "targetId"])) return false;
  if (typeof value.endpoint !== "string" || typeof value.targetId !== "string") return false;
  try {
    const endpoint = new URL(value.endpoint);
    return endpoint.protocol === "http:"
      && endpoint.hostname === "127.0.0.1"
      && endpoint.port.length > 0
      && Number(endpoint.port) <= 65_535
      && (endpoint.pathname === "/" || endpoint.pathname === "")
      && !endpoint.search
      && !endpoint.hash
      && SAFE_TARGET_ID.test(value.targetId);
  } catch {
    return false;
  }
}

function validPGliteRpc(value: unknown): value is NonNullable<AppWorkflowWorkerStart["pgliteRpc"]> {
  return isRecord(value)
    && exactKeys(value, ["endpoint", "token"])
    && typeof value.endpoint === "string"
    && value.endpoint.length > 0
    && value.endpoint.length <= 1_024
    && typeof value.token === "string"
    && PGLITE_TOKEN.test(value.token);
}

export function parseAppWorkflowWorkerStart(value: unknown): AppWorkflowWorkerStart {
  if (!isRecord(value) || !exactKeys(value, [
    "protocolVersion", "workflowId", "taskRunId", "input",
  ], ["browserConnection", "pgliteRpc"])) invalid();
  const nonbrowser = value.workflowId === "exchange-rates" || value.workflowId === "sync-maicoin";
  if (
    value.protocolVersion !== APP_WORKFLOW_WORKER_PROTOCOL_VERSION
    || typeof value.workflowId !== "string"
    || !SAFE_WORKFLOW_ID.test(value.workflowId)
    || typeof value.taskRunId !== "string"
    || !SAFE_ID.test(value.taskRunId)
    || !Object.hasOwn(value, "input")
    || (nonbrowser ? Object.hasOwn(value, "browserConnection") : !validLoopbackConnection(value.browserConnection))
    || (nonbrowser && !Object.hasOwn(value, "pgliteRpc"))
    || (Object.hasOwn(value, "pgliteRpc") && !validPGliteRpc(value.pgliteRpc))
    || !boundedJson(value)
  ) invalid();
  return value as unknown as AppWorkflowWorkerStart;
}

export function parseAppWorkflowWorkerInboundFrame(value: unknown): AppWorkflowWorkerInboundFrame {
  if (!isRecord(value) || value.protocolVersion !== APP_WORKFLOW_WORKER_PROTOCOL_VERSION || !boundedJson(value)) invalid();
  if (value.kind === "cancel" && exactKeys(value, ["protocolVersion", "kind"])) {
    return value as unknown as AppWorkflowWorkerInboundFrame;
  }
  if (value.kind === "event-ack" && exactKeys(value, ["protocolVersion", "kind", "eventId", "ok"], ["code"])) {
    if (
      typeof value.eventId !== "string"
      || !SAFE_ID.test(value.eventId)
      || typeof value.ok !== "boolean"
      || (value.ok && Object.hasOwn(value, "code"))
      || (!value.ok && value.code !== "event-persistence-failed")
    ) invalid();
    return value as unknown as AppWorkflowWorkerInboundFrame;
  }
  if (value.kind === "human-assistance-response" && exactKeys(value, ["protocolVersion", "kind", "requestId", "status"])) {
    if (
      typeof value.requestId !== "string"
      || !SAFE_ID.test(value.requestId)
      || typeof value.status !== "string"
      || !completionStatuses.has(value.status as Exclude<HumanAssistanceCompletionStatus, "pending">)
    ) invalid();
    return value as unknown as AppWorkflowWorkerInboundFrame;
  }
  if (value.kind === "cathay-gmail-otp-response") {
    if (
      typeof value.requestId !== "string"
      || !UUID.test(value.requestId)
      || (value.operation !== "ensure-access" && value.operation !== "prepare-retrieval" && value.operation !== "retrieve")
    ) invalid();
    if (value.status === "fallback" && exactKeys(value, ["protocolVersion", "kind", "requestId", "operation", "status", "reason"])) {
      if (typeof value.reason !== "string" || !gmailOtpFallbackReasons.has(value.reason as GmailOtpFallbackReason)) invalid();
      return value as unknown as AppWorkflowWorkerInboundFrame;
    }
    if (value.operation === "ensure-access" && value.status === "ready" && exactKeys(value, ["protocolVersion", "kind", "requestId", "operation", "status"])) {
      return value as unknown as AppWorkflowWorkerInboundFrame;
    }
    if (value.operation === "prepare-retrieval" && value.status === "prepared" && exactKeys(value, ["protocolVersion", "kind", "requestId", "operation", "status", "boundaryId"])) {
      if (typeof value.boundaryId !== "string" || !UUID.test(value.boundaryId)) invalid();
      return value as unknown as AppWorkflowWorkerInboundFrame;
    }
    if (value.operation === "retrieve" && value.status === "found" && exactKeys(value, ["protocolVersion", "kind", "requestId", "operation", "status", "otp"])) {
      if (typeof value.otp !== "string" || !CATHAY_OTP.test(value.otp)) invalid();
      return value as unknown as AppWorkflowWorkerInboundFrame;
    }
  }
  invalid();
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
  if (contract.ocrAttemptPlan !== undefined && !contract.ocrAttemptPlan.every((plan) => allowNestedKeys(plan, ["imagePreprocessing", "ocrPageSegmentationMode", "ocrOutputStage"]))) return false;
  try {
    createHumanAssistanceContract(contract, 1);
    return boundedJson(contract);
  } catch {
    return false;
  }
}

function validEvent(value: unknown): value is WorkflowRunEvent {
  if (!isRecord(value) || !exactKeys(value, ["runId", "stage", "code", "occurredAt"], ["completed", "total"])) return false;
  if (
    typeof value.runId !== "string"
    || !SAFE_ID.test(value.runId)
    || typeof value.stage !== "string"
    || !stages.has(value.stage as WorkflowRunEvent["stage"])
    || typeof value.code !== "string"
    || !SAFE_CODE.test(value.code)
    || typeof value.occurredAt !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value.occurredAt)
    || !Number.isFinite(Date.parse(value.occurredAt))
  ) return false;
  for (const key of ["completed", "total"] as const) {
    if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0 || Number(value[key]) > 1_000_000_000)) return false;
  }
  if (value.completed !== undefined && value.total !== undefined && Number(value.completed) > Number(value.total)) return false;
  return true;
}

function validSummary(value: unknown): value is TypedWorkflowOutcomeSummary | null {
  if (value === null) return true;
  if (!isRecord(value) || !exactKeys(value, ["counts"], ["status"]) || !isRecord(value.counts)) return false;
  const statuses = new Set(["financial-admitted", "source-only", "no-data", "completed", "partial", "failed"]);
  const countNames = new Set([
    "accountCount", "canonicalCaptureCount", "count", "financialItemCount", "holdingGridCount",
    "holdingPageCount", "holdingRowCount", "invoiceCount", "itemCount", "rowCount",
    "skippedAccountCount", "skippedProductCount", "sourceCaptureCount", "statementRowCount",
    "tradeGridCount", "tradePageCount", "tradeRowCount",
  ]);
  if (value.status !== undefined && (typeof value.status !== "string" || !statuses.has(value.status))) return false;
  return Object.entries(value.counts).every(([key, count]) => countNames.has(key)
    && Number.isSafeInteger(count)
    && Number(count) >= 0
    && Number(count) <= 1_000_000_000);
}

export function parseAppWorkflowWorkerOutboundFrame(value: unknown): AppWorkflowWorkerOutboundFrame {
  if (!isRecord(value) || value.protocolVersion !== APP_WORKFLOW_WORKER_PROTOCOL_VERSION || !boundedJson(value)) invalid();
  if (value.kind === "exchange-rate-progress" && exactKeys(value, ["protocolVersion", "kind", "eventId", "phaseCode", "completed", "total", "percent"])) {
    if (
      typeof value.eventId !== "string" || !SAFE_ID.test(value.eventId)
      || (value.phaseCode !== "load-request" && value.phaseCode !== "sync" && value.phaseCode !== "complete")
      || !Number.isSafeInteger(value.completed) || Number(value.completed) < 0 || Number(value.completed) > 3
      || value.total !== 3
      || !Number.isSafeInteger(value.percent) || Number(value.percent) < 0 || Number(value.percent) > 100
      || Number(value.completed) > Number(value.total)
    ) invalid();
    return value as unknown as AppWorkflowWorkerOutboundFrame;
  }
  if (value.kind === "event" && exactKeys(value, ["protocolVersion", "kind", "eventId", "event"])) {
    if (typeof value.eventId !== "string" || !SAFE_ID.test(value.eventId) || !validEvent(value.event)) invalid();
    return value as unknown as AppWorkflowWorkerOutboundFrame;
  }
  if (value.kind === "human-assistance-request" && exactKeys(value, ["protocolVersion", "kind", "requestId", "contract"])) {
    if (typeof value.requestId !== "string" || !SAFE_ID.test(value.requestId) || !validHumanContract(value.contract)) invalid();
    return value as unknown as AppWorkflowWorkerOutboundFrame;
  }
  if (value.kind === "cathay-gmail-otp-request") {
    if (
      typeof value.requestId !== "string"
      || !UUID.test(value.requestId)
      || (value.operation !== "ensure-access" && value.operation !== "prepare-retrieval" && value.operation !== "retrieve")
    ) invalid();
    if (value.operation === "retrieve") {
      if (!exactKeys(value, ["protocolVersion", "kind", "requestId", "operation", "boundaryId"])) invalid();
      if (typeof value.boundaryId !== "string" || !UUID.test(value.boundaryId)) invalid();
      return value as unknown as AppWorkflowWorkerOutboundFrame;
    }
    if (!exactKeys(value, ["protocolVersion", "kind", "requestId", "operation"])) invalid();
    return value as unknown as AppWorkflowWorkerOutboundFrame;
  }
  if (value.kind === "completed" && exactKeys(value, ["protocolVersion", "kind", "taskRunId", "summary"])) {
    if (typeof value.taskRunId !== "string" || !SAFE_ID.test(value.taskRunId) || !validSummary(value.summary)) invalid();
    return value as unknown as AppWorkflowWorkerOutboundFrame;
  }
  if (value.kind === "failed" && exactKeys(value, ["protocolVersion", "kind", "taskRunId", "errorCode"])) {
    if (
      (value.taskRunId !== null && (typeof value.taskRunId !== "string" || !SAFE_ID.test(value.taskRunId)))
      || typeof value.errorCode !== "string"
      || !failureCodes.has(value.errorCode)
    ) invalid();
    return value as unknown as AppWorkflowWorkerOutboundFrame;
  }
  if (value.kind === "cancelled" && exactKeys(value, ["protocolVersion", "kind", "taskRunId"])) {
    if (typeof value.taskRunId !== "string" || !SAFE_ID.test(value.taskRunId)) invalid();
    return value as unknown as AppWorkflowWorkerOutboundFrame;
  }
  invalid();
}
