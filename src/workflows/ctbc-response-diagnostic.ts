import { mkdir, open, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

export const CTBC_RESPONSE_DIAGNOSTIC_DIRECTORY_ENV =
  "OCTOPUSBEAK_CTBC_RESPONSE_DIAGNOSTIC_DIR" as const;

export type CtbcResponseDiagnostic = {
  capturedAt: string;
  resource: string;
  account: {
    accountId: string;
    label: string;
  };
  rangeOrdinal: number;
  visibleMonthLabel: string | null;
  expectedRange: unknown;
  queryPeriods: readonly string[];
  request: {
    method: string;
    url: string;
    postData: string | null;
  };
  response: unknown;
};

export function ctbcResponseDiagnosticDirectoryFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  const configured =
    environment[CTBC_RESPONSE_DIAGNOSTIC_DIRECTORY_ENV]?.trim();
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
      "CTBC response diagnostic directory must be a private directory (0700).",
    );
}

export async function writeCtbcResponseDiagnostic(
  directory: string | null,
  diagnostic: CtbcResponseDiagnostic,
): Promise<string | null> {
  if (directory === null) return null;
  const destination = resolve(directory);
  await ensurePrivateDirectory(destination);
  const filePath = join(
    destination,
    `ctbc-response-${Date.now()}-${diagnostic.rangeOrdinal}-${randomUUID()}.json`,
  );
  const payload = {
    schemaVersion: "ctbc-response-diagnostic-v1",
    ...diagnostic,
  };
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
  const metadata = await stat(filePath);
  if (!privateMode(metadata.mode))
    throw new Error("CTBC response diagnostic file must be private (0600).");
  return filePath;
}
