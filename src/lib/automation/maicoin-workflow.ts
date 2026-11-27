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
  type MaxCredentials,
} from "../../ledger/sync-maicoin.ts";
import { defineWorkflow, type WorkflowDefinition } from "./workflow-executor.ts";
import { workflowRunResult } from "./workflow-run-result.ts";
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
  }, async (context, input: MaicoinWorkflowInput) => {
    const credentials = validatedCredentials(input);
    const syncRunId = context.runId;
    let stage: "collection" | "validation" | "commit" = "collection";

    try {
      context.signal.throwIfAborted();
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
        // A failed price lookup lands here too, so nothing is written and the next run retries (ADR 0158).
        await context.event("validation", "failed", "source-rejected");
        throw safeError("source-rejected", error);
      }

      stage = "validation";
      let captures;
      try {
        captures = buildMaicoinInvestmentCaptures({
          captureId: syncRunId,
          providerEmail: source.providerEmail,
          subAccount: credentials.subAccount,
          accountBatches: source.accountBatches,
          statementBatches: source.statementBatches,
          valuationQuotes: source.valuationQuotes,
          statementValuations: source.statementValuations,
        });
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

      const accountCount = source.accountBatches.reduce((count, batch) => count + batch.accounts.length, 0);
      const statementRows = source.statementBatches.reduce(
        (count, batch) => count + batch.rows.length,
        0,
      );
      await context.event("finalization", "completed", "canonical-records-committed", {
        completed: commit.committedCount,
        total: captures.length,
      });
      return workflowRunResult({
        status: "completed",
        counts: {
          canonicalCaptureCount: commit.committedCount,
          accountCount,
          statementRowCount: statementRows,
        },
      });
    } catch (error) {
      const cancelled = context.signal.aborted
        || (error instanceof Error && error.message === "Automation task cancelled.");
      if (cancelled) throw cancellationError();
      if (error instanceof MaicoinWorkflowError) throw error;
      throw safeError(stage === "commit" ? "canonical-commit-failed" : "source-rejected", error);
    }
  });
}
