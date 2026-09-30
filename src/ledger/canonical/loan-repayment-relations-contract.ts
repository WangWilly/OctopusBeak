export type ExplicitLoanTransactionLink = Readonly<{
  fromCaptureId: string;
  fromSourceRecordKey: string;
  toCaptureId: string;
  toSourceRecordKey: string;
  relationId: string;
  contractVersion: string;
  evidenceSourceRecordKey?: string;
}>;

export type LoanRepaymentRelationResolutionResult = Readonly<{
  status: "canonical-live";
  outcome: "changed" | "unchanged" | "no-admission";
  resolutionId: string | null;
  exactRelationIds: readonly string[];
  settlementGroupIds: readonly string[];
  reason?: string;
}>;
