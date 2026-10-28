import { isWorkflowRunResult, type WorkflowRunResult } from "../workflow-run-result.ts";
import { workflowRuntimeForTask } from "./app-workflow-registry.ts";
import { TYPED_WORKFLOW_ERROR_CODES } from "../workflow-failures.ts";
import type { PGliteWorkflowRpc } from "../../../../electron/pglite-child-rpc-client.ts";
import {
  sanitizeSafeWorkflowFailureError,
  workflowFailureDiagnosticRepoRoot,
  type SafeWorkflowFailureError,
} from "./workflow-failure-diagnostics.ts";
import { parsePreviewResponseShapes, type PreviewResponseShapes } from "../../preview-sources/structure-report.ts";

export const APP_WORKFLOW_WORKER_PROTOCOL_VERSION = 3 as const;
export const APP_WORKFLOW_WORKER_MAX_FRAME_BYTES = 1_048_576;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const SAFE_WORKFLOW_ID = /^[a-z][a-z0-9-]{0,63}$/u;
const SAFE_CODE = /^[a-z][a-z0-9-]{0,63}$/u;
const SAFE_METHOD = /^[a-z][A-Za-z0-9]{0,63}$/u;
const SAFE_TARGET_ID = /^[A-Za-z0-9._:-]{1,200}$/u;
const PGLITE_TOKEN = /^[A-Za-z0-9_-]{32,128}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
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
  pgliteRpc?: PGliteWorkflowRpc;
}>;

/** A host call (ADR 0072); its method's contract in app-workflow-host-calls.ts validates the request. */
export type HostCallFrame = Readonly<{
  protocolVersion: 3;
  kind: "call";
  callId: string;
  method: string;
  request: unknown;
}>;

/** The answer to one host call; its method's contract validates the result. */
export type HostCallReplyFrame =
  | Readonly<{ protocolVersion: 3; kind: "reply"; callId: string; ok: true; result: unknown }>
  | Readonly<{ protocolVersion: 3; kind: "reply"; callId: string; ok: false; code: string }>;

export type AppWorkflowWorkerInboundFrame =
  | Readonly<{ protocolVersion: 3; kind: "cancel" }>
  | HostCallReplyFrame;

export type AppWorkflowWorkerOutboundFrame =
  | HostCallFrame
  | Readonly<{
    protocolVersion: 3;
    kind: "completed";
    taskRunId: string;
    summary: WorkflowRunResult | null;
  }>
  | Readonly<{
    protocolVersion: 3;
    kind: "failed";
    taskRunId: string | null;
    errorCode: string;
    diagnostic?: SafeWorkflowFailureError;
    summary?: WorkflowRunResult | null;
    previewResponses?: PreviewResponseShapes;
  }>
  | Readonly<{
    protocolVersion: 3;
    kind: "cancelled";
    taskRunId: string;
    summary?: WorkflowRunResult | null;
  }>;

export class AppWorkflowWorkerProtocolError extends Error {
  readonly code = "invalid-frame";

  constructor() {
    super("App workflow worker protocol rejected a frame.");
    this.name = "AppWorkflowWorkerProtocolError";
  }
}

function parsedPreviewResponses(value: unknown): PreviewResponseShapes {
  try {
    return parsePreviewResponseShapes(value);
  } catch {
    invalid();
  }
}

function invalid(): never {
  throw new AppWorkflowWorkerProtocolError();
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) {
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

export function boundedJson(value: unknown): boolean {
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
  const nonbrowser = typeof value.workflowId === "string"
    && workflowRuntimeForTask(value.workflowId).kind === "nonbrowser";
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
  if (value.kind === "reply" && typeof value.ok === "boolean"
    && exactKeys(value, ["protocolVersion", "kind", "callId", "ok", value.ok ? "result" : "code"])) {
    if (
      typeof value.callId !== "string"
      || !UUID.test(value.callId)
      || (!value.ok && (typeof value.code !== "string" || !SAFE_CODE.test(value.code)))
    ) invalid();
    return value as unknown as AppWorkflowWorkerInboundFrame;
  }
  invalid();
}

function validSummary(value: unknown): value is WorkflowRunResult | null {
  return value === null || isWorkflowRunResult(value);
}

export function parseAppWorkflowWorkerOutboundFrame(
  value: unknown,
  diagnosticRepoRoot = workflowFailureDiagnosticRepoRoot(),
): AppWorkflowWorkerOutboundFrame {
  if (!isRecord(value) || value.protocolVersion !== APP_WORKFLOW_WORKER_PROTOCOL_VERSION || !boundedJson(value)) invalid();
  if (value.kind === "call" && exactKeys(value, ["protocolVersion", "kind", "callId", "method", "request"])) {
    if (
      typeof value.callId !== "string"
      || !UUID.test(value.callId)
      || typeof value.method !== "string"
      || !SAFE_METHOD.test(value.method)
    ) invalid();
    return value as unknown as AppWorkflowWorkerOutboundFrame;
  }
  if (value.kind === "completed" && exactKeys(value, ["protocolVersion", "kind", "taskRunId", "summary"])) {
    if (typeof value.taskRunId !== "string" || !SAFE_ID.test(value.taskRunId) || !validSummary(value.summary)) invalid();
    return value as unknown as AppWorkflowWorkerOutboundFrame;
  }
  if (value.kind === "failed" && exactKeys(value, ["protocolVersion", "kind", "taskRunId", "errorCode"], ["diagnostic", "summary", "previewResponses"])) {
    if (
      (value.taskRunId !== null && (typeof value.taskRunId !== "string" || !SAFE_ID.test(value.taskRunId)))
      || typeof value.errorCode !== "string"
      || !failureCodes.has(value.errorCode)
      || (Object.hasOwn(value, "summary") && !validSummary(value.summary))
    ) invalid();
    return {
      protocolVersion: APP_WORKFLOW_WORKER_PROTOCOL_VERSION,
      kind: "failed",
      taskRunId: value.taskRunId as string | null,
      errorCode: value.errorCode,
      ...(Object.hasOwn(value, "summary") ? { summary: value.summary as WorkflowRunResult | null } : {}),
      ...(Object.hasOwn(value, "diagnostic")
        ? { diagnostic: sanitizeSafeWorkflowFailureError(value.diagnostic, diagnosticRepoRoot) }
        : {}),
      ...(Object.hasOwn(value, "previewResponses")
        ? { previewResponses: parsedPreviewResponses(value.previewResponses) }
        : {}),
    };
  }
  if (value.kind === "cancelled" && exactKeys(value, ["protocolVersion", "kind", "taskRunId"], ["summary"])) {
    if (typeof value.taskRunId !== "string" || !SAFE_ID.test(value.taskRunId)
      || (Object.hasOwn(value, "summary") && !validSummary(value.summary))) invalid();
    return value as unknown as AppWorkflowWorkerOutboundFrame;
  }
  invalid();
}
