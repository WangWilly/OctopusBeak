#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import {
  evaluateCanonicalReadiness,
  formatCanonicalReadinessDiagnostics,
} from "../src/ledger/canonical/advertised-source-readiness.ts";
import {
  createCanonicalReadinessLedgerFixture,
} from "../src/ledger/canonical/advertised-source-readiness-fixture.ts";

/** Run the deterministic, ledger-backed release gate. */
export async function runCanonicalReadinessCheck() {
  const fixture = await createCanonicalReadinessLedgerFixture();
  try {
    return evaluateCanonicalReadiness({ mode: "ledger", db: fixture.store.db });
  } finally {
    await fixture.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const gate = await runCanonicalReadinessCheck();
  const heading = `Canonical readiness (${gate.mode}): ${gate.status}`;
  if (gate.effectiveInventory.length !== 21) {
    console.error(heading);
    console.error(
      `Release is blocked: expected 21 effective canonical inventory rows, found ${gate.effectiveInventory.length}.`,
    );
    process.exitCode = 1;
  } else if (gate.releaseReady) {
    console.log(heading);
    console.log(formatCanonicalReadinessDiagnostics(gate));
  } else {
    console.error(heading);
    console.error("Release is blocked by the following canonical readiness diagnostics:");
    console.error(formatCanonicalReadinessDiagnostics(gate));
    process.exitCode = 1;
  }
}
