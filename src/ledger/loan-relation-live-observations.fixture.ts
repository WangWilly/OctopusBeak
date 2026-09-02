/**
 * Sanitized field-shape observations from solver-assisted live pages. These
 * records prove only which semantic columns were present and the aggregate
 * result of a non-admissible amount/date coincidence diagnostic. They are not
 * financial records and do not admit canonical transaction relations.
 */
export const LOAN_RELATION_LIVE_FIELD_OBSERVATIONS_V1 = Object.freeze({
  schemaVersion: "loan-relation-live-field-observations/v1",
  evidenceId: "sha256:loan-relation-live-field-observations-20260901",
  verifiedOn: "2026-09-01",
  validationMethod: "solver-assisted-electron-cdp",
  financialValuesRetained: false,
  authenticationSecretsRetained: false,
  rawSourcePayloadRetained: false,
  sources: Object.freeze({
    fubon: Object.freeze({
      observedFieldRoles: Object.freeze([
        "transaction-date",
        "transaction-content",
        "amount-change",
        "interest-rate",
        "interest-period",
        "balance",
        "remark",
      ]),
      transferReferenceField: "absent",
      counterpartyAccountField: "absent",
      amountDateDiagnostic: Object.freeze({
        paymentGroupCount: 6,
        uniqueCoincidenceCount: 6,
        ambiguousCoincidenceCount: 0,
        unmatchedGroupCount: 0,
      }),
    }),
    yuanta: Object.freeze({
      observedFieldRoles: Object.freeze([
        "loan-account",
        "transaction-date",
        "accounting-date",
        "payment-item",
        "interest-period",
        "amount",
        "balance-after",
        "overpayment",
      ]),
      transferReferenceField: "absent",
      counterpartyAccountField: "absent",
      amountDateDiagnostic: Object.freeze({
        paymentGroupCount: 24,
        uniqueCoincidenceCount: 0,
        ambiguousCoincidenceCount: 0,
        unmatchedGroupCount: 24,
      }),
    }),
  }),
} as const);

/**
 * Sanitized acceptance evidence for the versioned Yuanta account-linkage
 * contract. Counts describe the canonical projection after a complete live
 * recollection; account values and financial values are intentionally absent.
 */
export const YUANTA_LOAN_RELATION_LIVE_ACCEPTANCE_V1 = Object.freeze({
  schemaVersion: "yuanta-loan-relation-live-acceptance/v1",
  evidenceId: "sha256:yuanta-loan-relation-live-acceptance-20260902",
  verifiedOn: "2026-09-02",
  validationMethod: "solver-assisted-electron-cdp",
  financialValuesRetained: false,
  authenticationSecretsRetained: false,
  accountValuesRetained: false,
  sourceConnectionCount: 1,
  providerContract: Object.freeze({
    mandateSurface: "loan-statement-account-selector",
    mandateAccountShape: "one-exact-14-digit-value-matching-visible-label",
    transactionSurface: "domestic-deposit-csv-note",
    transactionAccountShape: "entire-note-is-00-plus-14-digits",
    comparisonNormalization: "remove-leading-00-from-exact-16-digit-note",
  }),
  canonicalEvidence: Object.freeze({
    boundedRepaymentMandateCount: 2,
    transactionCounterpartyAccountCount: 7,
    normalizedAccountDigestCount: 2,
    sourceAccountLengths: Object.freeze([14, 16]),
    normalizedAccountLengths: Object.freeze([14]),
  }),
  resolution: Object.freeze({
    outcome: "changed",
    currentSettlementGroupCount: 7,
    matchedDepositOutflowCount: 7,
    coveredLoanTransactionCount: 73,
    exactPairGroupCount: 5,
    collectiveAccountGroupCount: 2,
  }),
} as const);
