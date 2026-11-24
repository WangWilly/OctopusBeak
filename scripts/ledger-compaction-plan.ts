/**
 * Reports what a ledger compaction would remove from a store, without
 * changing it (`src/ledger/pglite/compaction-plan.ts`).
 *
 *   npm run ledger:compaction-plan -- <dataDir>
 *
 * `dataDir` is the PGlite folder, `data/pglite` under the app's user data
 * folder. Quit the app first: the script plans on a copy of the folder,
 * which is consistent only while nothing writes to it, and refuses a folder
 * a running store holds. The copy is a clone where the disk supports one,
 * and is brought to the current schema before planning, as the app would
 * on its next open; it is removed afterwards, and the folder itself is only
 * read. Prints the plan as JSON on stdout and a summary on stderr; exits 2
 * when the store holds a citation the planner does not know.
 */
import { constants, cpSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync, statfsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import {
  planLedgerCompaction,
  type CompactionCopyCounts,
  type CompactionPlanResult,
  type CompactionTablePlan,
} from "../src/ledger/pglite/compaction-plan.ts";
import { installFinancialStore } from "../src/ledger/pglite/store-layout.ts";

const RUNNING = "postmaster.pid";

const megabytes = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MB`;

function folderBytes(path: string): number {
  return readdirSync(path, { withFileTypes: true }).reduce((sum, entry) => {
    const child = join(path, entry.name);
    return sum + (entry.isDirectory() ? folderBytes(child) : entry.isFile() ? statSync(child).size : 0);
  }, 0);
}

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

function summarize(result: CompactionPlanResult, dataFolderBytes: number): string {
  if (result.status === "unrecognised-citations")
    return [
      "No plan: the store cites Source Records through columns the planner does not know.",
      ...result.problems.map(({ table, columns, problem }) => `  ${table} (${columns.join(", ")}): ${problem}`),
    ].join("\n");
  const pinned = Object.entries(result.phaseB.pinnedBy).sort(([, a], [, b]) => b - a);
  return [
    "Planned on a copy brought to the current schema, as the app would open the store.",
    `Data folder: ${megabytes(dataFolderBytes)}; database size: ${megabytes(result.databaseBytes)}.`,
    `Compaction would free about ${megabytes(result.estimatedBytes)} once the tables are rewritten.`,
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

const heldMessage = (folder: string) =>
  `${folder} is held by a running store, or was not closed cleanly. Quit the app, or open and quit it once, then run again.`;

/** Clone `source` where the disk can, else copy it; a full disk is reported, not thrown. */
function copyStore(source: string, copy: string, bytes: number): string | undefined {
  try {
    cpSync(source, copy, { recursive: true, mode: constants.COPYFILE_FICLONE });
    return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOSPC") throw error;
    const { bavail, bsize } = statfsSync(tmpdir());
    return `Not enough free space to copy the store: it needs ${megabytes(bytes)}, and ${tmpdir()} has ${megabytes(bavail * bsize)} free. `
      + "Set TMPDIR to a folder on a disk with more space.";
  }
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
  if (existsSync(join(source, RUNNING))) {
    console.error(heldMessage(source));
    return 1;
  }
  const bytes = folderBytes(source);
  const copy = mkdtempSync(join(tmpdir(), "octopus-beak-compaction-plan-"));
  try {
    const failure = copyStore(source, copy, bytes);
    if (failure !== undefined) {
      console.error(failure);
      return 1;
    }
    // The app may have opened the store while it was being copied.
    if (existsSync(join(source, RUNNING)) || existsSync(join(copy, RUNNING))) {
      console.error(heldMessage(source));
      return 1;
    }
    const store = await installFinancialStore(await PGlite.create(copy));
    try {
      const result = await planLedgerCompaction(store);
      console.log(JSON.stringify(result, null, 2));
      console.error(summarize(result, bytes));
      return result.status === "planned" ? 0 : 2;
    } finally {
      await store.close();
    }
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

process.exitCode = await main(process.argv[2]);
