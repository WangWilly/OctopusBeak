import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  CANONICAL_SOURCE_SCHEMA_VERSION,
  createCanonicalSourceStore,
  validateCanonicalSourceStore,
} from "./canonical-source-store.ts";
import {
  LOAN_CONTRACT_FIXTURES,
  admitCanonicalLoanCapture,
  commitCanonicalLoanCapture,
  queryCanonicalLoanCurrent,
  queryCanonicalLoanHistorical,
  queryCanonicalLoanLineage,
  type LoanCaptureInput,
  type LoanTransactionInput,
} from "./loan-financial.ts";
import {
  admitCanonicalFinancialDepositCapture,
  commitCanonicalFinancialDepositCapture,
  type CanonicalFinancialDepositCapture,
  type CanonicalFinancialDepositRecord,
} from "./canonical-financial-deposit-writer.ts";
import {
  admitCounterpartyAccountEvidence,
  counterpartyAccountDigest,
  INSTITUTION_REPAYMENT_NOTE_EVIDENCE_VERSION,
  normalizeInstitutionGeneratedRepaymentNote,
  normalizeCounterpartyAccountValue,
  persistCounterpartyAccountEvidence,
  persistInstitutionGeneratedRepaymentNoteEvidence,
  queryCounterpartyAccountEvidence,
  queryInstitutionGeneratedRepaymentNoteEvidence,
  queryCurrentLoanRepaymentRelations,
  queryCurrentLoanRepaymentSettlementGroups,
  resolveLoanRepaymentRelations,
  YUANTA_LOAN_ACCOUNT_NOTE_NORMALIZATION_CONTRACT_VERSION,
} from "./loan-repayment-relations.ts";

test("admits only the live-verified Yuanta 00-plus-14 loan-account alias", () => {
  const admitted = admitCounterpartyAccountEvidence(
    {
      captureId: "capture",
      sourceRecordKey: "record",
      sourceConnectionKey: "connection",
      identityEpochKey: "epoch",
      accountValue: "0012345678901234",
      normalizedAccountValue: "12345678901234",
      role: "beneficiary",
      purpose: "loan_repayment",
      scope: "loan_contract",
      evidenceKind: "transaction-counterparty-account",
      sourceField: "備註",
      contractVersion:
        YUANTA_LOAN_ACCOUNT_NOTE_NORMALIZATION_CONTRACT_VERSION,
    },
    "yuanta",
  );
  assert.equal(admitted.sourceValue, "0012345678901234");
  assert.equal(admitted.normalizedAccountValue, "12345678901234");
  assert.equal(
    admitted.accountDigest,
    counterpartyAccountDigest("yuanta", "12345678901234"),
  );

  for (const invalid of [
    { accountValue: "001234567890123", normalizedAccountValue: "1234567890123" },
    { accountValue: "9912345678901234", normalizedAccountValue: "12345678901234" },
    { accountValue: "00******901234", normalizedAccountValue: "12345678901234" },
  ]) {
    assert.throws(
      () =>
        admitCounterpartyAccountEvidence(
          {
            captureId: "capture",
            sourceRecordKey: "record",
            sourceConnectionKey: "connection",
            identityEpochKey: "epoch",
            ...invalid,
            role: "beneficiary",
            purpose: "loan_repayment",
            scope: "loan_contract",
            evidenceKind: "transaction-counterparty-account",
            sourceField: "備註",
            contractVersion:
              YUANTA_LOAN_ACCOUNT_NOTE_NORMALIZATION_CONTRACT_VERSION,
          },
          "yuanta",
        ),
      /normalization|masked/iu,
    );
  }
});

const token = (label: string): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(`relation-check:${label}`).digest("base64url")}`;

function loanCapture(
  sourceConnectionKey: string,
  identityEpochKey: string,
  captureLabel: string,
  paymentCount = 1,
  options: {
    effectiveOn?: string;
    effectiveOns?: readonly string[];
    amounts?: readonly LoanTransactionInput["amount"][];
    eventKinds?: readonly ("payment" | "interest")[];
    observedAt?: string;
  } = {},
): ReturnType<typeof admitCanonicalLoanCapture> {
  const input = structuredClone(LOAN_CONTRACT_FIXTURES.fubon) as LoanCaptureInput;
  const paymentTemplate = input.records.find(
    (record) => record.eventKind === "payment",
  )!;
  const records: LoanTransactionInput[] = Array.from(
    { length: paymentCount },
    (_, index) => {
      const eventKind = options.eventKinds?.[index] ?? "payment";
      const record = structuredClone(paymentTemplate);
      const sourceRecordKey = token(`${captureLabel}:${eventKind}:${index}`);
      record.sourceRecordKey = sourceRecordKey;
      record.eventKind = eventKind;
      record.occurrenceIndex = index + 1;
      record.effectiveOn = options.effectiveOns?.[index] ?? options.effectiveOn ?? "2026-01-15";
      if (options.amounts?.[index] !== undefined)
        record.amount = options.amounts[index]!;
      record.eventEvidence = {
        ...record.eventEvidence,
        sourceRecordKey,
        sourceCode:
          eventKind === "interest" ? "LOAN-INTEREST" : "LOAN-PAYMENT",
      };
      record.balanceSourceEvidence = undefined;
      record.description = `relation check loan payment ${index}`;
      return record;
    },
  );
  input.captureId = token(`${captureLabel}:capture`);
  input.identity.sourceConnectionKey = sourceConnectionKey;
  input.identity.identityEpochKey = identityEpochKey;
  input.identity.accountKey = token(`${captureLabel}:account-key`);
  input.identity.accountNo = token(`${captureLabel}:account-no`);
  input.identity.subjectDigest = token(`${captureLabel}:subject`);
  input.observedAt = options.observedAt ?? "2026-02-01T00:00:00.000Z";
  input.scope.startDate = "2025-01-01";
  input.scope.endDate = "2026-12-31";
  input.scope.pageCount = 1;
  input.pages = [{ ...input.pages[0]!, rowCount: paymentCount }];
  input.records = records;
  input.counterpartTransactions = [];
  input.relations = [];
  input.relationCoverage = "not-asserted";
  input.balanceObservations = [];
  return admitCanonicalLoanCapture(input);
}

function depositCapture(
  sourceConnectionKey: string,
  identityEpochKey: string,
  captureLabel: string,
  transactionCount = 1,
  options: {
    effectiveOn?: string;
    effectiveOns?: readonly string[];
    amounts?: readonly CanonicalFinancialDepositRecord["amount"][];
    observedAt?: string;
    currency?: string;
  } = {},
): ReturnType<typeof admitCanonicalFinancialDepositCapture> {
  const route = "fubon/domestic-deposit/human-attested-v1";
  const records: CanonicalFinancialDepositRecord[] = Array.from({ length: transactionCount }, (_, index) => {
    const sourceDate = options.effectiveOns?.[index] ?? options.effectiveOn ?? "2026-01-15";
    const sourceTime = "09:10:11";
    const occurrenceKey = token(`${captureLabel}:outflow:${index}`);
    return {
      occurrenceKey,
      collisionKey: token(`${captureLabel}:collision:${index}`),
      providerKey: token(`${captureLabel}:provider:${index}`),
      contentHash: token(`${captureLabel}:content:${index}`),
      sequenceLexeme: String(index + 1),
      compactJson: JSON.stringify({ occurrenceKey, index }),
      amount: options.amounts?.[index] ?? { coefficient: "12500", scale: 2 },
      balanceAfter: { coefficient: "100000", scale: 2 },
      currency: options.currency ?? "TWD",
      direction: "outflow",
      sourceTime: {
        localDate: sourceDate,
        localTime: sourceTime,
        timeZone: "Asia/Taipei",
        epochMilliseconds: Date.parse(`${sourceDate}T${sourceTime}+08:00`),
        precision: "second",
        timeOrigin: "source_reported",
      },
      effectiveOn: sourceDate,
      transactionDateTimeLocal: `${sourceDate}T${sourceTime}`,
      description: `relation check deposit outflow ${index}`,
    };
  });
  return admitCanonicalFinancialDepositCapture({
    captureId: token(`${captureLabel}:capture`),
    authorityRoute: route,
    contractVersion: route,
    identity: {
      integrationNamespace: "fubon",
      sourceConnectionKey,
      identityEpochKey,
      stream: "domestic-deposit",
      recordKind: "fubon-domestic-deposit",
      subjectDigest: token(`${captureLabel}:subject`),
      accountNo: token(`${captureLabel}:account-no`),
      accountType: "depository",
      currency: options.currency ?? "TWD",
    },
    observedAt: options.observedAt ?? "2026-02-01T00:00:00.000Z",
    scope: {
      startDate: "2025-01-01",
      endDate: "2026-12-31",
      scopeKind: "bounded-range",
      completeness: "complete-range",
      completenessBasis: "relation-check-complete-range",
      completenessRuleVersion: route,
      absenceAuthority: null,
      contractFingerprint: token(`${captureLabel}:contract`),
      preflightFingerprint: token(`${captureLabel}:preflight`),
      pageCount: 1,
      withdrawalPolicy: "never-infer",
    },
    semantics: {
      postingStatus: "posted",
      postingOrigin: "human-attested",
      postingBasis: "statement-posted-history",
      postingRuleVersion: route,
      economicStatus: "normal",
      administrativeState: "active",
      semanticRuleVersion: route,
      effectiveTimeBasis: "transaction-time",
      effectiveTimeRuleVersion: route,
      timeZone: "Asia/Taipei",
      timePrecision: "second",
      timeOrigin: "source_reported",
      requireBalance: true,
    },
    pages: [
      {
        pageOrdinal: 0,
        responseCode: "200",
        terminal: true,
        rowCount: transactionCount,
        responseDigest: token(`${captureLabel}:page`),
        proofKind: "relation-check-complete-range",
        contractFingerprint: token(`${captureLabel}:contract`),
        preflightFingerprint: token(`${captureLabel}:preflight`),
        metadataJson: "{}",
      },
    ],
    records,
  });
}

async function commitPair(
  sourceConnectionKey: string,
  depositEpoch: string,
  label: string,
  paymentCount = 1,
  options: {
    loanEffectiveOn?: string;
    loanEffectiveOns?: readonly string[];
    loanAmounts?: readonly LoanTransactionInput["amount"][];
    depositEffectiveOn?: string;
    depositEffectiveOns?: readonly string[];
    depositAmounts?: readonly CanonicalFinancialDepositRecord["amount"][];
    loanObservedAt?: string;
    depositObservedAt?: string;
    depositCurrency?: string;
  } = {},
): Promise<{
  store: ReturnType<typeof createCanonicalSourceStore>;
  loan: ReturnType<typeof loanCapture>;
  deposit: ReturnType<typeof depositCapture>;
}> {
  const directory = await mkdtemp(join(tmpdir(), `loan-relation-${label}-`));
  const store = createCanonicalSourceStore(join(directory, "canonical.sqlite"));
  const loan = loanCapture(
    sourceConnectionKey,
    token(`${label}:loan-epoch`),
    `${label}:loan`,
    paymentCount,
    {
      effectiveOn: options.loanEffectiveOn,
      effectiveOns: options.loanEffectiveOns,
      amounts: options.loanAmounts,
      observedAt: options.loanObservedAt,
    },
  );
  const deposit = depositCapture(
    sourceConnectionKey,
    depositEpoch,
    `${label}:deposit`,
    paymentCount,
    {
      effectiveOn: options.depositEffectiveOn,
      effectiveOns: options.depositEffectiveOns,
      amounts: options.depositAmounts,
      observedAt: options.depositObservedAt,
      currency: options.depositCurrency,
    },
  );
  await commitCanonicalLoanCapture(store, loan);
  await commitCanonicalFinancialDepositCapture(store, deposit);
  return { store, loan, deposit };
}

function evidenceInput(
  captureId: string,
  sourceRecordKey: string,
  sourceConnectionKey: string,
  identityEpochKey: string,
  accountValue: string,
  role: "originator" | "beneficiary" = "beneficiary",
  options: {
    evidenceKind?: "transaction-counterparty-account" | "repayment-mandate";
    effectiveStartDate?: string | null;
    effectiveEndDate?: string | null;
  } = {},
) {
  return {
    captureId,
    sourceRecordKey,
    sourceConnectionKey,
    identityEpochKey,
    accountValue,
    role,
    purpose: "loan_repayment",
    scope: "shared_collection" as const,
    evidenceKind: options.evidenceKind ?? "transaction-counterparty-account",
    sourceField: "counterparty-account",
    contractVersion: "fubon/loan-repayment-account/v1",
    effectiveStartDate: options.effectiveStartDate,
    effectiveEndDate: options.effectiveEndDate,
  };
}

function institutionNoteInput(
  captureId: string,
  sourceRecordKey: string,
  sourceConnectionKey: string,
  identityEpochKey: string,
  overrides: {
    noteValue?: string;
    fixedValue?: string;
    generatedBy?: "institution";
    liveVerified?: true;
    dateField?: "transaction-date";
    contractVersion?: string;
    patternId?: string;
    dateContractVersion?: string;
    allowedSignedDayOffsets?: readonly number[];
  } = {},
) {
  const fixedValue = overrides.fixedValue ?? "LOAN PAYMENT";
  const dateContractVersion =
    overrides.dateContractVersion ?? "fubon/domestic-deposit-date/v1";
  return {
    captureId,
    sourceRecordKey,
    sourceConnectionKey,
    identityEpochKey,
    noteValue: overrides.noteValue ?? fixedValue,
    contract: {
      evidenceVersion: INSTITUTION_REPAYMENT_NOTE_EVIDENCE_VERSION,
      integrationNamespace: "fubon",
      contractVersion: overrides.contractVersion ?? "fubon/repayment-note/v1",
      patternId: overrides.patternId ?? "fubon-loan-payment-note",
      fixedValue,
      generatedBy: overrides.generatedBy ?? "institution",
      liveVerified: overrides.liveVerified ?? true,
      dateContractVersion,
      dateField: overrides.dateField ?? "transaction-date",
      dateContract: {
        version: dateContractVersion,
        comparison: "signed-calendar-day-offset" as const,
        allowedSignedDayOffsets: overrides.allowedSignedDayOffsets ?? [0],
      },
    },
    sourceField: "institution-note",
  };
}

test("v9 loan relation schema migrates transactionally and survives reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "loan-relation-migration-"));
  const path = join(directory, "canonical.sqlite");
  try {
    const initial = createCanonicalSourceStore(path);
    initial.close();
    const downgraded = new DatabaseSync(path);
    downgraded.exec("PRAGMA foreign_keys = OFF");
    downgraded.exec("DROP VIEW counterparty_account_evidence");
    for (const table of [
      "institution_repayment_note_evidence_support",
      "institution_repayment_note_evidence",
      "current_loan_repayment_settlement_groups",
      "loan_repayment_relation_events",
      "loan_repayment_settlement_group_members",
      "loan_repayment_settlement_groups",
      "loan_repayment_resolution_runs",
      "counterparty_account_evidence_support",
      "transaction_counterparty_account_evidence",
    ]) downgraded.exec(`DROP TABLE ${table}`);
    downgraded.exec(`
      DELETE FROM canonical_contract_purge_commits;
      DELETE FROM canonical_contract_purges;
      DELETE FROM schema_migrations WHERE version > 9;
      PRAGMA user_version = 9;
    `);
    downgraded.close();

    const reopened = createCanonicalSourceStore(path);
    assert.equal(
      (reopened.db.prepare("PRAGMA user_version").get() as { user_version?: number })
        .user_version,
      CANONICAL_SOURCE_SCHEMA_VERSION,
    );
    validateCanonicalSourceStore(reopened);
    assert.equal(
      (
        reopened.db
          .prepare("SELECT type FROM sqlite_master WHERE name = 'counterparty_account_evidence'")
          .get() as { type?: string }
      ).type,
      "view",
    );
    assert.equal(
      (
        reopened.db
          .prepare("SELECT type FROM sqlite_master WHERE name = 'institution_repayment_note_evidence'")
          .get() as { type?: string }
      ).type,
      "table",
    );
    assert.ok(
      (
        reopened.db
          .prepare("PRAGMA table_info(institution_repayment_note_evidence)")
          .all() as Array<{ name?: string }>
      ).some((column) => column.name === "date_contract_json"),
    );
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("counterparty account evidence stores exact source, normalized value, digest and lineage", async () => {
  const sourceConnectionKey = token("evidence-connection");
  const pair = await commitPair(sourceConnectionKey, token("evidence-deposit-epoch"), "evidence");
  try {
    const record = pair.deposit.records[0]!;
    const persisted = await persistCounterpartyAccountEvidence(
      pair.store,
      evidenceInput(
        pair.deposit.captureId,
        record.occurrenceKey,
        sourceConnectionKey,
        pair.deposit.identity.identityEpochKey,
        "  1234-5678  ",
      ),
    );
    assert.equal(persisted.sourceValue, "  1234-5678  ");
    assert.equal(persisted.normalizedValue, "12345678");
    assert.equal(
      persisted.valueDigest,
      counterpartyAccountDigest("fubon", normalizeCounterpartyAccountValue("1234-5678")),
    );
    assert.equal(queryCounterpartyAccountEvidence(pair.store).length, 1);
    assert.equal(
      (
        pair.store.db
          .prepare("SELECT COUNT(*) AS count FROM counterparty_account_evidence_support")
          .get() as { count?: number }
      ).count,
      1,
    );
    await assert.rejects(
      () =>
        persistCounterpartyAccountEvidence(
          pair.store,
          evidenceInput(
            pair.deposit.captureId,
            record.occurrenceKey,
            sourceConnectionKey,
            pair.deposit.identity.identityEpochKey,
            "******78",
          ),
        ),
      /masked/i,
    );
  } finally {
    const directory = pair.store.databasePath.slice(0, pair.store.databasePath.lastIndexOf("/"));
    pair.store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("replayed source observations retain transaction-scoped account evidence", async () => {
  const sourceConnectionKey = token("replay-evidence-connection");
  const pair = await commitPair(
    sourceConnectionKey,
    token("replay-evidence-deposit-epoch"),
    "replay-evidence",
  );
  try {
    const replay = admitCanonicalFinancialDepositCapture({
      ...pair.deposit,
      captureId: token("replay-evidence:second-capture"),
      observedAt: "2026-02-02T00:00:00.000Z",
    });
    await commitCanonicalFinancialDepositCapture(pair.store, replay);
    const record = replay.records[0]!;
    const persisted = await persistCounterpartyAccountEvidence(
      pair.store,
      evidenceInput(
        replay.captureId,
        record.occurrenceKey,
        sourceConnectionKey,
        replay.identity.identityEpochKey,
        "12345678901234",
      ),
    );
    assert.notEqual(persisted.transactionId, null);
    assert.equal(persisted.accountId, null);
    assert.equal(persisted.captureId, replay.captureId);
  } finally {
    const directory = pair.store.databasePath.slice(
      0,
      pair.store.databasePath.lastIndexOf("/"),
    );
    pair.store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("resolver admits direct exact transfer counterpart across independent captures and is idempotent", async () => {
  const sourceConnectionKey = token("exact-connection");
  const pair = await commitPair(sourceConnectionKey, token("exact-deposit-epoch"), "exact");
  try {
    const depositRecord = pair.deposit.records[0]!;
    const loanRecord = pair.loan.records[0]!;
    const relationId = token("explicit-relation");
    const inputKnowledge = Number(
      (
        pair.store.db
          .prepare(
            "SELECT MAX(commit_sequence) AS value FROM canonical_commits",
          )
          .get() as { value?: number }
      ).value,
    );
    const first = await resolveLoanRepaymentRelations(pair.store, {
      sourceConnectionKey,
      integrationNamespace: "fubon",
      explicitLinks: [
        {
          fromCaptureId: pair.deposit.captureId,
          fromSourceRecordKey: depositRecord.occurrenceKey,
          toCaptureId: pair.loan.captureId,
          toSourceRecordKey: loanRecord.sourceRecordKey,
          relationId,
          contractVersion: "fubon/loan-repayment-link/v1",
          evidenceSourceRecordKey: depositRecord.occurrenceKey,
        },
      ],
    });
    assert.equal(first.outcome, "changed");
    assert.equal(first.exactRelationIds.length, 1);
    assert.ok(first.resolutionId);
    assert.equal(queryCurrentLoanRepaymentRelations(pair.store).length, 1);
    const resolutionCommit = pair.store.db
      .prepare(
        `SELECT canonical_commit.commit_sequence,
                canonical_commit.commit_kind,
                canonical_commit.authority_route
           FROM loan_repayment_resolution_runs run
           JOIN canonical_commits canonical_commit
             ON canonical_commit.commit_id = run.commit_id
          WHERE run.resolution_id = ?`,
      )
      .get(Buffer.from(first.resolutionId.replaceAll("-", ""), "hex")) as {
      commit_sequence?: number;
      commit_kind?: string;
      authority_route?: string;
    };
    assert.equal(resolutionCommit.commit_sequence, inputKnowledge + 1);
    assert.equal(resolutionCommit.commit_kind, "relation_resolution");
    assert.equal(
      resolutionCommit.authority_route,
      "canonical/loan-repayment-relation-resolution-v1",
    );
    assert.equal(
      queryCanonicalLoanHistorical(pair.store, {
        sourceId: "fubon",
        knowledgeAt: inputKnowledge,
        financialAt: "2026-01-15",
      }).relations.length,
      0,
    );
    assert.equal(
      queryCanonicalLoanHistorical(pair.store, {
        sourceId: "fubon",
        knowledgeAt: inputKnowledge + 1,
        financialAt: "2026-01-15",
      }).relations.length,
      1,
    );
    const commitCountAfterFirst = Number(
      (
        pair.store.db
          .prepare("SELECT COUNT(*) AS value FROM canonical_commits")
          .get() as { value?: number }
      ).value,
    );
    const second = await resolveLoanRepaymentRelations(pair.store, {
      sourceConnectionKey,
      integrationNamespace: "fubon",
      explicitLinks: [
        {
          fromCaptureId: pair.deposit.captureId,
          fromSourceRecordKey: depositRecord.occurrenceKey,
          toCaptureId: pair.loan.captureId,
          toSourceRecordKey: loanRecord.sourceRecordKey,
          relationId,
          contractVersion: "fubon/loan-repayment-link/v1",
          evidenceSourceRecordKey: depositRecord.occurrenceKey,
        },
      ],
    });
    assert.equal(second.outcome, "unchanged");
    assert.equal(
      Number(
        (
          pair.store.db
            .prepare("SELECT COUNT(*) AS value FROM canonical_commits")
            .get() as { value?: number }
        ).value,
      ),
      commitCountAfterFirst,
    );
    assert.equal(
      (pair.store.db.prepare("SELECT COUNT(*) AS count FROM transaction_relations").get() as { count?: number }).count,
      1,
    );
    assert.equal(
      (pair.store.db.prepare("SELECT COUNT(*) AS count FROM loan_repayment_relation_events").get() as { count?: number }).count,
      1,
    );
  } finally {
    const directory = pair.store.databasePath.slice(0, pair.store.databasePath.lastIndexOf("/"));
    pair.store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("independent exact relations sharing one endpoint remain current", async () => {
  const sourceConnectionKey = token("shared-endpoint-relations-connection");
  const pair = await commitPair(
    sourceConnectionKey,
    token("shared-endpoint-relations-deposit-epoch"),
    "shared-endpoint-relations",
    2,
  );
  try {
    const result = await resolveLoanRepaymentRelations(pair.store, {
      sourceConnectionKey,
      integrationNamespace: "fubon",
      explicitLinks: pair.loan.records.map((loanRecord, index) => ({
        fromCaptureId: pair.deposit.captureId,
        fromSourceRecordKey: pair.deposit.records[0]!.occurrenceKey,
        toCaptureId: pair.loan.captureId,
        toSourceRecordKey: loanRecord.sourceRecordKey,
        relationId: token(`shared-endpoint-relation-${index}`),
        contractVersion: "fubon/loan-repayment-link/v1",
        evidenceSourceRecordKey: pair.deposit.records[0]!.occurrenceKey,
      })),
    });
    assert.equal(result.exactRelationIds.length, 2);
    assert.equal(queryCurrentLoanRepaymentRelations(pair.store).length, 2);
    assert.equal(
      (pair.store.db.prepare("SELECT COUNT(*) AS count FROM loan_repayment_relation_events WHERE event_kind = 'superseded'").get() as { count?: number }).count,
      0,
    );
  } finally {
    const directory = pair.store.databasePath.slice(0, pair.store.databasePath.lastIndexOf("/"));
    pair.store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a collective group remains current alongside an exact relation sharing an endpoint", async () => {
  const sourceConnectionKey = token("shared-endpoint-group-connection");
  const pair = await commitPair(
    sourceConnectionKey,
    token("shared-endpoint-group-deposit-epoch"),
    "shared-endpoint-group",
    2,
  );
  try {
    await resolveLoanRepaymentRelations(pair.store, {
      sourceConnectionKey,
      integrationNamespace: "fubon",
      explicitLinks: [
        {
          fromCaptureId: pair.deposit.captureId,
          fromSourceRecordKey: pair.deposit.records[0]!.occurrenceKey,
          toCaptureId: pair.loan.captureId,
          toSourceRecordKey: pair.loan.records[0]!.sourceRecordKey,
          relationId: token("shared-endpoint-group-exact-relation"),
          contractVersion: "fubon/loan-repayment-link/v1",
          evidenceSourceRecordKey: pair.deposit.records[0]!.occurrenceKey,
        },
      ],
    });
    const accountValue = "88776655";
    for (const record of pair.deposit.records)
      await persistCounterpartyAccountEvidence(
        pair.store,
        evidenceInput(
          pair.deposit.captureId,
          record.occurrenceKey,
          sourceConnectionKey,
          pair.deposit.identity.identityEpochKey,
          accountValue,
        ),
      );
    for (const record of pair.loan.records)
      await persistCounterpartyAccountEvidence(
        pair.store,
        evidenceInput(
          pair.loan.captureId,
          record.sourceRecordKey,
          sourceConnectionKey,
          pair.loan.identity.identityEpochKey,
          accountValue,
        ),
      );
    const grouped = await resolveLoanRepaymentRelations(pair.store, {
      sourceConnectionKey,
      integrationNamespace: "fubon",
    });
    assert.equal(grouped.exactRelationIds.length, 0);
    assert.equal(grouped.settlementGroupIds.length, 1);
    assert.equal(queryCurrentLoanRepaymentRelations(pair.store).length, 1);
    assert.equal(queryCurrentLoanRepaymentSettlementGroups(pair.store).length, 1);
    assert.equal(
      (pair.store.db.prepare("SELECT COUNT(*) AS count FROM loan_repayment_relation_events WHERE event_kind = 'superseded'").get() as { count?: number }).count,
      0,
    );
  } finally {
    const directory = pair.store.databasePath.slice(0, pair.store.databasePath.lastIndexOf("/"));
    pair.store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("resolver audits no-admission, is idempotent, and fails closed on incomplete input", async () => {
  const sourceConnectionKey = token("incomplete-connection");
  const pair = await commitPair(sourceConnectionKey, token("incomplete-deposit-epoch"), "incomplete");
  try {
    await assert.rejects(
      () =>
        resolveLoanRepaymentRelations(pair.store, {
          sourceConnectionKey,
          integrationNamespace: "fubon",
          explicitLinks: [
            {
              fromCaptureId: token("missing-capture"),
              fromSourceRecordKey: token("missing-deposit-record"),
              toCaptureId: pair.loan.captureId,
              toSourceRecordKey: pair.loan.records[0]!.sourceRecordKey,
              relationId: token("invalid-explicit-relation"),
              contractVersion: "fubon/loan-repayment-link/v1",
            },
          ],
        }),
      /source capture .* was not found/i,
    );
    assert.equal(
      (pair.store.db.prepare("SELECT COUNT(*) AS count FROM loan_repayment_resolution_runs").get() as { count?: number }).count,
      0,
    );

    const observedAt = "2026-02-01T00:00:00.000Z";
    const noEvidence = await resolveLoanRepaymentRelations(pair.store, {
      sourceConnectionKey,
      integrationNamespace: "fubon",
      observedAt,
    });
    assert.equal(noEvidence.outcome, "no-admission");
    assert.ok(noEvidence.resolutionId);
    assert.equal(noEvidence.reason, "no-evidence-backed-admission");
    const firstRun = pair.store.db
      .prepare(
        "SELECT coverage_state, outcome, reason, observed_at FROM loan_repayment_resolution_runs",
      )
      .get() as {
      coverage_state?: string;
      outcome?: string;
      reason?: string;
      observed_at?: string;
    };
    assert.equal(firstRun.coverage_state, "complete");
    assert.equal(firstRun.outcome, "no-admission");
    assert.equal(firstRun.reason, "no-evidence-backed-admission");
    assert.equal(firstRun.observed_at, observedAt);

    const repeated = await resolveLoanRepaymentRelations(pair.store, {
      sourceConnectionKey,
      integrationNamespace: "fubon",
      observedAt,
    });
    assert.equal(repeated.outcome, "unchanged");
    assert.equal(repeated.resolutionId, noEvidence.resolutionId);
    assert.equal(
      (pair.store.db.prepare("SELECT COUNT(*) AS count FROM loan_repayment_resolution_runs").get() as { count?: number }).count,
      1,
    );
    assert.equal(queryCurrentLoanRepaymentRelations(pair.store).length, 0);

    const laterLoan = loanCapture(
      sourceConnectionKey,
      token("incomplete-later-loan-epoch"),
      "incomplete-later-loan",
      1,
      { observedAt: "2026-02-02T00:00:00.000Z" },
    );
    const laterDeposit = depositCapture(
      sourceConnectionKey,
      token("incomplete-later-deposit-epoch"),
      "incomplete-later-deposit",
      1,
      { observedAt: "2026-02-02T00:00:00.000Z" },
    );
    await commitCanonicalLoanCapture(pair.store, laterLoan);
    await commitCanonicalFinancialDepositCapture(pair.store, laterDeposit);
    const later = await resolveLoanRepaymentRelations(pair.store, {
      sourceConnectionKey,
      integrationNamespace: "fubon",
      observedAt: "2026-02-02T00:00:00.000Z",
    });
    assert.equal(later.outcome, "no-admission");
    assert.notEqual(later.resolutionId, noEvidence.resolutionId);
    assert.equal(
      (pair.store.db.prepare("SELECT COUNT(*) AS count FROM loan_repayment_resolution_runs").get() as { count?: number }).count,
      2,
    );

    const incomplete = await resolveLoanRepaymentRelations(pair.store, {
      sourceConnectionKey,
      integrationNamespace: "fubon",
      requiredCoverage: { complete: false },
      observedAt: "2026-02-03T00:00:00.000Z",
    });
    assert.equal(incomplete.outcome, "no-admission");
    assert.match(incomplete.reason!, /incomplete/);
    assert.ok(incomplete.resolutionId);
    assert.equal(
      (
        pair.store.db
          .prepare(
            "SELECT coverage_state, outcome, reason FROM loan_repayment_resolution_runs WHERE resolution_id = ?",
          )
          .get(Buffer.from(incomplete.resolutionId!.replaceAll("-", ""), "hex")) as {
          coverage_state?: string;
          outcome?: string;
          reason?: string;
        }
      ).coverage_state,
      "incomplete",
    );
    assert.equal(queryCurrentLoanRepaymentRelations(pair.store).length, 0);
    assert.equal(queryCurrentLoanRepaymentSettlementGroups(pair.store).length, 0);
  } finally {
    const directory = pair.store.databasePath.slice(0, pair.store.databasePath.lastIndexOf("/"));
    pair.store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("resolver retains an ambiguous settlement group and never uses amount components as endpoints", async () => {
  const sourceConnectionKey = token("group-connection");
  const pair = await commitPair(sourceConnectionKey, token("group-deposit-epoch"), "group", 2);
  try {
    const accountValue = "99887766";
    for (const record of pair.deposit.records)
      await persistCounterpartyAccountEvidence(
        pair.store,
        evidenceInput(
          pair.deposit.captureId,
          record.occurrenceKey,
          sourceConnectionKey,
          pair.deposit.identity.identityEpochKey,
          accountValue,
        ),
      );
    for (const record of pair.loan.records)
      await persistCounterpartyAccountEvidence(
        pair.store,
        evidenceInput(
          pair.loan.captureId,
          record.sourceRecordKey,
          sourceConnectionKey,
          pair.loan.identity.identityEpochKey,
          accountValue,
        ),
      );
    const result = await resolveLoanRepaymentRelations(pair.store, {
      sourceConnectionKey,
      integrationNamespace: "fubon",
    });
    assert.equal(result.outcome, "changed");
    assert.equal(result.exactRelationIds.length, 0);
    assert.equal(result.settlementGroupIds.length, 1);
    const groups = queryCurrentLoanRepaymentSettlementGroups(pair.store);
    assert.equal(groups.length, 1);
    assert.equal(groups[0]!.members.length, 4);
    assert.equal(
      (pair.store.db.prepare("SELECT COUNT(*) AS count FROM transaction_relations").get() as { count?: number }).count,
      0,
    );
    assert.equal(
      (pair.store.db.prepare("SELECT COUNT(*) AS count FROM loan_transaction_facts").get() as { count?: number }).count,
      2,
    );
  } finally {
    const directory = pair.store.databasePath.slice(0, pair.store.databasePath.lastIndexOf("/"));
    pair.store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("verified repayment destination groups collective membership despite unequal dates and amounts", async () => {
  const sourceConnectionKey = token("unequal-group-connection");
  const pair = await commitPair(
    sourceConnectionKey,
    token("unequal-group-deposit-epoch"),
    "unequal-group",
    2,
    {
      depositEffectiveOns: ["2026-01-15", "2026-01-17"],
      loanEffectiveOns: ["2026-01-16", "2026-01-20"],
      depositAmounts: [
        { coefficient: "12500", scale: 2 },
        { coefficient: "13000", scale: 2 },
      ],
      loanAmounts: [
        { coefficient: "12000", scale: 2 },
        { coefficient: "13500", scale: 2 },
      ],
    },
  );
  try {
    const accountValue = "11223344";
    for (const record of pair.deposit.records)
      await persistCounterpartyAccountEvidence(
        pair.store,
        evidenceInput(
          pair.deposit.captureId,
          record.occurrenceKey,
          sourceConnectionKey,
          pair.deposit.identity.identityEpochKey,
          accountValue,
        ),
      );
    for (const record of pair.loan.records)
      await persistCounterpartyAccountEvidence(
        pair.store,
        evidenceInput(
          pair.loan.captureId,
          record.sourceRecordKey,
          sourceConnectionKey,
          pair.loan.identity.identityEpochKey,
          accountValue,
        ),
      );
    const result = await resolveLoanRepaymentRelations(pair.store, {
      sourceConnectionKey,
      integrationNamespace: "fubon",
    });
    assert.equal(result.outcome, "changed");
    assert.equal(result.exactRelationIds.length, 0);
    assert.equal(result.settlementGroupIds.length, 1);
    assert.equal(queryCurrentLoanRepaymentSettlementGroups(pair.store)[0]?.members.length, 4);
    assert.equal(
      (pair.store.db.prepare("SELECT COUNT(*) AS count FROM transaction_relations").get() as { count?: number }).count,
      0,
    );
  } finally {
    const directory = pair.store.databasePath.slice(0, pair.store.databasePath.lastIndexOf("/"));
    pair.store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("verified Fubon account evidence partitions principal and interest by complete same-day total", async () => {
  const sourceConnectionKey = token("fubon-date-total-connection");
  const directory = await mkdtemp(join(tmpdir(), "loan-relation-fubon-date-total-"));
  const store = createCanonicalSourceStore(join(directory, "canonical.sqlite"));
  const loan = loanCapture(
    sourceConnectionKey,
    token("fubon-date-total-loan-epoch"),
    "fubon-date-total-loan",
    4,
    {
      effectiveOns: ["2026-03-16", "2026-03-16", "2026-04-16", "2026-04-16"],
      amounts: [
        { coefficient: "5997", scale: 0 },
        { coefficient: "1606", scale: 0 },
        { coefficient: "5841", scale: 0 },
        { coefficient: "1762", scale: 0 },
      ],
      eventKinds: ["payment", "interest", "payment", "interest"],
    },
  );
  const deposit = depositCapture(
    sourceConnectionKey,
    token("fubon-date-total-deposit-epoch"),
    "fubon-date-total-deposit",
    2,
    {
      effectiveOns: ["2026-03-16", "2026-04-16"],
      amounts: [
        { coefficient: "760300", scale: 2 },
        { coefficient: "7603", scale: 0 },
      ],
    },
  );
  try {
    await commitCanonicalLoanCapture(store, loan);
    await commitCanonicalFinancialDepositCapture(store, deposit);
    const accountValue = "01234567890123";
    for (const record of deposit.records) {
      await persistCounterpartyAccountEvidence(
        store,
        evidenceInput(
          deposit.captureId,
          record.occurrenceKey,
          sourceConnectionKey,
          deposit.identity.identityEpochKey,
          accountValue,
        ),
      );
    }
    await persistCounterpartyAccountEvidence(store, {
      captureId: loan.captureId,
      sourceRecordKey: loan.records[0]!.sourceRecordKey,
      sourceConnectionKey,
      identityEpochKey: loan.identity.identityEpochKey,
      accountValue,
      role: "beneficiary",
      purpose: "loan_repayment",
      scope: "loan_contract",
      evidenceKind: "repayment-mandate",
      sourceField: "loan-account-selector",
      contractVersion: "fubon/loan-account-as-repayment-destination/v1",
      effectiveStartDate: loan.scope.startDate,
      effectiveEndDate: loan.scope.endDate,
      accountKey: loan.identity.accountKey,
    });

    const result = await resolveLoanRepaymentRelations(store, {
      sourceConnectionKey,
      integrationNamespace: "fubon",
    });
    assert.equal(result.exactRelationIds.length, 0);
    assert.equal(result.settlementGroupIds.length, 2);
    const groups = queryCurrentLoanRepaymentSettlementGroups(store);
    assert.equal(groups.length, 2);
    assert.deepEqual(
      groups.map((group) => group.members.length).sort(),
      [3, 3],
    );
    const mandate = queryCounterpartyAccountEvidence(store).find(
      (entry) => entry.evidenceKind === "repayment-mandate",
    );
    assert.equal(mandate?.sourceValue, accountValue);
    assert.equal(mandate?.transactionId, null);
    assert.ok(mandate?.accountId);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("verified account reconciliation never withdraws another Source Connection group", async () => {
  const directory = await mkdtemp(join(tmpdir(), "loan-relation-connection-isolation-"));
  const store = createCanonicalSourceStore(join(directory, "canonical.sqlite"));
  const accountValue = "01234567890123";
  const connections = [
    {
      key: token("connection-isolation-a"),
      label: "connection-isolation-a",
    },
    {
      key: token("connection-isolation-b"),
      label: "connection-isolation-b",
    },
  ] as const;
  try {
    for (const connection of connections) {
      const loan = loanCapture(
        connection.key,
        token(`${connection.label}:loan-epoch`),
        `${connection.label}:loan`,
        2,
        {
          amounts: [
            { coefficient: "10000", scale: 2 },
            { coefficient: "2500", scale: 2 },
          ],
          eventKinds: ["payment", "interest"],
        },
      );
      const deposit = depositCapture(
        connection.key,
        token(`${connection.label}:deposit-epoch`),
        `${connection.label}:deposit`,
      );
      await commitCanonicalLoanCapture(store, loan);
      await commitCanonicalFinancialDepositCapture(store, deposit);
      await persistCounterpartyAccountEvidence(
        store,
        evidenceInput(
          deposit.captureId,
          deposit.records[0]!.occurrenceKey,
          connection.key,
          deposit.identity.identityEpochKey,
          accountValue,
        ),
      );
      await persistCounterpartyAccountEvidence(store, {
        captureId: loan.captureId,
        sourceRecordKey: loan.records[0]!.sourceRecordKey,
        sourceConnectionKey: connection.key,
        identityEpochKey: loan.identity.identityEpochKey,
        accountValue,
        role: "beneficiary",
        purpose: "loan_repayment",
        scope: "loan_contract",
        evidenceKind: "repayment-mandate",
        sourceField: "loan-account-selector",
        contractVersion: "fubon/loan-account-as-repayment-destination/v1",
        effectiveStartDate: loan.scope.startDate,
        effectiveEndDate: loan.scope.endDate,
        accountKey: loan.identity.accountKey,
      });
    }

    for (const connection of connections) {
      const result = await resolveLoanRepaymentRelations(store, {
        sourceConnectionKey: connection.key,
        integrationNamespace: "fubon",
      });
      assert.equal(result.settlementGroupIds.length, 1, JSON.stringify(result));
    }

    const groups = queryCurrentLoanRepaymentSettlementGroups(store);
    assert.equal(groups.length, 2);
    assert.equal(new Set(groups.map((group) => group.sourceConnectionKey)).size, 2);
    assert.equal(
      (store.db.prepare("SELECT COUNT(*) AS count FROM loan_repayment_relation_events WHERE event_kind = 'withdrawn'").get() as { count?: number }).count,
      0,
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a stronger exact resolution does not withdraw an unrelated larger group", async () => {
  const sourceConnectionKey = token("supersession-connection");
  const pair = await commitPair(sourceConnectionKey, token("supersession-deposit-epoch"), "supersession", 2);
  try {
    const accountValue = "44556677";
    for (const record of pair.deposit.records)
      await persistCounterpartyAccountEvidence(
        pair.store,
        evidenceInput(
          pair.deposit.captureId,
          record.occurrenceKey,
          sourceConnectionKey,
          pair.deposit.identity.identityEpochKey,
          accountValue,
        ),
      );
    for (const record of pair.loan.records)
      await persistCounterpartyAccountEvidence(
        pair.store,
        evidenceInput(
          pair.loan.captureId,
          record.sourceRecordKey,
          sourceConnectionKey,
          pair.loan.identity.identityEpochKey,
          accountValue,
        ),
      );
    const grouped = await resolveLoanRepaymentRelations(pair.store, {
      sourceConnectionKey,
      integrationNamespace: "fubon",
    });
    assert.equal(grouped.settlementGroupIds.length, 1);
    const historicalGroupId = grouped.settlementGroupIds[0]!;
    const exact = await resolveLoanRepaymentRelations(pair.store, {
      sourceConnectionKey,
      integrationNamespace: "fubon",
      explicitLinks: [
        {
          fromCaptureId: pair.deposit.captureId,
          fromSourceRecordKey: pair.deposit.records[0]!.occurrenceKey,
          toCaptureId: pair.loan.captureId,
          toSourceRecordKey: pair.loan.records[0]!.sourceRecordKey,
          relationId: token("supersession-explicit-relation"),
          contractVersion: "fubon/loan-repayment-link/v1",
          evidenceSourceRecordKey: pair.deposit.records[0]!.occurrenceKey,
        },
      ],
    });
    assert.equal(exact.exactRelationIds.length, 1);
    assert.equal(queryCurrentLoanRepaymentSettlementGroups(pair.store).length, 1);
    assert.equal(queryCurrentLoanRepaymentRelations(pair.store).length, 1);
    assert.equal(
      (pair.store.db.prepare("SELECT COUNT(*) AS count FROM loan_repayment_settlement_groups").get() as { count?: number }).count,
      1,
    );
    assert.equal(
      (pair.store.db.prepare("SELECT COUNT(*) AS count FROM loan_repayment_relation_events WHERE event_kind = 'superseded'").get() as { count?: number }).count,
      0,
    );
    assert.equal(
      queryCurrentLoanRepaymentSettlementGroups(pair.store)[0]?.settlementGroupId,
      historicalGroupId,
    );
  } finally {
    const directory = pair.store.databasePath.slice(0, pair.store.databasePath.lastIndexOf("/"));
    pair.store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an exact assertion replaces a current two-member group when it is the same assertion", async () => {
  const sourceConnectionKey = token("two-member-group-replacement-connection");
  const pair = await commitPair(
    sourceConnectionKey,
    token("two-member-group-replacement-deposit-epoch"),
    "two-member-group-replacement",
  );
  try {
    const blobForTest = (label: string): Uint8Array =>
      createHash("sha256")
        .update(`relation-check-two-member-group:${label}`)
        .digest()
        .subarray(0, 16);
    const connection = pair.store.db
      .prepare("SELECT source_connection_id FROM source_connections WHERE source_connection_key = ?")
      .get(sourceConnectionKey) as { source_connection_id?: Uint8Array };
    const generation = pair.store.db
      .prepare("SELECT generation_id FROM active_projection_generation WHERE singleton_id = 1")
      .get() as { generation_id?: number };
    const commit = pair.store.db
      .prepare("SELECT commit_id FROM canonical_commits ORDER BY commit_sequence DESC LIMIT 1")
      .get() as { commit_id?: Uint8Array };
    const memberFor = (captureKey: string, sourceRecordKey: string) =>
      pair.store.db
        .prepare(
          `SELECT revision.transaction_id, record.source_record_id, record.capture_id,
                  capture.commit_id
           FROM source_records record
           JOIN source_captures capture ON capture.capture_id = record.capture_id
           JOIN transaction_revisions revision
             ON revision.source_record_id = record.source_record_id
            AND revision.capture_id = record.capture_id
           WHERE capture.capture_key = ? AND record.occurrence_key = ?
           ORDER BY revision.revision_number DESC LIMIT 1`,
        )
        .get(captureKey, sourceRecordKey) as {
        transaction_id?: Uint8Array;
        source_record_id?: Uint8Array;
        capture_id?: Uint8Array;
        commit_id?: Uint8Array;
      };
    const depositMember = memberFor(
      pair.deposit.captureId,
      pair.deposit.records[0]!.occurrenceKey,
    );
    const loanMember = memberFor(
      pair.loan.captureId,
      pair.loan.records[0]!.sourceRecordKey,
    );
    assert.ok(connection.source_connection_id);
    assert.ok(generation.generation_id !== undefined);
    assert.ok(commit.commit_id);
    assert.ok(depositMember.transaction_id);
    assert.ok(depositMember.source_record_id);
    assert.ok(depositMember.capture_id);
    assert.ok(depositMember.commit_id);
    assert.ok(loanMember.transaction_id);
    assert.ok(loanMember.source_record_id);
    assert.ok(loanMember.capture_id);
    assert.ok(loanMember.commit_id);

    const groupId = blobForTest("group");
    const seedResolutionId = blobForTest("resolution");
    pair.store.db
      .prepare(
        `INSERT INTO loan_repayment_resolution_runs(
           resolution_id, resolution_key, source_connection_id, resolver_version,
           coverage_state, outcome, reason, observed_at, commit_id
         ) VALUES (?, ?, ?, 'loan-repayment-relation/v1', 'complete', 'changed',
                   NULL, '2026-02-01T00:00:00.000Z', ?)`,
      )
      .run(
        seedResolutionId,
        "two-member-group-seed-resolution",
        connection.source_connection_id,
        commit.commit_id,
      );
    pair.store.db
      .prepare(
        `INSERT INTO loan_repayment_settlement_groups(
           settlement_group_id, source_connection_id, group_key,
           resolver_version, created_commit_id
         ) VALUES (?, ?, 'two-member-group-seed', 'loan-repayment-relation/v1', ?)`,
      )
      .run(groupId, connection.source_connection_id, commit.commit_id);
    pair.store.db
      .prepare(
        `INSERT INTO loan_repayment_settlement_group_members(
           settlement_group_id, transaction_id, member_kind,
           source_record_id, capture_id, commit_id
         ) VALUES (?, ?, 'deposit_outflow', ?, ?, ?),
                  (?, ?, 'loan_payment', ?, ?, ?)`,
      )
      .run(
        groupId,
        depositMember.transaction_id,
        depositMember.source_record_id,
        depositMember.capture_id,
        depositMember.commit_id,
        groupId,
        loanMember.transaction_id,
        loanMember.source_record_id,
        loanMember.capture_id,
        loanMember.commit_id,
      );
    pair.store.db
      .prepare(
        `INSERT INTO current_loan_repayment_settlement_groups(
           generation_id, settlement_group_id, projection_commit_id
         ) VALUES (?, ?, ?)`,
      )
      .run(generation.generation_id, groupId, commit.commit_id);
    pair.store.db
      .prepare(
        `INSERT INTO loan_repayment_relation_events(
           event_id, resolution_id, relation_id, settlement_group_id, event_kind,
           support_kind, support_key, supersedes_relation_id, supersedes_group_id,
           evidence_json, commit_id
         ) VALUES (?, ?, NULL, ?, 'observed', 'verified-repayment-destination',
                   'two-member-group-seed-support', NULL, NULL, '{}', ?)`,
      )
      .run(blobForTest("observed-event"), seedResolutionId, groupId, commit.commit_id);

    const exact = await resolveLoanRepaymentRelations(pair.store, {
      sourceConnectionKey,
      integrationNamespace: "fubon",
      explicitLinks: [
        {
          fromCaptureId: pair.deposit.captureId,
          fromSourceRecordKey: pair.deposit.records[0]!.occurrenceKey,
          toCaptureId: pair.loan.captureId,
          toSourceRecordKey: pair.loan.records[0]!.sourceRecordKey,
          relationId: token("two-member-group-replacement-relation"),
          contractVersion: "fubon/loan-repayment-link/v1",
          evidenceSourceRecordKey: pair.deposit.records[0]!.occurrenceKey,
        },
      ],
    });
    assert.equal(exact.exactRelationIds.length, 1);
    assert.equal(queryCurrentLoanRepaymentSettlementGroups(pair.store).length, 0);
    assert.equal(queryCurrentLoanRepaymentRelations(pair.store).length, 1);
    const superseded = pair.store.db
      .prepare(
        `SELECT supersedes_relation_id
         FROM loan_repayment_relation_events
         WHERE event_kind = 'superseded'`,
      )
      .get() as { supersedes_relation_id?: Uint8Array } | undefined;
    assert.ok(superseded?.supersedes_relation_id);
  } finally {
    const directory = pair.store.databasePath.slice(0, pair.store.databasePath.lastIndexOf("/"));
    pair.store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("repayment mandates honor effective intervals and are not retroactive when current-only", async () => {
  const run = async (
    label: string,
    loanEffectiveOn: string,
    mandate: { effectiveStartDate?: string | null; effectiveEndDate?: string | null },
    expectedExactRelations: number,
    includeOutflowAccountEvidence = true,
  ) => {
    const sourceConnectionKey = token(`${label}:connection`);
    const pair = await commitPair(
      sourceConnectionKey,
      token(`${label}:deposit-epoch`),
      label,
      1,
      { loanEffectiveOn, depositEffectiveOn: loanEffectiveOn },
    );
    try {
      const depositRecord = pair.deposit.records[0]!;
      const loanRecord = pair.loan.records[0]!;
      if (includeOutflowAccountEvidence)
        await persistCounterpartyAccountEvidence(
          pair.store,
          evidenceInput(
            pair.deposit.captureId,
            depositRecord.occurrenceKey,
            sourceConnectionKey,
            pair.deposit.identity.identityEpochKey,
            "temporal-repayment-account",
          ),
        );
      await persistCounterpartyAccountEvidence(
        pair.store,
        evidenceInput(
          pair.loan.captureId,
          loanRecord.sourceRecordKey,
          sourceConnectionKey,
          pair.loan.identity.identityEpochKey,
          "temporal-repayment-account",
          "beneficiary",
          { evidenceKind: "repayment-mandate", ...mandate },
        ),
      );
      const result = await resolveLoanRepaymentRelations(pair.store, {
        sourceConnectionKey,
        integrationNamespace: "fubon",
      });
      assert.equal(result.exactRelationIds.length, expectedExactRelations);
      if (expectedExactRelations === 0)
        assert.equal(result.outcome, "no-admission");
    } finally {
      const directory = pair.store.databasePath.slice(0, pair.store.databasePath.lastIndexOf("/"));
      pair.store.close();
      await rm(directory, { recursive: true, force: true });
    }
  };

  await run("mandate-before", "2025-12-31", {
    effectiveStartDate: "2026-01-01",
    effectiveEndDate: "2026-01-31",
  }, 0);
  // A mandate alone scopes the loan account but cannot identify this one
  // deposit outflow.  The same in-range mandate becomes exact only after the
  // outflow itself carries the matching repayment destination evidence.
  await run("mandate-in-range-only", "2026-01-15", {
    effectiveStartDate: "2026-01-01",
    effectiveEndDate: "2026-01-31",
  }, 0, false);
  await run("mandate-in-range-with-outflow-evidence", "2026-01-15", {
    effectiveStartDate: "2026-01-01",
    effectiveEndDate: "2026-01-31",
  }, 1);
  await run("mandate-after", "2026-02-15", {
    effectiveStartDate: "2026-01-01",
    effectiveEndDate: "2026-01-31",
  }, 0);
  await run("mandate-current-only", "2026-01-15", {}, 0);
});

test("fixed Institution note fallback persists provenance and admits only exact unique matches", async () => {
  const sourceConnectionKey = token("fixed-note-connection");
  const pair = await commitPair(sourceConnectionKey, token("fixed-note-deposit-epoch"), "fixed-note");
  try {
    const persisted = await persistInstitutionGeneratedRepaymentNoteEvidence(
      pair.store,
      institutionNoteInput(
        pair.deposit.captureId,
        pair.deposit.records[0]!.occurrenceKey,
        sourceConnectionKey,
        pair.deposit.identity.identityEpochKey,
        { noteValue: "  LOAN   PAYMENT  " },
      ),
    );
    assert.equal(persisted.sourceValue, "  LOAN   PAYMENT  ");
    assert.equal(persisted.normalizedValue, normalizeInstitutionGeneratedRepaymentNote("LOAN PAYMENT"));
    assert.equal(persisted.fixedValue, "LOAN PAYMENT");
    assert.equal(persisted.evidenceVersion, INSTITUTION_REPAYMENT_NOTE_EVIDENCE_VERSION);
    assert.equal(persisted.dateField, "transaction-date");
    assert.equal(persisted.generatedBy, "institution");
    assert.equal(persisted.liveVerified, true);
    assert.equal(queryInstitutionGeneratedRepaymentNoteEvidence(pair.store).length, 1);
    assert.equal(
      (pair.store.db.prepare("SELECT COUNT(*) AS count FROM institution_repayment_note_evidence_support").get() as { count?: number }).count,
      1,
    );
    const result = await resolveLoanRepaymentRelations(pair.store, {
      sourceConnectionKey,
      integrationNamespace: "fubon",
    });
    assert.equal(result.outcome, "changed");
    assert.equal(result.exactRelationIds.length, 1);
    assert.equal(
      (pair.store.db.prepare("SELECT support_kind FROM loan_repayment_relation_events WHERE event_kind = 'observed'").get() as { support_kind?: string }).support_kind,
      "fixed-institution-note",
    );
  } finally {
    const directory = pair.store.databasePath.slice(0, pair.store.databasePath.lastIndexOf("/"));
    pair.store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("repayment amount keys normalize equivalent decimal scales consistently", async () => {
  const sourceConnectionKey = token("decimal-scale-connection");
  const pair = await commitPair(
    sourceConnectionKey,
    token("decimal-scale-deposit-epoch"),
    "decimal-scale",
    1,
    {
      depositAmounts: [{ coefficient: "125000", scale: 3 }],
      loanAmounts: [{ coefficient: "12500", scale: 2 }],
    },
  );
  try {
    await persistInstitutionGeneratedRepaymentNoteEvidence(
      pair.store,
      institutionNoteInput(
        pair.deposit.captureId,
        pair.deposit.records[0]!.occurrenceKey,
        sourceConnectionKey,
        pair.deposit.identity.identityEpochKey,
      ),
    );
    const result = await resolveLoanRepaymentRelations(pair.store, {
      sourceConnectionKey,
      integrationNamespace: "fubon",
    });
    assert.equal(result.exactRelationIds.length, 1);
  } finally {
    const directory = pair.store.databasePath.slice(0, pair.store.databasePath.lastIndexOf("/"));
    pair.store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("loan queries expose the actual explicit, account, and fixed-note support", async () => {
  const assertQuerySupport = (
    store: ReturnType<typeof createCanonicalSourceStore>,
    sourceRecordKey: string,
    expectedKind: string,
    expectedVersion: string,
  ) => {
    const current = queryCanonicalLoanCurrent(store, { sourceId: "fubon" });
    assert.equal(current.relations.length, 1);
    assert.equal(current.relations[0]?.evidence.kind, expectedKind);
    assert.equal(current.relations[0]?.evidence.evidenceVersion, expectedVersion);
    const historical = queryCanonicalLoanHistorical(store, {
      sourceId: "fubon",
      knowledgeAt: current.knowledgeAt,
      financialAt: "2026-01-15",
    });
    assert.equal(historical.relations[0]?.evidence.kind, expectedKind);
    assert.equal(historical.relations[0]?.evidence.evidenceVersion, expectedVersion);
    const lineage = queryCanonicalLoanLineage(store, {
      sourceId: "fubon",
      sourceRecordKey,
    });
    assert.equal(lineage.relations[0]?.evidence.kind, expectedKind);
    assert.equal(lineage.relations[0]?.evidence.evidenceVersion, expectedVersion);
  };

  const accountPair = await commitPair(
    token("query-account-connection"),
    token("query-account-deposit-epoch"),
    "query-account",
  );
  try {
    const sourceConnectionKey = token("query-account-connection");
    await persistCounterpartyAccountEvidence(
      accountPair.store,
      evidenceInput(
        accountPair.deposit.captureId,
        accountPair.deposit.records[0]!.occurrenceKey,
        sourceConnectionKey,
        accountPair.deposit.identity.identityEpochKey,
        "22334455",
      ),
    );
    await persistCounterpartyAccountEvidence(
      accountPair.store,
      evidenceInput(
        accountPair.loan.captureId,
        accountPair.loan.records[0]!.sourceRecordKey,
        sourceConnectionKey,
        accountPair.loan.identity.identityEpochKey,
        "22334455",
      ),
    );
    await resolveLoanRepaymentRelations(accountPair.store, {
      sourceConnectionKey,
      integrationNamespace: "fubon",
    });
    assertQuerySupport(
      accountPair.store,
      accountPair.loan.records[0]!.sourceRecordKey,
      "verified-repayment-destination",
      "counterparty-account/v1",
    );
  } finally {
    const directory = accountPair.store.databasePath.slice(0, accountPair.store.databasePath.lastIndexOf("/"));
    accountPair.store.close();
    await rm(directory, { recursive: true, force: true });
  }

  const notePair = await commitPair(
    token("query-note-connection"),
    token("query-note-deposit-epoch"),
    "query-note",
  );
  try {
    const sourceConnectionKey = token("query-note-connection");
    await persistInstitutionGeneratedRepaymentNoteEvidence(
      notePair.store,
      institutionNoteInput(
        notePair.deposit.captureId,
        notePair.deposit.records[0]!.occurrenceKey,
        sourceConnectionKey,
        notePair.deposit.identity.identityEpochKey,
      ),
    );
    await resolveLoanRepaymentRelations(notePair.store, {
      sourceConnectionKey,
      integrationNamespace: "fubon",
    });
    assertQuerySupport(
      notePair.store,
      notePair.loan.records[0]!.sourceRecordKey,
      "fixed-institution-note",
      INSTITUTION_REPAYMENT_NOTE_EVIDENCE_VERSION,
    );
  } finally {
    const directory = notePair.store.databasePath.slice(0, notePair.store.databasePath.lastIndexOf("/"));
    notePair.store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("fixed-note date matching requires an explicit provider offset contract", async () => {
  const run = async (
    label: string,
    allowedSignedDayOffsets: readonly number[],
    expectedRelations: number,
  ) => {
    const sourceConnectionKey = token(`${label}:connection`);
    const pair = await commitPair(
      sourceConnectionKey,
      token(`${label}:deposit-epoch`),
      label,
      1,
      {
        depositEffectiveOn: "2026-01-15",
        loanEffectiveOn: "2026-01-16",
      },
    );
    try {
      await persistInstitutionGeneratedRepaymentNoteEvidence(
        pair.store,
        institutionNoteInput(
          pair.deposit.captureId,
          pair.deposit.records[0]!.occurrenceKey,
          sourceConnectionKey,
          pair.deposit.identity.identityEpochKey,
          { allowedSignedDayOffsets },
        ),
      );
      const result = await resolveLoanRepaymentRelations(pair.store, {
        sourceConnectionKey,
        integrationNamespace: "fubon",
      });
      assert.equal(result.exactRelationIds.length, expectedRelations);
      if (expectedRelations === 0)
        assert.equal(result.outcome, "no-admission");
    } finally {
      const directory = pair.store.databasePath.slice(0, pair.store.databasePath.lastIndexOf("/"));
      pair.store.close();
      await rm(directory, { recursive: true, force: true });
    }
  };

  await run("fixed-note-offset-allowed", [1], 1);
  await run("fixed-note-offset-disallowed", [0], 0);

  const missingContractPair = await commitPair(
    token("fixed-note-no-contract:connection"),
    token("fixed-note-no-contract:deposit-epoch"),
    "fixed-note-no-contract",
  );
  try {
    const sourceConnectionKey = token("fixed-note-no-contract:connection");
    const input = institutionNoteInput(
      missingContractPair.deposit.captureId,
      missingContractPair.deposit.records[0]!.occurrenceKey,
      sourceConnectionKey,
      missingContractPair.deposit.identity.identityEpochKey,
    );
    const { dateContract: _dateContract, ...contractWithoutDatePayload } = input.contract;
    await assert.rejects(
      () =>
        persistInstitutionGeneratedRepaymentNoteEvidence(missingContractPair.store, {
          ...input,
          contract: contractWithoutDatePayload,
        } as never),
      /date contract/i,
    );
  } finally {
    const directory = missingContractPair.store.databasePath.slice(0, missingContractPair.store.databasePath.lastIndexOf("/"));
    missingContractPair.store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("expired or current-only mandate evidence cannot downgrade to fixed-note fallback", async () => {
  const sourceConnectionKey = token("stale-mandate-note-connection");
  const pair = await commitPair(
    sourceConnectionKey,
    token("stale-mandate-note-deposit-epoch"),
    "stale-mandate-note",
  );
  try {
    await persistInstitutionGeneratedRepaymentNoteEvidence(
      pair.store,
      institutionNoteInput(
        pair.deposit.captureId,
        pair.deposit.records[0]!.occurrenceKey,
        sourceConnectionKey,
        pair.deposit.identity.identityEpochKey,
      ),
    );
    await persistCounterpartyAccountEvidence(
      pair.store,
      evidenceInput(
        pair.loan.captureId,
        pair.loan.records[0]!.sourceRecordKey,
        sourceConnectionKey,
        pair.loan.identity.identityEpochKey,
        "stale-mandate-account",
        "beneficiary",
        {
          evidenceKind: "repayment-mandate",
          effectiveStartDate: "2025-01-01",
          effectiveEndDate: "2026-01-01",
        },
      ),
    );
    const expired = await resolveLoanRepaymentRelations(pair.store, {
      sourceConnectionKey,
      integrationNamespace: "fubon",
    });
    assert.equal(expired.outcome, "no-admission");
    assert.equal(expired.exactRelationIds.length, 0);
    assert.equal(queryCurrentLoanRepaymentRelations(pair.store).length, 0);
    assert.equal(
      (pair.store.db.prepare("SELECT COUNT(*) AS count FROM loan_repayment_resolution_runs").get() as { count?: number }).count,
      1,
    );
  } finally {
    const directory = pair.store.databasePath.slice(0, pair.store.databasePath.lastIndexOf("/"));
    pair.store.close();
    await rm(directory, { recursive: true, force: true });
  }

  const currentOnlyPair = await commitPair(
    token("current-only-mandate-note-connection"),
    token("current-only-mandate-note-deposit-epoch"),
    "current-only-mandate-note",
  );
  try {
    const currentOnlyConnection = token("current-only-mandate-note-connection");
    await persistInstitutionGeneratedRepaymentNoteEvidence(
      currentOnlyPair.store,
      institutionNoteInput(
        currentOnlyPair.deposit.captureId,
        currentOnlyPair.deposit.records[0]!.occurrenceKey,
        currentOnlyConnection,
        currentOnlyPair.deposit.identity.identityEpochKey,
      ),
    );
    await persistCounterpartyAccountEvidence(
      currentOnlyPair.store,
      evidenceInput(
        currentOnlyPair.loan.captureId,
        currentOnlyPair.loan.records[0]!.sourceRecordKey,
        currentOnlyConnection,
        currentOnlyPair.loan.identity.identityEpochKey,
        "current-only-mandate-account",
        "beneficiary",
        { evidenceKind: "repayment-mandate" },
      ),
    );
    const currentOnly = await resolveLoanRepaymentRelations(currentOnlyPair.store, {
      sourceConnectionKey: currentOnlyConnection,
      integrationNamespace: "fubon",
    });
    assert.equal(currentOnly.outcome, "no-admission");
    assert.equal(queryCurrentLoanRepaymentRelations(currentOnlyPair.store).length, 0);
  } finally {
    const directory = currentOnlyPair.store.databasePath.slice(0, currentOnlyPair.store.databasePath.lastIndexOf("/"));
    currentOnlyPair.store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("account evidence has priority over fixed-note fallback", async () => {
  const sourceConnectionKey = token("account-priority-connection");
  const pair = await commitPair(sourceConnectionKey, token("account-priority-deposit-epoch"), "account-priority");
  try {
    await persistCounterpartyAccountEvidence(
      pair.store,
      evidenceInput(
        pair.deposit.captureId,
        pair.deposit.records[0]!.occurrenceKey,
        sourceConnectionKey,
        pair.deposit.identity.identityEpochKey,
        "priority-account",
      ),
    );
    await persistCounterpartyAccountEvidence(
      pair.store,
      evidenceInput(
        pair.loan.captureId,
        pair.loan.records[0]!.sourceRecordKey,
        sourceConnectionKey,
        pair.loan.identity.identityEpochKey,
        "priority-account",
      ),
    );
    await persistInstitutionGeneratedRepaymentNoteEvidence(
      pair.store,
      institutionNoteInput(
        pair.deposit.captureId,
        pair.deposit.records[0]!.occurrenceKey,
        sourceConnectionKey,
        pair.deposit.identity.identityEpochKey,
      ),
    );
    const result = await resolveLoanRepaymentRelations(pair.store, {
      sourceConnectionKey,
      integrationNamespace: "fubon",
    });
    assert.equal(result.exactRelationIds.length, 1);
    assert.equal(
      (pair.store.db.prepare("SELECT support_kind FROM loan_repayment_relation_events WHERE event_kind = 'observed'").get() as { support_kind?: string }).support_kind,
      "verified-repayment-destination",
    );
  } finally {
    const directory = pair.store.databasePath.slice(0, pair.store.databasePath.lastIndexOf("/"));
    pair.store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("fixed-note fallback refuses wrong currency, invalid authoring, incomplete coverage, and non-collective ambiguity", async () => {
  const invalidPair = await commitPair(token("fixed-note-invalid-connection"), token("fixed-note-invalid-epoch"), "fixed-note-invalid", 1, { depositCurrency: "USD" });
  try {
    const sourceConnectionKey = token("fixed-note-invalid-connection");
    await persistInstitutionGeneratedRepaymentNoteEvidence(
      invalidPair.store,
      institutionNoteInput(
        invalidPair.deposit.captureId,
        invalidPair.deposit.records[0]!.occurrenceKey,
        sourceConnectionKey,
        invalidPair.deposit.identity.identityEpochKey,
      ),
    );
    const wrongCurrency = await resolveLoanRepaymentRelations(invalidPair.store, {
      sourceConnectionKey,
      integrationNamespace: "fubon",
    });
    assert.equal(wrongCurrency.outcome, "no-admission");
    await assert.rejects(
      () => persistInstitutionGeneratedRepaymentNoteEvidence(
        invalidPair.store,
        institutionNoteInput(
          invalidPair.deposit.captureId,
          invalidPair.deposit.records[0]!.occurrenceKey,
          sourceConnectionKey,
          invalidPair.deposit.identity.identityEpochKey,
          { noteValue: "user authored note" },
        ),
      ),
      /fixed provider contract/i,
    );
    const userAuthored = institutionNoteInput(
      invalidPair.deposit.captureId,
      invalidPair.deposit.records[0]!.occurrenceKey,
      sourceConnectionKey,
      invalidPair.deposit.identity.identityEpochKey,
    ) as any;
    userAuthored.contract = { ...userAuthored.contract, generatedBy: "user" };
    await assert.rejects(
      () => persistInstitutionGeneratedRepaymentNoteEvidence(invalidPair.store, userAuthored),
      /live-verified/i,
    );
    const incomplete = await resolveLoanRepaymentRelations(invalidPair.store, {
      sourceConnectionKey,
      integrationNamespace: "fubon",
      requiredCoverage: { complete: false },
    });
    assert.equal(incomplete.outcome, "no-admission");
  } finally {
    const directory = invalidPair.store.databasePath.slice(0, invalidPair.store.databasePath.lastIndexOf("/"));
    invalidPair.store.close();
    await rm(directory, { recursive: true, force: true });
  }

  const ambiguous = await commitPair(token("fixed-note-ambiguous-connection"), token("fixed-note-ambiguous-epoch"), "fixed-note-ambiguous", 2);
  try {
    const sourceConnectionKey = token("fixed-note-ambiguous-connection");
    // One note on a two-by-two amount/date match is not collective proof.
    await persistInstitutionGeneratedRepaymentNoteEvidence(
      ambiguous.store,
      institutionNoteInput(
        ambiguous.deposit.captureId,
        ambiguous.deposit.records[0]!.occurrenceKey,
        sourceConnectionKey,
        ambiguous.deposit.identity.identityEpochKey,
      ),
    );
    const nonCollective = await resolveLoanRepaymentRelations(ambiguous.store, {
      sourceConnectionKey,
      integrationNamespace: "fubon",
    });
    assert.equal(nonCollective.outcome, "no-admission");

    await persistInstitutionGeneratedRepaymentNoteEvidence(
      ambiguous.store,
      institutionNoteInput(
        ambiguous.deposit.captureId,
        ambiguous.deposit.records[1]!.occurrenceKey,
        sourceConnectionKey,
        ambiguous.deposit.identity.identityEpochKey,
      ),
    );
    const collective = await resolveLoanRepaymentRelations(ambiguous.store, {
      sourceConnectionKey,
      integrationNamespace: "fubon",
    });
    assert.equal(collective.settlementGroupIds.length, 1);
    assert.equal(collective.exactRelationIds.length, 0);
  } finally {
    const directory = ambiguous.store.databasePath.slice(0, ambiguous.store.databasePath.lastIndexOf("/"));
    ambiguous.store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
