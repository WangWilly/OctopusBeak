import assert from "node:assert/strict";
import test from "node:test";
import {
  admitCanonicalFinancialDepositCapture,
  commitCanonicalFinancialDepositCapture,
} from "./canonical-financial-deposit-writer.ts";
import { createCanonicalProjectionRuntime } from "./canonical-projection-runtime.ts";
import { createCanonicalSourceStore } from "./canonical-source-store.ts";
import type { CanonicalSourceAccountIdentifierKind } from "./canonical-source-evidence.ts";

const token = (value: string): `sha256:${string}` =>
  `sha256:${value.repeat(64).slice(0, 64)}` as `sha256:${string}`;

const SOURCE_CONNECTION_KEY = token("identifier-history-connection");
const IDENTITY_EPOCH_KEY = token("identifier-history-epoch");
const SOURCE_ACCOUNT_KEY = token("identifier-history-source-account");
const SUBJECT_DIGEST = token("identifier-history-subject");
const PROVIDER_ACCOUNT_NUMBER = "012345678901";

type AccountNumberInput = Readonly<{
  value: string;
  kind: CanonicalSourceAccountIdentifierKind;
  evidenceVersion?: string;
  sourceField?: string;
}>;

type CaptureOptions = Readonly<{
  captureId: string;
  observedAt?: string;
  accountNo?: string;
  sourceAccountKey?: string;
  accountNumber?: AccountNumberInput | null;
  recordSuffix?: string;
}>;

function accountNumber(input: AccountNumberInput | null | undefined) {
  return input === undefined || input === null
    ? null
    : {
        value: input.value,
        kind: input.kind,
        evidenceVersion: input.evidenceVersion ?? "test/account-number/v1",
        sourceField: input.sourceField ?? "account.number",
      };
}

function recordFor(suffix: string) {
  return {
    occurrenceKey: token(`identifier-history-occurrence-${suffix}`),
    collisionKey: token(`identifier-history-collision-${suffix}`),
    providerKey: token(`identifier-history-provider-${suffix}`),
    contentHash: token(`identifier-history-content-${suffix}`),
    sequenceLexeme: "1",
    compactJson: JSON.stringify({
      source: "synthetic",
      statement: "identifier-history",
      suffix,
    }),
    amount: { coefficient: "1250", scale: 0 },
    balanceAfter: { coefficient: "91250", scale: 0 },
    currency: "TWD",
    direction: "inflow",
    sourceTime: {
      localDate: "2026-09-01",
      localTime: "09:00:00",
      timeZone: "Asia/Taipei",
      epochMilliseconds: Date.parse("2026-09-01T09:00:00+08:00"),
      precision: "second" as const,
      timeOrigin: "source_reported" as const,
    },
    effectiveOn: "2026-09-01",
    transactionDateTimeLocal: "2026-09-01T09:00:00",
    description: "SANITIZED identifier history fixture",
  };
}

function capture({
  captureId,
  observedAt = "2026-09-01T00:00:00.000Z",
  accountNo = SOURCE_ACCOUNT_KEY,
  sourceAccountKey = accountNo,
  accountNumber: identifier,
  recordSuffix = "stable-transaction",
}: CaptureOptions) {
  return admitCanonicalFinancialDepositCapture({
    captureId,
    authorityRoute: "synthetic/domestic-deposit/v8",
    contractVersion: "synthetic-v8",
    identity: {
      integrationNamespace: "synthetic",
      sourceConnectionKey: SOURCE_CONNECTION_KEY,
      identityEpochKey: IDENTITY_EPOCH_KEY,
      stream: "domestic-deposit",
      recordKind: "synthetic-domestic-deposit",
      subjectDigest: SUBJECT_DIGEST,
      accountNo,
      sourceAccountKey,
      accountNumber: accountNumber(identifier),
      accountType: "depository",
      currency: "TWD",
    },
    observedAt,
    scope: {
      startDate: "2026-09-01",
      endDate: "2026-09-08",
      scopeKind: "bounded-range",
      completeness: "complete-range",
      completenessBasis: "test",
      completenessRuleVersion: "test/account-identifier-history/v1",
      absenceAuthority: null,
      contractFingerprint: token("identifier-history-contract"),
      preflightFingerprint: token("identifier-history-preflight"),
      pageCount: 1,
    },
    semantics: {
      postingStatus: "posted",
      postingOrigin: "synthetic_provider_booked_history_v1",
      postingBasis: "synthetic_query_status_success_v1",
      postingRuleVersion: "synthetic-v8",
      economicStatus: "normal",
      administrativeState: "active",
      semanticRuleVersion: "synthetic-v8",
      effectiveTimeBasis: "accounting",
      effectiveTimeRuleVersion: "synthetic-v8",
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
        rowCount: 1,
        responseDigest: token("identifier-history-page"),
        proofKind: "test",
        contractFingerprint: token("identifier-history-contract"),
        preflightFingerprint: token("identifier-history-preflight"),
        metadataJson: '{"fixture":"identifier-history"}',
      },
    ],
    records: [recordFor(recordSuffix)],
  });
}

function projection(store: ReturnType<typeof createCanonicalSourceStore>) {
  return createCanonicalProjectionRuntime(store.db);
}

function accountAndTransactionIdentity(
  store: ReturnType<typeof createCanonicalSourceStore>,
) {
  return store.db
    .prepare(
      `SELECT hex(account.account_id) AS account_id,
              account.source_account_key,
              account.account_no,
              hex(transaction_row.transaction_id) AS transaction_id,
              transaction_row.source_sequence
         FROM financial_accounts account
         JOIN financial_transactions transaction_row
           ON transaction_row.account_id = account.account_id
        WHERE account.source_connection_id = (
          SELECT source_connection_id FROM source_connections
           WHERE source_connection_key = ?
        )
        ORDER BY transaction_row.source_sequence`,
    )
    .all(SOURCE_CONNECTION_KEY) as Array<{
    account_id?: string;
    source_account_key?: string;
    account_no?: string | null;
    transaction_id?: string;
    source_sequence?: string;
  }>;
}

function mutationSnapshot(
  store: ReturnType<typeof createCanonicalSourceStore>,
) {
  const tableNames = store.db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as Array<{ name?: string }>;
  const tableCounts = tableNames.map(({ name }) => {
    assert.ok(name);
    const escaped = name.replaceAll('"', '""');
    const row = store.db
      .prepare(`SELECT COUNT(*) AS count FROM "${escaped}"`)
      .get() as { count?: number };
    return [name, Number(row.count ?? 0)] as const;
  });
  return {
    tableCounts,
    accounts: store.db
      .prepare(
        `SELECT hex(account_id) AS account_id, source_account_key, account_no
           FROM financial_accounts ORDER BY hex(account_id)`,
      )
      .all(),
    identifierObservations: store.db
      .prepare(
        `SELECT hex(observation_id) AS observation_id,
                hex(account_id) AS account_id,
                hex(capture_id) AS capture_id,
                source_record_id,
                hex(commit_id) AS commit_id,
                identifier_kind, identifier_value, evidence_version,
                source_field, observed_at
           FROM financial_account_identifier_observations
          ORDER BY hex(observation_id)`,
      )
      .all(),
    sourceSyncStates: store.db
      .prepare(
        `SELECT hex(source_connection_id) AS source_connection_id,
                hex(account_id) AS account_id, stream, scope_start, scope_end,
                cursor, hex(last_capture_id) AS last_capture_id,
                hex(commit_id) AS commit_id
           FROM source_sync_states ORDER BY hex(account_id), stream`,
      )
      .all(),
    projection: projection(store).read({
      kind: "current",
      families: ["financial-accounts", "transactions"],
      scope: { sourceConnectionKey: SOURCE_CONNECTION_KEY },
    }),
  };
}

test("a later provider account number preserves identity and respects historical knowledge", async () => {
  const store = createCanonicalSourceStore(":memory:");
  try {
    const firstCommit = await commitCanonicalFinancialDepositCapture(
      store,
      capture({
        captureId: "identifier-history-first",
        observedAt: "2026-09-01T00:00:00.000Z",
      }),
    );
    const firstIdentity = accountAndTransactionIdentity(store);
    assert.equal(firstIdentity.length, 1);
    assert.equal(firstIdentity[0]?.source_account_key, SOURCE_ACCOUNT_KEY);
    assert.equal(firstIdentity[0]?.account_no, null);

    const secondCommit = await commitCanonicalFinancialDepositCapture(
      store,
      capture({
        captureId: "identifier-history-numbered",
        observedAt: "2026-09-02T00:00:00.000Z",
        accountNumber: {
          value: PROVIDER_ACCOUNT_NUMBER,
          kind: "depository-account",
        },
      }),
    );
    assert.ok(secondCommit.commitSequence > firstCommit.commitSequence);

    const secondIdentity = accountAndTransactionIdentity(store);
    assert.deepEqual(
      secondIdentity.map(({ account_id, transaction_id, source_sequence }) => ({
        account_id,
        transaction_id,
        source_sequence,
      })),
      firstIdentity.map(({ account_id, transaction_id, source_sequence }) => ({
        account_id,
        transaction_id,
        source_sequence,
      })),
    );
    assert.equal(secondIdentity[0]?.source_account_key, SOURCE_ACCOUNT_KEY);
    assert.equal(secondIdentity[0]?.account_no, PROVIDER_ACCOUNT_NUMBER);

    const identifierRows = (store.db
      .prepare(
        `SELECT identifier_kind, identifier_value, evidence_version,
                source_field, source_record_id
           FROM financial_account_identifier_observations`,
      )
      .all() as Array<{
      identifier_kind?: string;
      identifier_value?: string;
      evidence_version?: string;
      source_field?: string;
      source_record_id?: unknown;
    }>).map((row) => ({ ...row }));
    assert.deepEqual(identifierRows, [
      {
        identifier_kind: "depository-account",
        identifier_value: PROVIDER_ACCOUNT_NUMBER,
        evidence_version: "test/account-number/v1",
        source_field: "account.number",
        source_record_id: null,
      },
    ]);

    const runtime = projection(store);
    const historical = runtime.read({
      kind: "historical",
      families: ["financial-accounts", "transactions"],
      scope: { sourceConnectionKey: SOURCE_CONNECTION_KEY },
      cutoff: {
        financialAt: "2026-09-08",
        knowledgeAt: firstCommit.commitSequence,
      },
    });
    const current = runtime.read({
      kind: "current",
      families: ["financial-accounts", "transactions"],
      scope: { sourceConnectionKey: SOURCE_CONNECTION_KEY },
    });
    assert.equal(historical.families["financial-accounts"][0]?.accountNo, null);
    assert.equal(historical.families.transactions[0]?.accountNumber, null);
    assert.equal(current.families["financial-accounts"][0]?.accountNo, PROVIDER_ACCOUNT_NUMBER);
    assert.equal(current.families.transactions[0]?.accountNumber, PROVIDER_ACCOUNT_NUMBER);
    assert.equal(
      historical.families.transactions[0]?.transactionId,
      current.families.transactions[0]?.transactionId,
    );
    assert.equal(
      historical.families["financial-accounts"][0]?.accountId,
      current.families["financial-accounts"][0]?.accountId,
    );
  } finally {
    store.close();
  }
});

test("unchanged same-capture replay is rejected without mutation", async () => {
  const store = createCanonicalSourceStore(":memory:");
  try {
    const base = capture({
      captureId: "identifier-history-replay",
      accountNumber: {
        value: PROVIDER_ACCOUNT_NUMBER,
        kind: "depository-account",
      },
    });
    await commitCanonicalFinancialDepositCapture(store, base);
    const beforeReplay = mutationSnapshot(store);
    await assert.rejects(
      () => commitCanonicalFinancialDepositCapture(store, base),
      (error: unknown) =>
        error instanceof Error &&
        "reason" in error &&
        (error as { reason?: unknown }).reason === "capture-overwrite",
    );
    assert.deepEqual(mutationSnapshot(store), beforeReplay);
  } finally {
    store.close();
  }
});

test("changed same-capture identifier metadata is rejected atomically", async () => {
  const store = createCanonicalSourceStore(":memory:");
  try {
    await commitCanonicalFinancialDepositCapture(
      store,
      capture({
        captureId: "identifier-history-replay",
        accountNumber: {
          value: PROVIDER_ACCOUNT_NUMBER,
          kind: "depository-account",
        },
      }),
    );
    const changedCaptures = [
      capture({
        captureId: "identifier-history-replay",
        accountNumber: null,
      }),
      capture({
        captureId: "identifier-history-replay",
        accountNumber: {
          value: "012345678902",
          kind: "depository-account",
        },
      }),
      capture({
        captureId: "identifier-history-replay",
        accountNumber: {
          value: PROVIDER_ACCOUNT_NUMBER,
          kind: "depository-account",
          sourceField: "account.number.v2",
        },
      }),
      capture({
        captureId: "identifier-history-replay",
        accountNumber: {
          value: PROVIDER_ACCOUNT_NUMBER,
          kind: "depository-account",
          evidenceVersion: "test/account-number/v2",
        },
      }),
    ];
    for (const changed of changedCaptures) {
      const beforeRejected = mutationSnapshot(store);
      await assert.rejects(() =>
        commitCanonicalFinancialDepositCapture(store, changed),
      );
      assert.deepEqual(mutationSnapshot(store), beforeRejected);
    }
  } finally {
    store.close();
  }
});

test("source-key aliases, numeric keys, and provider identifier kinds are bounded at admission", async () => {
  assert.throws(
    () =>
      capture({
        captureId: "identifier-history-mismatched-alias",
        sourceAccountKey: token("different-source-account"),
      }),
    /source account key.*accountNo|accountNo.*source account key/i,
  );

  const numericKey = "001234567890";
  const numericStore = createCanonicalSourceStore(":memory:");
  try {
    await commitCanonicalFinancialDepositCapture(
      numericStore,
      capture({
        captureId: "identifier-history-numeric-source-key",
        accountNo: numericKey,
        sourceAccountKey: numericKey,
        accountNumber: null,
      }),
    );
    const row = numericStore.db
      .prepare(
        "SELECT source_account_key, account_no FROM financial_accounts WHERE stream = 'domestic-deposit'",
      )
      .get() as { source_account_key?: string; account_no?: string | null };
    assert.equal(row.source_account_key, numericKey);
    assert.equal(row.account_no, null);
  } finally {
    numericStore.close();
  }

  assert.throws(
    () =>
      capture({
        captureId: "identifier-history-wrong-kind",
        accountNumber: {
          value: PROVIDER_ACCOUNT_NUMBER,
          kind: "credit-portfolio-account",
        },
      }),
    /account number kind|incompatible/i,
  );
  assert.throws(
    () =>
      capture({
        captureId: "identifier-history-masked-number",
        accountNumber: {
          value: "******",
          kind: "depository-account",
        },
      }),
    /account number/i,
  );
});
