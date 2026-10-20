import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { applyPgliteBaseline } from "./baseline.ts";
import { applyPgliteOperationalBaseline } from "./operational.ts";
import { PGliteStore } from "./transaction.ts";

/**
 * Test-only: each baseline shape is installed for real once, snapshotted with
 * `dumpDataDir`, and restored into a fresh PGlite per caller. The seed install
 * runs the real apply functions, which verify their manifests, so every copy
 * starts from a verified baseline without paying the install again.
 *
 * `scripts/run-test-lane.mjs` writes the snapshots once per lane and points
 * {@link TEMPLATE_DIRECTORY_ENV} at them, so test file processes share one
 * install. Without it, each process installs its own on first use.
 */
export type TestBaseline = "ledger" | "operational" | "ledger+operational";

const TEST_BASELINES: readonly TestBaseline[] = ["ledger", "operational", "ledger+operational"];

export const TEMPLATE_DIRECTORY_ENV = "OCTOPUSBEAK_TEST_PGLITE_TEMPLATES";

const templateFile = (directory: string, baseline: TestBaseline) =>
  join(directory, `${baseline.replace("+", "-")}.tar`);

async function installTemplate(baseline: TestBaseline): Promise<Blob> {
  const seed = await PGlite.create();
  try {
    if (baseline !== "operational") await applyPgliteBaseline(seed);
    if (baseline !== "ledger") await applyPgliteOperationalBaseline(new PGliteStore(seed));
    return await seed.dumpDataDir("none");
  } finally {
    await seed.close();
  }
}

const templates = new Map<TestBaseline, Promise<Blob>>();

function template(baseline: TestBaseline): Promise<Blob> {
  let pending = templates.get(baseline);
  if (!pending) {
    const directory = process.env[TEMPLATE_DIRECTORY_ENV];
    pending = directory
      ? Promise.resolve(new Blob([readFileSync(templateFile(directory, baseline))]))
      : installTemplate(baseline);
    templates.set(baseline, pending);
  }
  return pending;
}

/** A fresh, isolated PGlite with the reviewed baseline shape already installed. */
export async function createTestPGlite(
  baseline: TestBaseline,
  options: Readonly<{ dataDir?: string }> = {},
): Promise<PGlite> {
  return PGlite.create({ ...options, loadDataDir: await template(baseline) });
}

/** Install every baseline shape once and write the snapshots for a test lane. */
export async function writeTestPGliteTemplates(directory: string): Promise<void> {
  mkdirSync(directory, { recursive: true });
  for (const baseline of TEST_BASELINES) {
    const blob = await installTemplate(baseline);
    writeFileSync(templateFile(directory, baseline), Buffer.from(await blob.arrayBuffer()));
  }
}

if (import.meta.main) {
  const directory = process.argv[2];
  if (!directory) throw new Error("Usage: baseline-test-template.ts <directory>");
  await writeTestPGliteTemplates(directory);
}
