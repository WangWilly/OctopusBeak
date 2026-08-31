import { mkdir, open, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { YuantaDomesticDepositCaptureEvidence } from "../ledger/canonical/yuanta-domestic-deposit.ts";

export const YUANTA_OCCURRENCE_DIAGNOSTIC_DIRECTORY_ENV =
  "OCTOPUSBEAK_YUANTA_OCCURRENCE_DIAGNOSTIC_DIR" as const;

type YuantaOccurrenceDiagnosticCandidate = {
  schemaVersion: "yuanta-occurrence-candidate-v1";
  capturedAt: string;
  captureId: string;
  account: YuantaDomesticDepositCaptureEvidence["account"];
  queryRange: YuantaDomesticDepositCaptureEvidence["queryRange"];
  downloads: Array<{
    filename: string;
    columnNames: string[];
    rows: Array<{ rowOrdinal: number; values: string[] }>;
  }>;
};

export function yuantaOccurrenceDiagnosticDirectoryFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  const configured =
    environment[YUANTA_OCCURRENCE_DIAGNOSTIC_DIRECTORY_ENV]?.trim();
  return configured ? resolve(configured) : null;
}

function privateMode(mode: number): boolean {
  return (mode & 0o077) === 0;
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await stat(directory);
  if (!metadata.isDirectory() || !privateMode(metadata.mode))
    throw new Error(
      "Yuanta occurrence diagnostic directory must be a private directory (0700).",
    );
}

function safeCaptureId(captureId: string): string {
  const safe = captureId.replace(/[^A-Za-z0-9._-]/g, "_");
  if (!safe) throw new Error("Yuanta occurrence diagnostic capture ID is empty.");
  return safe;
}

/**
 * Persist the in-memory Yuanta CSV candidate only when an explicit private
 * diagnostic directory was configured. This is intentionally separate from
 * canonical storage and runs before canonical commit.
 */
export async function writeYuantaOccurrenceDiagnosticCandidate(
  directory: string | null,
  input: {
    captureId: string;
    capture: YuantaDomesticDepositCaptureEvidence;
  },
): Promise<string | null> {
  if (directory === null) return null;
  const destination = resolve(directory);
  await ensurePrivateDirectory(destination);
  const filePath = join(
    destination,
    `${safeCaptureId(input.captureId)}-candidate.json`,
  );
  const candidate: YuantaOccurrenceDiagnosticCandidate = {
    schemaVersion: "yuanta-occurrence-candidate-v1",
    capturedAt: input.capture.observedAt,
    captureId: input.captureId,
    account: { ...input.capture.account },
    queryRange: { ...input.capture.queryRange },
    downloads: input.capture.downloads.map((download) => ({
      filename: download.filename,
      columnNames: [...download.columnNames],
      rows: download.rows.map((row) => ({
        rowOrdinal: row.rowOrdinal,
        values: [...row.values],
      })),
    })),
  };
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(candidate, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
  const metadata = await stat(filePath);
  if (!privateMode(metadata.mode))
    throw new Error("Yuanta occurrence diagnostic file must be private (0600).");
  return filePath;
}
