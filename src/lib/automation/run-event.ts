import type {
  WorkflowProgressActivity,
  WorkflowProgressStatementType,
  WorkflowStage,
} from "./workflow-executor.ts";

/** ADR 0059: readers take an event's meaning from its outcome and signal, never its code. */
export const RUN_EVENT_OUTCOMES = ["started", "advanced", "completed", "failed"] as const;
export type RunEventOutcome = typeof RUN_EVENT_OUTCOMES[number];

export const RUN_EVENT_SIGNALS = {
  "verification-solver-exhausted": { stage: "authentication", outcome: "failed" },
  "solver-route-unavailable": { stage: "authentication", outcome: "failed" },
  "solver-challenge-unsupported": { stage: "authentication", outcome: "failed" },
  "login-dialog-interrupted": { stage: "authentication", outcome: "failed" },
  "human-assistance-failed": { stage: "authentication", outcome: "failed" },
} as const satisfies Record<string, Readonly<{ stage: WorkflowStage; outcome: RunEventOutcome }>>;
export type RunEventSignal = keyof typeof RUN_EVENT_SIGNALS;

type RunEventDetail = Readonly<{
  runId: string;
  occurredAt: string;
  completed?: number;
  total?: number;
  activity?: WorkflowProgressActivity;
  statementType?: WorkflowProgressStatementType;
  retrying?: boolean;
}>;

type PlainRunEvent = RunEventDetail & Readonly<{
  stage: WorkflowStage;
  outcome: RunEventOutcome;
  code: string;
  signal?: undefined;
}>;

type SignalRunEvent = {
  [S in RunEventSignal]: RunEventDetail & Readonly<{
    stage: typeof RUN_EVENT_SIGNALS[S]["stage"];
    outcome: typeof RUN_EVENT_SIGNALS[S]["outcome"];
    code: S;
    signal: S;
  }>;
}[RunEventSignal];

export type WorkflowRunEvent = PlainRunEvent | SignalRunEvent;

const OUTCOMES: ReadonlySet<string> = new Set(RUN_EVENT_OUTCOMES);

export function isRunEventSignal(value: unknown): value is RunEventSignal {
  return typeof value === "string" && Object.hasOwn(RUN_EVENT_SIGNALS, value);
}

export function signalRunEvent<S extends RunEventSignal>(
  signal: S,
  detail: Pick<RunEventDetail, "runId" | "occurredAt">,
): Extract<SignalRunEvent, { signal: S }> {
  const { stage, outcome } = RUN_EVENT_SIGNALS[signal];
  return { ...detail, stage, outcome, code: signal, signal } as Extract<SignalRunEvent, { signal: S }>;
}

/** Boundary check for the closed outcome and a signal that agrees with its stage, outcome and code. */
export function hasValidRunEventMeaning(value: Readonly<Record<string, unknown>>): boolean {
  if (typeof value.outcome !== "string" || !OUTCOMES.has(value.outcome)) return false;
  if (value.signal === undefined) return !isRunEventSignal(value.code);
  if (!isRunEventSignal(value.signal)) return false;
  const fixed = RUN_EVENT_SIGNALS[value.signal];
  return value.code === value.signal && value.stage === fixed.stage && value.outcome === fixed.outcome;
}

const LEGACY_FAILED = /(?:failed|rejected|malformed|exhausted|unavailable|unsupported|interrupted|cancelled|canceled|error)$/u;
const LEGACY_COMPLETED = /(?:completed|complete|collected|no-data|validated|ready|persisted|admitted)$/u;

export function legacyRunEventOutcome(code: string): RunEventOutcome {
  if (LEGACY_FAILED.test(code)) return "failed";
  if (LEGACY_COMPLETED.test(code)) return "completed";
  if (code.endsWith("started")) return "started";
  return "advanced";
}

/**
 * Give an event stored before ADR 0059 its outcome and signal. Run events are
 * kept 30 days, so this upgrade and the legacy patterns can be deleted after
 * 2026-11-23.
 */
export function upgradeStoredRunEvent(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const event = value as Record<string, unknown>;
  if (event.outcome !== undefined || typeof event.code !== "string") return value;
  if (isRunEventSignal(event.code) && event.stage === RUN_EVENT_SIGNALS[event.code].stage) {
    return { ...event, outcome: RUN_EVENT_SIGNALS[event.code].outcome, signal: event.code };
  }
  if (isRunEventSignal(event.code)) return value;
  return { ...event, outcome: legacyRunEventOutcome(event.code) };
}
