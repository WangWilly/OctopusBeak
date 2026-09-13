#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import {
  evaluateCanonicalReadiness,
  formatCanonicalReadinessDiagnostics,
} from "../src/ledger/canonical/advertised-source-readiness.ts";

/** Run the deterministic, fixture-only release gate. */
export function runCanonicalReadinessCheck() {
  return evaluateCanonicalReadiness({ mode: "fixture" });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const gate = runCanonicalReadinessCheck();
  const heading = `Canonical readiness (${gate.mode}): ${gate.status}`;
  if (gate.releaseReady) {
    console.log(heading);
    console.log(formatCanonicalReadinessDiagnostics(gate));
  } else {
    console.error(heading);
    console.error("Release is blocked by the following canonical readiness diagnostics:");
    console.error(formatCanonicalReadinessDiagnostics(gate));
    process.exitCode = 1;
  }
}

