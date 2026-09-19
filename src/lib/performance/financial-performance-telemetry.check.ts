import assert from "node:assert/strict";
import test from "node:test";
import {
  createFinancialPerformanceTelemetry,
  FINANCIAL_INTERACTION_SLO_MS,
} from "./financial-performance-telemetry.ts";

test("financial performance events expose only privacy-bounded fields", () => {
  const telemetry = createFinancialPerformanceTelemetry({ now: () => 10, buildProfile: "test" });
  const event = telemetry.record(
    "spending-action",
    "action-result",
    240,
    "error",
    {
      knowledgePointDistance: 4,
      cardinality: 12,
      contention: false,
      coldStart: true,
      error: new Error("account=secret merchant=secret /Users/private/ledger.sqlite"),
    },
  );
  assert.deepEqual(Object.keys(event).sort(), [
    "buildProfile",
    "cardinalityBucket",
    "coldStart",
    "contention",
    "correlationId",
    "durationMs",
    "errorCode",
    "hardwareProfile",
    "knowledgePointDistance",
    "operation",
    "outcome",
    "slo",
    "span",
  ]);
  assert.equal(event.errorCode, "unknown");
  assert.equal(event.slo, "violation");
  assert.equal(event.cardinalityBucket, "11-100");
  assert.equal(event.knowledgePointDistance, 4);
  const serialized = JSON.stringify(event);
  assert.doesNotMatch(serialized, /account|merchant|ledger\.sqlite|private/iu);
});
test("aggregates retain bounded samples and calculate percentiles", () => {
  const telemetry = createFinancialPerformanceTelemetry({
    maxAggregates: 2,
    maxSamplesPerAggregate: 4,
  });
  for (const duration of [10, 20, 30, 40, 50]) {
    telemetry.record("financial-load", "primary-load", duration);
  }
  const aggregate = telemetry.getAggregates()[0];
  assert.ok(aggregate);
  assert.equal(aggregate.count, 5);
  assert.equal(aggregate.p50DurationMs, 30);
  assert.equal(aggregate.p95DurationMs, 50);
  assert.equal(aggregate.p99DurationMs, 50);
  telemetry.record("financial-load", "secondary-load", 1);
  telemetry.record("spending-action", "worker-response", 1);
  assert.equal(telemetry.getAggregates().length, 2);
});

test("operation handles correlate stages without carrying financial identity", () => {
  let now = 100;
  const telemetry = createFinancialPerformanceTelemetry({ now: () => now });
  const events: Array<{ correlationId: string; span: string }> = [];
  telemetry.subscribe((event) => events.push({ correlationId: event.correlationId, span: event.span }));
  const operation = telemetry.startOperation("spending-action");
  const start = operation.startSpan("action-start");
  now += 1;
  start.finish();
  now += 10;
  operation.finish("patch-applied");
  assert.equal(events.length, 2);
  assert.equal(events[0]!.correlationId, operation.correlationId);
  assert.equal(events[1]!.correlationId, operation.correlationId);
  assert.equal("accountId" in (events as unknown as Record<string, unknown>), false);
});

test("diagnostic traces are opt-in and bounded", () => {
  const telemetry = createFinancialPerformanceTelemetry({ maxDiagnosticTraces: 2 });
  assert.equal(telemetry.getDiagnosticTraces().length, 0);
  telemetry.record("financial-load", "page-shell", 1);
  assert.equal(telemetry.getDiagnosticTraces().length, 0);
  telemetry.setDiagnosticsEnabled(true);
  telemetry.record("financial-load", "page-shell", 2);
  telemetry.record("financial-load", "primary-load", 3);
  telemetry.record("financial-load", "secondary-load", 4);
  assert.deepEqual(telemetry.getDiagnosticTraces().map((trace) => trace.span), [
    "primary-load",
    "secondary-load",
  ]);
  telemetry.setDiagnosticsEnabled(false);
  assert.equal(telemetry.getDiagnosticTraces().length, 0);
});

test("interaction SLO distinguishes normal and writer-contention budgets", () => {
  const telemetry = createFinancialPerformanceTelemetry();
  assert.equal(
    telemetry.record("spending-action", "paint-ready", FINANCIAL_INTERACTION_SLO_MS.normal).slo,
    "within-budget",
  );
  assert.equal(
    telemetry.record("spending-action", "paint-ready", FINANCIAL_INTERACTION_SLO_MS.normal + 1).slo,
    "violation",
  );
  assert.equal(
    telemetry.record("spending-action", "paint-ready", FINANCIAL_INTERACTION_SLO_MS.contention, "success", { contention: true }).slo,
    "within-budget",
  );
  const error = telemetry.record(
    "spending-action",
    "action-result",
    FINANCIAL_INTERACTION_SLO_MS.contention + 1,
    "error",
    { contention: true, error: new Error("database is locked") },
  );
  assert.equal(error.errorCode, "contention");
  assert.equal(error.slo, "violation");
  assert.equal(telemetry.getAggregates().at(-1)?.sloViolationCount, 1);
});
