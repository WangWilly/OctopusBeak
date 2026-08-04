import { existsSync, statSync } from "node:fs";
import { hashBytes, stableStringify } from "../../../ledger/content-hash.ts";
import { ledgerSqlitePath, openLedgerDatabase, type LedgerDatabase } from "../../../ledger/db/client.ts";
import { buildFinancialModel } from "../../../ledger/financial-dashboard-model.ts";
import { TYPED_STATEMENT_TABLES, type FinancialModel } from "../../../ledger/financial-dashboard-types.ts";
import {
  createAgentSecretBoundaryGate,
  type AgentRunStore,
  type SecretBoundaryDependencies,
  type SecretBoundaryGate,
} from "./harness.ts";

export const AGENT_TOOL_PROPOSAL_VERSION = "agent-tool-proposal.v1" as const;
export const AGENT_TOOL_DECISION_VERSION = "agent-tool-decision.v1" as const;
export const AGENT_TOOL_RESULT_VERSION = "agent-tool-result.v1" as const;
export const AGENT_TOOL_REFERENCE_VERSION = "immutable-result-ref.v1" as const;
export const FINANCIAL_OVERVIEW_AGGREGATE_VERSION = "financial-overview.aggregate.v1" as const;

/** Quantitative host-owned limits for the first allowlisted tool. */
export const AGENT_TOOL_RESOURCE_LIMITS = Object.freeze({
  maxLedgerPathBytes: 4_096,
  maxLedgerBytes: 64 * 1024 * 1024,
  maxLedgerRows: 500_000,
  maxProposalBytes: 16_384,
  maxAggregateBytes: 262_144,
  maxCurrencyBuckets: 128,
  maxAggregateCount: 1_000_000,
});
export const AGENT_TOOL_DEFAULT_EXECUTION_TIMEOUT_MS = 5_000;

export const AGENT_TOOL_OUTCOMES = [
  "not-dispatched",
  "completed",
  "outcome-unknown",
] as const;
export type AgentToolOutcome = (typeof AGENT_TOOL_OUTCOMES)[number];

export const AGENT_TOOL_DECISION_REASONS = [
  "allowed",
  "malformed-proposal",
  "tool-not-allowlisted",
  "schema-invalid",
  "permission-denied",
  "sensitivity-denied",
  "resource-denied",
  "run-authority-denied",
  "credential-boundary",
  "secret-boundary-violation",
] as const;
export type AgentToolDecisionReason = (typeof AGENT_TOOL_DECISION_REASONS)[number];

export type ReadFinancialOverviewInput = Record<string, never>;

export type AgentToolProposal = {
  proposalVersion: typeof AGENT_TOOL_PROPOSAL_VERSION;
  requestId: string;
  runId: string;
  toolName: "read_financial_overview";
  input: ReadFinancialOverviewInput;
  permission: "financial.overview.read";
  sensitivity: "derived-financial";
  resource: "ledger.overview";
  runAuthority: string;
};

export type AgentToolResultReference = {
  referenceVersion: typeof AGENT_TOOL_REFERENCE_VERSION;
  value: string;
};

export type AgentToolDecision = {
  decisionVersion: typeof AGENT_TOOL_DECISION_VERSION;
  allowed: boolean;
  reason: AgentToolDecisionReason;
};

export type FinancialOverviewAggregate = {
  aggregateVersion: typeof FINANCIAL_OVERVIEW_AGGREGATE_VERSION;
  snapshot: {
    snapshotId: string;
    importedAt: string | null;
    snapshotDate: string | null;
  };
  totalsByCurrency: Record<string, {
    assets: number;
    liabilities: number;
    net: number;
  }>;
  overview: {
    cashAssets: Record<string, number>;
    foreignAssets: Record<string, number>;
    investmentAssets: Record<string, number>;
    unbilledCreditCard: Record<string, number>;
    loans: Record<string, number>;
    netAssets: Record<string, number>;
  };
  counts: {
    normalizedTransactions: number;
    assetPositions: number;
    includedPositions: number;
    assetSnapshots: number;
  };
  quality: {
    status: FinancialModel["quality"]["status"];
    issueCount: number;
  };
};

export type AgentToolResult = {
  resultVersion: typeof AGENT_TOOL_RESULT_VERSION;
  toolName: "read_financial_overview";
  data: FinancialOverviewAggregate;
  reference: AgentToolResultReference;
  secretFields: readonly [];
};

export const AGENT_TOOL_SETTLEMENTS = ["normal", "cancelled-in-flight"] as const;
export type AgentToolSettlement = (typeof AGENT_TOOL_SETTLEMENTS)[number];

export type AgentToolExecutionRecord = {
  runId: string;
  requestId: string;
  proposal: AgentToolProposal;
  decision: AgentToolDecision;
  outcome: AgentToolOutcome;
  result: AgentToolResult | null;
  resultReference: AgentToolResultReference | null;
  occurredAt: string;
  settlement?: AgentToolSettlement;
};

export type AgentToolSubmission = {
  requestId: string;
  decision: AgentToolDecision;
  outcome: AgentToolOutcome;
  result: AgentToolResult | null;
  resultReference: AgentToolResultReference | null;
  settlement: AgentToolSettlement;
};

export type AgentProviderToolGateway = {
  submit(proposal: unknown): Promise<AgentToolSubmission>;
};

type FinancialOverviewAdapter = (input: {
  ledgerDir: string;
  proposal: AgentToolProposal;
}) => Promise<AgentToolResult>;

const TOP_LEVEL_PROPOSAL_KEYS = [
  "proposalVersion",
  "requestId",
  "runId",
  "toolName",
  "input",
  "permission",
  "sensitivity",
  "resource",
  "runAuthority",
] as const;
const INPUT_KEYS: readonly string[] = [];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function hasCredentialKey(key: string) {
  return /(?:credential|password|passcode|secret|token|cookie|api[-_]?key|authorization)/i.test(key);
}

function containsCredentialMaterial(value: unknown, key = ""): boolean {
  if (hasCredentialKey(key)) return value !== null && value !== undefined && value !== "";
  if (typeof value === "string") return false;
  if (Array.isArray(value)) return value.some((item) => containsCredentialMaterial(item));
  if (isRecord(value)) {
    return Object.entries(value).some(([childKey, childValue]) =>
      containsCredentialMaterial(childValue, childKey));
  }
  return false;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function safeIdentifier(value: unknown, fallback: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) return fallback;
  if (containsCredentialMaterial(value)) return "redacted";
  return value;
}

export function agentToolProposalIdentity(proposal: AgentToolProposal): string {
  return hashBytes(stableStringify(proposal));
}

export function createReadFinancialOverviewProposal(
  runId: string,
  requestId: string,
): AgentToolProposal {
  return {
    proposalVersion: AGENT_TOOL_PROPOSAL_VERSION,
    requestId,
    runId,
    toolName: "read_financial_overview",
    input: {},
    permission: "financial.overview.read",
    sensitivity: "derived-financial",
    resource: "ledger.overview",
    runAuthority: runId,
  };
}

export function validateAgentToolProposal(value: unknown):
  | { value: AgentToolProposal; reason: null }
  | { value: null; reason: Exclude<AgentToolDecisionReason, "allowed"> } {
  if (!isRecord(value) || !hasExactKeys(value, TOP_LEVEL_PROPOSAL_KEYS)) {
    return { value: null, reason: "malformed-proposal" };
  }
  if (containsCredentialMaterial(value)) {
    return { value: null, reason: "credential-boundary" };
  }
  if (value.proposalVersion !== AGENT_TOOL_PROPOSAL_VERSION
    || typeof value.requestId !== "string"
    || value.requestId.length === 0
    || value.requestId.length > 200
    || typeof value.runId !== "string"
    || value.runId.length === 0
    || value.runId.length > 200) {
    return { value: null, reason: "schema-invalid" };
  }
  if (value.toolName !== "read_financial_overview") {
    return { value: null, reason: "tool-not-allowlisted" };
  }
  if (!isRecord(value.input) || !hasExactKeys(value.input, INPUT_KEYS)) {
    return { value: null, reason: "schema-invalid" };
  }
  if (value.permission !== "financial.overview.read") {
    return { value: null, reason: "permission-denied" };
  }
  if (value.sensitivity !== "derived-financial") {
    return { value: null, reason: "sensitivity-denied" };
  }
  if (value.resource !== "ledger.overview") {
    return { value: null, reason: "resource-denied" };
  }
  if (typeof value.runAuthority !== "string" || value.runAuthority.length === 0) {
    return { value: null, reason: "run-authority-denied" };
  }
  return { value: value as AgentToolProposal, reason: null };
}

function emptyDecision(reason: AgentToolDecisionReason): AgentToolDecision {
  return {
    decisionVersion: AGENT_TOOL_DECISION_VERSION,
    allowed: reason === "allowed",
    reason,
  };
}

function resultReference(data: FinancialOverviewAggregate): AgentToolResultReference {
  return {
    referenceVersion: AGENT_TOOL_REFERENCE_VERSION,
    value: `${AGENT_TOOL_REFERENCE_VERSION}:${hashBytes(stableStringify(data))}`,
  };
}

function exactRecordKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function isFiniteNumberRecord(value: unknown): value is Record<string, number> {
  return isRecord(value)
    && Object.values(value).every((item) => typeof item === "number" && Number.isFinite(item));
}

export function validateAgentToolResult(value: unknown): value is AgentToolResult {
  if (!isRecord(value)
    || !exactRecordKeys(value, ["resultVersion", "toolName", "data", "reference", "secretFields"])
    || value.resultVersion !== AGENT_TOOL_RESULT_VERSION
    || value.toolName !== "read_financial_overview"
    || !Array.isArray(value.secretFields)
    || value.secretFields.length !== 0
    || !isRecord(value.reference)
    || value.reference.referenceVersion !== AGENT_TOOL_REFERENCE_VERSION
    || typeof value.reference.value !== "string"
    || !isRecord(value.data)
    || !exactRecordKeys(value.data, ["aggregateVersion", "snapshot", "totalsByCurrency", "overview", "counts", "quality"])
    || value.data.aggregateVersion !== FINANCIAL_OVERVIEW_AGGREGATE_VERSION
    || !isRecord(value.data.snapshot)
    || !exactRecordKeys(value.data.snapshot, ["snapshotId", "importedAt", "snapshotDate"])
    || typeof value.data.snapshot.snapshotId !== "string"
    || (value.data.snapshot.importedAt !== null && typeof value.data.snapshot.importedAt !== "string")
    || (value.data.snapshot.snapshotDate !== null && typeof value.data.snapshot.snapshotDate !== "string")
    || !isRecord(value.data.totalsByCurrency)
    || Object.values(value.data.totalsByCurrency).some((totals) =>
      !isRecord(totals)
      || !exactRecordKeys(totals, ["assets", "liabilities", "net"])
      || Object.values(totals).some((item) => typeof item !== "number" || !Number.isFinite(item)))
    || !isRecord(value.data.overview)
    || !exactRecordKeys(value.data.overview, [
      "cashAssets", "foreignAssets", "investmentAssets", "unbilledCreditCard", "loans", "netAssets",
    ])
    || !Object.values(value.data.overview).every(isFiniteNumberRecord)
    || !isRecord(value.data.counts)
    || !exactRecordKeys(value.data.counts, ["normalizedTransactions", "assetPositions", "includedPositions", "assetSnapshots"])
    || Object.values(value.data.counts).some((item) => !Number.isSafeInteger(item) || (item as number) < 0)
    || !isRecord(value.data.quality)
    || !exactRecordKeys(value.data.quality, ["status", "issueCount"])
    || !["pass", "warn", "fail"].includes(value.data.quality.status as string)
    || !Number.isSafeInteger(value.data.quality.issueCount)
    || (value.data.quality.issueCount as number) < 0) {
    return false;
  }
  const canonical = resultReference(value.data as unknown as FinancialOverviewAggregate);
  return value.reference.value === canonical.value;
}

function aggregateFromModel(model: FinancialModel): FinancialOverviewAggregate {
  const snapshots = model.snapshotHistory.snapshots;
  const latestSnapshot = snapshots.at(-1) ?? null;
  const snapshotIdentity = hashBytes(stableStringify(snapshots.map((snapshot) => ({
    importRunId: snapshot.importRunId,
    importedAt: snapshot.importedAt,
    snapshotDate: snapshot.snapshotDate,
  }))));
  const overview = model.dashboard.overview;
  const totalsByCurrency = Object.fromEntries(
    Object.entries(model.totals.includedByCurrency)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([currency, totals]) => [currency, {
        assets: totals.assets,
        liabilities: totals.liabilities,
        net: totals.net,
      }]),
  );
  const data: FinancialOverviewAggregate = {
    aggregateVersion: FINANCIAL_OVERVIEW_AGGREGATE_VERSION,
    snapshot: {
      snapshotId: `${FINANCIAL_OVERVIEW_AGGREGATE_VERSION}:${snapshotIdentity}`,
      importedAt: latestSnapshot?.importedAt ?? null,
      snapshotDate: latestSnapshot?.snapshotDate ?? null,
    },
    totalsByCurrency,
    overview: {
      cashAssets: { ...overview.assets.totalTwdAssets },
      foreignAssets: { ...overview.assets.totalForeignAssets },
      investmentAssets: { ...overview.assets.totalInvestmentAssets },
      unbilledCreditCard: { ...overview.liabilities.unbilledCreditCardAmount },
      loans: { ...overview.liabilities.loanTotalBalance },
      netAssets: { ...overview.netAssets },
    },
    counts: {
      normalizedTransactions: model.counts.normalizedTransactions,
      assetPositions: model.counts.assetPositions,
      includedPositions: model.counts.includedPositions,
      assetSnapshots: model.counts.assetSnapshots,
    },
    quality: {
      status: model.quality.status,
      issueCount: model.quality.issues.length,
    },
  };
  return data;
}

export async function readFinancialOverviewResult(
  ledgerDir: string,
  buildModel: (input: { ledgerDir: string; outputDir: string }) => Promise<FinancialModel> = buildFinancialModel,
): Promise<AgentToolResult> {
  const model = await buildModel({ ledgerDir, outputDir: ledgerDir });
  if (!modelWithinResourceLimits(model)) throw new Error("tool-resource-limit-exceeded");
  const data = aggregateFromModel(model);
  return {
    resultVersion: AGENT_TOOL_RESULT_VERSION,
    toolName: "read_financial_overview",
    data,
    reference: resultReference(data),
    secretFields: [],
  };
}

function replaySubmission(record: AgentToolExecutionRecord): AgentToolSubmission {
  return {
    requestId: record.requestId,
    decision: record.decision,
    outcome: record.outcome,
    result: record.result,
    resultReference: record.resultReference,
    settlement: record.settlement ?? "normal",
  };
}

const TOOL_OUTCOME_RANK: Record<AgentToolOutcome, number> = {
  "not-dispatched": 1,
  "outcome-unknown": 2,
  completed: 3,
};

function isMoreFinalOutcome(next: AgentToolOutcome, current: AgentToolOutcome): boolean {
  return TOOL_OUTCOME_RANK[next] > TOOL_OUTCOME_RANK[current];
}

function resultWithinResourceLimits(result: AgentToolResult): boolean {
  const currencyCount = Object.keys(result.data.totalsByCurrency).length
    + Object.values(result.data.overview).reduce((total, bucket) => total + Object.keys(bucket).length, 0);
  const counts = Object.values(result.data.counts);
  return utf8Bytes(stableStringify(result)) <= AGENT_TOOL_RESOURCE_LIMITS.maxAggregateBytes
    && currencyCount <= AGENT_TOOL_RESOURCE_LIMITS.maxCurrencyBuckets
    && counts.every((count) => count <= AGENT_TOOL_RESOURCE_LIMITS.maxAggregateCount);
}

function modelWithinResourceLimits(model: FinancialModel): boolean {
  return model.counts.normalizedTransactions <= AGENT_TOOL_RESOURCE_LIMITS.maxAggregateCount
    && model.counts.assetPositions <= AGENT_TOOL_RESOURCE_LIMITS.maxAggregateCount
    && model.counts.assetSnapshots <= AGENT_TOOL_RESOURCE_LIMITS.maxAggregateCount
    && model.normalizedTransactions.length <= AGENT_TOOL_RESOURCE_LIMITS.maxAggregateCount
    && model.assetPositions.length <= AGENT_TOOL_RESOURCE_LIMITS.maxAggregateCount
    && model.snapshotHistory.snapshots.length <= AGENT_TOOL_RESOURCE_LIMITS.maxAggregateCount;
}

type LedgerResourceSnapshot = {
  fileSignature: string;
  dataVersion: number | null;
  totalBytes: number;
  totalRows: number;
};

function ledgerResourceSnapshot(
  ledgerDir: string,
  snapshotDb?: LedgerDatabase,
): LedgerResourceSnapshot | null {
  const sqlitePath = ledgerSqlitePath(ledgerDir);
  try {
    const files = [sqlitePath, `${sqlitePath}-wal`, `${sqlitePath}-shm`];
    const fileStats = files.map((file) => {
      try {
        const stats = statSync(file);
        return { file, size: stats.size, mtimeMs: stats.mtimeMs };
      } catch {
        return { file, size: 0, mtimeMs: null };
      }
    });
    const totalBytes = fileStats.reduce((total, file) => total + file.size, 0);
    if (totalBytes > AGENT_TOOL_RESOURCE_LIMITS.maxLedgerBytes) return null;
    if (!existsSync(sqlitePath)) {
      return totalBytes === 0
        ? { fileSignature: "missing", dataVersion: null, totalBytes: 0, totalRows: 0 }
        : null;
    }
    const fileSignature = fileStats.map((file) =>
      `${file.file}:${file.size}:${file.mtimeMs === null ? "missing" : file.mtimeMs}`).join("|");
    const db = snapshotDb ?? openLedgerDatabase(ledgerDir, { readOnly: true });
    try {
      const dataVersionRow = db.prepare("PRAGMA data_version").get() as { data_version?: number };
      const tables = ["import_runs", "source_files", ...TYPED_STATEMENT_TABLES] as const;
      const totalRows = tables.reduce((total, table) => {
        const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
        return total + Number(row.count);
      }, 0);
      return {
        fileSignature,
        dataVersion: typeof dataVersionRow.data_version === "number"
          ? dataVersionRow.data_version
          : null,
        totalBytes,
        totalRows,
      };
    } finally {
      if (!snapshotDb) db.close();
    }
  } catch {
    return null;
  }
}

function ledgerSnapshotWithinResourceLimits(snapshot: LedgerResourceSnapshot | null): boolean {
  return snapshot !== null
    && snapshot.totalBytes <= AGENT_TOOL_RESOURCE_LIMITS.maxLedgerBytes
    && snapshot.totalRows <= AGENT_TOOL_RESOURCE_LIMITS.maxLedgerRows;
}

function sameLedgerSnapshot(
  before: LedgerResourceSnapshot,
  after: LedgerResourceSnapshot | null,
): boolean {
  return after !== null
    && before.fileSignature === after.fileSignature
    && before.totalBytes === after.totalBytes
    && (before.dataVersion === null
      || after.dataVersion === null
      || before.dataVersion === after.dataVersion)
    && before.totalRows === after.totalRows;
}

export function createFinancialOverviewToolGateway({
  ledgerDir = process.env.LEDGER_DIR ?? "data/ledger",
  runStore,
  clock = { now: () => new Date().toISOString() },
  adapter = ({ ledgerDir: root }) => readFinancialOverviewResult(root),
  executionTimeoutMs = AGENT_TOOL_DEFAULT_EXECUTION_TIMEOUT_MS,
  secretValues,
  additionalSecretValues,
  secretBoundaryDependencies,
}: {
  ledgerDir?: string;
  runStore: AgentRunStore;
  clock?: { now(): string };
  adapter?: FinancialOverviewAdapter;
  executionTimeoutMs?: number;
  secretValues?: readonly string[];
  additionalSecretValues?: readonly string[];
  secretBoundaryDependencies?: Partial<SecretBoundaryDependencies>;
}): AgentProviderToolGateway {
  const secretBoundary: SecretBoundaryGate = createAgentSecretBoundaryGate({
    secretValues,
    additionalSecretValues,
    dependencies: secretBoundaryDependencies,
  });
  const records = new Map<string, AgentToolExecutionRecord>();
  const inFlight = new Map<string, { identity: string; submission: Promise<AgentToolSubmission> }>();

  function protect<T extends Record<string, unknown>>(schema: string, value: T) {
    const protectedValue = secretBoundary.protectRecord("sqlite-persistence", schema, value);
    if (protectedValue.failure) {
      throw new Error("SECRET_BOUNDARY_VIOLATION surface=sqlite-persistence reason=authentication-secret-detected");
    }
    return protectedValue.value as T;
  }

  function persist(record: AgentToolExecutionRecord): AgentToolExecutionRecord {
    const protectedRecord = protect("agent-tool-outcome", record as unknown as Record<string, unknown>);
    const next = protectedRecord as unknown as AgentToolExecutionRecord;
    const key = `${next.runId}:${next.requestId}`;
    if (!runStore.getRun(next.runId)) return next;
    const existing = records.get(key) ?? runStore.getToolRequest?.(next.runId, next.requestId) ?? null;
    const identityDiffers = existing
      && agentToolProposalIdentity(existing.proposal) !== agentToolProposalIdentity(next.proposal);
    if (identityDiffers && existing?.outcome !== "not-dispatched") {
      records.set(key, existing);
      return next;
    }
    if (existing && !isMoreFinalOutcome(next.outcome, existing.outcome)) {
      records.set(key, existing);
      return existing;
    }
    runStore.recordToolRequest?.(next);
    const persisted = runStore.getToolRequest?.(next.runId, next.requestId) ?? next;
    records.set(key, persisted);
    return persisted;
  }

  return {
    async submit(rawProposal) {
      let containsSecret = false;
      try {
        containsSecret = containsCredentialMaterial(rawProposal);
      } catch {
        containsSecret = true;
      }
      const exactProposal = isRecord(rawProposal) && hasExactKeys(rawProposal, TOP_LEVEL_PROPOSAL_KEYS);
      let proposalHasSecret = false;
      if (exactProposal) {
        try {
          const protectedProposal = secretBoundary.protectRecord(
            "diagnostic-export",
            "agent-tool-proposal",
            rawProposal,
          );
          proposalHasSecret = Boolean(protectedProposal.failure) || containsSecret;
        } catch {
          proposalHasSecret = true;
        }
      }
      containsSecret ||= proposalHasSecret;
      let serializedProposal = "";
      try {
        const serialized = stableStringify(rawProposal);
        serializedProposal = typeof serialized === "string" ? serialized : String(serialized);
      } catch {
        serializedProposal = "[unserializable]";
      }
      const proposalTooLarge = utf8Bytes(serializedProposal) > AGENT_TOOL_RESOURCE_LIMITS.maxProposalBytes;
      const validation = proposalTooLarge
        ? { value: null, reason: "resource-denied" as const }
        : proposalHasSecret
          ? { value: null, reason: "credential-boundary" as const }
          : validateAgentToolProposal(rawProposal);
      const proposal = validation.value;
      const rawRunId = isRecord(rawProposal) ? rawProposal.runId : undefined;
      const rawRequestId = isRecord(rawProposal) ? rawProposal.requestId : undefined;
      const runId = containsSecret ? "redacted" : safeIdentifier(rawRunId, "unknown");
      const requestId = containsSecret
        ? "redacted"
        : safeIdentifier(
          rawRequestId,
          `invalid-${hashBytes(serializedProposal).slice(0, 16)}`,
        );

      if (!proposal) {
        const decision = emptyDecision(validation.reason);
        const record = {
          runId,
          requestId,
          proposal: {
            ...createReadFinancialOverviewProposal(runId, requestId),
            runAuthority: "invalid",
          },
          decision,
          outcome: "not-dispatched" as const,
          result: null,
          resultReference: null,
          occurredAt: clock.now(),
        };
        return replaySubmission(persist(record));
      }

      const run = runStore.getRun(proposal.runId);
      const active = Boolean(run && run.phase === "running" && proposal.runAuthority === proposal.runId);
      const existing = records.get(`${proposal.runId}:${proposal.requestId}`)
        ?? runStore.getToolRequest?.(proposal.runId, proposal.requestId)
        ?? null;
      if (existing) {
        if (active && agentToolProposalIdentity(existing.proposal) === agentToolProposalIdentity(proposal)) {
          if (existing.outcome !== "not-dispatched") {
            records.set(`${proposal.runId}:${proposal.requestId}`, existing);
            return replaySubmission(existing);
          }
        } else if (existing.outcome !== "not-dispatched") {
          const decision = emptyDecision(active ? "schema-invalid" : "run-authority-denied");
          return replaySubmission({
            runId: proposal.runId,
            requestId: proposal.requestId,
            proposal,
            decision,
            outcome: "not-dispatched",
            result: null,
            resultReference: null,
            occurredAt: clock.now(),
          });
        }
      }

      const reason: AgentToolDecisionReason = !active
        ? "run-authority-denied"
        : "allowed";
      const decision = emptyDecision(reason);
      if (!decision.allowed) {
        const record = {
          runId: proposal.runId,
          requestId: proposal.requestId,
          proposal,
          decision,
          outcome: "not-dispatched" as const,
          result: null,
          resultReference: null,
          occurredAt: clock.now(),
        };
        return replaySubmission(persist(record));
      }
      const key = `${proposal.runId}:${proposal.requestId}`;
      const identity = agentToolProposalIdentity(proposal);
      const concurrent = inFlight.get(key);
      if (concurrent?.identity === identity) return concurrent.submission;

      let snapshotDb: LedgerDatabase | undefined;
      if (existsSync(ledgerSqlitePath(ledgerDir))) {
        try {
          snapshotDb = openLedgerDatabase(ledgerDir, { readOnly: true });
        } catch {
          snapshotDb = undefined;
        }
      }
      const ledgerBefore = ledgerResourceSnapshot(ledgerDir, snapshotDb);
      if (utf8Bytes(ledgerDir) > AGENT_TOOL_RESOURCE_LIMITS.maxLedgerPathBytes
        || !ledgerSnapshotWithinResourceLimits(ledgerBefore)) {
        snapshotDb?.close();
        const record = {
          runId: proposal.runId,
          requestId: proposal.requestId,
          proposal,
          decision: emptyDecision("resource-denied"),
          outcome: "not-dispatched" as const,
          result: null,
          resultReference: null,
          occurredAt: clock.now(),
        };
        return replaySubmission(persist(record));
      }

      const dispatch = (async (): Promise<AgentToolSubmission> => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          const timeoutMs = Number.isFinite(executionTimeoutMs) && executionTimeoutMs > 0
            ? executionTimeoutMs
            : AGENT_TOOL_DEFAULT_EXECUTION_TIMEOUT_MS;
          const adapterResult = await Promise.race([
            adapter({ ledgerDir, proposal }),
            new Promise<never>((_, reject) => {
              timeout = setTimeout(() => reject(new Error("tool-execution-timeout")), timeoutMs);
            }),
          ]);
          if (!validateAgentToolResult(adapterResult) || !resultWithinResourceLimits(adapterResult)) {
            throw new Error("invalid-tool-result");
          }
          if (!ledgerBefore || !sameLedgerSnapshot(ledgerBefore, ledgerResourceSnapshot(ledgerDir, snapshotDb))) {
            throw new Error("ledger-changed-during-tool-read");
          }
          const settlement: AgentToolSettlement = runStore.getRun(proposal.runId)?.phase === "cancelled"
            ? "cancelled-in-flight" as const
            : "normal";
          const protectedResult = protect("agent-tool-result", adapterResult as unknown as Record<string, unknown>) as unknown as AgentToolResult;
          const record = {
            runId: proposal.runId,
            requestId: proposal.requestId,
            proposal,
            decision,
            outcome: "completed" as const,
            result: protectedResult,
            resultReference: protectedResult.reference,
            occurredAt: clock.now(),
            settlement,
          };
          return replaySubmission(persist(record));
        } catch {
          const record = {
            runId: proposal.runId,
            requestId: proposal.requestId,
            proposal,
            decision,
            outcome: "outcome-unknown" as const,
            result: null,
            resultReference: null,
            occurredAt: clock.now(),
            settlement: (runStore.getRun(proposal.runId)?.phase === "cancelled"
              ? "cancelled-in-flight"
              : "normal") as AgentToolSettlement,
          };
          return replaySubmission(persist(record));
        } finally {
          if (timeout) clearTimeout(timeout);
          snapshotDb?.close();
        }
      })();
      inFlight.set(key, { identity, submission: dispatch });
      try {
        return await dispatch;
      } finally {
        if (inFlight.get(key)?.submission === dispatch) inFlight.delete(key);
      }
    },
  };
}
