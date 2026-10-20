import type {
  PGliteCanonicalBalanceCaptureRequest,
  PGliteCanonicalBalanceCommitResult,
} from "./balance.ts";
import type {
  PGliteCanonicalFinancialCommitBatchRequest,
  PGliteCanonicalFinancialCommitRequest,
  PGliteCanonicalFinancialCommitResult,
  PGliteCanonicalSourceAdmissionReceipt,
  PGliteCanonicalSourceAdmissionRequest,
} from "./canonical-source-store.ts";
import {
  PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND,
  PGLITE_CANONICAL_CREDIT_CARD_BALANCE_COMMAND,
  PGLITE_CANONICAL_CREDIT_CARD_COMMIT_COMMAND,
  PGLITE_CANONICAL_DEPOSIT_COMMIT_COMMAND,
  PGLITE_CANONICAL_EINVOICE_COMMIT_COMMAND,
  PGLITE_CANONICAL_FINANCIAL_COMMIT_BATCH_COMMAND,
  PGLITE_CANONICAL_FINANCIAL_COMMIT_COMMAND,
  PGLITE_CANONICAL_INVESTMENT_COMMIT_COMMAND,
  PGLITE_CANONICAL_INVESTMENT_RELATIONS_RESOLVE_COMMAND,
  PGLITE_CANONICAL_LOAN_COMMIT_COMMAND,
  PGLITE_CANONICAL_LOAN_RELATIONS_RESOLVE_COMMAND,
  PGLITE_CANONICAL_MIXED_COMMIT_COMMAND,
  PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND,
} from "./workflow-commands.ts";
import type {
  PGliteCanonicalCreditCardBalanceCaptureRequest,
  PGliteCanonicalCreditCardCaptureRequest,
  PGliteCanonicalCreditCardCommitResult,
} from "./credit-card.ts";
import type {
  PGliteCanonicalDepositCommitRequest,
  PGliteCanonicalDepositCommitResult,
} from "./deposit.ts";
import type {
  PGliteCanonicalEInvoiceCommitResult,
} from "./einvoice.ts";
import type {
  PGliteCanonicalInvestmentCommitRequest,
  PGliteCanonicalInvestmentCommitResult,
} from "./investment.ts";
import type {
  PGliteCanonicalLoanCommitRequest,
  PGliteCanonicalLoanCommitResult,
} from "./loan.ts";
import type {
  PGliteCanonicalLoanRelationResolutionRequest,
  PGliteCanonicalLoanRelationResolutionResult,
  PGliteCanonicalInvestmentRelationResolutionRequest,
  PGliteCanonicalInvestmentRelationResolutionResult,
} from "./relations.ts";
import type { CanonicalEInvoiceCaptureInput } from "../canonical/einvoice-contract.ts";
import type { PGliteCanonicalMixedCommitRequest, PGliteCanonicalMixedCommitResult } from "./mixed-commit.ts";

export {
  PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND,
  PGLITE_CANONICAL_CREDIT_CARD_BALANCE_COMMAND,
  PGLITE_CANONICAL_CREDIT_CARD_COMMIT_COMMAND,
  PGLITE_CANONICAL_DEPOSIT_COMMIT_COMMAND,
  PGLITE_CANONICAL_EINVOICE_COMMIT_COMMAND,
  PGLITE_CANONICAL_FINANCIAL_COMMIT_BATCH_COMMAND,
  PGLITE_CANONICAL_FINANCIAL_COMMIT_COMMAND,
  PGLITE_CANONICAL_INVESTMENT_COMMIT_COMMAND,
  PGLITE_CANONICAL_INVESTMENT_RELATIONS_RESOLVE_COMMAND,
  PGLITE_CANONICAL_LOAN_COMMIT_COMMAND,
  PGLITE_CANONICAL_LOAN_RELATIONS_RESOLVE_COMMAND,
  PGLITE_CANONICAL_MIXED_COMMIT_COMMAND,
  PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND,
};

/** Set only at the central activation boundary for a PGlite workflow run. */
export const PGLITE_WORKFLOW_REQUIRED_ENV =
  "OCTOPUSBEAK_PGLITE_WORKFLOW_REQUIRED" as const;

type CommandContract<Request, Result> = Readonly<{ request: Request; result: Result }>;

/** One entry per worker command: what a child sends and what the worker returns. */
type PGliteWorkflowCommandContracts = {
  [PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND]: CommandContract<PGliteCanonicalSourceAdmissionRequest, PGliteCanonicalSourceAdmissionReceipt>;
  [PGLITE_CANONICAL_FINANCIAL_COMMIT_COMMAND]: CommandContract<PGliteCanonicalFinancialCommitRequest, PGliteCanonicalFinancialCommitResult>;
  [PGLITE_CANONICAL_FINANCIAL_COMMIT_BATCH_COMMAND]: CommandContract<PGliteCanonicalFinancialCommitBatchRequest, readonly PGliteCanonicalFinancialCommitResult[]>;
  [PGLITE_CANONICAL_DEPOSIT_COMMIT_COMMAND]: CommandContract<PGliteCanonicalDepositCommitRequest, PGliteCanonicalDepositCommitResult>;
  [PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND]: CommandContract<PGliteCanonicalBalanceCaptureRequest, PGliteCanonicalBalanceCommitResult>;
  [PGLITE_CANONICAL_EINVOICE_COMMIT_COMMAND]: CommandContract<CanonicalEInvoiceCaptureInput, PGliteCanonicalEInvoiceCommitResult>;
  [PGLITE_CANONICAL_CREDIT_CARD_COMMIT_COMMAND]: CommandContract<PGliteCanonicalCreditCardCaptureRequest, PGliteCanonicalCreditCardCommitResult>;
  [PGLITE_CANONICAL_CREDIT_CARD_BALANCE_COMMAND]: CommandContract<PGliteCanonicalCreditCardBalanceCaptureRequest, PGliteCanonicalCreditCardCommitResult>;
  [PGLITE_CANONICAL_LOAN_COMMIT_COMMAND]: CommandContract<PGliteCanonicalLoanCommitRequest, PGliteCanonicalLoanCommitResult>;
  [PGLITE_CANONICAL_INVESTMENT_COMMIT_COMMAND]: CommandContract<PGliteCanonicalInvestmentCommitRequest, PGliteCanonicalInvestmentCommitResult>;
  [PGLITE_CANONICAL_MIXED_COMMIT_COMMAND]: CommandContract<PGliteCanonicalMixedCommitRequest, PGliteCanonicalMixedCommitResult>;
  [PGLITE_CANONICAL_LOAN_RELATIONS_RESOLVE_COMMAND]: CommandContract<PGliteCanonicalLoanRelationResolutionRequest, PGliteCanonicalLoanRelationResolutionResult>;
  [PGLITE_CANONICAL_INVESTMENT_RELATIONS_RESOLVE_COMMAND]: CommandContract<PGliteCanonicalInvestmentRelationResolutionRequest, PGliteCanonicalInvestmentRelationResolutionResult>;
};

export type PGliteWorkflowCommandKind = keyof PGliteWorkflowCommandContracts;

export type PGliteWorkflowCommand = {
  [Kind in PGliteWorkflowCommandKind]: Readonly<{
    kind: Kind;
    request: PGliteWorkflowCommandContracts[Kind]["request"];
  }>;
}[PGliteWorkflowCommandKind];

export type PGliteWorkflowCommandResult<
  Command extends PGliteWorkflowCommand,
> = PGliteWorkflowCommandContracts[Command["kind"]]["result"];

export type PGliteWorkflowRequestOptions = Readonly<{
  signal?: AbortSignal;
}>;

export type PGliteWorkflowFailureCategory =
  | "admission"
  | "stale"
  | "ineligible"
  | "conflict";

/** A relation warning remains item-local and never turns a committed item fatal. */
export type PGliteWorkflowRelationWarning = Readonly<{
  code: string;
  message: string;
}>;

export type PGliteWorkflowItemFailure = Readonly<{
  kind: "item";
  category: PGliteWorkflowFailureCategory;
  code: string;
  message: string;
}>;

export type PGliteWorkflowFatalFailure = Readonly<{
  kind: "fatal";
  code: string;
  message: string;
}>;

export type PGliteWorkflowFailure =
  | PGliteWorkflowItemFailure
  | PGliteWorkflowFatalFailure;

export type PGliteWorkflowTransportErrorCode =
  | "missing-endpoint"
  | "invalid-authentication"
  | "connection-failed"
  | "closed"
  | "command-unavailable";

/** Safe transport failures contain no socket, SQL, path, or payload text. */
export class PGliteWorkflowTransportError extends Error {
  readonly code: PGliteWorkflowTransportErrorCode;

  constructor(code: PGliteWorkflowTransportErrorCode) {
    super(
      code === "missing-endpoint"
        ? "PGlite workflow transport requires the parent worker endpoint."
        : code === "invalid-authentication"
          ? "PGlite workflow transport authentication failed."
          : code === "connection-failed"
            ? "PGlite workflow transport could not connect to the parent worker."
            : code === "command-unavailable"
              ? "PGlite workflow command is unavailable in this worker."
              : "PGlite workflow transport is closed.",
    );
    this.name = "PGliteWorkflowTransportError";
    this.code = code;
  }
}

export type PGliteWorkflowTransport = Readonly<{
  execute<Command extends PGliteWorkflowCommand>(
    command: Command,
    options?: PGliteWorkflowRequestOptions,
  ): Promise<PGliteWorkflowCommandResult<Command>>;
}>;

export type PGliteWorkflowClient = Readonly<{
  commit<Command extends PGliteWorkflowCommand>(
    command: Command,
    options?: PGliteWorkflowRequestOptions,
  ): Promise<PGliteWorkflowCommandResult<Command>>;
  commitBatch(
    command: Extract<PGliteWorkflowCommand, { kind: typeof PGLITE_CANONICAL_FINANCIAL_COMMIT_BATCH_COMMAND }>,
    options?: PGliteWorkflowRequestOptions,
  ): Promise<readonly PGliteCanonicalFinancialCommitResult[]>;
}>;

/** Build a workflow client around a named transport supplied by the owner. */
export function createPGliteWorkflowClient(
  transport: PGliteWorkflowTransport,
): PGliteWorkflowClient {
  return Object.freeze({
    commit: <Command extends PGliteWorkflowCommand>(
      command: Command,
      options?: PGliteWorkflowRequestOptions,
    ) => transport.execute(command, options),
    commitBatch: (
      command: Extract<PGliteWorkflowCommand, { kind: typeof PGLITE_CANONICAL_FINANCIAL_COMMIT_BATCH_COMMAND }>,
      options?: PGliteWorkflowRequestOptions,
    ) => transport.execute(command, options),
  });
}

export function pgliteWorkflowEnabled(
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  return environment[PGLITE_WORKFLOW_REQUIRED_ENV] === "1";
}

/** Enforce the explicit activation flag before a workflow selects this path. */
export function requirePGliteWorkflowEnabled(
  environment: Readonly<Record<string, string | undefined>>,
): void {
  if (!pgliteWorkflowEnabled(environment))
    throw new Error("PGlite workflow transport is not enabled for this run.");
}
