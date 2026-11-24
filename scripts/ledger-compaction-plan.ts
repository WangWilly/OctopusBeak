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
 * and is brought to the schema of this code version before planning, as
 * that version of the app would on its next open; it is removed afterwards,
 * and the folder itself is only read. Prints the plan as JSON on stdout and
 * a summary, with the code version, on stderr; exits 2 when the store holds
 * a citation the planner does not know.
 */
import { execFileSync } from "node:child_process";
import { constants, cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, statfsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import {
  planLedgerCompaction,
  type CompactionCopyCounts,
  type CompactionPlanResult,
  type CompactionTablePlan,
} from "../src/ledger/pglite/compaction-plan.ts";
import { installFinancialStore } from "../src/ledger/pglite/store-layout.ts";
import type { PGliteStore } from "../src/ledger/pglite/transaction.ts";

const RUNNING = "postmaster.pid";
const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The package version, and the short commit when this is a git checkout. */
function codeVersion(): string {
  const { version } = JSON.parse(readFileSync(join(REPOSITORY, "package.json"), "utf8")) as { version: string };
  try {
    const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPOSITORY, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return `${version} (${commit})`;
  } catch {
    return version;
  }
}

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

function summarize(result: CompactionPlanResult, dataFolderBytes: number, version: string): string {
  if (result.status === "unrecognised-citations")
    return [
      "No plan: the store cites Source Records through columns the planner does not know.",
      ...result.problems.map(({ table, columns, problem }) => `  ${table} (${columns.join(", ")}): ${problem}`),
    ].join("\n");
  const pinned = Object.entries(result.phaseB.pinnedBy).sort(([, a], [, b]) => b - a);
  return [
    `Planned with code version ${version}, on a copy brought to that version's schema. Its migrations ran on the copy,`,
    "including the ADR 0144 Kind cleanup and the Kind rederivation, so the plan assumes the app that compacts this store is at this version.",
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

/** A full disk, from Node or from PostgreSQL inside PGlite. */
function diskFull(error: unknown): boolean {
  if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOSPC") return true;
  return /ENOSPC|No space left on device|could not extend file/iu.test(error instanceof Error ? error.message : String(error));
}

function diskFullMessage(action: string, bytes: number): string {
  const { bavail, bsize } = statfsSync(tmpdir());
  return `Not enough free space to ${action}: the store is ${megabytes(bytes)}, and ${tmpdir()} has ${megabytes(bavail * bsize)} free. `
    + "Set TMPDIR to a folder on a disk with more space.";
}

/** Clone `source` where the disk can, else copy it; a full disk is reported, not thrown. */
function copyStore(source: string, copy: string, bytes: number): string | undefined {
  try {
    cpSync(source, copy, { recursive: true, mode: constants.COPYFILE_FICLONE });
    return undefined;
  } catch (error) {
    if (!diskFull(error)) throw error;
    return diskFullMessage("copy the store", bytes);
  }
}

/** Open the copy and run this version's migrations on it; a full disk is reported, not thrown. */
async function migrateCopy(copy: string, bytes: number): Promise<PGliteStore | string> {
  const database = await PGlite.create(copy);
  try {
    return await installFinancialStore(database);
  } catch (error) {
    await database.close().catch(() => undefined);
    if (!diskFull(error)) throw error;
    return diskFullMessage("bring the copy to the current schema", bytes);
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
    const store = await migrateCopy(copy, bytes);
    if (typeof store === "string") {
      console.error(store);
      return 1;
    }
    try {
      const result = await planLedgerCompaction(store);
      console.log(JSON.stringify(result, null, 2));
      console.error(summarize(result, bytes, codeVersion()));
      return result.status === "planned" ? 0 : 2;
    } finally {
      await store.close();
    }
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

process.exitCode = await main(process.argv[2]);
