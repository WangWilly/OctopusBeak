/**
 * Privacy-bounded performance telemetry for financial UI operations.
 *
 * This module is intentionally in-process.  It does not write a file, emit a
 * log line, or accept arbitrary error/detail payloads.  The aggregate surface
 * contains only dimensions that are useful for performance work without
 * carrying financial facts across a diagnostics boundary.
 */

export const FINANCIAL_INTERACTION_SLO_MS = Object.freeze({
  normal: 200,
  contention: 500,
});

export type FinancialPerformanceOperationKind =
  | "spending-action"
  | "financial-load";

export type FinancialPerformanceSpan =
  | "action-start"
  | "action-result"
  | "worker-dispatch"
  | "worker-response"
  | "store-open"
  | "narrow-validation"
  | "canonical-transaction"
  | "canonical-commit"
  | "patch-applied"
  | "paint-ready"
  | "page-shell"
  | "primary-load"
  | "secondary-load";

export type FinancialPerformanceOutcome = "success" | "error";
export type FinancialPerformanceSlo = "within-budget" | "violation" | "not-applicable";
export type FinancialPerformanceCardinalityBucket =
  | "unknown"
  | "0"
  | "1-10"
  | "11-100"
  | "101-1000"
  | "1001+";

export type FinancialPerformanceBuildProfile =
  | "development"
  | "production"
  | "test"
  | "unknown";

export type FinancialPerformanceHardwareProfile =
  | "low"
  | "medium"
  | "high"
  | "unknown";

export type FinancialPerformanceErrorCode =
  | "unknown"
  | "spending-pair-stale"
  | "idempotency-key-conflict"
  | "canonical-cutoff-unavailable"
  | "worker-closed"
  | "worker-exit"
  | "worker-error"
  | "financial-section-knowledge-point-mismatch"
  | "spending-action-stale"
  | "validation-failed"
  | "contention"
  | "cancelled";

export type FinancialPerformanceContext = Readonly<{
  knowledgePointDistance?: number | null;
  cardinality?: number | FinancialPerformanceCardinalityBucket | null;
  contention?: boolean;
  coldStart?: boolean;
}>;

export type FinancialPerformanceEvent = Readonly<{
  operation: FinancialPerformanceOperationKind;
  span: FinancialPerformanceSpan;
  durationMs: number;
  knowledgePointDistance: number | null;
  cardinalityBucket: FinancialPerformanceCardinalityBucket;
  contention: boolean;
  coldStart: boolean;
  outcome: FinancialPerformanceOutcome;
  errorCode?: FinancialPerformanceErrorCode;
  slo: FinancialPerformanceSlo;
  buildProfile: FinancialPerformanceBuildProfile;
  hardwareProfile: FinancialPerformanceHardwareProfile;
  /** Opaque process-local correlation only; never a financial identity. */
  correlationId: string;
}>;

export type FinancialPerformanceAggregate = Readonly<{
  operation: FinancialPerformanceOperationKind;
  span: FinancialPerformanceSpan;
  outcome: FinancialPerformanceOutcome;
  errorCode?: FinancialPerformanceErrorCode;
  knowledgePointDistance: number | null;
  cardinalityBucket: FinancialPerformanceCardinalityBucket;
  contention: boolean;
  coldStart: boolean;
  slo: FinancialPerformanceSlo;
  buildProfile: FinancialPerformanceBuildProfile;
  hardwareProfile: FinancialPerformanceHardwareProfile;
  count: number;
  sumDurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;
  lastDurationMs: number;
  p50DurationMs: number;
  p95DurationMs: number;
  p99DurationMs: number;
  sloViolationCount: number;
}>;

export type FinancialPerformanceTelemetryOptions = Readonly<{
  now?: () => number;
  maxAggregates?: number;
  maxSamplesPerAggregate?: number;
  maxDiagnosticTraces?: number;
  diagnosticsEnabled?: boolean;
  buildProfile?: FinancialPerformanceBuildProfile;
  hardwareProfile?: FinancialPerformanceHardwareProfile;
}>;

export type FinancialPerformanceOperation = Readonly<{
  readonly correlationId: string;
  startSpan(span: FinancialPerformanceSpan, context?: FinancialPerformanceContext): FinancialPerformanceSpanHandle;
  finish(
    span: FinancialPerformanceSpan,
    outcome?: FinancialPerformanceOutcome,
    context?: FinancialPerformanceContext & { error?: unknown },
  ): FinancialPerformanceEvent | null;
}>;

export type FinancialPerformanceSpanHandle = Readonly<{
  finish(
    outcome?: FinancialPerformanceOutcome,
    context?: FinancialPerformanceContext & { error?: unknown },
  ): FinancialPerformanceEvent | null;
}>;

export type FinancialPerformanceTelemetry = Readonly<{
  startOperation(
    operation: FinancialPerformanceOperationKind,
    context?: FinancialPerformanceContext,
  ): FinancialPerformanceOperation;
  record(
    operation: FinancialPerformanceOperationKind,
    span: FinancialPerformanceSpan,
    durationMs: number,
    outcome?: FinancialPerformanceOutcome,
    context?: FinancialPerformanceContext & { error?: unknown; correlationId?: string },
  ): FinancialPerformanceEvent;
  subscribe(listener: (event: FinancialPerformanceEvent) => void): () => void;
  setDiagnosticsEnabled(enabled: boolean): void;
  diagnosticsEnabled(): boolean;
  getAggregates(): readonly FinancialPerformanceAggregate[];
  getDiagnosticTraces(): readonly FinancialPerformanceEvent[];
  clear(): void;
}>;

const MAX_DURATION_MS = 86_400_000;
const MAX_KNOWLEDGE_POINT_DISTANCE = 1_000_000;
const DEFAULT_MAX_AGGREGATES = 128;
const DEFAULT_MAX_SAMPLES_PER_AGGREGATE = 256;
const DEFAULT_MAX_DIAGNOSTIC_TRACES = 256;

const STABLE_ERROR_CODES = new Set<FinancialPerformanceErrorCode>([
  "unknown",
  "spending-pair-stale",
  "idempotency-key-conflict",
  "canonical-cutoff-unavailable",
  "worker-closed",
  "worker-exit",
  "worker-error",
  "financial-section-knowledge-point-mismatch",
  "spending-action-stale",
  "validation-failed",
  "contention",
  "cancelled",
]);

function clampDuration(value: number): number {
  return Number.isFinite(value)
    ? Math.min(MAX_DURATION_MS, Math.max(0, Math.round(value * 1000) / 1000))
    : 0;
}

function normalizedDistance(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) return null;
  return Math.min(value, MAX_KNOWLEDGE_POINT_DISTANCE);
}

export function cardinalityBucket(
  value: number | FinancialPerformanceCardinalityBucket | null | undefined,
): FinancialPerformanceCardinalityBucket {
  if (typeof value === "string") {
    return value === "unknown" || value === "0" || value === "1-10" || value === "11-100" ||
      value === "101-1000" || value === "1001+"
      ? value
      : "unknown";
  }
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return "unknown";
  if (value === 0) return "0";
  if (value <= 10) return "1-10";
  if (value <= 100) return "11-100";
  if (value <= 1000) return "101-1000";
  return "1001+";
}

export function stableFinancialPerformanceErrorCode(error: unknown): FinancialPerformanceErrorCode {
  const candidate = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : error instanceof Error
      ? error.message
      : error;
  if (typeof candidate !== "string") return "unknown";
  if (STABLE_ERROR_CODES.has(candidate as FinancialPerformanceErrorCode)) {
    return candidate as FinancialPerformanceErrorCode;
  }
  if (/busy|locked|contention/i.test(candidate)) return "contention";
  if (/worker.*closed|closed.*worker/i.test(candidate)) return "worker-closed";
  if (/worker.*exit|exit.*worker/i.test(candidate)) return "worker-exit";
  if (/cutoff/i.test(candidate)) return "canonical-cutoff-unavailable";
  if (/validation|invalid|stale/i.test(candidate)) return "validation-failed";
  if (/cancel/i.test(candidate)) return "cancelled";
  return "unknown";
}

function percentile(samples: readonly number[], percentileValue: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(percentileValue * sorted.length) - 1));
  return sorted[index]!;
}

function profileValue<T extends string>(value: T | undefined, allowed: readonly T[], fallback: T): T {
  return value && allowed.includes(value) ? value : fallback;
}

function buildAggregateKey(event: FinancialPerformanceEvent): string {
  return [
    event.operation,
    event.span,
    event.outcome,
    event.errorCode ?? "",
    event.knowledgePointDistance ?? "",
    event.cardinalityBucket,
    event.contention ? "1" : "0",
    event.coldStart ? "1" : "0",
    event.slo,
    event.buildProfile,
    event.hardwareProfile,
  ].join("\u0001");
}

function correlationIdFor(sequence: number): string {
  return `performance-${sequence.toString(36)}`;
}

export function createFinancialPerformanceTelemetry(
  options: FinancialPerformanceTelemetryOptions = {},
): FinancialPerformanceTelemetry {
  const now = options.now ?? (() => performance.now());
  const maxAggregates = Math.max(1, Math.floor(options.maxAggregates ?? DEFAULT_MAX_AGGREGATES));
  const maxSamplesPerAggregate = Math.max(1, Math.floor(options.maxSamplesPerAggregate ?? DEFAULT_MAX_SAMPLES_PER_AGGREGATE));
  const maxDiagnosticTraces = Math.max(1, Math.floor(options.maxDiagnosticTraces ?? DEFAULT_MAX_DIAGNOSTIC_TRACES));
  const buildProfile = profileValue(options.buildProfile, ["development", "production", "test", "unknown"], "unknown");
  const hardwareProfile = profileValue(options.hardwareProfile, ["low", "medium", "high", "unknown"], "unknown");
  const aggregates = new Map<string, {
    event: FinancialPerformanceEvent;
    count: number;
    sumDurationMs: number;
    minDurationMs: number;
    maxDurationMs: number;
    lastDurationMs: number;
    samples: number[];
    sloViolationCount: number;
  }>();
  const traces: FinancialPerformanceEvent[] = [];
  const listeners = new Set<(event: FinancialPerformanceEvent) => void>();
  let diagnosticMode = Boolean(options.diagnosticsEnabled);
  let operationSequence = 0;

  const emit = (
    operation: FinancialPerformanceOperationKind,
    span: FinancialPerformanceSpan,
    durationMs: number,
    outcome: FinancialPerformanceOutcome,
    context: FinancialPerformanceContext & { error?: unknown; correlationId?: string } = {},
  ): FinancialPerformanceEvent => {
    const contention = Boolean(context.contention);
    const sloApplicable = operation === "spending-action" &&
      (span === "paint-ready" || span === "patch-applied" || span === "action-result");
    const budget = contention ? FINANCIAL_INTERACTION_SLO_MS.contention : FINANCIAL_INTERACTION_SLO_MS.normal;
    const duration = clampDuration(durationMs);
    const event: FinancialPerformanceEvent = Object.freeze({
      operation,
      span,
      durationMs: duration,
      knowledgePointDistance: normalizedDistance(context.knowledgePointDistance),
      cardinalityBucket: cardinalityBucket(context.cardinality),
      contention,
      coldStart: Boolean(context.coldStart),
      outcome,
      ...(outcome === "error" ? { errorCode: stableFinancialPerformanceErrorCode(context.error) } : {}),
      slo: sloApplicable ? (duration <= budget ? "within-budget" : "violation") : "not-applicable",
      buildProfile,
      hardwareProfile,
      correlationId: context.correlationId ?? correlationIdFor(++operationSequence),
    });
    const key = buildAggregateKey(event);
    const previous = aggregates.get(key);
    const aggregate = previous ?? {
      event,
      count: 0,
      sumDurationMs: 0,
      minDurationMs: duration,
      maxDurationMs: duration,
      lastDurationMs: duration,
      samples: [],
      sloViolationCount: 0,
    };
    aggregate.count += 1;
    aggregate.sumDurationMs += duration;
    aggregate.minDurationMs = Math.min(aggregate.minDurationMs, duration);
    aggregate.maxDurationMs = Math.max(aggregate.maxDurationMs, duration);
    aggregate.lastDurationMs = duration;
    aggregate.samples.push(duration);
    if (aggregate.samples.length > maxSamplesPerAggregate) aggregate.samples.shift();
    if (event.slo === "violation") aggregate.sloViolationCount += 1;
    if (!previous && aggregates.size >= maxAggregates) {
      const oldest = aggregates.keys().next().value;
      if (oldest !== undefined) aggregates.delete(oldest);
    }
    aggregates.set(key, aggregate);

    if (diagnosticMode) {
      traces.push(event);
      if (traces.length > maxDiagnosticTraces) traces.shift();
    }
    for (const listener of listeners) {
      try { listener(event); } catch { /* telemetry observers cannot affect financial work */ }
    }
    return event;
  };

  const telemetry: FinancialPerformanceTelemetry = {
    startOperation(operation, context = {}) {
      const correlationId = correlationIdFor(++operationSequence);
      const startedAt = now();
      let finished = false;
      return {
        correlationId,
        startSpan(span, spanContext = {}) {
          const spanStartedAt = now();
          let spanFinished = false;
          return {
            finish(outcome = "success", finishContext = {}) {
              if (spanFinished) return null;
              spanFinished = true;
              return emit(operation, span, now() - spanStartedAt, outcome, {
                ...context,
                ...spanContext,
                ...finishContext,
                correlationId,
              });
            },
          };
        },
        finish(span, outcome = "success", finishContext = {}) {
          if (finished) return null;
          finished = true;
          return emit(operation, span, now() - startedAt, outcome, {
            ...context,
            ...finishContext,
            correlationId,
          });
        },
      };
    },
    record(operation, span, durationMs, outcome = "success", context = {}) {
      return emit(operation, span, durationMs, outcome, context);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setDiagnosticsEnabled(enabled) {
      diagnosticMode = enabled;
      if (!enabled) traces.length = 0;
    },
    diagnosticsEnabled() { return diagnosticMode; },
    getAggregates() {
      return Object.freeze([...aggregates.values()].map((aggregate) => Object.freeze({
        operation: aggregate.event.operation,
        span: aggregate.event.span,
        outcome: aggregate.event.outcome,
        ...(aggregate.event.errorCode ? { errorCode: aggregate.event.errorCode } : {}),
        knowledgePointDistance: aggregate.event.knowledgePointDistance,
        cardinalityBucket: aggregate.event.cardinalityBucket,
        contention: aggregate.event.contention,
        coldStart: aggregate.event.coldStart,
        slo: aggregate.event.slo,
        buildProfile: aggregate.event.buildProfile,
        hardwareProfile: aggregate.event.hardwareProfile,
        count: aggregate.count,
        sumDurationMs: Math.round(aggregate.sumDurationMs * 1000) / 1000,
        minDurationMs: aggregate.minDurationMs,
        maxDurationMs: aggregate.maxDurationMs,
        lastDurationMs: aggregate.lastDurationMs,
        p50DurationMs: percentile(aggregate.samples, 0.5),
        p95DurationMs: percentile(aggregate.samples, 0.95),
        p99DurationMs: percentile(aggregate.samples, 0.99),
        sloViolationCount: aggregate.sloViolationCount,
      })));
    },
    getDiagnosticTraces() {
      return diagnosticMode ? Object.freeze([...traces]) : Object.freeze([]);
    },
    clear() {
      aggregates.clear();
      traces.length = 0;
    },
  };
  return Object.freeze(telemetry);
}

export const financialPerformanceTelemetry = createFinancialPerformanceTelemetry();
