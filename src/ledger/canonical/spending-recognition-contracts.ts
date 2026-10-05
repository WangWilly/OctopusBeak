export type ExactMoney = Readonly<{ coefficient: string; scale: number; currency: string }>;

export type SpendingPair = Readonly<{ invoiceId: string; transactionId: string }>;

export type SpendingDecisionOrigin =
  | Readonly<{ kind: "user"; userId: string }>
  | Readonly<{ kind: "source"; authorityRoute: string; stableCrossSourceReference: string }>;

export type SpendingDecisionInput = SpendingPair & Readonly<{
  decisionKey: string;
  origin: SpendingDecisionOrigin;
  evidenceKnowledgeSequence: number;
  evidence: Readonly<Record<string, unknown>>;
}>;

export type SpendingDirectUserConfirmationInput = Readonly<{
  invoiceIdentityId: string;
  transactionIdentityId: string;
  decisionKey: string;
  userId: string;
  evidenceKnowledgeSequence: number;
  evidence: Readonly<Record<string, unknown>>;
}>;

export type SpendingCandidateInput = SpendingPair & Readonly<{
  candidateKey: string;
  algorithm: string;
  algorithmVersion: string;
  similarityEvidence: Readonly<Record<string, unknown>>;
}>;

export type SpendingRefundRevisionInput = Readonly<{
  stableRefundKey: string;
  transactionId: string;
  sourceRevisionKey: string;
  revisionNumber: number;
  revisionKind: "asserted" | "revised" | "revoked";
  amount?: ExactMoney | null;
  occurrence?: Readonly<{
    value: string;
    precision: "date" | "minute" | "second";
    timeZone: string;
    basis: "source-occurrence" | "posting-date-fallback";
  }> | null;
  authorityRoute: string;
  provenanceReference: string;
  evidence: Readonly<Record<string, unknown>>;
}>;

export type SpendingDedupLinkView = SpendingPair & Readonly<{
  eventId: string;
  origin: "user" | "source";
  evidenceKnowledgeSequence: number;
  decisionCommitSequence: number;
  /** When the decision was recorded: its commit's recorded_at, as an ISO-8601 UTC instant. */
  decidedAt: string;
  evidence: Readonly<Record<string, unknown>>;
  userId: string | null;
  authorityRoute: string | null;
  stableCrossSourceReference: string | null;
}>;

export type SpendingCandidateView = SpendingPair & Readonly<{
  candidateId: string;
  algorithm: string;
  algorithmVersion: string;
  similarityEvidence: Readonly<Record<string, unknown>>;
  status: "candidate" | "confirmed" | "denied" | "revoked";
}>;

export type SpendingRefundView = Readonly<{
  refundId: string;
  stableRefundKey: string;
  transactionId: string;
  revisionId: string;
  sourceRevisionKey: string;
  revisionNumber: number;
  revisionKind: "asserted" | "revised" | "revoked";
  state: "active" | "revoked";
  amount: ExactMoney | null;
  occurrence: null | Readonly<{ value: string; precision: "date" | "minute" | "second"; timeZone: string; basis: "source-occurrence" | "posting-date-fallback" }>;
  authorityRoute: string;
  provenanceReference: string;
  evidence: Readonly<Record<string, unknown>>;
  commitSequence: number;
}>;

export type SpendingRecognitionSnapshot = Readonly<{
  knowledgeAt: number;
  candidates: readonly SpendingCandidateView[];
  activeLinks: readonly SpendingDedupLinkView[];
  denied: readonly SpendingPair[];
  refunds: readonly SpendingRefundView[];
}>;
