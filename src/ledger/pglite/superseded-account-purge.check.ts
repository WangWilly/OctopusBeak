import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createBaselinePGlite } from "./baseline-test-template.ts";
import { commitPGliteCanonicalBalanceCapture, type PGliteCanonicalBalanceCaptureRequest } from "./balance.ts";
import { commitPGliteCanonicalDepositCapture } from "./deposit.ts";
import { createPGliteCanonicalOverviewQuery } from "./overview.ts";
import { PGliteStore } from "./transaction.ts";
import {
  previewSupersededAccountPurge,
  purgeSupersededAccount,
  SUPERSEDED_ACCOUNT_PURGE_ID_PREFIX,
  type SupersededAccountPurgeRequest,
} from "./superseded-account-purge.ts";
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
  deriveFubonCompositeAccountNumberEvidence,
  deriveFubonDomesticDepositAccountIdentity,
} from "../canonical/fubon-domestic-deposit.ts";
import { FUBON_HUMAN_ATTESTED_V1_MANIFEST } from "../canonical/fubon-human-attestation.ts";
import { deriveSourceConnectionIdentityKey } from "../canonical/source-connection-identity.ts";
import { uuidV7 } from "../canonical/canonical-local-identifier.ts";

const token = (value: string): string => `sha256:${createHash("sha256").update(value).digest("base64url")}`;

const STREAM = "domestic-deposit";
const DIGITS_A = "12345678901234";
const DIGITS_B = "12345678905678";
const CONNECTION_SCOPE = "PGLITE-PURGE-USER-001\u0000PGLITE-PURGE-LOGIN-001";

function admitFubon(optionValue: string, digits: string, captureId: string, sourceConnectionScope = CONNECTION_SCOPE) {
  const sourceConnectionKey = deriveSourceConnectionIdentityKey("fubon", sourceConnectionScope);
  const raw = structuredClone(FUBON_DOMESTIC_DEPOSIT_CAPTURE_FIXTURE_V2);
  const option = { value: optionValue, label: `${digits} (SYNTHETIC-BRANCH)` };
  const accountNumberEvidence = deriveFubonCompositeAccountNumberEvidence(option);
  assert.ok(accountNumberEvidence);
  const account = { ...option, branchName: "SYNTHETIC-BRANCH", accountNumber: accountNumberEvidence };
  raw.account = account;
  raw.pages = raw.pages.map((page) => ({ ...page, selectedAccount: account }));
  const structural = admitFubonDomesticDepositCaptureEvidence(raw);
  assert.ok(structural.capture, structural.diagnostics.join(","));
  const identity = deriveFubonDomesticDepositAccountIdentity(structural.capture.account, FUBON_HUMAN_ATTESTED_V1_MANIFEST, sourceConnectionKey);
  const financial = admitFubonDomesticDepositFinancialCapture({
    capture: structural.capture,
    captureId,
    sourceConnectionScope,
    sourceConnectionKey,
    humanAttestation: FUBON_HUMAN_ATTESTED_V1_MANIFEST,
    semantics: {
      evidenceVersion: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_EVIDENCE_VERSION,
      account: { ...identity, accountNumber: accountNumberEvidence, accountType: "depository", currency: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_CURRENCY },
      authority: { route: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY, scope: "personal-owned-accounts", membershipEffectiveDate: null },
      posting: { status: "posted", origin: FUBON_DOMESTIC_DEPOSIT_POSTING_ORIGIN, basis: FUBON_DOMESTIC_DEPOSIT_POSTING_BASIS, ruleVersion: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY },
      direction: { outflowCellIndex: 3, inflowCellIndex: 4, ruleVersion: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY },
      effectiveTime: { basis: FUBON_DOMESTIC_DEPOSIT_EFFECTIVE_TIME_BASIS, timeZone: FUBON_DOMESTIC_DEPOSIT_TIME_ZONE, ruleVersion: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY },
      cancellation: { rule: "explicit-none-only", ruleVersion: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY },
      completeness: { basis: FUBON_DOMESTIC_DEPOSIT_COMPLETENESS_BASIS, ruleVersion: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY, absenceAuthority: FUBON_DOMESTIC_DEPOSIT_ABSENCE_AUTHORITY },
      occurrence: { ruleVersion: FUBON_DOMESTIC_DEPOSIT_OCCURRENCE_RULE_VERSION, providerGuaranteed: false },
    },
  });
  assert.ok(financial.capture, financial.diagnostics.join(","));
  return { identity, capture: financial.capture };
}

function fubonBalance(
  captureId: string,
  identity: ReturnType<typeof deriveFubonDomesticDepositAccountIdentity>,
  effectiveAt: string,
  coefficient: string,
): PGliteCanonicalBalanceCaptureRequest {
  const occurrenceKey = token(`${captureId}:occurrence`);
  const date = effectiveAt.slice(0, 10);
  const contractVersion = "fubon/current-deposit-balance-v1";
  return {
    capture: {
      captureId,
      integrationNamespace: "fubon",
      sourceConnectionKey: identity.sourceConnectionKey,
      identityEpoch: identity.identityEpochKey,
      stream: STREAM,
      recordKind: "synthetic-balance",
      routeKey: "fubon/domestic-deposit/current-balance-v1",
      contractVersion,
      subjectDigest: identity.subjectDigest,
      observedAt: effectiveAt,
      accountNumber: null,
      scope: {
        startDate: date,
        endDate: date,
        dateFormat: "YYYY-MM-DD",
        kind: "point-in-time",
        completeness: "single-page",
        ruleVersion: contractVersion,
        sourceAccountKey: identity.accountNo,
        accountNo: identity.accountNo,
      },
      pages: [{ pageOrdinal: 0, responseCode: "200", terminal: true, rowCount: 1, metadata: { provider: "synthetic" } }],
      records: [{
        occurrenceKey,
        collisionKey: token(`${captureId}:collision`),
        providerKey: token(`${captureId}:provider`),
        contentHash: token(`${captureId}:content`),
        compact: { balance: { coefficient, scale: 0 }, effectiveAt },
      }],
    },
    account: { sourceAccountKey: identity.accountNo, accountType: "depository", currency: "TWD" },
    observations: [{
      observationKey: token(`${captureId}:ledger`),
      balanceKind: "ledger",
      balance: { coefficient, scale: 0 },
      currency: "TWD",
      effectiveAt,
      effectiveTimeBasis: "provider-system-time",
      effectiveTimeRuleVersion: contractVersion,
      evidenceSourceRecordKey: occurrenceKey,
      evidenceSourceField: "balance",
      evidenceSourceValue: coefficient,
      evidenceContractVersion: contractVersion,
      sourceOccurrenceKey: occurrenceKey,
    }],
  };
}

type Snapshot = Readonly<{ accounts: number; transactions: number; revisions: number; balances: number; captures: number; records: number }>;

async function snapshot(store: PGliteStore): Promise<Snapshot> {
  const count = async (sql: string): Promise<number> =>
    (await store.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM ${sql}`)).rows[0]!.count;
  return {
    accounts: await count("financial_accounts"),
    transactions: await count("financial_transactions"),
    revisions: await count("transaction_revisions"),
    balances: await count("balance_observations"),
    captures: await count("source_captures"),
    records: await count("source_records"),
  };
}

async function accountRows(store: PGliteStore, sourceAccountKey: string) {
  const accountIds = (await store.query<{ account_id: Uint8Array }>(
    "SELECT account_id FROM financial_accounts WHERE source_account_key = $1",
    [sourceAccountKey],
  )).rows.map((row) => row.account_id);
  assert.equal(accountIds.length, 1);
  const accountId = accountIds[0]!;
  const transactions = (await store.query<{ transaction_id: Uint8Array; source_sequence: string }>(
    "SELECT transaction_id, source_sequence FROM financial_transactions WHERE account_id = $1 ORDER BY source_sequence",
    [accountId],
  )).rows;
  const revisions = (await store.query<{ revision_id: Uint8Array; amount_coefficient: string; currency: string }>(
    "SELECT r.revision_id, r.amount_coefficient, r.currency FROM transaction_revisions r JOIN financial_transactions t ON t.transaction_id = r.transaction_id WHERE t.account_id = $1 ORDER BY r.revision_id",
    [accountId],
  )).rows;
  const balances = (await store.query<{ observation_id: Uint8Array; observation_key: string }>(
    "SELECT observation_id, observation_key FROM balance_observations WHERE account_id = $1 ORDER BY observation_id",
    [accountId],
  )).rows;
  return { accountId, transactions, revisions, balances };
}

async function arrange(options: { balanceForB?: boolean } = {}) {
  const a = admitFubon(`123-00${DIGITS_A}-TWD-01`, DIGITS_A, "purge-account-a");
  const b = admitFubon(`123-00${DIGITS_B}-TWD-01`, DIGITS_B, "purge-account-b");
  assert.notEqual(a.identity.accountNo, b.identity.accountNo);
  const store = new PGliteStore(await createBaselinePGlite());
  await commitPGliteCanonicalDepositCapture(store, a.capture, { clock: () => 400 });
  await commitPGliteCanonicalBalanceCapture(store, fubonBalance("purge-balance-a", a.identity, "2026-10-01T04:00:00.000Z", "1000"), { clock: () => 401 });
  await commitPGliteCanonicalDepositCapture(store, b.capture, { clock: () => 402 });
  if (options.balanceForB !== false)
    await commitPGliteCanonicalBalanceCapture(store, fubonBalance("purge-balance-b", b.identity, "2026-10-02T04:00:00.000Z", "2500"), { clock: () => 403 });
  const request: SupersededAccountPurgeRequest = {
    integrationNamespace: "fubon",
    stream: STREAM,
    supersededSourceAccountKey: b.identity.accountNo,
    successorSourceAccountKey: a.identity.accountNo,
  };
  return { store, a, b, request };
}

async function linkTransactions(store: PGliteStore, fromKey: string, toKey: string): Promise<void> {
  const from = await accountRows(store, fromKey);
  const to = await accountRows(store, toKey);
  const [commit] = (await store.query<{ commit_id: Uint8Array }>("SELECT commit_id FROM canonical_commits ORDER BY commit_sequence LIMIT 1")).rows;
  const [scope] = (await store.query<{ source_connection_id: Uint8Array; identity_epoch_id: Uint8Array }>(
    "SELECT source_connection_id, identity_epoch_id FROM financial_accounts WHERE account_id = $1",
    [from.accountId],
  )).rows;
  await store.query(
    `INSERT INTO transaction_relations(relation_id, account_id, source_connection_id, identity_epoch_id, commit_id, relation_key, relation_kind,
       from_account_id, to_account_id, from_source_record_key, to_source_record_key, from_transaction_id, to_transaction_id, from_direction, to_direction,
       evidence_source_record_key, evidence_relation_id, evidence_contract_version)
     VALUES ($1, $2, $3, $4, $5, 'synthetic-link', 'transfer_counterpart', $2, $6, 'from-key', 'to-key', $7, $8, 'outflow', 'inflow', 'evidence-key', 'synthetic-relation', 'synthetic-v1')`,
    [uuidV7(), from.accountId, scope!.source_connection_id, scope!.identity_epoch_id, commit!.commit_id, to.accountId, from.transactions[0]!.transaction_id, to.transactions[0]!.transaction_id],
  );
}

test("preview reports the orphan's closure and leaves every row in place", async () => {
  const { store, request } = await arrange();
  try {
    const before = await snapshot(store);
    const preview = await previewSupersededAccountPurge(store, request);
    assert.ok(!("refused" in preview), JSON.stringify(preview));
    assert.equal(preview.transactionCount, 1);
    assert.equal(preview.captureCount, 2, "the deposit capture and the balance capture");
    assert.equal(preview.balanceObservationCount, 1);
    assert.equal(preview.deletedTableCounts["financial_accounts"], 1);
    assert.equal(preview.deletedTableCounts["financial_transactions"], 1);
    assert.equal(preview.deletedRowCount, Object.values(preview.deletedTableCounts).reduce((total, count) => total + count, 0));
    assert.ok(preview.deletedRowCount > 10, `closure is more than the account row: ${preview.deletedRowCount}`);
    assert.deepEqual(await snapshot(store), before, "a preview deletes nothing");
    assert.equal((await store.query("SELECT 1 FROM canonical_runtime_contract_purges")).rows.length, 0);
  } finally {
    await store.close();
  }
});

test("purge deletes the orphan closure, keeps the successor untouched, and audits the deletion", async () => {
  const { store, a, b, request } = await arrange();
  try {
    const survivorBefore = await accountRows(store, a.identity.accountNo);
    const before = await snapshot(store);
    const preview = await previewSupersededAccountPurge(store, request);
    assert.ok(!("refused" in preview));

    const result = await purgeSupersededAccount(store, request, { clock: () => 500 });
    assert.ok(!("refused" in result), JSON.stringify(result));
    assert.ok(result.purgeId.startsWith(SUPERSEDED_ACCOUNT_PURGE_ID_PREFIX));
    assert.deepEqual(result.deletedTableCounts, preview.deletedTableCounts, "the preview is the exact closure the purge deletes");
    assert.ok(result.linkedCommitCount >= 2, "deposit and balance commits are linked");

    const after = await snapshot(store);
    assert.deepEqual(after, {
      accounts: before.accounts - 1,
      transactions: before.transactions - 1,
      revisions: before.revisions - 1,
      balances: before.balances - 1,
      captures: before.captures - 2,
      records: before.records - 2,
    });
    assert.equal((await store.query("SELECT 1 FROM financial_accounts WHERE source_account_key = $1", [b.identity.accountNo])).rows.length, 0);
    const survivorAfter = await accountRows(store, a.identity.accountNo);
    assert.deepEqual(survivorAfter, survivorBefore, "the successor's rows survive byte-for-byte");

    const [audit] = (await store.query<{ purge_id: string; reason: string; scope_json: string; deleted_row_count: number; deleted_table_counts_json: string; closure_fingerprint: string; applied_at_utc_us: number }>(
      "SELECT purge_id, reason, scope_json, deleted_row_count::int, deleted_table_counts_json, closure_fingerprint, applied_at_utc_us::int FROM canonical_runtime_contract_purges",
    )).rows;
    assert.ok(audit);
    assert.equal(audit.purge_id, result.purgeId);
    assert.equal(audit.reason, "wrong-contract");
    assert.equal(audit.deleted_row_count, result.deletedRowCount);
    assert.equal(audit.applied_at_utc_us, 500);
    assert.deepEqual(JSON.parse(audit.deleted_table_counts_json), result.deletedTableCounts);
    assert.match(audit.closure_fingerprint, /^sha256:/u);
    assert.equal(audit.closure_fingerprint, result.closureFingerprint);
    const scope = JSON.parse(audit.scope_json);
    assert.equal(scope.integrationNamespace, "fubon");
    assert.equal(scope.stream, STREAM);
    assert.equal(scope.supersededSourceAccountKey, b.identity.accountNo);
    assert.equal(scope.successorSourceAccountKey, a.identity.accountNo);
    const [commitLinks] = (await store.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM canonical_runtime_contract_purge_commits WHERE purge_id = $1",
      [result.purgeId],
    )).rows;
    assert.equal(commitLinks?.count, result.linkedCommitCount);

    const current = await createPGliteCanonicalOverviewQuery(store).current();
    const fubonAccounts = current.projection.accounts.filter((account) => account.institutionKey === "fubon");
    assert.equal(fubonAccounts.length, 1);
    assert.deepEqual(fubonAccounts[0]?.amounts.map(({ currency, exact }) => ({ currency, exact })), [
      { currency: "TWD", exact: { coefficient: "1000", scale: 0 } },
    ]);

    assert.deepEqual(await purgeSupersededAccount(store, request), { refused: "superseded-account-missing" });
    assert.deepEqual(await snapshot(store), after, "a repeated purge deletes nothing");
  } finally {
    await store.close();
  }
});

test("purge refuses when the successor account has not been admitted yet", async () => {
  const { store, request } = await arrange();
  try {
    const before = await snapshot(store);
    const missing = { ...request, successorSourceAccountKey: "9999-no-such-account" };
    assert.deepEqual(await previewSupersededAccountPurge(store, missing), { refused: "successor-account-missing" });
    assert.deepEqual(await purgeSupersededAccount(store, missing), { refused: "successor-account-missing" });
    assert.deepEqual(await purgeSupersededAccount(store, { ...request, successorSourceAccountKey: request.supersededSourceAccountKey }), { refused: "successor-is-superseded" });
    assert.deepEqual(await snapshot(store), before);
  } finally {
    await store.close();
  }
});

test("purge refuses when the orphan key resolves to more than one account", async () => {
  const { store, b, request } = await arrange();
  try {
    const twin = await accountRows(store, b.identity.accountNo);
    const [commit] = (await store.query<{ commit_id: Uint8Array }>("SELECT commit_id FROM canonical_commits ORDER BY commit_sequence LIMIT 1")).rows;
    const [account] = (await store.query<{ source_connection_id: Uint8Array; account_type: string; institution_key: string }>(
      "SELECT source_connection_id, account_type, institution_key FROM financial_accounts WHERE account_id = $1",
      [twin.accountId],
    )).rows;
    const epochId = uuidV7();
    await store.query(
      "INSERT INTO identity_epochs(identity_epoch_id, source_connection_id, epoch_key, created_commit_id) VALUES ($1, $2, 'synthetic-second-epoch', $3)",
      [epochId, account!.source_connection_id, commit!.commit_id],
    );
    await store.query(
      "INSERT INTO financial_accounts(account_id, source_connection_id, identity_epoch_id, stream, source_account_key, account_type, institution_key, created_commit_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
      [uuidV7(), account!.source_connection_id, epochId, STREAM, b.identity.accountNo, account!.account_type, account!.institution_key, commit!.commit_id],
    );
    const before = await snapshot(store);
    const refusal = await purgeSupersededAccount(store, request);
    assert.ok("refused" in refusal);
    assert.equal(refusal.refused, "superseded-account-ambiguous");
    assert.deepEqual(await snapshot(store), before);
  } finally {
    await store.close();
  }
});

test("a relation between the orphan's transaction and the successor's transaction is an external reference", async () => {
  const { store, a, b, request } = await arrange();
  try {
    await linkTransactions(store, a.identity.accountNo, b.identity.accountNo);
    const before = await snapshot(store);
    const preview = await previewSupersededAccountPurge(store, request);
    assert.ok("refused" in preview);
    assert.equal(preview.refused, "external-reference");
    assert.equal(preview.table, "transaction_relations");
    const result = await purgeSupersededAccount(store, request);
    assert.ok("refused" in result);
    assert.equal(result.refused, "external-reference");
    assert.equal(result.table, "transaction_relations");
    assert.deepEqual(await snapshot(store), before, "a refused purge deletes nothing");
    assert.equal((await store.query("SELECT 1 FROM transaction_relations")).rows.length, 1);
    assert.equal((await store.query("SELECT 1 FROM canonical_runtime_contract_purges")).rows.length, 0);
  } finally {
    await store.close();
  }
});

test("a relation owned by the orphan whose counterpart is the successor is also refused", async () => {
  const { store, a, b, request } = await arrange();
  try {
    await linkTransactions(store, b.identity.accountNo, a.identity.accountNo);
    const before = await snapshot(store);
    const result = await purgeSupersededAccount(store, request);
    assert.ok("refused" in result);
    assert.equal(result.refused, "external-reference");
    assert.deepEqual(await snapshot(store), before);
  } finally {
    await store.close();
  }
});
