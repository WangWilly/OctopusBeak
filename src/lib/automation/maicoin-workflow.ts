import {
  buildMaicoinInvestmentCaptures,
} from "../../ledger/canonical/maicoin-crypto-adapters.ts";
import {
  PGLITE_CANONICAL_INVESTMENT_COMMIT_COMMAND,
  PGLITE_CANONICAL_INVESTMENT_RELATIONS_RESOLVE_COMMAND,
} from "../../ledger/pglite/workflow-client.ts";
import {
  collectMaicoinSource,
  MAICOIN_STATEMENT_LIMIT,
  MAICOIN_WALLET_TYPES,
  maicoinRpcChunks,
  pgliteSnapshotRows,
  pgliteStatementRows,
  type MaxCredentials,
} from "../../ledger/sync-maicoin.ts";
import { defineWorkflow, type WorkflowDefinition } from "./workflow-executor.ts";
import { CommitOutcomeUnknownError } from "./commit-attempt.ts";

export type MaicoinWorkflowInput = Readonly<{
  credentials: MaxCredentials;
}>;

export class MaicoinWorkflowError extends Error {
  readonly code: string;

  constructor(code: string, cause?: unknown) {
    super(`MaiCoin workflow failed: ${code}.`, { cause });
    this.name = "MaicoinWorkflowError";
    this.code = code;
  }
}

function safeError(code: string, cause?: unknown): MaicoinWorkflowError {
  return new MaicoinWorkflowError(code, cause);
}

function validatedCredentials(input: MaicoinWorkflowInput): MaxCredentials {
  const credentials = input?.credentials;
  if (!credentials
    || typeof credentials.accessKey !== "string"
    || credentials.accessKey.trim() === ""
    || typeof credentials.secretKey !== "string"
    || credentials.secretKey.trim() === ""
    || typeof credentials.subAccount !== "string"
    || credentials.subAccount.trim() === "") {
    throw safeError("credentials-missing");
  }
  return credentials;
}

function cancellationError(): Error {
  return new Error("Automation task cancelled.");
}

export function createMaicoinWorkflow(): WorkflowDefinition<MaicoinWorkflowInput> {
  return defineWorkflow({
    id: "sync-maicoin",
    requiresFinancialCommit: true,
    requiresMaicoinPersistence: true,
  }, async (context, input: MaicoinWorkflowInput) => {
    const credentials = validatedCredentials(input);
    const persistence = context.maicoinPersistence;
    const syncRunId = context.runId;
    const startedAt = context.now();
    let runStarted = false;
    let runFinished = false;
    let stage: "preparation" | "collection" | "validation" | "commit" | "operational" = "preparation";

    try {
      context.signal.throwIfAborted();
      await persistence.startRun({
        syncRunId,
        startedAt,
        subAccount: credentials.subAccount,
        walletTypes: MAICOIN_WALLET_TYPES,
        statementLimit: MAICOIN_STATEMENT_LIMIT,
        record: { status: "started" },
      });
      runStarted = true;

      stage = "collection";
      await context.event("authentication", "advanced", "authenticating");
      await context.event("collection", "advanced", "collecting-wallets");
      let source;
      try {
        source = await collectMaicoinSource(credentials, {
          walletTypes: MAICOIN_WALLET_TYPES,
          statementLimit: MAICOIN_STATEMENT_LIMIT,
          signal: context.signal,
          now: context.now,
          onWalletsCollected: (count) => context.event(
            "collection",
            "advanced",
            "wallets-collected",
            { completed: count, total: count },
          ),
          onStatementsStarted: () => context.event("collection", "advanced", "collecting-statements"),
          onStatementsCollected: (count) => context.event(
            "collection",
            "completed",
            "statements-collected",
            { completed: count, total: count },
          ),
        });
      } catch (error) {
        if (context.signal.aborted) throw cancellationError();
        await context.event("validation", "failed", "source-rejected");
        throw safeError("source-rejected", error);
      }

      stage = "validation";
      let captures;
      let snapshotChunks;
      let statementChunks;
      try {
        captures = buildMaicoinInvestmentCaptures({
          captureId: syncRunId,
          providerEmail: source.providerEmail,
          subAccount: credentials.subAccount,
          accountBatches: source.accountBatches,
          statementBatches: source.statementBatches,
          valuationQuotes: source.valuationQuotes,
        });
        snapshotChunks = [...maicoinRpcChunks(pgliteSnapshotRows(
          syncRunId,
          source.capturedAt,
          credentials.subAccount,
          source.snapshots,
        ))];
        statementChunks = [...maicoinRpcChunks(pgliteStatementRows(
          syncRunId,
          source.capturedAt,
          source.statementBatches,
          source.statementValues,
        ))];
      } catch (error) {
        await context.event("validation", "failed", "source-rejected");
        throw safeError("source-rejected", error);
      }
      await context.event("validation", "completed", "source-complete", {
        completed: captures.length,
        total: captures.length,
      });

      const items = captures.map((capture) => ({
        provider: "maicoin",
        product: "investment",
        itemKey: capture.captureId,
        command: {
          kind: PGLITE_CANONICAL_INVESTMENT_COMMIT_COMMAND,
          request: { capture },
        },
        relationCommands: () => [{
          kind: PGLITE_CANONICAL_INVESTMENT_RELATIONS_RESOLVE_COMMAND,
          request: {
            sourceConnectionKey: capture.identity.sourceConnectionKey,
            observedAt: capture.observedAt,
          },
        }],
      }));

      context.signal.throwIfAborted();
      stage = "commit";
      let commit;
      try {
        commit = await context.financialCommit.execute(items, {
          provider: "maicoin",
          product: "investment",
          signal: context.signal,
        });
      } catch (error) {
        // Only the commit port knows a request may have landed (ADR 0056).
        if (error instanceof CommitOutcomeUnknownError) throw safeError("commit-outcome-unknown", error);
        if (context.signal.aborted) throw cancellationError();
        // The commit's start could not be recorded, so nothing was committed.
        throw safeError("operational-persistence-failed", error);
      }
      if (commit.status !== "completed") {
        throw safeError(commit.status === "cancelled"
          ? "canonical-commit-cancelled"
          : "canonical-commit-failed");
      }

      stage = "operational";
      for (const chunk of snapshotChunks)
        await persistence.appendSnapshots(chunk);
      for (const chunk of statementChunks)
        await persistence.appendStatementRows(chunk);

      const statementRows = source.statementBatches.reduce(
        (count, batch) => count + batch.rows.length,
        0,
      );
      const summary = {
        status: "completed",
        syncRunId,
        capturedAt: source.capturedAt,
        walletTypes: source.walletTypes,
        canonicalInvestmentCaptures: commit.committedCount,
        accountSnapshots: source.snapshots.length,
        statementMode: "full",
        statementRows,
      } as const;
      await persistence.finishRun({
        syncRunId,
        finishedAt: context.now(),
        record: summary,
      });
      runFinished = true;
      await context.event("finalization", "completed", "operational-records-persisted", {
        completed: source.snapshots.length + statementRows,
        total: source.snapshots.length + statementRows,
      });
      return summary;
    } catch (error) {
      const cancelled = context.signal.aborted
        || (error instanceof Error && error.message === "Automation task cancelled.");
      const code = cancelled
        ? "cancelled"
        : error instanceof MaicoinWorkflowError
          ? error.code
          : stage === "preparation"
            ? "operational-persistence-failed"
            : stage === "collection" || stage === "validation"
              ? "source-rejected"
              : stage === "commit"
                ? "canonical-commit-failed"
                : "operational-persistence-failed";
      if (runStarted && !runFinished) {
        await persistence.finishRun({
          syncRunId,
          finishedAt: context.now(),
          record: {
            status: cancelled ? "cancelled" : "failed",
            syncRunId,
            errorCode: code,
          },
        }).catch(() => undefined);
      }
      if (cancelled) throw cancellationError();
      throw error instanceof MaicoinWorkflowError ? error : safeError(code, error);
    }
  });
}
