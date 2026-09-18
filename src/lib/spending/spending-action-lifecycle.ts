import type {
  SpendingPurchaseActionResult,
} from "./model.ts";
import type { SpendingPurchaseReportView } from "./purchase-matching.ts";
import { applySpendingPurchaseReportPatch } from "./purchase-report-patch.ts";

/**
 * The renderer keeps one opaque key for one logical user action.  The key is
 * deliberately independent from the report generation: a response-loss
 * retry must replay the same canonical command even after the page reloads.
 */
export type SpendingPendingCommand = Readonly<{
  action: "candidate-confirmation" | "direct-pair" | "unlink";
  identity: string;
  idempotencyKey: string;
}>;

export type SpendingPendingCommandIdentity = Readonly<{
  action: SpendingPendingCommand["action"];
  firstId: string;
  secondId: string;
}>;

type StoredPendingCommand = SpendingPendingCommand & Readonly<{
  createdAt: number;
  lastUsedAt: number;
}>;

type PendingCommandStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const STORAGE_KEY = "octopus-beak.spending.pending-commands.v1";
const STORAGE_VERSION = 1;
const MAX_PENDING_COMMANDS = 32;
const MAX_PENDING_COMMAND_AGE_MS = 24 * 60 * 60 * 1000;

function storageFrom(value?: PendingCommandStorage): PendingCommandStorage | null {
  if (value) return value;
  if (typeof localStorage === "undefined") return null;
  return localStorage;
}

function identityFor(value: SpendingPendingCommandIdentity): string {
  const action = value.action.trim();
  const firstId = value.firstId.trim().toLowerCase();
  const secondId = value.secondId.trim().toLowerCase();
  if (!action || !firstId || !secondId) throw new TypeError("Spending action identity is incomplete.");
  return `${action}:${firstId}:${secondId}`;
}

function readStored(storage: PendingCommandStorage, now: number): StoredPendingCommand[] {
  let value: unknown;
  try {
    const serialized = storage.getItem(STORAGE_KEY);
    value = serialized ? JSON.parse(serialized) : null;
  } catch {
    storage.removeItem(STORAGE_KEY);
    return [];
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  if (record.version !== STORAGE_VERSION || !Array.isArray(record.commands)) return [];
  const commands = record.commands.filter((entry): entry is StoredPendingCommand => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const command = entry as Record<string, unknown>;
    return (
      (command.action === "candidate-confirmation" || command.action === "direct-pair" || command.action === "unlink") &&
      typeof command.identity === "string" && command.identity.length > 0 &&
      typeof command.idempotencyKey === "string" && command.idempotencyKey.length > 0 &&
      typeof command.createdAt === "number" && Number.isFinite(command.createdAt) &&
      typeof command.lastUsedAt === "number" && Number.isFinite(command.lastUsedAt) &&
      now - command.lastUsedAt <= MAX_PENDING_COMMAND_AGE_MS
    );
  });
  return commands
    .sort((left, right) => right.lastUsedAt - left.lastUsedAt)
    .slice(0, MAX_PENDING_COMMANDS);
}

function writeStored(storage: PendingCommandStorage, commands: readonly StoredPendingCommand[]): void {
  if (commands.length === 0) {
    storage.removeItem(STORAGE_KEY);
    return;
  }
  storage.setItem(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, commands }));
}

function opaqueKey(): string {
  const browserCrypto = typeof globalThis.crypto === "object" ? globalThis.crypto : undefined;
  if (browserCrypto?.randomUUID) return `renderer-${browserCrypto.randomUUID()}`;
  if (browserCrypto?.getRandomValues) {
    const values = browserCrypto.getRandomValues(new Uint32Array(4));
    return `renderer-${Array.from(values, (value) => value.toString(16).padStart(8, "0")).join("")}`;
  }
  return `renderer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Return the durable key for an action, creating it only once for the same
 * action identity. Stored data contains only action identity and the opaque
 * key; report facts such as amounts, merchants, accounts, and payloads never
 * enter the pending-command record.
 */
export function beginSpendingPendingCommand(
  identity: SpendingPendingCommandIdentity,
  storageValue?: PendingCommandStorage,
  now = Date.now(),
): SpendingPendingCommand {
  const storage = storageFrom(storageValue);
  const normalizedIdentity = identityFor(identity);
  if (!storage) return { action: identity.action, identity: normalizedIdentity, idempotencyKey: opaqueKey() };
  try {
    const commands = readStored(storage, now);
    const existing = commands.find((command) => command.identity === normalizedIdentity && command.action === identity.action);
    const command: StoredPendingCommand = existing
      ? { ...existing, lastUsedAt: now }
      : {
          action: identity.action,
          identity: normalizedIdentity,
          idempotencyKey: opaqueKey(),
          createdAt: now,
          lastUsedAt: now,
        };
    writeStored(storage, [command, ...commands.filter((entry) => entry !== existing)].slice(0, MAX_PENDING_COMMANDS));
    return { action: command.action, identity: command.identity, idempotencyKey: command.idempotencyKey };
  } catch {
    // A blocked or full browser storage must not prevent the canonical action
    // from running. The command remains safe because the server still owns
    // idempotency; this renderer simply cannot survive a reload in this case.
    return { action: identity.action, identity: normalizedIdentity, idempotencyKey: opaqueKey() };
  }
}

/** Remove a key only after the command outcome is known to be durable. */
export function completeSpendingPendingCommand(
  command: SpendingPendingCommand,
  storageValue?: PendingCommandStorage,
  now = Date.now(),
): void {
  const storage = storageFrom(storageValue);
  if (!storage) return;
  try {
    const commands = readStored(storage, now).filter((entry) =>
      entry.identity !== command.identity || entry.idempotencyKey !== command.idempotencyKey,
    );
    writeStored(storage, commands);
  } catch {
    // Completion remains correct even if local cleanup is unavailable.
  }
}

export function spendingActionErrorCode(error: unknown): string | null {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code === "spending-pair-stale" || error.code === "idempotency-key-conflict"
      ? error.code
      : null;
  }
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return text === "spending-pair-stale" || text === "idempotency-key-conflict" ? text : null;
}

export function isSpendingActionUncertain(error: unknown): boolean {
  return spendingActionErrorCode(error) === null;
}

/**
 * Validate both the command receipt and the patch boundary before changing
 * the displayed report. A mismatch means the renderer cannot prove that the
 * sparse patch belongs to the visible generation and must reconcile instead.
 */
export function applyValidatedSpendingActionResult(
  current: SpendingPurchaseReportView,
  result: SpendingPurchaseActionResult,
): SpendingPurchaseReportView {
  if (!Number.isSafeInteger(result.knowledgePoint) || result.knowledgePoint < 0)
    throw new Error("spending-action-knowledge-point-invalid");
  if (result.patch.knowledgeAt !== result.knowledgePoint)
    throw new Error("spending-action-knowledge-point-mismatch");
  if (result.patch.baseKnowledgeAt !== current.knowledgeAt)
    throw new Error("spending-action-stale");
  const next = applySpendingPurchaseReportPatch(current, result.patch);
  if (next.knowledgeAt !== result.knowledgePoint)
    throw new Error("spending-action-patch-result-mismatch");
  return next;
}

export const spendingPendingCommandStorageKey = STORAGE_KEY;
