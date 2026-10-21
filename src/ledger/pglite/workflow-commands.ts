/**
 * Serializable command names shared by workflow children and the worker. Each
 * name is also the worker's financial operation that executes it.
 *
 * Keep this module free of store, renderer, and domain implementation imports:
 * a child workflow can load the command contract without loading a PGlite
 * writer or its transitive database dependencies.
 */
export const PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND =
  "financial.source.admit" as const;
export const PGLITE_CANONICAL_FINANCIAL_COMMIT_COMMAND =
  "financial.source.commit" as const;
export const PGLITE_CANONICAL_FINANCIAL_COMMIT_BATCH_COMMAND =
  "financial.source.commitBatch" as const;
export const PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND =
  "financial.balance.capture" as const;
export const PGLITE_CANONICAL_DEPOSIT_COMMIT_COMMAND =
  "financial.deposit.commit" as const;
export const PGLITE_CANONICAL_EINVOICE_COMMIT_COMMAND =
  "financial.einvoice.commit" as const;
export const PGLITE_CANONICAL_CREDIT_CARD_COMMIT_COMMAND =
  "financial.creditCard.commit" as const;
export const PGLITE_CANONICAL_CREDIT_CARD_BALANCE_COMMAND =
  "financial.creditCard.balance" as const;
export const PGLITE_CANONICAL_LOAN_COMMIT_COMMAND =
  "financial.loan.commit" as const;
export const PGLITE_CANONICAL_INVESTMENT_COMMIT_COMMAND =
  "financial.investment.commit" as const;
export const PGLITE_CANONICAL_MIXED_COMMIT_COMMAND =
  "financial.mixed.commit" as const;
export const PGLITE_CANONICAL_LOAN_RELATIONS_RESOLVE_COMMAND =
  "financial.loanRelations.resolve" as const;
export const PGLITE_CANONICAL_INVESTMENT_RELATIONS_RESOLVE_COMMAND =
  "financial.investmentRelations.resolve" as const;
