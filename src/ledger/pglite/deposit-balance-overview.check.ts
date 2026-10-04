import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import test from "node:test";
import { applyPgliteBaseline } from "./baseline.ts";
import {
  commitPGliteCanonicalBalanceCapture,
  type PGliteCanonicalBalanceCaptureRequest,
} from "./balance.ts";
import {
  commitPGliteCanonicalDepositCapture,
  type PGliteCanonicalDepositCommitRequest,
} from "./deposit.ts";
import {
  createPGliteCanonicalOverviewQuery,
  selectPGliteOverviewAssets,
  selectPGliteOverviewLiabilities,
} from "./overview.ts";
import { readPGliteDailyHistory, readPGliteDailyHistoryWithAccounts } from "./daily-history.ts";
import { exchangeRateRequestFromOverview } from "../exchange-rate-requirements.ts";
import { PGliteStore } from "./transaction.ts";
import {
  FUBON_DOMESTIC_DEPOSIT_ABSENCE_AUTHORITY,
  FUBON_DOMESTIC_DEPOSIT_CAPTURE_FIXTURE_V2,
  FUBON_DOMESTIC_DEPOSIT_COMPLETENESS_BASIS,
  FUBON_DOMESTIC_DEPOSIT_EFFECTIVE_TIME_BASIS,
  FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
  FUBON_DOMESTIC_DEPOSIT_FINANCIAL_CURRENCY,
  FUBON_DOMESTIC_DEPOSIT_FINANCIAL_EVIDENCE_VERSION,
  FUBON_DOMESTIC_DEPOSIT_OCCURRENCE_RULE_VERSION,
  FUBON_DOMESTIC_DEPOSIT_POSTING_BASIS,
  FUBON_DOMESTIC_DEPOSIT_POSTING_ORIGIN,
  FUBON_DOMESTIC_DEPOSIT_TIME_ZONE,
  admitFubonDomesticDepositCaptureEvidence,
  admitFubonDomesticDepositFinancialCapture,
  deriveFubonDomesticDepositAccountIdentity,
} from "../canonical/fubon-domestic-deposit.ts";
import { FUBON_HUMAN_ATTESTED_V1_MANIFEST } from "../canonical/fubon-human-attestation.ts";
import { deriveSourceConnectionIdentityKey } from "../canonical/source-connection-identity.ts";
import { createForeignCurrencyDepositCapture } from "../canonical/foreign-currency-deposit-admission.ts";
import { YUANTA_FOREIGN_CURRENCY_DEPOSIT_FIXTURE_V1 } from "../canonical/foreign-currency-deposit.fixtures.ts";

const token = (value: string): string => `sha256:${createHash("sha256").update(value).digest("base64url")}`;

const accountNumber = {
  value: "123456",
  kind: "depository-account" as const,
  evidenceVersion: "synthetic-account-v1",
  sourceField: "accountNumber",
};

function depositRequest(
  captureId: string,
  options: {
    includeStatementEvidence?: boolean;
    includeConversionEvidence?: boolean;
    accountNo?: string;
    sourceAccountKey?: string;
  } = {},
): PGliteCanonicalDepositCommitRequest {
  const occurrenceKey = token(`${captureId}:occurrence`);
  const accountNo = options.accountNo ?? accountNumber.value;
  const sourceAccountKey = options.sourceAccountKey ?? accountNo;
  const accountNumberEvidence = { ...accountNumber, value: accountNo };
  const balanceAfter = options.includeConversionEvidence ? { coefficient: "95", scale: 0 } : null;
  const compactJson = JSON.stringify({ amount: { coefficient: "100", scale: 0 }, accountNumber: accountNo, balanceAfter });
  return {
    capture: {
      captureId,
      authorityRoute: "cathay/domestic-deposit/v1",
      contractVersion: "v1",
      identity: {
        integrationNamespace: "cathay",
        sourceConnectionKey: token("connection"),
        identityEpochKey: token("epoch"),
        stream: "domestic-deposit",
        recordKind: "synthetic-deposit",
        subjectDigest: token("subject"),
        accountNo,
        sourceAccountKey,
        accountNumber: accountNumberEvidence,
        accountType: "depository",
        currency: "TWD",
      },
      observedAt: "2026-09-22T00:00:00.000Z",
      scope: {
        startDate: "2026-09-22",
        endDate: "2026-09-22",
        scopeKind: "bounded-range",
        completeness: "complete-range",
        completenessBasis: "synthetic-complete-range",
        completenessRuleVersion: "cathay/domestic-deposit/v1",
        absenceAuthority: "comparable-complete-range",
        contractFingerprint: token("contract"),
        preflightFingerprint: token("preflight"),
        pageCount: 1,
        withdrawalPolicy: options.includeStatementEvidence ? "never-infer" : "allow-inference",
      },
      semantics: {
        postingStatus: "posted",
        postingOrigin: "provider_booked_history",
        postingBasis: "query-status-success-with-accounting-date",
        postingRuleVersion: "cathay/domestic-deposit/v1",
        economicStatus: "normal",
        administrativeState: "active",
        semanticRuleVersion: "cathay/domestic-deposit/v1",
        effectiveTimeBasis: "accounting",
        effectiveTimeRuleVersion: "cathay/domestic-deposit/v1",
        timeZone: "Asia/Taipei",
        timePrecision: "second",
        timeOrigin: "source_reported",
        requireBalance: false,
      },
      pages: [{
        pageOrdinal: 0,
        responseCode: "200",
        terminal: true,
        rowCount: options.includeStatementEvidence ? 2 : 1,
        responseDigest: token(`${captureId}:page`),
        proofKind: "synthetic",
        contractFingerprint: token("contract"),
        preflightFingerprint: token("preflight"),
        metadataJson: JSON.stringify({ provider: "synthetic" }),
      }],
      records: [{
        occurrenceKey,
        collisionKey: token(`${captureId}:collision`),
        providerKey: token(`${captureId}:provider`),
        contentHash: token(`${captureId}:content`),
        sequenceLexeme: "1",
        compactJson,
        amount: { coefficient: "100", scale: 0 },
        balanceAfter,
        currency: "TWD",
        direction: "inflow",
        sourceTime: {
          localDate: "2026-09-22",
          localTime: "12:00:00",
          timeZone: "Asia/Taipei",
          epochMilliseconds: Date.parse("2026-09-22T12:00:00+08:00"),
          precision: "second",
          timeOrigin: "source_reported",
        },
        effectiveOn: "2026-09-22",
        transactionDateTimeLocal: "2026-09-22T12:00:00",
        description: "synthetic deposit",
        ...(options.includeConversionEvidence
          ? {
              conversionEvidence: {
                originalAmount: { coefficient: "250", scale: 2 },
                originalCurrency: "USD",
                bookedAmount: { coefficient: "100", scale: 0 },
                bookedCurrency: "TWD",
                sourceReportedRate: {
                  amount: { coefficient: "40", scale: 2 },
                  baseCurrency: "USD",
                  quoteCurrency: "TWD",
                  observedOn: "2026-09-22",
                },
                impliedRate: null,
                comparison: "not-comparable" as const,
                feeAmount: null,
                feeCurrency: null,
                evidenceOrigin: "synthetic-conversion-v1",
              },
            }
          : {}),
      }],
      ...(options.includeStatementEvidence
        ? {
            nonTransactionRecords: [{
              recordType: "statement-evidence" as const,
              recordKind: "synthetic-statement",
              occurrenceKey: token(`${captureId}:statement`),
              collisionKey: token(`${captureId}:statement-collision`),
              providerKey: token(`${captureId}:statement-provider`),
              contentHash: token(`${captureId}:statement-content`),
              sequenceLexeme: "2",
              compactJson: JSON.stringify({ statementId: `${captureId}-statement`, closing: "2026-09-22" }),
              description: "synthetic statement evidence",
            }],
          }
        : {}),
    },
  };
}

function balanceRequest(
  captureId: string,
  effectiveAt: string,
  coefficient: string,
  options: { currency?: string; accountCurrency?: string; sourceAccountKey?: string; accountNo?: string } = {},
): PGliteCanonicalBalanceCaptureRequest {
  const occurrenceKey = token(`${captureId}:occurrence`);
  const date = effectiveAt.slice(0, 10);
  const currency = options.currency ?? "TWD";
  const sourceAccountKey = options.sourceAccountKey ?? accountNumber.value;
  const accountNo = options.accountNo ?? sourceAccountKey;
  return {
    capture: {
      captureId,
      integrationNamespace: "cathay",
      sourceConnectionKey: token("connection"),
      identityEpoch: token("epoch"),
      stream: "domestic-deposit",
      recordKind: "synthetic-balance",
      routeKey: "cathay/domestic-deposit/current-balance-v1",
      contractVersion: "cathay/current-deposit-balance-v1",
      subjectDigest: token(`${captureId}:subject`),
      observedAt: "2026-09-22T00:01:00.000Z",
      accountNumber: null,
      scope: {
        startDate: date,
        endDate: date,
        dateFormat: "YYYY-MM-DD",
        kind: "point-in-time",
        completeness: "single-page",
        ruleVersion: "cathay/current-deposit-balance-v1",
        sourceAccountKey,
        accountNo,
      },
      pages: [{
        pageOrdinal: 0,
        responseCode: "200",
        terminal: true,
        rowCount: 1,
        metadata: { provider: "synthetic" },
      }],
      records: [{
        occurrenceKey,
        collisionKey: token(`${captureId}:collision`),
        providerKey: token(`${captureId}:provider`),
        contentHash: token(`${captureId}:content`),
        compact: { balance: { coefficient, scale: 0 }, effectiveAt },
      }],
    },
    account: {
      sourceAccountKey,
      accountType: "depository",
      currency: options.accountCurrency ?? "TWD",
    },
    observations: [{
      observationKey: token("ledger-observation"),
      balanceKind: "ledger",
      balance: { coefficient, scale: 0 },
      currency,
      effectiveAt,
      effectiveTimeBasis: "provider-system-time",
      effectiveTimeRuleVersion: "cathay/current-deposit-balance-v1",
      evidenceSourceRecordKey: occurrenceKey,
      evidenceSourceField: "balance",
      evidenceSourceValue: coefficient,
      evidenceContractVersion: "cathay/current-deposit-balance-v1",
      sourceOccurrenceKey: occurrenceKey,
    }],
  };
}

async function seedInvestmentOverviewFixture(store: PGliteStore): Promise<void> {
  const id = (value: number): Uint8Array => Uint8Array.from({ length: 16 }, () => value);
  const commitId = id(41);
  const connectionId = id(42);
  const epochId = id(43);
  const accountId = id(44);
  const captureId = id(45);
  const sourceRecordId = id(46);
  const securityId = id(47);
  const transactionId = id(48);
  const transactionRecordId = id(49);
  const marginRecordId = id(50);
  await store.query(
    "INSERT INTO canonical_commits(commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind) VALUES ($1, 1, 1, 'yuanta-trade/investment/canonical-v1', 'source_capture')",
    [commitId],
  );
  await store.query(
    "INSERT INTO source_connections(source_connection_id, integration_namespace, source_connection_key, created_commit_id) VALUES ($1, 'yuanta-trade', 'fixture-broker-connection', $2)",
    [connectionId, commitId],
  );
  await store.query(
    "INSERT INTO identity_epochs(identity_epoch_id, source_connection_id, epoch_key, created_commit_id) VALUES ($1, $2, 'fixture-broker-epoch', $3)",
    [epochId, connectionId, commitId],
  );
  await store.query(
    "INSERT INTO source_authority_routes(authority_route, integration_namespace, stream, contract_version, created_commit_id) VALUES ('yuanta-trade/investment/canonical-v1', 'yuanta-trade', 'investment', 'yuanta-trade/investment/canonical-v1', $1)",
    [commitId],
  );
  await store.query(
    "INSERT INTO financial_accounts(account_id, source_connection_id, identity_epoch_id, stream, source_account_key, account_no, account_type, currency, created_commit_id) VALUES ($1, $2, $3, 'investment', 'brokerage-1', 'BR-001', 'investment', 'TWD', $4)",
    [accountId, connectionId, epochId, commitId],
  );
  await store.query(
    "INSERT INTO investment_accounts(account_id, source_connection_id, identity_epoch_id, source_id, account_key, account_type, account_subtype) VALUES ($1, $2, $3, 'yuanta-trade', 'brokerage-1', 'investment', NULL)",
    [accountId, connectionId, epochId],
  );
  await store.query(
    "INSERT INTO source_captures(capture_id, capture_key, source_connection_id, identity_epoch_id, authority_route, stream, record_kind, source_account_key, observed_at, scope_start, scope_end, completeness, completeness_basis, completeness_rule_version, commit_id) VALUES ($1, 'fixture-investment-capture', $2, $3, 'yuanta-trade/investment/canonical-v1', 'investment', 'investment', 'brokerage-1', '2026-09-22T01:00:00.000Z', '2026-09-22', '2026-09-22', 'single-page', 'fixture', 'yuanta-trade/investment/canonical-v1', $4)",
    [captureId, connectionId, epochId, commitId],
  );
  await store.query(
    "INSERT INTO investment_captures(capture_id, commit_id, source_id, contract_version) VALUES ($1, $2, 'yuanta-trade', 'yuanta-trade/investment/canonical-v1')",
    [captureId, commitId],
  );
  await store.query(
    "INSERT INTO source_records(source_record_id, capture_id, commit_id, record_kind, sequence_lexeme, occurrence_key, description, payload_json) VALUES ($1, $2, $3, 'investment-holding', '1', 'holding-1', 'Acme holding', '{\"description\":\"Acme holding\"}')",
    [sourceRecordId, captureId, commitId],
  );
  await store.query(
    "INSERT INTO source_records(source_record_id, capture_id, commit_id, record_kind, sequence_lexeme, occurrence_key, description, payload_json) VALUES ($1, $2, $3, 'investment-transaction', '2', 'transaction-1', 'Acme buy', '{\"description\":\"Acme buy\"}')",
    [transactionRecordId, captureId, commitId],
  );
  await store.query(
    "INSERT INTO source_records(source_record_id, capture_id, commit_id, record_kind, sequence_lexeme, occurrence_key, description, payload_json) VALUES ($1, $2, $3, 'investment-margin', '3', 'margin-1', 'Margin loan', '{}')",
    [marginRecordId, captureId, commitId],
  );
  await store.query(
    "INSERT INTO investment_securities(security_id, source_id, security_key, producer_security_id, name, ticker, currency, security_type) VALUES ($1, 'yuanta-trade', 'acme-equity', 'ACME', 'Acme Equity', 'ACME', 'TWD', 'equity')",
    [securityId],
  );
  await store.query(
    "INSERT INTO investment_holding_observations(observation_id, capture_id, commit_id, account_id, security_id, source_record_id, measurement_key, correction_of_observation_id, revision_number, is_current, quantity_coefficient, quantity_scale, valuation_coefficient, valuation_scale, valuation_currency, cost_coefficient, cost_scale, cost_currency, effective_on, observed_at, lineage_json) VALUES ($1, $2, $3, $4, $5, $6, 'holding-1', NULL, 1, 1, '5', 0, '12500', 0, 'TWD', '10000', 0, 'TWD', '2026-09-22', '2026-09-22T01:00:00.000Z', '{\"page\":1,\"row\":1}')",
    [id(51), captureId, commitId, accountId, securityId, sourceRecordId],
  );
  await store.query(
    "INSERT INTO financial_transactions(transaction_id, account_id, source_sequence, created_commit_id) VALUES ($1, $2, 'transaction-1', $3)",
    [transactionId, accountId, commitId],
  );
  await store.query(
    `INSERT INTO transaction_revisions(
       revision_id, transaction_id, source_record_id, capture_id, commit_id,
       revision_number, amount_coefficient, amount_scale, currency, direction,
       posting_status, posting_origin, posting_basis, posting_rule_version,
       description, economic_status, administrative_state, semantic_rule_version,
       effective_on, transaction_date_time_local, time_zone, time_precision,
       time_origin, effective_time_basis, effective_time_rule_version, utc_instant_utc_us
     ) VALUES ($1, $2, $3, $4, $5, 1, '10000', 0, 'TWD', 'outflow', 'posted',
               'provider_booked_history', 'query-status-success-with-accounting-date',
               'yuanta-trade/investment/canonical-v1', 'Acme buy', 'normal', 'active',
               'yuanta-trade/investment/canonical-v1', '2026-09-22', '2026-09-22T00:00:00',
               'Asia/Taipei', 'date', 'source_reported', 'accounting',
               'yuanta-trade/investment/canonical-v1', 0)`,
    [id(53), transactionId, transactionRecordId, captureId, commitId],
  );
  await store.query(
    "INSERT INTO investment_transactions(transaction_id, capture_id, commit_id, account_id, security_id, source_record_id, action, quantity_coefficient, quantity_scale, cash_coefficient, cash_scale, cash_currency, effective_on, funding_evidence_json) VALUES ($1, $2, $3, $4, $5, $6, 'buy', '5', 0, '10000', 0, 'TWD', '2026-09-22', '{\"description\":\"Acme buy\"}')",
    [transactionId, captureId, commitId, accountId, securityId, transactionRecordId],
  );
  await store.query(
    "INSERT INTO investment_margin_balance_observations(observation_id, capture_id, commit_id, account_id, source_record_id, balance_kind, coefficient, scale, currency, effective_on) VALUES ($1, $2, $3, $4, $5, 'margin_loan', '200', 0, 'TWD', '2026-09-22')",
    [id(52), captureId, commitId, accountId, marginRecordId],
  );
}

test("PGlite deposit and balance commands feed current and historical overview atomically", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteBaseline(database);
    const deposit = await commitPGliteCanonicalDepositCapture(
      store,
      depositRequest("deposit-1", { includeStatementEvidence: true, includeConversionEvidence: true }),
      { clock: () => 100 },
    );
    assert.equal(deposit.transactions.length, 1);
    assert.equal(deposit.balanceRevisionCount, 0);
    assert.deepEqual(
      (await store.query<{ scope_kind: string; completeness: string }>(
        `SELECT scope_kind, completeness
           FROM capture_scopes
          WHERE capture_id = (SELECT capture_id FROM source_captures WHERE capture_key = $1)`,
        ["deposit-1"],
      )).rows,
      [{ scope_kind: "bounded-range", completeness: "complete-range" }],
    );
    assert.equal(
      (await store.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count
           FROM source_records
          WHERE capture_id = (SELECT capture_id FROM source_captures WHERE capture_key = $1)`,
        ["deposit-1"],
      )).rows[0]?.count,
      2,
    );
    assert.deepEqual(
      (await store.query<{ original_currency: string; booked_currency: string; evidence_origin: string }>(
        `SELECT original_currency, booked_currency, evidence_origin
           FROM transaction_conversion_evidence
          WHERE revision_id = (SELECT revision_id FROM transaction_revisions LIMIT 1)`,
      )).rows,
      [{ original_currency: "USD", booked_currency: "TWD", evidence_origin: "synthetic-conversion-v1" }],
    );
    assert.deepEqual(
      (await store.query<{ balance_after: unknown }>(
        `SELECT payload_json::jsonb -> 'balanceAfter' AS balance_after
           FROM source_records
          WHERE capture_id = (SELECT capture_id FROM source_captures WHERE capture_key = $1)
            AND sequence_lexeme = '1'`,
        ["deposit-1"],
      )).rows,
      [{ balance_after: { coefficient: "95", scale: 0 } }],
    );
    assert.deepEqual(
      (await store.query<{ cursor: string | null; stream: string }>(
        `SELECT cursor, stream FROM source_sync_states
          WHERE account_id = (SELECT account_id FROM capture_scopes WHERE capture_id = (SELECT capture_id FROM source_captures WHERE capture_key = $1))`,
        ["deposit-1"],
      )).rows,
      [{ cursor: null, stream: "domestic-deposit" }],
    );

    const firstBalance = await commitPGliteCanonicalBalanceCapture(
      store,
      balanceRequest("balance-1", "2026-09-22T04:00:00.000Z", "1000"),
      { clock: () => 200 },
    );
    assert.equal(firstBalance.revisionCount, 1);
    assert.equal(firstBalance.deduplicatedRevisionCount, 0);
    const recurrence = await commitPGliteCanonicalBalanceCapture(
      store,
      balanceRequest("balance-2", "2026-09-22T04:00:00.000Z", "1000"),
      { clock: () => 200 },
    );
    assert.equal(recurrence.revisionCount, 0);
    assert.equal(recurrence.deduplicatedRevisionCount, 1);
    const later = await commitPGliteCanonicalBalanceCapture(
      store,
      balanceRequest("balance-3", "2026-09-22T05:00:00.000Z", "1100"),
      { clock: () => 200 },
    );
    assert.equal(later.revisionCount, 1);
    await commitPGliteCanonicalBalanceCapture(
      store,
      balanceRequest("balance-4", "2026-09-25T04:00:00.000Z", "1300"),
      { clock: () => 200 },
    );
    await commitPGliteCanonicalDepositCapture(
      store,
      depositRequest("deposit-second-account", {
        accountNo: "654321",
        sourceAccountKey: "654321",
      }),
      { clock: () => 200 },
    );
    await commitPGliteCanonicalBalanceCapture(
      store,
      balanceRequest("balance-second-account", "2026-09-24T06:00:00.000Z", "500", {
        sourceAccountKey: "654321",
        accountNo: "654321",
      }),
      { clock: () => 200 },
    );
    await commitPGliteCanonicalBalanceCapture(
      store,
      balanceRequest("balance-usd", "2026-09-22T06:00:00.000Z", "425", {
        currency: "USD",
      }),
      { clock: () => 200 },
    );

    const overview = createPGliteCanonicalOverviewQuery(store);
    const current = await overview.current();
    assert.equal(current.projection.availability, "available");
    assert.equal(current.projection.accounts.length, 2);
    assert.deepEqual(
      current.projection.accounts.find((account) => account.amounts[0]?.currency === "TWD")?.amounts[0]?.exact,
      { coefficient: "1300", scale: 0 },
    );
    assert.equal(current.projection.transactions.length, 2);
    assert.ok(current.projection.accounts.some((account) => account.accountNo === accountNumber.value));
    const historical = await overview.historical({ knowledgeAt: firstBalance.commitSequence });
    assert.deepEqual(
      historical.projection.accounts.find((account) => account.accountNo === accountNumber.value)?.amounts[0]?.exact,
      { coefficient: "1000", scale: 0 },
    );

    const dailyHistory = await readPGliteDailyHistory(
      store,
      current.projection.knowledgePoint,
      current.projection.accounts,
    );
    assert.deepEqual(dailyHistory.map((row) => row.date), ["2026-09-22", "2026-09-24", "2026-09-25"]);
    assert.deepEqual(dailyHistory[0]?.assets.map(({ currency, exact }) => ({ currency, exact })), [
      { currency: "TWD", exact: { coefficient: "1100", scale: 0 } },
      { currency: "USD", exact: { coefficient: "425", scale: 0 } },
    ]);
    assert.deepEqual(dailyHistory[1]?.assets.map(({ currency, exact }) => ({ currency, exact })), [
      { currency: "TWD", exact: { coefficient: "1600", scale: 0 } },
      { currency: "USD", exact: { coefficient: "425", scale: 0 } },
    ]);
    assert.deepEqual(dailyHistory[1]?.dailyChange.map(({ currency, exact }) => ({ currency, exact })), [
      { currency: "TWD", exact: { coefficient: "500", scale: 0 } },
    ]);
    assert.deepEqual(dailyHistory[2]?.assets.map(({ currency, exact }) => ({ currency, exact })), [
      { currency: "TWD", exact: { coefficient: "1800", scale: 0 } },
      { currency: "USD", exact: { coefficient: "425", scale: 0 } },
    ]);
    assert.deepEqual(dailyHistory[2]?.dailyChange.map(({ currency, exact }) => ({ currency, exact })), [
      { currency: "TWD", exact: { coefficient: "200", scale: 0 } },
    ]);
    assert.equal(dailyHistory[0]?.accountChanges.length, 1);
    assert.equal(dailyHistory[1]?.accountChanges.length, 1);
    const withAccounts = await readPGliteDailyHistoryWithAccounts(
      store,
      current.projection.knowledgePoint,
      current.projection.accounts,
    );
    assert.deepEqual(withAccounts.dailyHistory, dailyHistory);
    assert.deepEqual(
      Object.keys(withAccounts.dailyHistoryByAccount).sort(),
      current.projection.accounts.map((account) => account.id).sort(),
    );
    for (const row of dailyHistory) {
      const carried = new Map<string, number>();
      for (const rows of Object.values(withAccounts.dailyHistoryByAccount)) {
        const latest = rows.filter((item) => item.date <= row.date).at(-1);
        for (const amount of latest?.assets ?? []) carried.set(amount.currency, (carried.get(amount.currency) ?? 0) + amount.value);
      }
      assert.deepEqual(
        Object.fromEntries(carried),
        Object.fromEntries(row.assets.map((amount) => [amount.currency, amount.value])),
        `per-account history must sum to the total on ${row.date}`,
      );
    }
    assert.deepEqual(exchangeRateRequestFromOverview({ dailyHistory }), {
      requiredFrom: "2026-09-22",
      currencies: ["USD"],
    });

    await assert.rejects(
      commitPGliteCanonicalBalanceCapture(
        store,
        balanceRequest("balance-conflict", "2026-09-22T05:00:00.000Z", "1200"),
        { clock: () => 200 },
      ),
      /contradicts/u,
    );
    assert.deepEqual(
      (await store.query<{ count: number | string }>("SELECT COUNT(*) AS count FROM source_captures")).rows,
      [{ count: 8 }],
    );
  } finally {
    await store.close();
  }
});

test("PGlite deposit command preserves foreign-currency account scope and exact row currency", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteBaseline(database);
    const foreignCapture = createForeignCurrencyDepositCapture(YUANTA_FOREIGN_CURRENCY_DEPOSIT_FIXTURE_V1);
    const committed = await commitPGliteCanonicalDepositCapture(store, foreignCapture, { clock: () => 300 });
    assert.equal(committed.transactions[0]?.amount.coefficient, "1025");
    const overview = await createPGliteCanonicalOverviewQuery(store).current();
    // This fixture exposes only the opaque source account key. The display
    // account number remains nullable until the provider supplies explicit
    // account-number evidence.
    assert.equal(overview.projection.accounts[0]?.accountNo, null);
    assert.deepEqual(overview.projection.transactions[0]?.amount, { coefficient: "1025", scale: 2 });
    assert.equal(overview.projection.transactions[0]?.currency, "USD");
  } finally {
    await store.close();
  }
});

test("PGlite deposit identity is independent of collection sequence across captures", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteBaseline(database);
    const first = depositRequest("stable-first");
    const later = depositRequest("stable-later");
    const laterRecord = {
      ...later.capture.records[0]!,
      amount: { coefficient: "200", scale: 0 },
      compactJson: JSON.stringify({ amount: { coefficient: "200", scale: 0 }, accountNumber: accountNumber.value, balanceAfter: null }),
    };
    await commitPGliteCanonicalDepositCapture(store, first);
    const shifted = {
      capture: {
        ...first.capture,
        captureId: "stable-recapture",
        records: [
          { ...laterRecord, sequenceLexeme: "1" },
          { ...first.capture.records[0]!, sequenceLexeme: "2" },
        ],
        pages: [{ ...first.capture.pages[0]!, rowCount: 2 }],
      },
    };
    await commitPGliteCanonicalDepositCapture(store, shifted);
    assert.equal((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM financial_transactions")).rows[0]?.count, 2);
    assert.equal((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM transaction_revisions")).rows[0]?.count, 2);
  } finally {
    await store.close();
  }
});

test("PGlite deposit command accepts a provider-built Fubon financial capture", async () => {
  const structural = admitFubonDomesticDepositCaptureEvidence(FUBON_DOMESTIC_DEPOSIT_CAPTURE_FIXTURE_V2);
  assert.equal(structural.status, "admissible");
  assert.ok(structural.capture);
  const sourceConnectionScope = "PGLITE-FUBON-USER-001\u0000PGLITE-FUBON-LOGIN-001";
  const sourceConnectionKey = deriveSourceConnectionIdentityKey("fubon", sourceConnectionScope);
  const identity = deriveFubonDomesticDepositAccountIdentity(
    structural.capture.account,
    FUBON_HUMAN_ATTESTED_V1_MANIFEST,
    sourceConnectionKey,
  );
  const financial = admitFubonDomesticDepositFinancialCapture({
    capture: structural.capture,
    captureId: "pglite-fubon-provider-built",
    sourceConnectionScope,
    sourceConnectionKey,
    humanAttestation: FUBON_HUMAN_ATTESTED_V1_MANIFEST,
    semantics: {
      evidenceVersion: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_EVIDENCE_VERSION,
      account: { ...identity, accountType: "depository", currency: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_CURRENCY },
      authority: { route: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY, scope: "personal-owned-accounts", membershipEffectiveDate: null },
      posting: { status: "posted", origin: FUBON_DOMESTIC_DEPOSIT_POSTING_ORIGIN, basis: FUBON_DOMESTIC_DEPOSIT_POSTING_BASIS, ruleVersion: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY },
      direction: { outflowCellIndex: 3, inflowCellIndex: 4, ruleVersion: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY },
      effectiveTime: { basis: FUBON_DOMESTIC_DEPOSIT_EFFECTIVE_TIME_BASIS, timeZone: FUBON_DOMESTIC_DEPOSIT_TIME_ZONE, ruleVersion: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY },
      cancellation: { rule: "explicit-none-only", ruleVersion: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY },
      completeness: { basis: FUBON_DOMESTIC_DEPOSIT_COMPLETENESS_BASIS, ruleVersion: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY, absenceAuthority: FUBON_DOMESTIC_DEPOSIT_ABSENCE_AUTHORITY },
      occurrence: { ruleVersion: FUBON_DOMESTIC_DEPOSIT_OCCURRENCE_RULE_VERSION, providerGuaranteed: false },
    },
  });
  assert.equal(financial.status, "admitted");
  assert.ok(financial.capture);

  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteBaseline(database);
    const committed = await commitPGliteCanonicalDepositCapture(store, financial.capture, { clock: () => 350 });
    assert.equal(committed.transactions.length, 1);
    assert.deepEqual(
      (await store.query<{ currency: string }>(
        "SELECT currency FROM transaction_revisions ORDER BY revision_number LIMIT 1",
      )).rows,
      [{ currency: "TWD" }],
    );
    assert.equal((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM source_records")).rows[0]?.count, 1);
  } finally {
    await store.close();
  }
});

test("complete deposit ranges withdraw omitted prior source assertions without deleting evidence", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteBaseline(database);
    await commitPGliteCanonicalDepositCapture(store, depositRequest("withdrawal-seed"), { clock: () => 400 });
    const omittedSeed = depositRequest("withdrawal-empty");
    const omitted: PGliteCanonicalDepositCommitRequest = {
      ...omittedSeed,
      capture: {
        ...omittedSeed.capture,
        pages: omittedSeed.capture.pages.map((page) => ({ ...page, rowCount: 0 })),
        records: [],
      },
    };
    const emptyResult = await commitPGliteCanonicalDepositCapture(store, omitted, { clock: () => 400 });
    assert.equal(emptyResult.transactions.length, 0);
    const lifecycle = await store.query<{ event_kind: string }>(
      `SELECT transition.event_kind
         FROM assertion_transitions transition
         JOIN canonical_commits commit_row ON commit_row.commit_id = transition.commit_id
        WHERE transition.capture_id = (SELECT capture_id FROM source_captures WHERE capture_key = $1)
        ORDER BY commit_row.commit_sequence DESC`,
      ["withdrawal-empty"],
    );
    assert.deepEqual(lifecycle.rows.map((row) => row.event_kind), ["withdrawn"]);
    assert.equal((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM source_records")).rows[0]?.count, 1);
  } finally {
    await store.close();
  }
});

test("overview preserves investment holdings, transactions, margin lineage, and group selectors", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteBaseline(database);
    await seedInvestmentOverviewFixture(store);
    const projection = (await createPGliteCanonicalOverviewQuery(store).current()).projection;
    const account = projection.accounts[0];
    assert.ok(account);
    assert.equal(account.accountType, "investment");
    assert.equal(account.group, "investment");
    assert.equal(account.kind, "brokerage");
    assert.deepEqual(account.amounts[0]?.exact, { coefficient: "12500", scale: 0 });
    assert.deepEqual(account.marginAmounts[0]?.exact, { coefficient: "200", scale: 0 });
    assert.equal(account.positions[0]?.label, "Acme Equity");
    assert.deepEqual(account.positions[0]?.amount?.exact, { coefficient: "12500", scale: 0 });
    assert.deepEqual(account.positions[0]?.units, { coefficient: "5", scale: 0 });
    assert.equal(projection.positions.length, 1);
    assert.equal(projection.transactions[0]?.direction, "outflow");
    assert.equal(projection.transactions[0]?.description, "Acme buy");
    assert.equal(projection.sourceGaps.length, 0);
    const dailyHistory = await readPGliteDailyHistory(store, projection.knowledgePoint, projection.accounts);
    assert.deepEqual(dailyHistory.map((row) => row.date), ["2026-09-22"]);
    assert.deepEqual(dailyHistory[0]?.assets.map(({ currency, exact }) => ({ currency, exact })), [
      { currency: "TWD", exact: { coefficient: "12500", scale: 0 } },
    ]);
    assert.deepEqual(dailyHistory[0]?.liabilities, []);
    assert.equal(dailyHistory[0]?.positionCount, 1);
    const historical = await createPGliteCanonicalOverviewQuery(store).historical({
      knowledgeAt: 1,
      financialAt: "2026-09-22",
    });
    assert.equal(historical.projection.positions.length, 1);
    assert.equal(historical.projection.transactions.length, 1);
    assert.equal(historical.projection.knowledgePoint, 1);
    const assets = selectPGliteOverviewAssets(projection);
    assert.equal(assets.accounts.length, 1);
    assert.equal(assets.positions.length, 1);
    assert.equal(assets.transactions.length, 1);
    const liabilities = selectPGliteOverviewLiabilities(projection);
    assert.equal(liabilities.accounts.length, 0);
    assert.equal(liabilities.positions.length, 0);
    assert.equal(liabilities.transactions.length, 0);
  } finally {
    await store.close();
  }
});
