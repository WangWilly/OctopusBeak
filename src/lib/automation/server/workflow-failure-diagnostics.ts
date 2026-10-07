import { appendFile, chmod, mkdir } from "node:fs/promises";
import { lstatSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { TYPED_WORKFLOW_ERROR_CODES } from "../workflow-failures.ts";
import {
  WORKFLOW_PROGRESS_STATEMENT_TYPE_IDS,
  type WorkflowProgressStatementType,
  type WorkflowRunEvent,
} from "../workflow-executor.ts";

const SAFE_WORKFLOW_ID = /^[a-z][a-z0-9-]{0,63}$/u;
const SAFE_TASK_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const ERROR_TYPES = new Set([
  "Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "URIError", "EvalError",
  "AggregateError", "AbortError", "TimeoutError", "PostgresError", "DatabaseError", "PGliteError",
]);
const POSTGRES_SQLSTATES = new Set([
  "08000", "08003", "08006", "22001", "22003", "22P02", "25P02", "40001", "40P01", "42601",
  "42703", "42804", "42883", "42P01", "53100", "53200", "53300", "55P03", "57014", "23502",
  "23503", "23505", "23514", "XX000",
]);
const HTTP_FAILURE_STATUSES = new Set([400, 401, 403, 404, 408, 409, 422, 429, 500, 502, 503, 504]);
const STAGES = new Set<WorkflowRunEvent["stage"]>([
  "preparation", "authentication", "collection", "decoding", "validation", "commit", "finalization",
]);
const FAILURE_CODES = new Set<string>([
  ...TYPED_WORKFLOW_ERROR_CODES,
  "worker-start-failed", "worker-crash", "unexpected-exit", "protocol-invalid",
]);
const SOURCES = new Set(["workflow-worker", "workflow-host", "financial-rpc", "operational-rpc"]);
const STATEMENT_TYPES = new Set<string>(WORKFLOW_PROGRESS_STATEMENT_TYPE_IDS);
const MAX_CHAIN = 4;
const MAX_FRAMES_PER_ERROR = 8;
const MAX_RECORD_BYTES = 16_384;
const BUILT_ELECTRON_ENTRIES = /^build-electron\/(?:main|app-workflow-worker|pglite-view-worker|preload)\.cjs$/u;
const HASHED_ELECTRON_CHUNK = /^build-electron\/[a-z0-9]+(?:-[a-z0-9]+)*-[A-Za-z0-9_-]{8}\.cjs$/u;
export const WORKFLOW_FAILURE_DIAGNOSTICS_FILE_ENV = "OCTOPUSBEAK_WORKFLOW_DIAGNOSTICS_FILE" as const;

/** Main changes to userData as cwd; use the App's declared root for frame checks. */
export function workflowFailureDiagnosticRepoRoot(environment: NodeJS.ProcessEnv = process.env): string {
  const appRoot = environment.OCTOPUSBEAK_APP_ROOT;
  return typeof appRoot === "string" && appRoot.trim() !== "" ? resolve(appRoot) : process.cwd();
}

export type WorkflowFailureStackFrame = Readonly<{
  file: string;
  line: number;
  column: number;
}>;

export type WorkflowFailureCorrelation = Readonly<{
  workflowId: string;
  taskRunId: string;
}>;

export function isWorkflowFailureCorrelation(value: unknown): value is WorkflowFailureCorrelation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).every((key) => key === "workflowId" || key === "taskRunId")
    && typeof row.workflowId === "string" && SAFE_WORKFLOW_ID.test(row.workflowId)
    && typeof row.taskRunId === "string" && SAFE_TASK_RUN_ID.test(row.taskRunId);
}

export type WorkflowFailureErrorNode = Readonly<{
  type: string;
  sqlState?: string;
  httpStatus?: number;
  frames: readonly WorkflowFailureStackFrame[];
}>;

export type SafeWorkflowFailureError = Readonly<{
  chain: readonly WorkflowFailureErrorNode[];
}>;

export type WorkflowFailureDiagnostic = Readonly<{
  version: 1;
  occurredAt: string;
  workflowId: string;
  taskRunId: string;
  source: "workflow-worker" | "workflow-host" | "financial-rpc" | "operational-rpc";
  errorCode: string;
  stage?: WorkflowRunEvent["stage"];
  statementType?: WorkflowProgressStatementType;
  operation?: string;
  error: SafeWorkflowFailureError;
}>;

export type WorkflowFailureDiagnosticInput = Readonly<{
  workflowId: string;
  taskRunId: string;
  source: WorkflowFailureDiagnostic["source"];
  errorCode: string;
  stage?: WorkflowRunEvent["stage"];
  statementType?: WorkflowProgressStatementType;
  operation?: string;
  error?: unknown;
  safeError?: unknown;
}>;

// Internal typed RPC errors carry only a revalidated snapshot, never a raw cause.
const rpcErrorSnapshots = new WeakMap<Error, SafeWorkflowFailureError>();

export function retainSafeWorkflowFailureError(error: Error, value: unknown): void {
  if (!process.env[WORKFLOW_FAILURE_DIAGNOSTICS_FILE_ENV]?.trim()) return;
  try {
    const snapshot = sanitizeSafeWorkflowFailureError(value);
    if (snapshot.chain.length) rpcErrorSnapshots.set(error, snapshot);
  } catch {
    // Untrusted diagnostic fields cannot change the request outcome.
  }
}

function ownDataValue(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function prototypeDataValue(value: object, key: string): unknown {
  try {
    let prototype = Object.getPrototypeOf(value) as object | null;
    for (let depth = 0; prototype && depth < 4; depth += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
      if (descriptor && "value" in descriptor) return descriptor.value;
      prototype = Object.getPrototypeOf(prototype) as object | null;
    }
  } catch {
    // Diagnostic inspection must never replace the workflow's original error.
  }
  return undefined;
}

function errorType(error: Error): string {
  try {
    const name = ownDataValue(error, "name") ?? prototypeDataValue(error, "name");
    return typeof name === "string" && ERROR_TYPES.has(name) ? name : "Error";
  } catch {
    return "Error";
  }
}

function isBuiltElectronFrame(file: string, repoRoot: string): boolean {
  if (BUILT_ELECTRON_ENTRIES.test(file)) return true;
  if (!HASHED_ELECTRON_CHUNK.test(file)) return false;
  try {
    // Vite/Rolldown emits trusted hashed chunks beside the four stable entries.
    // Checking the artifact inventory keeps arbitrary names and missing chunks
    // out of both the worker snapshot and the host's protocol revalidation.
    return lstatSync(resolve(repoRoot, file)).isFile();
  } catch {
    return false;
  }
}

function projectRelativeFramePath(value: string, repoRoot: string): string | null {
  let file = value.trim();
  if (file.startsWith("file://")) {
    try { file = decodeURIComponent(new URL(file).pathname); } catch { return null; }
  }
  if (!isAbsolute(file)) return null;
  const root = resolve(repoRoot);
  const rel = relative(root, resolve(file)).split(sep).join("/");
  if (!rel || rel.startsWith("../") || rel === ".." || isAbsolute(rel)) return null;
  if (/^(?:src|electron)\/[A-Za-z0-9_./-]+\.(?:[cm]?[jt]s|cjs)$/u.test(rel)) return rel;
  if (isBuiltElectronFrame(rel, root)) return rel;
  return null;
}

function framesFor(error: Error, repoRoot: string): WorkflowFailureStackFrame[] {
  const descriptor = Object.getOwnPropertyDescriptor(error, "stack");
  let stack = descriptor && "value" in descriptor ? descriptor.value : undefined;
  if (stack === undefined && descriptor?.get) {
    const knownStackGetter = Object.getOwnPropertyDescriptor(new Error(), "stack")?.get;
    if (knownStackGetter && descriptor.get === knownStackGetter) {
      try { stack = Reflect.apply(descriptor.get, error, []); } catch { /* ignore unsafe runtime state */ }
    }
  }
  if (typeof stack !== "string") return [];
  const frames: WorkflowFailureStackFrame[] = [];
  for (const line of stack.split("\n").slice(1)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("at ")) continue;
    const afterAt = trimmed.slice(3).trim();
    const open = afterAt.lastIndexOf("(");
    const candidate = open >= 0 ? afterAt.slice(open + 1).replace(/\)$/u, "") : afterAt;
    const match = candidate.match(/^(?<file>.+):(?<line>\d+):(?<column>\d+)$/u);
    if (!match?.groups) continue;
    const file = projectRelativeFramePath(match.groups.file, repoRoot);
    const sourceLine = Number(match.groups.line);
    const column = Number(match.groups.column);
    if (!file || !Number.isSafeInteger(sourceLine) || sourceLine < 1 || sourceLine > 1_000_000
      || !Number.isSafeInteger(column) || column < 1 || column > 1_000_000) continue;
    frames.push({ file, line: sourceLine, column });
    if (frames.length >= MAX_FRAMES_PER_ERROR) break;
  }
  return frames;
}

function causeOf(error: Error): unknown {
  return ownDataValue(error, "cause");
}

function sqlStateFor(error: Error): string | undefined {
  const code = ownDataValue(error, "code");
  return typeof code === "string" && POSTGRES_SQLSTATES.has(code) ? code : undefined;
}

/** Capture only fixed error labels, known PostgreSQL states, and repo-local frames. */
export function captureSafeWorkflowFailureError(error: unknown, repoRoot: string): SafeWorkflowFailureError {
  const chain: WorkflowFailureErrorNode[] = [];
  const seen = new Set<object>();
  let current: unknown = error;
  try {
    for (let depth = 0; depth < MAX_CHAIN && current instanceof Error && !seen.has(current); depth += 1) {
      seen.add(current);
      const retained = rpcErrorSnapshots.get(current);
      if (retained) {
        chain.push(...sanitizeSafeWorkflowFailureError(retained, repoRoot).chain.slice(0, MAX_CHAIN - chain.length));
        break;
      }
      const type = errorType(current);
      const sqlState = sqlStateFor(current);
      const status = ownDataValue(current, "status");
      const httpStatus = typeof status === "number" && HTTP_FAILURE_STATUSES.has(status) ? status : undefined;
      chain.push({
        type,
        ...(sqlState ? { sqlState } : {}),
        ...(httpStatus ? { httpStatus } : {}),
        frames: framesFor(current, repoRoot),
      });
      current = causeOf(current);
    }
  } catch {
    // Error proxies and unusual causes are opaque; keep any safe data captured so far.
  }
  return { chain };
}

function safeFrame(value: unknown, repoRoot: string): WorkflowFailureStackFrame | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => !["file", "line", "column"].includes(key))) return null;
  if (typeof row.file !== "string"
    || !/^(?:src|electron)\/[A-Za-z0-9_./-]+\.(?:[cm]?[jt]s|cjs)$/u.test(row.file)
      && !isBuiltElectronFrame(row.file, repoRoot)
    || row.file.split("/").some((segment) => segment === ".." || segment === ".")
    || !Number.isSafeInteger(row.line) || Number(row.line) < 1 || Number(row.line) > 1_000_000
    || !Number.isSafeInteger(row.column) || Number(row.column) < 1 || Number(row.column) > 1_000_000) return null;
  return { file: row.file, line: Number(row.line), column: Number(row.column) };
}

/** Revalidate worker-provided data and copy only the fixed diagnostic schema. */
export function sanitizeSafeWorkflowFailureError(
  value: unknown,
  repoRoot = workflowFailureDiagnosticRepoRoot(),
): SafeWorkflowFailureError {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { chain: [] };
  const row = value as Record<string, unknown>;
  if (!Array.isArray(row.chain)) return { chain: [] };
  const chain: WorkflowFailureErrorNode[] = [];
  for (const candidate of row.chain.slice(0, MAX_CHAIN)) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) continue;
    const item = candidate as Record<string, unknown>;
    if (typeof item.type !== "string" || !ERROR_TYPES.has(item.type) || !Array.isArray(item.frames)) continue;
    const frames = item.frames.slice(0, MAX_FRAMES_PER_ERROR)
      .map((frame) => safeFrame(frame, repoRoot))
      .filter((frame): frame is WorkflowFailureStackFrame => frame !== null);
    const sqlState = typeof item.sqlState === "string" && POSTGRES_SQLSTATES.has(item.sqlState)
      ? item.sqlState
      : undefined;
    const httpStatus = typeof item.httpStatus === "number" && HTTP_FAILURE_STATUSES.has(item.httpStatus)
      ? item.httpStatus : undefined;
    chain.push({ type: item.type, ...(sqlState ? { sqlState } : {}), ...(httpStatus ? { httpStatus } : {}), frames });
  }
  return { chain };
}

function buildRecord(input: WorkflowFailureDiagnosticInput, options: { repoRoot: string; now?: () => Date }): WorkflowFailureDiagnostic | null {
  if (!SAFE_WORKFLOW_ID.test(input.workflowId)
    || !SAFE_TASK_RUN_ID.test(input.taskRunId)
    || !SOURCES.has(input.source)
    || !FAILURE_CODES.has(input.errorCode)
    || (input.stage !== undefined && !STAGES.has(input.stage))
    || (input.statementType !== undefined && !STATEMENT_TYPES.has(input.statementType))) return null;
  const operation = input.operation && /^(?:financial|maicoin|exchangeRates|automation)(?:\.[A-Za-z]+)+$/u.test(input.operation)
    ? input.operation
    : undefined;
  const safeError = input.safeError === undefined
    ? captureSafeWorkflowFailureError(input.error, options.repoRoot)
    : sanitizeSafeWorkflowFailureError(input.safeError, options.repoRoot);
  const occurredAt = (options.now?.() ?? new Date()).toISOString();
  return {
    version: 1,
    occurredAt,
    workflowId: input.workflowId,
    taskRunId: input.taskRunId,
    source: input.source,
    errorCode: input.errorCode,
    ...(input.stage ? { stage: input.stage } : {}),
    ...(input.statementType ? { statementType: input.statementType } : {}),
    ...(operation ? { operation } : {}),
    error: safeError,
  };
}

/** Append one opt-in, bounded, private JSONL record; diagnostics never affect the failure outcome. */
export async function appendWorkflowFailureDiagnostic(
  filePath: string | undefined,
  input: WorkflowFailureDiagnosticInput,
  options: { repoRoot: string; now?: () => Date },
): Promise<boolean> {
  if (!filePath || filePath.trim() === "") return false;
  try {
    const record = buildRecord(input, options);
    if (!record) return false;
    const line = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(line, "utf8") > MAX_RECORD_BYTES) return false;
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
    await appendFile(filePath, line, { encoding: "utf8", mode: 0o600 });
    await chmod(filePath, 0o600);
    return true;
  } catch {
    return false;
  }
}
