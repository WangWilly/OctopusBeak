/**
 * Sanitized provider-boundary examples for the Yuanta relation adapter.
 *
 * These values describe only the shape of evidence a live detail/mandate
 * page may explicitly provide.  The ordinary statement CSV does not contain
 * a counterparty account, so it must not be populated from its selected
 * account column, date, amount, or free-form note.
 */
export const YUANTA_RELATION_EVIDENCE_FIXTURES_V1 = {
  exactCounterpartyAccount: {
    rowOrdinal: 0,
    accountValue: " 9988-7766 ",
    role: "beneficiary",
    purpose: "loan_repayment",
    scope: "shared_collection",
    evidenceKind: "transaction-counterparty-account",
    sourceField: "provider-detail-counterparty-account",
    contractVersion: "yuanta/loan-repayment-account/v1",
  },
  maskedCounterpartyAccount: {
    rowOrdinal: 0,
    accountValue: "******7766",
    role: "beneficiary",
    purpose: "loan_repayment",
    scope: "shared_collection",
    evidenceKind: "transaction-counterparty-account",
    sourceField: "provider-detail-counterparty-account",
    contractVersion: "yuanta/loan-repayment-account/v1",
  },
} as const;
