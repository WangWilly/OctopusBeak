import assert from "node:assert/strict";
import test from "node:test";
import { createCanonicalLoanStore } from "../ledger/canonical/loan-financial.ts";
import type { LoanRelationResolver } from "./safe-loan-relation-resolution.ts";
import { resolveLoanRelationsAfterCapture } from "./safe-loan-relation-resolution.ts";

test("safe relation resolver constructs one complete provider request", async () => {
  const store = createCanonicalLoanStore(":memory:");
  try {
    let received: Parameters<LoanRelationResolver>[1] | undefined;
    const resolver: LoanRelationResolver = async (_store, request) => {
      received = request;
      return {
        status: "canonical-live",
        outcome: "no-admission",
        resolutionId: null,
        exactRelationIds: [],
        settlementGroupIds: [],
        reason: "no-supported-evidence",
      };
    };
    const result = await resolveLoanRelationsAfterCapture(store, resolver, {
      sourceConnectionKey: `sha256:${"1".repeat(64)}`,
      integrationNamespace: "fubon",
      observedAt: "2026-09-01T00:00:00.000Z",
      failureEvent: "test-resolution-failed",
      explicitLinks: [],
    });
    assert.equal(result?.outcome, "no-admission");
    assert.deepEqual(received, {
      sourceConnectionKey: `sha256:${"1".repeat(64)}`,
      integrationNamespace: "fubon",
      observedAt: "2026-09-01T00:00:00.000Z",
      requiredCoverage: { complete: true },
    });
  } finally {
    store.close();
  }
});

test("safe relation resolver isolates downstream failures under the caller event", async () => {
  const store = createCanonicalLoanStore(":memory:");
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...values: unknown[]) => warnings.push(values);
  try {
    const resolver: LoanRelationResolver = async () => {
      throw new Error("resolver unavailable");
    };
    assert.equal(
      await resolveLoanRelationsAfterCapture(store, resolver, {
        sourceConnectionKey: `sha256:${"2".repeat(64)}`,
        integrationNamespace: "yuanta",
        observedAt: "2026-09-01T00:00:00.000Z",
        failureEvent: "yuanta-loan-relation-resolution-failed",
      }),
      null,
    );
    assert.deepEqual(warnings, [
      [
        "yuanta-loan-relation-resolution-failed",
        { message: "resolver unavailable" },
      ],
    ]);
  } finally {
    console.warn = originalWarn;
    store.close();
  }
});
