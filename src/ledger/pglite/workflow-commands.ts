/**
 * Serializable command names shared by workflow children and the worker.
 *
 * Keep this module free of store, renderer, and domain implementation imports:
 * a child workflow can load the command contract without loading a PGlite
 * writer or its transitive database dependencies.
 */
export const PGLITE_CANONICAL_FINANCIAL_COMMIT_COMMAND =
  "canonical.financial.commit" as const;
export const PGLITE_CANONICAL_FINANCIAL_COMMIT_BATCH_COMMAND =
  "canonical.financial.commit-batch" as const;
export const PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND =
  "canonical.balance.capture" as const;
export const PGLITE_CANONICAL_DEPOSIT_COMMIT_COMMAND =
  "canonical.deposit.commit" as const;
export const PGLITE_CANONICAL_EINVOICE_COMMIT_COMMAND =
  "canonical.einvoice.commit" as const;
export const PGLITE_CANONICAL_CREDIT_CARD_COMMIT_COMMAND =
  "canonical.credit-card.commit" as const;
export const PGLITE_CANONICAL_CREDIT_CARD_BALANCE_COMMAND =
  "canonical.credit-card.balance" as const;
export const PGLITE_CANONICAL_LOAN_COMMIT_COMMAND =
  "canonical.loan.commit" as const;
export const PGLITE_CANONICAL_INVESTMENT_COMMIT_COMMAND =
  "canonical.investment.commit" as const;
export const PGLITE_CANONICAL_MIXED_COMMIT_COMMAND =
  "canonical.mixed.commit" as const;
