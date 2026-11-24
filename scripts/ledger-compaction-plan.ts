/**
 * Reports what a ledger compaction would remove from a store, without
 * changing it (`src/ledger/pglite/compaction-plan.ts`).
 *
 *   npm run ledger:compaction-plan -- <dataDir>
 *
 * `dataDir` is the PGlite folder, `data/pglite` under the app's user data
 * folder. Quit the app first: the script plans on a copy of the folder,
 * which is consistent only while nothing writes to it, and refuses a folder
 * a running store holds. The copy is removed afterwards and the folder
 * itself is only read. Prints the plan as JSON on stdout and a summary on
 * stderr; exits 2 when the store holds a citation the planner does not know.
 */
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import {
  planLedgerCompaction,
  type CompactionCopyCounts,
  type CompactionPlanResult,
  type CompactionTablePlan,
} from "../src/ledger/pglite/compaction-plan.ts";
import { PGliteStore } from "../src/ledger/pglite/transaction.ts";

const megabytes = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MB`;

function tableLine({ table, rows, removable, estimatedBytes }: CompactionTablePlan): string {
  return `  ${table}: ${removable} of ${rows} rows, about ${megabytes(estimatedBytes)}`;
}

function copyLine(label: string, counts: CompactionCopyCounts): string {
  const parts = [
    `${counts.removable} removable`,
    `${counts.pinned} pinned`,
    `${counts.lexemeOnly} lexeme-only`,
    `${counts.manifestCapture} in a manifest capture`,
    `${counts.changed} changed`,
    `${counts.first} first`,
    ...(counts.unchained > 0 ? [`${counts.unchained} without a chain`] : []),
  ];
  return `  ${label}: ${counts.copies} copies; ${parts.join(", ")}`;
}

function summarize(result: CompactionPlanResult): string {
  if (result.status === "unrecognised-citations")
    return [
      "No plan: the store cites Source Records through columns the planner does not know.",
      ...result.problems.map(({ table, columns, problem }) => `  ${table} (${columns.join(", ")}): ${problem}`),
    ].join("\n");
  const pinned = Object.entries(result.phaseB.pinnedBy).sort(([, a], [, b]) => b - a);
  return [
    `Store: ${megabytes(result.storeBytes)}. Compaction would free about ${megabytes(result.estimatedBytes)} once the tables are rewritten.`,
    "Phase A, domain rows:",
    ...result.phaseA.filter(({ rows }) => rows > 0).map(tableLine),
    "Phase B, record copies:",
    copyLine("all", result.phaseB.totals),
    ...result.phaseB.groups.map((group) => copyLine(`${group.integrationNamespace} / ${group.recordKind}`, group.counts)),
    ...(pinned.length > 0 ? ["  pinned by:", ...pinned.map(([table, copies]) => `    ${table}: ${copies}`)] : []),
    ...result.phaseB.tables.map(tableLine),
    "Phase C, count rows:",
    tableLine(result.phaseC),
  ].join("\n");
}

async function main(dataDir: string | undefined): Promise<number> {
  if (dataDir === undefined) {
    console.error("Usage: npm run ledger:compaction-plan -- <dataDir>");
    return 1;
  }
  const source = resolve(dataDir);
  if (!existsSync(join(source, "PG_VERSION"))) {
    console.error(`${source} is not a PGlite data folder.`);
    return 1;
  }
  if (existsSync(join(source, "postmaster.pid"))) {
    console.error(`${source} is held by a running store, or was not closed cleanly. Quit the app, or open and quit it once, then run again.`);
    return 1;
  }
  const copy = mkdtempSync(join(tmpdir(), "octopus-beak-compaction-plan-"));
  try {
    cpSync(source, copy, { recursive: true });
    const store = new PGliteStore(await PGlite.create(copy));
    try {
      const result = await planLedgerCompaction(store);
      console.log(JSON.stringify(result, null, 2));
      console.error(summarize(result));
      return result.status === "planned" ? 0 : 2;
    } finally {
      await store.close();
    }
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

process.exitCode = await main(process.argv[2]);
