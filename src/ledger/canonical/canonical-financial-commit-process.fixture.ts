import {
  executeCanonicalFinancialCommitRun,
  type CanonicalFinancialCommitItem,
} from "./canonical-financial-commit-execution.ts";
import type { CanonicalSourceEvidence } from "./canonical-source-evidence.ts";

const [ledgerDir, captureId, holdMsText] = process.argv.slice(2);
if (!ledgerDir || !captureId || holdMsText === undefined)
  throw new Error("Expected ledger directory, capture ID, and hold duration.");

const holdMs = Number(holdMsText);
const token = (value: string): `sha256:${string}` => `sha256:${value}`;
const evidence: CanonicalSourceEvidence = {
  captureId,
  integrationNamespace: "synthetic",
  sourceConnectionKey: token("connection"),
  identityEpoch: token("epoch"),
  stream: "domestic-deposit",
  recordKind: "source-record",
  routeKey: "synthetic/domestic-deposit/v8",
  contractVersion: "synthetic-v8",
  subjectDigest: token("subject"),
  observedAt: "2026-08-19T00:00:00.000Z",
  scope: {
    startDate: "20260101",
    endDate: "20260102",
    kind: "point-in-time",
    completeness: "single-page",
    ruleVersion: "synthetic-completeness-v1",
  },
  pages: [{
    pageOrdinal: 0,
    responseCode: "200",
    rowCount: 1,
    terminal: true,
    metadata: { pageCount: 1, totalCount: 1 },
  }],
  records: [{
    occurrenceKey: token(`occurrence-${captureId}`),
    collisionKey: token(`collision-${captureId}`),
    providerKey: token(`provider-${captureId}`),
    contentHash: token(`content-${captureId}`),
    compact: { sourceSequence: captureId },
  }],
};

function send(message: object): Promise<void> {
  return new Promise((resolve, reject) => {
    process.send?.(message, (error) => error ? reject(error) : resolve());
  });
}

let start!: () => void;
const started = new Promise<void>((resolve) => { start = resolve; });
process.on("message", (message) => {
  if (message === "start") start();
});

async function* items(): AsyncIterable<CanonicalFinancialCommitItem<string>> {
  await send({ event: "ready" });
  await started;
  yield {
    provider: "synthetic",
    product: "domestic-deposit",
    itemKey: captureId,
    commit: (transaction) => {
      transaction.admission.admit(evidence);
      if (holdMs > 0) {
        process.send?.({ event: "entered" });
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, holdMs);
      }
      return captureId;
    },
  };
}

try {
  const result = await executeCanonicalFinancialCommitRun({
    canonicalLedgerDir: ledgerDir,
    items: items(),
  });
  await send({
    event: "result",
    status: result.status,
    committedCount: result.committedCount,
    diagnostics: result.diagnostics.map(({ stage, errorCode }) => ({ stage, errorCode })),
  });
} catch (error) {
  await send({ event: "error", message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
process.disconnect?.();
