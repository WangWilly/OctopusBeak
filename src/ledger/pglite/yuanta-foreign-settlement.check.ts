import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { canonicalOccurrenceGroupKey } from "../canonical/occurrence-groups.ts";
import {
  deriveYuantaForeignSettlementLinkageKey,
  YUANTA_FOREIGN_SETTLEMENT_CONTRACT_VERSION,
  YUANTA_FOREIGN_SETTLEMENT_LINKAGE_CONTRACT_VERSION,
  YUANTA_FOREIGN_SETTLEMENT_MARKET_CONTRACT_VERSION,
  YUANTA_FOREIGN_SETTLEMENT_MARKET_US_EQUITY,
} from "../canonical/investment-funding-contract.ts";
import { createTestPGlite } from "./baseline-test-template.ts";
import { insertPGliteCanonicalCommit } from "./canonical-commit.ts";
import {
  commitPGliteCanonicalInvestmentCapture,
  type PGliteCanonicalInvestmentCommitRequest,
} from "./investment.ts";
import {
  commitPGliteCanonicalFinancialCapture,
  type PGliteCanonicalFinancialCommitRequest,
} from "./canonical-source-store.ts";
import {
  queryPGliteCurrentInvestmentFundingRelations,
  resolvePGliteCanonicalInvestmentFundingRelations,
} from "./relations.ts";
import { PGliteStore } from "./transaction.ts";

const token = (value: string): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(value).digest("base64url")}`;
const digest = (...parts: readonly string[]): string =>
  `sha256:${createHash("sha256").update(parts.join("\u0000")).digest("base64url")}`;

const LOGIN = "synthetic-yuanta-login";
const CONNECTION = token("yuanta-trade-connection");
const LINKAGE = deriveYuantaForeignSettlementLinkageKey(LOGIN, "USD");

type Trade = Readonly<{ key: string; action: "buy" | "sell"; tradeOn: string; cents: string }>;
type Posting = Readonly<{
  key: string;
  postedOn: string;
  direction: "inflow" | "outflow";
  cents: string;
  administrativeState?: "active" | "deleted";
}>;

function tradeCapture(captureId: string, trades: readonly Trade[]): PGliteCanonicalInvestmentCommitRequest {
  const contractVersion = "yuanta-trade/investment/canonical-v1";
  const securityKey = "yuanta-trade:ACME";
  const scopeKey = token("yuanta-trade-scope");
  const dates = trades.map((trade) => trade.tradeOn).sort();
  const startDate = dates[0]!;
  const endDate = dates.at(-1)!;
  return {
    capture: {
      captureId,
      sourceId: "yuanta-trade",
      authorityRoute: contractVersion,
      contractVersion,
      observedAt: `${endDate}T12:00:00.000Z`,
      identity: {
        sourceConnectionKey: CONNECTION,
        identityEpochKey: token("yuanta-trade-epoch"),
        accountKey: token("yuanta-trade-account"),
        accountNumber: {
          value: "7654321",
          kind: "brokerage-account",
          evidenceVersion: "yuanta-trade/account-v1",
          sourceField: "accountNo",
        },
        accountType: "investment",
        reportingCurrency: "USD",
      },
      scope: {
        effectiveOn: endDate,
        complete: true,
        transactionHistory: { startDate, endDate, complete: true },
      },
      occurrenceGroupCoverage: [{ scopeKey, startDate, endDate, contractVersion }],
      securities: [{
        securityKey,
        producerSecurityId: "ACME",
        name: "Acme Equity",
        ticker: "ACME",
        currency: "USD",
        securityType: "equity",
        identityEvidence: { kind: "producer-security-id", contractVersion },
      }],
      holdings: [],
      transactions: trades.map((trade) => {
        const occurrenceGroup = { scopeKey, fingerprint: token(`fingerprint:${trade.key}`), partitionDate: trade.tradeOn, ordinal: 1 };
        const sourceRecordKey = canonicalOccurrenceGroupKey(occurrenceGroup);
        return {
          sourceRecordKey,
          occurrenceGroup,
          transactionKey: token(`trade:${trade.key}`),
          securityKey,
          action: trade.action,
          quantity: { coefficient: "1", scale: 0 },
          cashEffect: { coefficient: trade.cents, scale: 2, currency: "USD" },
          effectiveOn: trade.tradeOn,
          description: `${trade.action} ACME`,
          fundingEvidence: {
            kind: "source-settlement-contract",
            sourceRecordKey,
            sourceLinkageKey: LINKAGE,
            linkageContractVersion: YUANTA_FOREIGN_SETTLEMENT_LINKAGE_CONTRACT_VERSION,
            settlementMarket: YUANTA_FOREIGN_SETTLEMENT_MARKET_US_EQUITY,
            settlementMarketContractVersion: YUANTA_FOREIGN_SETTLEMENT_MARKET_CONTRACT_VERSION,
            sourceMarketCode: "52",
            settlementModel: "account-currency-date-net",
            contractVersion: YUANTA_FOREIGN_SETTLEMENT_CONTRACT_VERSION,
          },
        };
      }),
    },
  };
}

function depositCapture(captureId: string, postings: readonly Posting[]): PGliteCanonicalFinancialCommitRequest {
  const route = "yuanta/foreign-currency/deposit/human-attested-v2";
  const dates = postings.map((posting) => posting.postedOn).sort();
  const scopeKey = token("yuanta-usd-scope");
  const group = (posting: Posting) => ({ scopeKey, fingerprint: token(`posting:${posting.key}:fingerprint`), partitionDate: posting.postedOn, ordinal: 1 });
  const records = postings.map((posting) => ({
    occurrenceKey: canonicalOccurrenceGroupKey(group(posting)),
    occurrenceGroup: group(posting),
    collisionKey: token(`posting:${posting.key}:collision`),
    providerKey: token(`posting:${posting.key}:provider`),
    contentHash: token(`posting:${posting.key}:content`),
    compact: {
      amount: { coefficient: posting.cents, scale: 2 },
      sourcePayload: {
        transactionInfo: posting.direction === "outflow" ? "淨額扣" : "淨額入",
        settlementLinkageKey: LINKAGE,
        settlementLinkageContractVersion: YUANTA_FOREIGN_SETTLEMENT_LINKAGE_CONTRACT_VERSION,
      },
    },
  }));
  return {
    capture: {
      captureId,
      integrationNamespace: "yuanta",
      sourceConnectionKey: token("yuanta-bank-connection"),
      identityEpoch: token("yuanta-bank-epoch"),
      stream: "foreign-currency-deposit",
      recordKind: "yuanta-foreign-currency-deposit",
      routeKey: route,
      contractVersion: "foreign-currency/yuanta/human-attested-v2",
      subjectDigest: token("yuanta-bank-subject"),
      observedAt: `${dates.at(-1)}T12:00:00.000Z`,
      accountNumber: { value: "654321", kind: "depository-account", evidenceVersion: "synthetic-v1", sourceField: "accountNumber" },
      scope: { startDate: dates[0]!.replaceAll("-", ""), endDate: dates.at(-1)!.replaceAll("-", ""), kind: "bounded-range", completeness: "complete-range", ruleVersion: route, sourceAccountKey: "yuanta-usd-account" },
      pages: [{ pageOrdinal: 0, responseCode: "200", rowCount: records.length, terminal: true, metadata: { pageCount: 1 } }],
      records,
      occurrenceGroupCoverage: [{ scopeKey, startDate: dates[0]!, endDate: dates.at(-1)!, contractVersion: "foreign-currency/yuanta/human-attested-v2" }],
    },
    account: { sourceAccountKey: "yuanta-usd-account", accountNo: "654321", accountType: "depository", currency: "USD" },
    transactions: postings.map((posting) => ({
      sourceOccurrenceKey: canonicalOccurrenceGroupKey(group(posting)),
      sourceSequence: posting.key,
      amount: { coefficient: posting.cents, scale: 2 },
      currency: "USD",
      direction: posting.direction,
      postingStatus: "posted",
      postingOrigin: "human-attested",
      postingBasis: "statement-posted-history",
      postingRuleVersion: "foreign-currency/yuanta/human-attested-v2",
      description: posting.direction === "outflow" ? "複委託扣" : "複委託入",
      economicStatus: "normal",
      administrativeState: posting.administrativeState ?? "active",
      semanticRuleVersion: "foreign-currency/yuanta/human-attested-v2",
      effectiveOn: posting.postedOn,
      transactionDateTimeLocal: `${posting.postedOn}T10:00:00+08:00`,
      timeZone: "Asia/Taipei",
      timePrecision: "second",
      timeOrigin: "source_reported",
      effectiveTimeBasis: "transaction-time",
      effectiveTimeRuleVersion: "foreign-currency/yuanta/human-attested-v2",
      utcInstantUtcUs: Date.parse(`${posting.postedOn}T02:00:00Z`) * 1000,
    })),
  };
}

type Ledger = Readonly<{
  store: PGliteStore;
  postingIds: ReadonlyMap<string, string>;
}>;

async function ledger(trades: readonly Trade[], postings: readonly Posting[]): Promise<Ledger> {
  const store = new PGliteStore(await createTestPGlite("ledger"));
  try {
    const deposit = await commitPGliteCanonicalFinancialCapture(store, depositCapture("yuanta-usd-1", postings));
    await commitPGliteCanonicalInvestmentCapture(store, tradeCapture("yuanta-trade-1", trades));
    const postingIds = new Map(postings.map((posting, index) => [posting.key, String(deposit.transactions[index]?.transactionId)]));
    return { store, postingIds };
  } catch (error) {
    await store.close();
    throw error;
  }
}

const resolve = (store: PGliteStore) =>
  resolvePGliteCanonicalInvestmentFundingRelations(store, { sourceConnectionKey: CONNECTION, observedAt: "2027-06-01T00:00:00.000Z" });

async function relatedPostings(store: PGliteStore): Promise<readonly Readonly<{ posting: string; settlementOn: string; members: number }>[]> {
  const relations = await queryPGliteCurrentInvestmentFundingRelations(store);
  for (const relation of relations)
    assert.ok(String(relation.settlementGroupKey).endsWith(`:${String(relation.settlementEffectiveOn)}`), "the settlement group key names the posting's day");
  return relations
    .map((relation) => ({ posting: String(relation.fundingTransactionId), settlementOn: String(relation.settlementEffectiveOn), members: Number(relation.investmentTransactionCount) }))
    .sort((left, right) => left.settlementOn.localeCompare(right.settlementOn));
}

test("Yuanta settlements resolve in 2027 and across the New Year without a holiday calendar", async () => {
  const { store, postingIds } = await ledger([
    { key: "sell-2026-12-30", action: "sell", tradeOn: "2026-12-30", cents: "50000" },
    { key: "buy-2027-03-02", action: "buy", tradeOn: "2027-03-02", cents: "12345" },
  ], [
    { key: "in-2027-01-04", postedOn: "2027-01-04", direction: "inflow", cents: "50000" },
    { key: "out-2027-03-03", postedOn: "2027-03-03", direction: "outflow", cents: "12345" },
  ]);
  try {
    const resolution = await resolve(store);
    assert.equal(resolution.outcome, "changed");
    assert.equal(resolution.resolved, 2);
    assert.equal(resolution.noAdmission, 0);
    assert.deepEqual(await relatedPostings(store), [
      { posting: postingIds.get("in-2027-01-04"), settlementOn: "2027-01-04", members: 1 },
      { posting: postingIds.get("out-2027-03-03"), settlementOn: "2027-03-03", members: 1 },
    ]);
  } finally {
    await store.close();
  }
});

test("a trade before a Taiwan holiday relates to the later posting inside its window", async () => {
  const { store, postingIds } = await ledger([
    // Friday buy: weekday settlement is Monday 2027-05-31; the posting lands Tuesday after a Monday closure.
    { key: "buy-friday", action: "buy", tradeOn: "2027-05-28", cents: "20000" },
    // Lunar New Year: weekday settlement is Friday 2027-02-05; the posting lands on the window's last day.
    { key: "buy-lunar-new-year", action: "buy", tradeOn: "2027-02-04", cents: "30000" },
  ], [
    { key: "out-2027-06-01", postedOn: "2027-06-01", direction: "outflow", cents: "20000" },
    { key: "out-2027-02-15", postedOn: "2027-02-15", direction: "outflow", cents: "30000" },
  ]);
  try {
    const resolution = await resolve(store);
    assert.equal(resolution.resolved, 2);
    assert.deepEqual(await relatedPostings(store), [
      { posting: postingIds.get("out-2027-02-15"), settlementOn: "2027-02-15", members: 1 },
      { posting: postingIds.get("out-2027-06-01"), settlementOn: "2027-06-01", members: 1 },
    ]);
  } finally {
    await store.close();
  }
});

test("a buy and a sell that share a weekday settlement net into one posting", async () => {
  // Monday sell (T+2) and Tuesday buy (T+1) both settle Wednesday 2027-03-03.
  const { store, postingIds } = await ledger([
    { key: "sell-monday", action: "sell", tradeOn: "2027-03-01", cents: "4000" },
    { key: "buy-tuesday", action: "buy", tradeOn: "2027-03-02", cents: "10000" },
  ], [
    { key: "out-net", postedOn: "2027-03-03", direction: "outflow", cents: "6000" },
  ]);
  try {
    const resolution = await resolve(store);
    assert.equal(resolution.resolved, 1);
    assert.deepEqual(await relatedPostings(store), [
      { posting: postingIds.get("out-net"), settlementOn: "2027-03-03", members: 2 },
    ]);
  } finally {
    await store.close();
  }
});

test("two equal postings in one settlement window relate nothing", async () => {
  const { store } = await ledger([
    { key: "buy", action: "buy", tradeOn: "2027-03-02", cents: "10000" },
  ], [
    { key: "out-first", postedOn: "2027-03-03", direction: "outflow", cents: "10000" },
    { key: "out-second", postedOn: "2027-03-08", direction: "outflow", cents: "10000" },
  ]);
  try {
    const resolution = await resolve(store);
    assert.equal(resolution.outcome, "no-admission");
    assert.equal(resolution.noAdmission, 1);
    assert.deepEqual(resolution.reasons, ["ambiguous-funding-candidate"]);
    assert.deepEqual(await relatedPostings(store), []);
  } finally {
    await store.close();
  }
});

test("a posting that is the only candidate of two groups relates to neither", async () => {
  const { store } = await ledger([
    { key: "buy-monday", action: "buy", tradeOn: "2027-03-01", cents: "10000" },
    { key: "buy-tuesday", action: "buy", tradeOn: "2027-03-02", cents: "10000" },
  ], [
    { key: "out-shared", postedOn: "2027-03-04", direction: "outflow", cents: "10000" },
  ]);
  try {
    const resolution = await resolve(store);
    assert.equal(resolution.outcome, "no-admission");
    assert.equal(resolution.noAdmission, 2);
    assert.deepEqual(resolution.reasons, ["ambiguous-funding-candidate"]);
    assert.deepEqual(await relatedPostings(store), []);
  } finally {
    await store.close();
  }
});

test("a posting eleven days after the weekday settlement is not a candidate", async () => {
  // Weekday settlement 2027-03-03; 2027-03-14 is eleven calendar days later.
  const { store } = await ledger([
    { key: "buy", action: "buy", tradeOn: "2027-03-02", cents: "10000" },
  ], [
    { key: "out-late", postedOn: "2027-03-14", direction: "outflow", cents: "10000" },
  ]);
  try {
    const resolution = await resolve(store);
    assert.equal(resolution.outcome, "no-admission");
    assert.equal(resolution.noAdmission, 1);
    assert.deepEqual(resolution.reasons, ["no-complete-funding-candidate"]);
    assert.deepEqual(await relatedPostings(store), []);
  } finally {
    await store.close();
  }
});

test("a group split by a holiday stays unrelated and is counted with a reason", async () => {
  // Friday 2027-02-05 is closed: the bank nets the Thursday and Friday buys into one Monday posting,
  // while weekday settlement puts them in separate groups (Friday and Monday).
  const { store } = await ledger([
    { key: "buy-thursday", action: "buy", tradeOn: "2027-02-04", cents: "10000" },
    { key: "buy-friday", action: "buy", tradeOn: "2027-02-05", cents: "15000" },
  ], [
    { key: "out-combined", postedOn: "2027-02-08", direction: "outflow", cents: "25000" },
  ]);
  try {
    const resolution = await resolve(store);
    assert.equal(resolution.outcome, "no-admission");
    assert.equal(resolution.noAdmission, 2);
    assert.deepEqual(resolution.reasons, ["no-complete-funding-candidate"]);
    assert.deepEqual(await relatedPostings(store), []);
  } finally {
    await store.close();
  }
});

test("a relation persisted for a correctly dated trade stays current without churn", async () => {
  // Tuesday 2026-09-22 buy: the retired 2026 calendar and the weekday rule both settle Wednesday 2026-09-23.
  const { store, postingIds } = await ledger([
    { key: "buy", action: "buy", tradeOn: "2026-09-22", cents: "10000" },
  ], [
    { key: "out", postedOn: "2026-09-23", direction: "outflow", cents: "10000" },
  ]);
  try {
    assert.equal((await resolve(store)).resolved, 1);
    const persisted = await store.query<Record<string, unknown>>(
      `SELECT relation.relation_key, relation.settlement_group_key, relation.settlement_effective_on::text AS settlement_effective_on,
              relation.settlement_model, encode(relation.investment_account_id, 'hex') AS account,
              encode(relation.funding_transaction_id, 'hex') AS funding, encode(relation.funding_source_record_id, 'hex') AS funding_record,
              encode(member.investment_transaction_id, 'hex') AS member, encode(member.investment_source_record_id, 'hex') AS member_record,
              event.reason
         FROM investment_funding_relations relation
         JOIN investment_funding_relation_members member ON member.relation_id = relation.relation_id
         JOIN investment_funding_relation_events event ON event.relation_id = relation.relation_id`,
    );
    assert.equal(persisted.rows.length, 1);
    const row = persisted.rows[0]!;
    assert.equal(row.funding, postingIds.get("out")!.replaceAll("-", ""));
    // The shape the calendar code persisted: group key and date are the posting's day, identity ignores dates.
    assert.deepEqual({
      relationKey: row.relation_key,
      settlementGroupKey: row.settlement_group_key,
      settlementEffectiveOn: row.settlement_effective_on,
      settlementModel: row.settlement_model,
      reason: row.reason,
    }, {
      relationKey: digest("investment-funding-relation-v1", String(row.account), String(row.funding), String(row.member)),
      settlementGroupKey: `${String(row.account)}:2026-09-23`,
      settlementEffectiveOn: "2026-09-23",
      settlementModel: "account-currency-date-net",
      reason: `verified-settlement:${digest("investment-funding-relation-support-v2", String(row.member_record), String(row.funding_record), String(row.member), String(row.funding))}`,
    });
    const repeated = await resolve(store);
    assert.equal(repeated.outcome, "unchanged");
    assert.equal(repeated.resolutionId, null);
    assert.equal((await store.query("SELECT 1 FROM investment_funding_relation_events")).rows.length, 1);
  } finally {
    await store.close();
  }
});

test("a related posting that disappears under complete coverage withdraws the relation", async () => {
  const { store } = await ledger([
    { key: "buy", action: "buy", tradeOn: "2027-03-02", cents: "10000" },
  ], [
    { key: "out", postedOn: "2027-03-04", direction: "outflow", cents: "10000" },
  ]);
  try {
    assert.equal((await resolve(store)).resolved, 1);
    await commitPGliteCanonicalFinancialCapture(store, depositCapture("yuanta-usd-2", [
      { key: "out", postedOn: "2027-03-04", direction: "outflow", cents: "10000", administrativeState: "deleted" },
    ]));
    const resolution = await resolve(store);
    assert.equal(resolution.outcome, "changed");
    assert.deepEqual(resolution.reasons, ["no-complete-funding-candidate"]);
    assert.deepEqual(await relatedPostings(store), []);
    const events = await store.query<{ event_kind: string }>(
      `SELECT event.event_kind FROM investment_funding_relation_events event
         JOIN canonical_commits event_commit ON event_commit.commit_id = event.commit_id
        ORDER BY event_commit.commit_sequence`,
    );
    assert.deepEqual(events.rows.map((row) => row.event_kind), ["observed", "withdrawn"]);
  } finally {
    await store.close();
  }
});

test("a posting another group also sees relates to neither group", async () => {
  // The 03-01 buy's own 03-02 posting predates the deposit history. Its window still sees the 03-09 posting,
  // which the 03-08 buy sees beside 03-16; each later posting is likewise seen by two weekly buys.
  const { store } = await ledger([
    { key: "buy-03-01", action: "buy", tradeOn: "2027-03-01", cents: "10000" },
    { key: "buy-03-08", action: "buy", tradeOn: "2027-03-08", cents: "10000" },
    { key: "buy-03-15", action: "buy", tradeOn: "2027-03-15", cents: "10000" },
    { key: "buy-03-22", action: "buy", tradeOn: "2027-03-22", cents: "10000" },
  ], [
    { key: "out-03-09", postedOn: "2027-03-09", direction: "outflow", cents: "10000" },
    { key: "out-03-16", postedOn: "2027-03-16", direction: "outflow", cents: "10000" },
    { key: "out-03-23", postedOn: "2027-03-23", direction: "outflow", cents: "10000" },
  ]);
  try {
    const resolution = await resolve(store);
    assert.equal(resolution.outcome, "no-admission");
    assert.equal(resolution.resolved, 0);
    assert.equal(resolution.noAdmission, 4);
    assert.deepEqual(resolution.reasons, ["ambiguous-funding-candidate"]);
    assert.deepEqual(await relatedPostings(store), []);
  } finally {
    await store.close();
  }
});

test("a posting that already funds another relation is not claimed again", async () => {
  const { store, postingIds } = await ledger([
    { key: "buy-monday", action: "buy", tradeOn: "2027-03-01", cents: "10000" },
  ], [
    { key: "out", postedOn: "2027-03-03", direction: "outflow", cents: "10000" },
  ]);
  try {
    assert.equal((await resolve(store)).resolved, 1);
    // A later capture adds a Friday sell that nets the Monday buy's group to zero, leaving its relation
    // observed, and a Tuesday buy whose window sees the same posting.
    await commitPGliteCanonicalInvestmentCapture(store, tradeCapture("yuanta-trade-2", [
      { key: "sell-friday", action: "sell", tradeOn: "2027-02-26", cents: "10000" },
      { key: "buy-monday", action: "buy", tradeOn: "2027-03-01", cents: "10000" },
      { key: "buy-tuesday", action: "buy", tradeOn: "2027-03-02", cents: "10000" },
    ]));
    const resolution = await resolve(store);
    assert.equal(resolution.resolved, 0);
    assert.deepEqual(resolution.reasons, ["ambiguous-funding-candidate", "zero-net-settlement"]);
    assert.deepEqual(await relatedPostings(store), [
      { posting: postingIds.get("out"), settlementOn: "2027-03-03", members: 1 },
    ]);
  } finally {
    await store.close();
  }
});

test("a posting the day before the weekday settlement is not a candidate", async () => {
  // Weekday settlement 2027-03-03; the posting is on 2027-03-02.
  const { store } = await ledger([
    { key: "buy", action: "buy", tradeOn: "2027-03-02", cents: "10000" },
  ], [
    { key: "out-early", postedOn: "2027-03-02", direction: "outflow", cents: "10000" },
  ]);
  try {
    const resolution = await resolve(store);
    assert.equal(resolution.outcome, "no-admission");
    assert.deepEqual(resolution.reasons, ["no-complete-funding-candidate"]);
    assert.deepEqual(await relatedPostings(store), []);
  } finally {
    await store.close();
  }
});

/** Writes the relation the retired 2026 calendar would have persisted for every trade in the ledger. */
async function persistCalendarRelation(store: PGliteStore, postingId: string, settlementOn: string): Promise<void> {
  await store.transaction(async (transaction) => {
    const members = (await transaction.query<{ transaction_id: Uint8Array; source_record_id: Uint8Array; account_id: Uint8Array; action: string; cash_coefficient: string; cash_scale: number }>(
      "SELECT transaction_id, source_record_id, account_id, action, cash_coefficient, cash_scale FROM investment_transactions",
    )).rows;
    const posting = (await transaction.query<{ transaction_id: Uint8Array; source_record_id: Uint8Array; account_id: Uint8Array; amount_coefficient: string; amount_scale: number; direction: string }>(
      `SELECT current_row.transaction_id, revision.source_record_id, financial.account_id,
              revision.amount_coefficient, revision.amount_scale, revision.direction
         FROM current_transactions current_row
         JOIN transaction_revisions revision ON revision.revision_id = current_row.revision_id
         JOIN financial_transactions financial ON financial.transaction_id = current_row.transaction_id
        WHERE encode(current_row.transaction_id, 'hex') = $1`,
      [postingId.replaceAll("-", "")],
    )).rows[0]!;
    const hex = (value: Uint8Array) => Buffer.from(value).toString("hex");
    const account = hex(members[0]!.account_id);
    const commit = await insertPGliteCanonicalCommit(transaction, {
      kind: "relation_resolution",
      authorityRoute: "canonical/investment-funding-relation-resolution-v1",
      time: { kind: "requested" },
    });
    const relationId = Uint8Array.from(Buffer.from(randomUUID().replaceAll("-", ""), "hex"));
    const memberIds = members.map((member) => hex(member.transaction_id)).sort();
    const memberRecords = members.map((member) => hex(member.source_record_id)).sort();
    await transaction.query(
      `INSERT INTO investment_funding_relations(relation_id, relation_key, settlement_group_key, investment_account_id, funding_account_id, funding_transaction_id, funding_source_record_id, settlement_effective_on, settlement_model, coefficient, scale, currency, direction, source_linkage_key, evidence_contract_version, created_commit_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'account-currency-date-net', $9, $10, 'USD', $11, $12, $13, $14)`,
      [relationId, digest("investment-funding-relation-v1", account, hex(posting.transaction_id), ...memberIds),
        `${account}:${settlementOn}`, members[0]!.account_id, posting.account_id, posting.transaction_id, posting.source_record_id, settlementOn,
        posting.amount_coefficient, posting.amount_scale, posting.direction,
        digest("investment-funding-linkage-set-v1", ...members.map(() => LINKAGE)), YUANTA_FOREIGN_SETTLEMENT_CONTRACT_VERSION, commit.id],
    );
    for (const member of members)
      await transaction.query(
        "INSERT INTO investment_funding_relation_members(relation_id, investment_transaction_id, investment_source_record_id, action, coefficient, scale, currency) VALUES ($1, $2, $3, $4, $5, $6, 'USD')",
        [relationId, member.transaction_id, member.source_record_id, member.action, member.cash_coefficient, member.cash_scale],
      );
    const support = digest("investment-funding-relation-support-v2", ...memberRecords, hex(posting.source_record_id), ...memberIds, hex(posting.transaction_id));
    await transaction.query(
      "INSERT INTO investment_funding_relation_events(event_id, relation_id, event_kind, reason, commit_id, recorded_at_utc_us) VALUES ($1, $2, 'observed', $3, $4, $5)",
      [Uint8Array.from(Buffer.from(randomUUID().replaceAll("-", ""), "hex")), relationId, `verified-settlement:${support}`, commit.id, commit.recordedAtUtcUs],
    );
  });
}

test("a calendar relation whose trades the weekday rule groups the same way stays current", async () => {
  // Tuesday 2026-09-22 buy: the retired calendar and the weekday rule both settle Wednesday 2026-09-23.
  const { store, postingIds } = await ledger([
    { key: "buy", action: "buy", tradeOn: "2026-09-22", cents: "10000" },
  ], [
    { key: "out", postedOn: "2026-09-23", direction: "outflow", cents: "10000" },
  ]);
  try {
    await persistCalendarRelation(store, postingIds.get("out")!, "2026-09-23");
    const before = await relatedPostings(store);
    const resolution = await resolve(store);
    assert.equal(resolution.outcome, "unchanged");
    assert.equal(resolution.resolutionId, null);
    assert.deepEqual(await relatedPostings(store), before);
    assert.equal((await store.query("SELECT 1 FROM investment_funding_relation_events")).rows.length, 1);
  } finally {
    await store.close();
  }
});

test("a calendar relation that netted trades across a closure is withdrawn, not re-paired", async () => {
  // The retired calendar settled a Thursday 2026-02-12 sell (T+2 across Lunar New Year) and a Friday
  // 2026-02-20 buy (T+1) together on Monday 2026-02-23. The weekday rule splits them into two groups.
  const { store, postingIds } = await ledger([
    { key: "sell-before-closure", action: "sell", tradeOn: "2026-02-12", cents: "10000" },
    { key: "buy-after-closure", action: "buy", tradeOn: "2026-02-20", cents: "30000" },
  ], [
    { key: "out-net", postedOn: "2026-02-23", direction: "outflow", cents: "20000" },
  ]);
  try {
    await persistCalendarRelation(store, postingIds.get("out-net")!, "2026-02-23");
    assert.equal((await relatedPostings(store)).length, 1, "the calendar relation starts out current");
    const resolution = await resolve(store);
    assert.equal(resolution.outcome, "changed");
    assert.equal(resolution.resolved, 0);
    assert.equal(resolution.noAdmission, 2);
    assert.deepEqual(resolution.reasons, ["no-complete-funding-candidate"]);
    assert.deepEqual(await relatedPostings(store), []);
    const events = await store.query<{ event_kind: string }>(
      `SELECT event.event_kind FROM investment_funding_relation_events event
         JOIN canonical_commits event_commit ON event_commit.commit_id = event.commit_id
        ORDER BY event_commit.commit_sequence`,
    );
    assert.deepEqual(events.rows.map((row) => row.event_kind), ["observed", "withdrawn"]);
  } finally {
    await store.close();
  }
});
