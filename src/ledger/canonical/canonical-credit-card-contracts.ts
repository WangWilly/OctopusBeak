export type CanonicalCreditCardAmount = Readonly<{
  coefficient: string;
  scale: number;
}>;

export type CanonicalCreditCardPersistenceCapture = Readonly<{
  integrationNamespace: string;
  captureId: string;
  identity: Readonly<{
    accountNaturalKey: string;
    identityMethod: string;
  }>;
  instruments: readonly Readonly<{
    instrumentKey: string;
    cardMask?: string;
    role: string;
    lifecycle?: string;
    evidence: Readonly<{ sourceRecordKey: string }>;
  }>[];
  transactions: readonly Readonly<{
    sourceRecordKey: string;
    sourceKey: string;
    instrumentKey: string;
    billingStatus: "billed" | "unbilled";
    consumeDate?: string | null;
    postingDate?: string | null;
    effectiveDateBasis?: "consume-date" | "posting-date-fallback";
    statementKey?: string;
  }>[];
  statements: readonly Readonly<{
    statementKey: string;
    revisionKey: string;
    cycleStart: string;
    cycleEnd: string;
    issueDate: string;
    dueDate: string;
    currency: string;
    balance: CanonicalCreditCardAmount;
    minimumPayment: CanonicalCreditCardAmount | null;
    transactionSourceKeys: readonly string[];
    evidence: Readonly<{ sourceRecordKey: string; settled: true }>;
  }>[];
  relations?: readonly Readonly<{
    kind: string;
    fromSourceRecordKey: string;
    toSourceRecordKey: string;
    evidence: Readonly<{ sourceRecordKey: string }>;
  }>[];
}>;
