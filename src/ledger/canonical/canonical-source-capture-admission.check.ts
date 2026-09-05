import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  createCanonicalSourceCaptureAdmission,
  withCanonicalSourceCaptureAdmissionTransaction,
  CanonicalSourceCaptureAdmissionError,
  type CanonicalSourceCaptureAdmissionRequest,
} from "./canonical-source-capture-admission.ts";
import {
  createCanonicalSourceStore,
  queryCanonicalSourceCurrent,
} from "./canonical-source-store.ts";
import {
  CANONICAL_SOURCE_ROUTE_REGISTRY,
  canonicalSourceRouteRegistration,
} from "./canonical-source-route-registry.ts";

const token = (letter: string) => `sha256:${letter.repeat(64)}`;

test("closed source routes deeply freeze contract-version authority", () => {
  const forgedVersion = "forged-after-registry-initialization";
  for (const registration of CANONICAL_SOURCE_ROUTE_REGISTRY) {
    assert.equal(Object.isFrozen(registration), true);
    assert.equal(Object.isFrozen(registration.contractVersions), true);
    assert.throws(
      () =>
        (registration.contractVersions as string[]).push(forgedVersion),
      TypeError,
    );
  }
  assert.equal(
    canonicalSourceRouteRegistration("synthetic/domestic-deposit/v8")
      ?.contractVersions.includes(forgedVersion),
    false,
  );
});

function request(captureId: string): CanonicalSourceCaptureAdmissionRequest {
  return {
    captureId,
    integrationNamespace: "synthetic",
    sourceConnectionKey: token("a"),
    identityEpoch: token("b"),
    stream: "domestic-deposit",
    recordKind: "source-record",
    routeKey: "synthetic/domestic-deposit/v8",
    contractVersion: "synthetic-v8",
    subjectDigest: token("c"),
    observedAt: "2026-08-19T00:00:00.000Z",
    scope: {
      startDate: "20260101",
      endDate: "20260102",
      kind: "point-in-time",
      completeness: "single-page",
      ruleVersion: "synthetic-completeness-v1",
    },
    pages: [
      {
        pageOrdinal: 0,
        responseCode: "200",
        rowCount: 1,
        terminal: true,
        metadata: { pageCount: 1 },
      },
    ],
    records: [
      {
        occurrenceKey: token("d"),
        collisionKey: token("e"),
        providerKey: token("f"),
        contentHash: token("g"),
        compact: { amount: { coefficient: "100", scale: 0 } },
      },
    ],
  };
}

test("Canonical Source Capture Admission admits one request through its public seam", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-source-admission-tracer-"));
  const store = createCanonicalSourceStore(join(directory, "canonical.sqlite"));
  try {
    const admission = createCanonicalSourceCaptureAdmission(store);
    const receipt = await admission.admit(request("capture-1"));
    assert.deepEqual(receipt, {
      captureId: "capture-1",
      knowledgePoint: 1,
    });
    assert.equal(queryCanonicalSourceCurrent(store).observations.length, 1);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Canonical Source Capture Admission exposes stable typed route failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-source-admission-errors-"));
  const store = createCanonicalSourceStore(join(directory, "canonical.sqlite"));
  try {
    const admission = createCanonicalSourceCaptureAdmission(store);
    await assert.rejects(
      admission.admit({
        ...request("unknown-route-capture"),
        routeKey: "provider-that-is-not-registered/source/v1",
      }),
      (error: unknown) =>
        error instanceof CanonicalSourceCaptureAdmissionError &&
        error.reason === "authority-route-unregistered",
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Canonical Source Capture Admission rejects capture overwrite and occurrence conflicts with stable reasons", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-source-admission-conflicts-"));
  const store = createCanonicalSourceStore(join(directory, "canonical.sqlite"));
  try {
    const admission = createCanonicalSourceCaptureAdmission(store);
    await admission.admit(request("capture-1"));
    await assert.rejects(
      admission.admit(request("capture-1")),
      (error: unknown) =>
        error instanceof CanonicalSourceCaptureAdmissionError &&
        error.reason === "capture-overwrite",
    );
    await assert.rejects(
      admission.admit({
        ...request("capture-2"),
        records: [{
          ...request("capture-2").records[0]!,
          contentHash: token("h"),
        }],
      }),
      (error: unknown) =>
        error instanceof CanonicalSourceCaptureAdmissionError &&
        error.reason === "occurrence-conflict",
    );
    assert.equal(queryCanonicalSourceCurrent(store).observations.length, 1);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Canonical Source Capture Admission retains one assertion observation and adds provenance on exact recurrence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-source-admission-recurrence-"));
  const store = createCanonicalSourceStore(join(directory, "canonical.sqlite"));
  try {
    const admission = createCanonicalSourceCaptureAdmission(store);
    await admission.admit(request("capture-1"));
    await admission.admit(request("capture-2"));
    const current = queryCanonicalSourceCurrent(store);
    assert.equal(current.records.length, 1);
    assert.equal(current.observations.length, 2);
    assert.equal(current.provenanceCount, 2);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Canonical Source Capture Admission batches atomically and preserves one knowledge point per capture", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-source-admission-batch-"));
  const store = createCanonicalSourceStore(join(directory, "canonical.sqlite"));
  try {
    const admission = createCanonicalSourceCaptureAdmission(store);
    const receipts = await admission.admitBatch([
      request("capture-1"),
      request("capture-2"),
    ]);
    assert.deepEqual(receipts, [
      { captureId: "capture-1", knowledgePoint: 1 },
      { captureId: "capture-2", knowledgePoint: 2 },
    ]);
    assert.equal(queryCanonicalSourceCurrent(store).observations.length, 2);

    await assert.rejects(
      admission.admitBatch([
        request("capture-3"),
        {
          ...request("capture-4"),
          records: [{
            ...request("capture-4").records[0]!,
            contentHash: token("h"),
          }],
        },
      ]),
      (error: unknown) =>
        error instanceof CanonicalSourceCaptureAdmissionError &&
        error.reason === "occurrence-conflict",
    );
    assert.deepEqual(
      queryCanonicalSourceCurrent(store).observations.map((observation) => observation.captureId),
      ["capture-1", "capture-2"],
      "a later batch conflict leaves every item in that batch invisible",
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Canonical Source Capture Admission rejects a registered route with drifting identity or contract", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-source-admission-route-drift-"));
  const store = createCanonicalSourceStore(join(directory, "canonical.sqlite"));
  try {
    const admission = createCanonicalSourceCaptureAdmission(store);
    await assert.rejects(
      admission.admit({ ...request("drifting-stream"), stream: "loan" }),
      (error: unknown) =>
        error instanceof CanonicalSourceCaptureAdmissionError &&
        error.reason === "authority-route-drift",
    );
    await assert.rejects(
      admission.admit({ ...request("drifting-contract"), contractVersion: "other-v1" }),
      (error: unknown) =>
        error instanceof CanonicalSourceCaptureAdmissionError &&
        error.reason === "authority-route-drift",
    );
    assert.equal(queryCanonicalSourceCurrent(store).observations.length, 0);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Canonical Source Capture Admission exposes an embedded transaction capability without nesting a queue", async () => {
  const store = createCanonicalSourceStore(":memory:");
  try {
    let expiredCapability:
      | { admit(request: CanonicalSourceCaptureAdmissionRequest): unknown }
      | undefined;
    const embedded = await withCanonicalSourceCaptureAdmissionTransaction(
      store,
      async (capability) => {
        expiredCapability = capability;
        return capability.admit(request("embedded-valid")).receipt;
      },
    );
    assert.deepEqual(embedded, {
      captureId: "embedded-valid",
      knowledgePoint: 1,
    });
    assert.throws(
      () => expiredCapability!.admit(request("embedded-expired")),
      (error: unknown) =>
        error instanceof CanonicalSourceCaptureAdmissionError &&
        error.reason === "invalid-transaction-capability",
    );
  } finally {
    store.close();
  }
});
