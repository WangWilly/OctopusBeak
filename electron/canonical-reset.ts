import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { openCanonicalDatabaseHandle } from "../src/ledger/canonical/canonical-database.ts";

/** Bump this when the set or meaning of reset targets changes. */
export const CANONICAL_RESET_VERSION = 1 as const;

const LEGACY_SQLITE_FILE = "ledger.sqlite";
const CANONICAL_SQLITE_FILE = "canonical.sqlite";
const SQLITE_SIDECARS = ["-wal", "-shm", "-journal"] as const;

/**
 * These directories are owned by the statement workflows. The downloads
 * root itself is deliberately not a reset target so unrelated user files in
 * that directory survive a reset.
 */
export const LEGACY_FINANCIAL_DOWNLOAD_DIRECTORIES = [
  "cathay-foreign-statements",
  "cathay-statements",
  "ctbc-statements",
  "einvoice-personal-invoices",
  "esun-credit-card-statements",
  "fubon-credit-card-statements",
  "fubon-loan-statements",
  "fubon-statements",
  "hncb-statements",
  "linebank-statements",
  "post-statements",
  "sinopac-statements",
  "yuanta-credit-card-statements",
  "yuanta-foreign-currency-statements",
  "yuanta-fund-statements",
  "yuanta-loan-statements",
  "yuanta-statements",
  "yuanta-trade-statements",
] as const;

export type CanonicalResetTargetKind =
  | "legacy-ledger"
  | "canonical-ledger"
  | "ledger-sidecar"
  | "financial-downloads";

export type CanonicalResetTarget = Readonly<{
  path: string;
  kind: CanonicalResetTargetKind;
}>;

type StagedResetTarget = CanonicalResetTarget & Readonly<{ stagePath: string }>;

type ResetMarker = {
  version: typeof CANONICAL_RESET_VERSION;
  status: "resetting" | "completed";
  resetId: string;
  userData: string;
  canonicalLedgerDir: string;
  targets: readonly StagedResetTarget[];
  updatedAtUtc: string;
};

function invalidMarker(reason: string): Error {
  return new Error(`Canonical reset marker is invalid: ${reason}`);
}

export type CanonicalResetState = Readonly<{
  status: "fresh-install" | "reset-needed" | "resetting" | "completed";
  markerPath: string;
  canonicalLedgerDir: string;
  targets: readonly CanonicalResetTarget[];
  resetId?: string;
}>;

export type CanonicalResetDatabaseHandle = { close: () => void };

export type CanonicalResetSeams = Readonly<{
  openCanonical: (ledgerDir: string) => CanonicalResetDatabaseHandle;
  beforeOpen?: () => void;
  afterOpen?: () => void;
}>;

export type CanonicalResetOptions = Readonly<{
  userData: string;
  canonicalLedgerDir?: string;
  seams?: CanonicalResetSeams;
  now?: () => string;
  resetId?: () => string;
}>;

function nowUtc() {
  return new Date().toISOString();
}

function markerPathFor(userData: string) {
  return join(userData, ".libretto", "canonical-reset.json");
}

function stagingDirectoryFor(userData: string) {
  return join(userData, ".libretto", "canonical-reset-staging");
}

function canonicalLedgerDirectoryFor(userData: string, explicit?: string) {
  return resolve(explicit ?? join(userData, "data", "ledger"));
}

function assertSafeTarget(root: string, target: string) {
  const relativeTarget = relative(root, target);
  if (
    relativeTarget === "" ||
    relativeTarget.startsWith("..") ||
    relativeTarget.includes("..\\") ||
    resolve(root, relativeTarget) !== target
  ) {
    throw new Error(`Canonical reset target escapes its owned root: ${target}`);
  }
}

function sidecarTargets(
  path: string,
): CanonicalResetTarget[] {
  return SQLITE_SIDECARS.map((suffix) => ({
    path: `${path}${suffix}`,
    kind: "ledger-sidecar" as const,
  }));
}

/** Resolve only known financial targets; never return a broad parent folder. */
export function resolveCanonicalResetTargets(
  userData: string,
  canonicalLedgerDir = canonicalLedgerDirectoryFor(userData),
): readonly CanonicalResetTarget[] {
  const ownedUserData = resolve(userData);
  const ledgerDir = canonicalLedgerDirectoryFor(userData, canonicalLedgerDir);
  const downloadsDir = join(ownedUserData, "downloads");
  const legacyLedgerPath = join(ledgerDir, LEGACY_SQLITE_FILE);
  const canonicalLedgerPath = join(ledgerDir, CANONICAL_SQLITE_FILE);
  const targets: CanonicalResetTarget[] = [
    { path: legacyLedgerPath, kind: "legacy-ledger" },
    { path: canonicalLedgerPath, kind: "canonical-ledger" },
    ...sidecarTargets(legacyLedgerPath),
    ...sidecarTargets(canonicalLedgerPath),
    ...LEGACY_FINANCIAL_DOWNLOAD_DIRECTORIES.map((name) => ({
      path: join(downloadsDir, name),
      kind: "financial-downloads" as const,
    })),
  ];
  for (const target of targets) {
    assertSafeTarget(ownedUserData, target.path);
  }
  return targets;
}

function readMarker(path: string): ResetMarker | null {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<ResetMarker>;
    if (
      value.version !== CANONICAL_RESET_VERSION ||
      (value.status !== "resetting" && value.status !== "completed") ||
      typeof value.resetId !== "string" ||
      typeof value.userData !== "string" ||
      typeof value.canonicalLedgerDir !== "string" ||
      !Array.isArray(value.targets) ||
      typeof value.updatedAtUtc !== "string"
    )
      throw invalidMarker("required fields are missing or invalid");
    return value as ResetMarker;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Canonical reset marker is invalid:"))
      throw error;
    throw invalidMarker("file is not valid JSON");
  }
}

function writeMarker(path: string, marker: ResetMarker) {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(marker, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporaryPath, path);
}

function markerState(
  markerPath: string,
  canonicalLedgerDir: string,
  targets: readonly CanonicalResetTarget[],
  marker: ResetMarker | null,
): CanonicalResetState {
  if (!marker) {
    const hasFinancialTargets = targets.some((target) => existsSync(target.path));
    return {
      status: hasFinancialTargets ? "reset-needed" : "fresh-install",
      markerPath,
      canonicalLedgerDir,
      targets,
    };
  }
  return {
    status: marker.status,
    markerPath,
    canonicalLedgerDir,
    targets: marker.targets.map(({ path, kind }) => ({ path, kind })),
    resetId: marker.resetId,
  };
}

function targetKey(target: Pick<CanonicalResetTarget, "path" | "kind">): string {
  return `${resolve(target.path)}\u0000${target.kind}`;
}

function validateResetMarker(
  marker: ResetMarker,
  userData: string,
  canonicalLedgerDir: string,
  targets: readonly CanonicalResetTarget[],
  stagingDir: string,
): void {
  if (resolve(marker.userData) !== userData)
    throw invalidMarker("user data root does not match this runtime");
  if (resolve(marker.canonicalLedgerDir) !== canonicalLedgerDir)
    throw invalidMarker("canonical ledger directory does not match this runtime");
  if (marker.resetId.trim() === "")
    throw invalidMarker("reset ID is empty");
  if (marker.targets.length !== targets.length)
    throw invalidMarker("target manifest length does not match the current allowlist");

  const expected = new Map(
    targets.map((target, index) => [
      targetKey(target),
      { target, index },
    ]),
  );
  const seen = new Set<string>();
  for (const candidate of marker.targets) {
    const raw = candidate as unknown as Record<string, unknown>;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
      throw invalidMarker("target manifest entry is not an object");
    if (typeof raw.path !== "string" || typeof raw.kind !== "string" || typeof raw.stagePath !== "string")
      throw invalidMarker("target manifest entry has invalid fields");
    const key = targetKey({ path: raw.path, kind: raw.kind as CanonicalResetTargetKind });
    const expectedTarget = expected.get(key);
    if (!expectedTarget)
      throw invalidMarker(`target is outside the current allowlist: ${raw.path}`);
    if (seen.has(key))
      throw invalidMarker(`target is duplicated: ${raw.path}`);
    const expectedStagePath = stagePathFor(
      stagingDir,
      expectedTarget.target,
      expectedTarget.index,
    );
    if (resolve(raw.stagePath) !== expectedStagePath)
      throw invalidMarker(`staging path does not match target: ${raw.path}`);
    seen.add(key);
  }
  if (seen.size !== expected.size)
    throw invalidMarker("target manifest is missing an allowlisted target");
}

export function readCanonicalResetState(
  userData: string,
  canonicalLedgerDir = canonicalLedgerDirectoryFor(userData),
): CanonicalResetState {
  const markerPath = markerPathFor(userData);
  const targets = resolveCanonicalResetTargets(userData, canonicalLedgerDir);
  const marker = readMarker(markerPath);
  if (marker) {
    validateResetMarker(
      marker,
      resolve(userData),
      canonicalLedgerDirectoryFor(userData, canonicalLedgerDir),
      targets,
      stagingDirectoryFor(resolve(userData)),
    );
  }
  return markerState(markerPath, canonicalLedgerDirectoryFor(userData, canonicalLedgerDir), targets, marker);
}

function stagePathFor(stagingDir: string, target: CanonicalResetTarget, index: number) {
  return join(stagingDir, `${String(index).padStart(2, "0")}-${target.path.split(/[\\/]/u).pop() ?? "target"}`);
}

function stageAndRemoveTargets(
  marker: ResetMarker,
  markerPath: string,
  stagingDir: string,
  now: () => string,
) {
  mkdirSync(stagingDir, { recursive: true });
  for (const target of marker.targets) {
    assertSafeTarget(marker.userData, target.path);
    assertSafeTarget(stagingDir, target.stagePath);
    if (existsSync(target.path) && !existsSync(target.stagePath)) {
      mkdirSync(dirname(target.path), { recursive: true });
      renameSync(target.path, target.stagePath);
      writeMarker(markerPath, { ...marker, updatedAtUtc: now() });
    }
    if (existsSync(target.stagePath)) {
      rmSync(target.stagePath, { recursive: true, force: false });
      writeMarker(markerPath, { ...marker, updatedAtUtc: now() });
    }
  }
}

function removePartialCanonicalTargets(marker: ResetMarker) {
  for (const target of marker.targets) {
    if (target.kind !== "canonical-ledger" && target.kind !== "ledger-sidecar")
      continue;
    try {
      if (existsSync(target.path))
        rmSync(target.path, { recursive: true, force: true });
    } catch {
      // The reset marker remains resetting, so the next launch retries the
      // exact target manifest before opening the canonical store.
    }
  }
}

function canonicalSeams(seams?: CanonicalResetSeams): CanonicalResetSeams {
  return seams ?? {
    openCanonical: (ledgerDir) => {
      const db = openCanonicalDatabaseHandle(ledgerDir);
      return { close: () => db.close() };
    },
  };
}

/**
 * Initialize one canonical store before creating any financial query. A
 * reset is persisted before its first rename, so a process interruption can
 * resume the exact target list without scanning or deleting a parent folder.
 */
export function initializeCanonicalRuntime(
  options: CanonicalResetOptions,
): CanonicalResetState {
  const userData = resolve(options.userData);
  const canonicalLedgerDir = canonicalLedgerDirectoryFor(
    userData,
    options.canonicalLedgerDir,
  );
  const markerPath = markerPathFor(userData);
  const targets = resolveCanonicalResetTargets(userData, canonicalLedgerDir);
  const existingMarker = readMarker(markerPath);
  if (existingMarker) {
    validateResetMarker(
      existingMarker,
      userData,
      canonicalLedgerDir,
      targets,
      stagingDirectoryFor(userData),
    );
  }
  const resumableMarker = existingMarker;
  const seams = canonicalSeams(options.seams);
  const now = options.now ?? nowUtc;
  const makeResetId = options.resetId ?? randomUUID;

  if (resumableMarker?.status === "completed") {
    options.seams?.beforeOpen?.();
    const db = seams.openCanonical(canonicalLedgerDir);
    try {
      options.seams?.afterOpen?.();
    } finally {
      db.close();
    }
    return markerState(markerPath, canonicalLedgerDir, targets, resumableMarker);
  }

  const resetId = resumableMarker?.resetId ?? makeResetId();
  const stagingDir = stagingDirectoryFor(userData);
  const stagedTargets: readonly StagedResetTarget[] = (resumableMarker?.targets?.length
    ? resumableMarker.targets
    : targets.map((target, index) => ({
        ...target,
        stagePath: stagePathFor(stagingDir, target, index),
      }))).map((target, index) => ({
        ...target,
        stagePath: target.stagePath || stagePathFor(stagingDir, target, index),
      }));
  let marker: ResetMarker = {
    version: CANONICAL_RESET_VERSION,
    status: "resetting",
    resetId,
    userData,
    canonicalLedgerDir,
    targets: stagedTargets,
    updatedAtUtc: now(),
  };
  writeMarker(markerPath, marker);

  try {
    stageAndRemoveTargets(marker, markerPath, stagingDir, now);
    mkdirSync(canonicalLedgerDir, { recursive: true });
    options.seams?.beforeOpen?.();
    const db = seams.openCanonical(canonicalLedgerDir);
    try {
      options.seams?.afterOpen?.();
    } finally {
      db.close();
    }
    marker = {
      ...marker,
      status: "completed",
      updatedAtUtc: now(),
    };
    if (existsSync(stagingDir)) rmSync(stagingDir, { recursive: true, force: false });
    writeMarker(markerPath, marker);
    return markerState(markerPath, canonicalLedgerDir, targets, marker);
  } catch (error) {
    removePartialCanonicalTargets(marker);
    // Keep the resetting marker and any staged target. The next launch will
    // resume from this exact manifest and will never fall back to legacy.
    throw error;
  }
}
