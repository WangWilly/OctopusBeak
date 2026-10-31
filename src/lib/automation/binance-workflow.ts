import { buildBinanceInvestmentCaptures } from "../../ledger/canonical/binance-crypto-adapters.ts";
import {
  PGLITE_CANONICAL_INVESTMENT_COMMIT_COMMAND,
  PGLITE_CANONICAL_INVESTMENT_RELATIONS_RESOLVE_COMMAND,
} from "../../ledger/pglite/workflow-client.ts";
import {
  BinanceSourceError,
  collectBinanceSource,
  type BinanceCredentials,
  type BinanceFailureKind,
} from "../../ledger/sync-binance.ts";
import { BINANCE_COLLECTION_PERIODS, BINANCE_QUOTE_ASSETS } from "./server/sources/binance.ts";
import { CommitOutcomeUnknownError } from "./commit-attempt.ts";
import { defineWorkflow, type WorkflowDefinition } from "./workflow-executor.ts";
import { FailureCodeError, type TypedWorkflowErrorCode } from "./workflow-failures.ts";
import { workflowRunResult } from "./workflow-run-result.ts";

export type BinanceWorkflowInput = Readonly<{
  credentials: Readonly<{ binance_api_key: string; binance_api_secret: string }>;
}>;

/** ADR 0068: each way a Binance request fails, as the Failure code the person sees. */
const FAILURE_CODES: Readonly<Record<BinanceFailureKind, TypedWorkflowErrorCode>> = {
  credential: "authentication-failed",
  "region-blocked": "source-access-challenged",
  unavailable: "source-unavailable",
  "invalid-response": "source-validation-failed",
  rejected: "source-collection-failed",
};

function credentialsFrom(input: BinanceWorkflowInput): BinanceCredentials {
  const apiKey = input?.credentials?.binance_api_key?.trim() ?? "";
  const apiSecret = input?.credentials?.binance_api_secret?.trim() ?? "";
  if (apiKey === "" || apiSecret === "")
    throw new FailureCodeError("authentication-failed", "Binance API key and secret are required.");
  return { apiKey, apiSecret };
}

export function createBinanceWorkflow(): WorkflowDefinition<BinanceWorkflowInput> {
  return defineWorkflow({
    id: "sync-binance",
    requiresFinancialCommit: true,
  }, async (context, input: BinanceWorkflowInput) => {
    const credentials = credentialsFrom(input);
    await context.event("authentication", "advanced", "authenticating");
    await context.event("collection", "advanced", "collecting-wallets");
    let source;
    try {
      source = await collectBinanceSource(credentials, {
        quoteAssets: BINANCE_QUOTE_ASSETS,
        periods: BINANCE_COLLECTION_PERIODS,
        now: context.now,
        signal: context.signal,
        onWalletsCollected: (count) => context.event("collection", "advanced", "wallets-collected", { completed: count, total: count }),
        onHistoryCollected: (count) => context.event("collection", "completed", "statements-collected", { completed: count, total: count }),
      });
    } catch (error) {
      context.signal.throwIfAborted();
      if (error instanceof BinanceSourceError) throw new FailureCodeError(FAILURE_CODES[error.kind], error.message);
      throw error;
    }

    let captures;
    try {
      captures = buildBinanceInvestmentCaptures({ captureId: context.runId, ...source });
    } catch (error) {
      await context.event("validation", "failed", "source-rejected");
      throw new FailureCodeError("source-validation-failed", error instanceof Error ? error.message : undefined);
    }
    await context.event("validation", "completed", "source-complete", { completed: captures.length, total: captures.length });

    context.signal.throwIfAborted();
    let commit;
    try {
      commit = await context.financialCommit.execute(captures.map((capture) => ({
        provider: "binance",
        product: "investment",
        itemKey: capture.captureId,
        command: { kind: PGLITE_CANONICAL_INVESTMENT_COMMIT_COMMAND, request: { capture } },
        relationCommands: () => [{
          kind: PGLITE_CANONICAL_INVESTMENT_RELATIONS_RESOLVE_COMMAND,
          request: { sourceConnectionKey: capture.identity.sourceConnectionKey, observedAt: capture.observedAt },
        }],
      })), { provider: "binance", product: "investment", signal: context.signal });
    } catch (error) {
      // Only the commit port knows a request may have landed (ADR 0056).
      if (error instanceof CommitOutcomeUnknownError) throw new FailureCodeError("commit-outcome-unknown", error.message);
      context.signal.throwIfAborted();
      throw new FailureCodeError("canonical-commit-failed", error instanceof Error ? error.message : undefined);
    }
    if (commit.status !== "completed")
      throw new FailureCodeError(commit.status === "cancelled" ? "cancelled" : "canonical-commit-failed");

    const historyRows = source.trades.length + source.fundMovements.length + source.transfers.length;
    await context.event("finalization", "completed", "canonical-records-committed", {
      completed: commit.committedCount,
      total: captures.length,
    });
    return workflowRunResult({
      status: "completed",
      counts: {
        canonicalCaptureCount: commit.committedCount,
        accountCount: source.wallets.length,
        statementRowCount: historyRows,
      },
    });
  });
}
