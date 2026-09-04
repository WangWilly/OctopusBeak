import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { assertValidatedCanonicalDatabase } from "./canonical-schema-lifecycle.ts";
import {
  withCanonicalSnapshot,
  withCanonicalWriterQueue,
} from "./canonical-runtime.ts";
import { deriveSourceConnectionIdentityKey } from "./source-connection-identity.ts";
import type {
  InvestmentFundingEvidence,
} from "./investment-financial.ts";

type LinkedFundingEvidence = Extract<
  InvestmentFundingEvidence,
  { kind: "source-linked-account" }
>;
/** Funding relation resolution is a canonical read/write seam.  Its adapters
 * may be a domain facade, but the carried database must be a lifecycle
 * capability; a raw DatabaseSync is never accepted. */
type RelationResolutionStore = Readonly<{
  readonly db: DatabaseSync;
  readonly databasePath: string;
  readonly commitClock: () => number;
}>;

type InvestmentRow = {
  transactionId: Uint8Array;
  investmentAccountId: Uint8Array;
  sourceRecordId: Uint8Array;
  commitId: Uint8Array;
  // The resolver query is intentionally restricted to these two actions.
  action: "buy" | "sell";
  effectiveOn: string;
  cashCoefficient: string;
  cashScale: number;
  cashCurrency: string;
  fundingEvidenceJson: string;
};

const digest = (...parts: string[]) =>
  `sha256:${createHash("sha256").update(parts.join("\0")).digest("base64url")}`;

function uuidV7(): Buffer {
  const bytes = randomBytes(16);
  const now = BigInt(Date.now());
  for (let index = 0; index < 6; index += 1)
    bytes[index] = Number((now >> BigInt(40 - index * 8)) & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return bytes;
}

const idHex = (value: Uint8Array) => Buffer.from(value).toString("hex");

const YUANTA_FOREIGN_SETTLEMENT_CONTRACT_VERSION =
  "yuanta/foreign-settlement/human-attested-v1";
export const YUANTA_FOREIGN_SETTLEMENT_LINKAGE_CONTRACT_VERSION =
  "yuanta/foreign-settlement/linkage-v1" as const;
/** v2 adds the live OverseaTrade MarketNo 52/53/54 source-code mapping. */
export const YUANTA_FOREIGN_SETTLEMENT_MARKET_CONTRACT_VERSION =
  "yuanta/foreign-settlement/market-v2" as const;
export const YUANTA_FOREIGN_SETTLEMENT_MARKET_US_EQUITY = "us-equity" as const;
export type YuantaForeignSettlementMarketCode = "52" | "53" | "54";
export const YUANTA_FOREIGN_SETTLEMENT_MARKET_CODEBOOK: Readonly<
  Record<YuantaForeignSettlementMarketCode, typeof YUANTA_FOREIGN_SETTLEMENT_MARKET_US_EQUITY>
> = {
  "52": YUANTA_FOREIGN_SETTLEMENT_MARKET_US_EQUITY,
  "53": YUANTA_FOREIGN_SETTLEMENT_MARKET_US_EQUITY,
  "54": YUANTA_FOREIGN_SETTLEMENT_MARKET_US_EQUITY,
};
export function isYuantaForeignSettlementMarketCode(
  value: unknown,
): value is YuantaForeignSettlementMarketCode {
  return (
    typeof value === "string" &&
    Object.hasOwn(YUANTA_FOREIGN_SETTLEMENT_MARKET_CODEBOOK, value)
  );
}
export const YUANTA_FOREIGN_SETTLEMENT_CALENDAR_CONTRACT_VERSION =
  "yuanta/foreign-settlement/calendar-v1" as const;
export const YUANTA_FOREIGN_SETTLEMENT_CALENDAR_START = "2026-01-01" as const;
export const YUANTA_FOREIGN_SETTLEMENT_CALENDAR_END = "2026-12-31" as const;

/**
 * The fixed bank note pair is the provider's cross-product linkage evidence:
 * it identifies a Yuanta foreign-currency row as a securities settlement,
 * without pretending that the bank and brokerage identity epochs are equal.
 * Keep the derivation versioned so a later provider contract cannot silently
 * reinterpret old relation judgments.
 */
export function deriveYuantaForeignSettlementLinkageKey(
  stableLoginIdentity: string,
  currency: string,
): `sha256:${string}` {
  if (!stableLoginIdentity.trim())
    throw new Error("Yuanta settlement linkage requires a stable login identity.");
  const normalizedCurrency = currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalizedCurrency))
    throw new Error("Yuanta settlement linkage requires an ISO currency code.");
  return deriveSourceConnectionIdentityKey(
    "yuanta-foreign-settlement-linkage",
    [
      YUANTA_FOREIGN_SETTLEMENT_LINKAGE_CONTRACT_VERSION,
      stableLoginIdentity,
      normalizedCurrency,
      "複委託扣",
      "複委託入",
      "淨額扣",
      "淨額入",
    ],
  );
}

/** The public live contract observed for Yuanta overseas equity settlement.
 * The holiday set is deliberately versioned with the contract so a later
 * provider-calendar correction can be admitted without silently changing old
 * relation judgments. */
const YUANTA_TAIWAN_HOLIDAYS_V1 = new Set([
  "2026-01-01",
  "2026-02-16",
  "2026-02-17",
  "2026-02-18",
  "2026-02-19",
  "2026-02-20",
  "2026-02-27",
  "2026-04-03",
  "2026-04-06",
  "2026-05-01",
  "2026-06-19",
  "2026-09-25",
  "2026-10-09",
]);

function isBusinessDay(dateValue: string): boolean {
  const weekday = new Date(`${dateValue}T00:00:00Z`).getUTCDay();
  return weekday !== 0 && weekday !== 6 && !YUANTA_TAIWAN_HOLIDAYS_V1.has(dateValue);
}

function addSettlementBusinessDays(
  effectiveOn: string,
  action: "buy" | "sell",
  settlementMarket: string | undefined,
): string | null {
  if (settlementMarket !== YUANTA_FOREIGN_SETTLEMENT_MARKET_US_EQUITY)
    return null;
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(effectiveOn) ||
    effectiveOn < YUANTA_FOREIGN_SETTLEMENT_CALENDAR_START ||
    effectiveOn > YUANTA_FOREIGN_SETTLEMENT_CALENDAR_END
  )
    return null;
  const days = action === "buy" ? 1 : 2;
  const dateValue = new Date(`${effectiveOn}T00:00:00Z`);
  let counted = 0;
  while (counted < days) {
    dateValue.setUTCDate(dateValue.getUTCDate() + 1);
    const candidate = dateValue.toISOString().slice(0, 10);
    if (candidate > YUANTA_FOREIGN_SETTLEMENT_CALENDAR_END) return null;
    if (isBusinessDay(candidate)) counted += 1;
  }
  return dateValue.toISOString().slice(0, 10);
}

function scaledInteger(
  coefficient: string,
  scale: number,
  targetScale: number,
): bigint {
  return BigInt(coefficient) * 10n ** BigInt(targetScale - scale);
}

function currentStateSql(alias: string): string {
  return `NOT EXISTS (
    SELECT 1 FROM investment_funding_relation_events newer
     WHERE newer.relation_id=${alias}.relation_id
       AND (newer.recorded_at_utc_us > ${alias}.recorded_at_utc_us
         OR (newer.recorded_at_utc_us = ${alias}.recorded_at_utc_us
           AND newer.rowid > ${alias}.rowid))
  )`;
}

type FundingCandidate = {
  accountId: Uint8Array;
  transactionId: Uint8Array;
  sourceRecordId: Uint8Array;
  coefficient: string;
  scale: number;
  accountNumber: string;
  scopeStart: string;
  scopeEnd: string;
};

type SettlementLinkagePayload = {
  key: string;
  contractVersion: string;
};

function parseSettlementLinkage(
  payloadJson: string,
): SettlementLinkagePayload | null {
  try {
    const payload = JSON.parse(payloadJson) as {
      sourcePayload?: {
        settlementLinkageKey?: unknown;
        settlementLinkageContractVersion?: unknown;
      };
    };
    const key = payload.sourcePayload?.settlementLinkageKey;
    const contractVersion =
      payload.sourcePayload?.settlementLinkageContractVersion;
    if (typeof key !== "string" || typeof contractVersion !== "string")
      return null;
    return { key: key.trim(), contractVersion: contractVersion.trim() };
  } catch {
    return null;
  }
}

function parseTransactionInfo(payloadJson: string): string {
  try {
    const payload = JSON.parse(payloadJson) as {
      sourcePayload?: { transactionInfo?: unknown };
    };
    return typeof payload.sourcePayload?.transactionInfo === "string"
      ? payload.sourcePayload.transactionInfo.trim()
      : "";
  } catch {
    return "";
  }
}

function fundingCandidates(
  db: DatabaseSync,
  settlementEffectiveOn: string,
  currency: string,
  direction: "inflow" | "outflow",
  expected: bigint,
  targetScale: number,
  expectedLinkageKey: string,
): FundingCandidate[] {
  const rows = db
    .prepare(
      `SELECT t.transaction_id AS transactionId,
              a.account_id AS accountId,a.account_no AS accountNumber,
              r.source_record_id AS sourceRecordId,
              r.amount_coefficient AS coefficient,r.amount_scale AS scale,
              r.description,p.payload_json AS payloadJson,
              scope.scope_start AS scopeStart,scope.scope_end AS scopeEnd,
              scope.completeness,scope.terminal
         FROM financial_transactions t
         JOIN financial_accounts a ON a.account_id=t.account_id
         JOIN source_connections connection
           ON connection.source_connection_id=a.source_connection_id
         JOIN current_transactions current_row
           ON current_row.transaction_id=t.transaction_id
         JOIN transaction_revisions r
           ON r.revision_id=current_row.revision_id
         JOIN source_records p
           ON p.source_record_id=r.source_record_id
         JOIN source_record_scopes record_scope
           ON record_scope.source_record_id=p.source_record_id
         JOIN capture_scopes scope ON scope.scope_id=record_scope.scope_id
        WHERE connection.integration_namespace='yuanta'
          AND a.stream='foreign-currency-deposit'
          AND a.account_type='depository'
          AND a.account_no IS NOT NULL
          AND r.effective_on=? AND r.direction=? AND r.currency=?
          AND r.posting_status='posted'
          AND r.economic_status='normal'
          AND r.administrative_state='active'
          AND r.description IN ('複委託扣','複委託入')`,
    )
    .all(settlementEffectiveOn, direction, currency) as Array<{
    transactionId: Uint8Array;
    accountId: Uint8Array;
    accountNumber: string;
    sourceRecordId: Uint8Array;
    coefficient: string;
    scale: number;
    description: string;
    payloadJson: string;
    scopeStart: string;
    scopeEnd: string;
    completeness: string;
    terminal: number;
  }>;
  const candidates = new Map<string, FundingCandidate>();
  const expectedDescription = direction === "outflow" ? "複委託扣" : "複委託入";
  const expectedInfo = direction === "outflow" ? "淨額扣" : "淨額入";
  for (const row of rows) {
    const accountNumber = String(row.accountNumber ?? "").replaceAll(/[\s-]/g, "");
    const linkage = parseSettlementLinkage(row.payloadJson);
    if (
      !/^\d{6,20}$/.test(accountNumber) ||
      row.description !== expectedDescription ||
      parseTransactionInfo(row.payloadJson) !== expectedInfo ||
      linkage?.key !== expectedLinkageKey ||
      linkage?.contractVersion !== YUANTA_FOREIGN_SETTLEMENT_LINKAGE_CONTRACT_VERSION ||
      row.completeness !== "complete-range" ||
      Number(row.terminal) !== 1 ||
      row.scopeStart > settlementEffectiveOn ||
      row.scopeEnd < settlementEffectiveOn
    )
      continue;
    const comparisonScale = Math.max(targetScale, Number(row.scale));
    if (
      scaledInteger(String(row.coefficient), Number(row.scale), comparisonScale) !==
      scaledInteger(expected.toString(), targetScale, comparisonScale)
    )
      continue;
    const key = idHex(row.transactionId);
    if (!candidates.has(key))
      candidates.set(key, {
        accountId: row.accountId,
        transactionId: row.transactionId,
        sourceRecordId: row.sourceRecordId,
        coefficient: String(row.coefficient),
        scale: Number(row.scale),
        accountNumber,
        scopeStart: row.scopeStart,
        scopeEnd: row.scopeEnd,
      });
  }
  return [...candidates.values()];
}

function hasCompleteInvestmentCoverage(
  db: DatabaseSync,
  sourceRecordIds: readonly Uint8Array[],
  intervalStart: string,
  intervalEnd: string,
): boolean {
  if (sourceRecordIds.length === 0) return false;
  const placeholders = sourceRecordIds.map(() => "?").join(",");
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT record_scope.source_record_id) AS covered
         FROM source_record_scopes record_scope
         JOIN capture_scopes scope ON scope.scope_id=record_scope.scope_id
        WHERE record_scope.source_record_id IN (${placeholders})
          AND scope.scope_start<=? AND scope.scope_end>=?
          AND scope.completeness='complete-range' AND scope.terminal=1`,
    )
    .get(...sourceRecordIds, intervalStart, intervalEnd) as {
    covered?: number;
  };
  return Number(row.covered ?? 0) === sourceRecordIds.length;
}

type FundingCoverageState = "complete" | "incomplete" | "missing";

function fundingCoverageState(
  db: DatabaseSync,
  settlementEffectiveOn: string,
  currency: string,
  direction: "inflow" | "outflow" | null,
  expectedLinkageKey: string,
): FundingCoverageState {
  const rows = db
    .prepare(
      `SELECT scope.scope_start AS scopeStart,scope.scope_end AS scopeEnd,
              scope.completeness,scope.terminal,
              revision.direction,revision.description,
              source_record.payload_json AS payloadJson
         FROM financial_accounts account
         JOIN source_connections connection
           ON connection.source_connection_id=account.source_connection_id
         JOIN financial_transactions transaction_row
           ON transaction_row.account_id=account.account_id
         JOIN current_transactions current_row
           ON current_row.transaction_id=transaction_row.transaction_id
         JOIN transaction_revisions revision
           ON revision.revision_id=current_row.revision_id
         JOIN source_records source_record
           ON source_record.source_record_id=revision.source_record_id
         JOIN source_record_scopes record_scope
           ON record_scope.source_record_id=source_record.source_record_id
         JOIN capture_scopes scope ON scope.scope_id=record_scope.scope_id
        WHERE connection.integration_namespace='yuanta'
          AND account.stream='foreign-currency-deposit'
          AND account.account_type='depository'
          AND revision.currency=?
          AND revision.posting_status='posted'
          AND revision.economic_status='normal'
          AND revision.administrative_state='active'
          AND scope.scope_start<=? AND scope.scope_end>=?
          AND (? IS NULL OR revision.direction=?)`,
    )
    .all(
      currency,
      settlementEffectiveOn,
      settlementEffectiveOn,
      direction,
      direction,
    ) as Array<{
    scopeStart: string;
    scopeEnd: string;
    completeness: string;
    terminal: number;
    direction: "inflow" | "outflow";
    description: string | null;
    payloadJson: string;
  }>;
  const relevantRows = rows.filter((row) => {
    const expectedDescription =
      row.direction === "outflow" ? "複委託扣" : "複委託入";
    const expectedInfo = row.direction === "outflow" ? "淨額扣" : "淨額入";
    const linkage = parseSettlementLinkage(row.payloadJson);
    return (
      row.description === expectedDescription &&
      parseTransactionInfo(row.payloadJson) === expectedInfo &&
      linkage?.key === expectedLinkageKey &&
      linkage.contractVersion ===
        YUANTA_FOREIGN_SETTLEMENT_LINKAGE_CONTRACT_VERSION
    );
  });
  if (relevantRows.length === 0) return "missing";
  if (
    relevantRows.some(
      (row) => row.completeness !== "complete-range" || Number(row.terminal) !== 1,
    )
  )
    return "incomplete";
  return "complete";
}

function completeFundingAccounts(
  db: DatabaseSync,
  accountNumberValue: string,
  currency: string,
  settlementEffectiveOn: string,
): Array<{ accountId: Uint8Array }> {
  const accountNumber = accountNumberValue
    .normalize("NFKC")
    .replaceAll(/[-\s]/g, "");
  if (!/^\d{6,20}$/.test(accountNumber)) return [];
  return db
    .prepare(
      `SELECT DISTINCT a.account_id AS accountId
         FROM financial_accounts a
         JOIN capture_scopes s ON s.account_id=a.account_id
        WHERE REPLACE(REPLACE(REPLACE(a.account_no,' ',''),'-',''),'　','')=?
          AND a.account_type='depository'
          AND a.currency=? AND s.scope_start<=? AND s.scope_end>=?
          AND s.completeness='complete-range' AND s.terminal=1`,
    )
    .all(
      accountNumber,
      currency,
      settlementEffectiveOn,
      settlementEffectiveOn,
    ) as Array<{ accountId: Uint8Array }>;
}

function relationSupportFingerprint(
  db: DatabaseSync,
  sourceRecordIds: readonly Uint8Array[],
  transactionIds: readonly Uint8Array[],
): string {
  const directSourceRecordIds = [
    ...new Map(
      sourceRecordIds.map((sourceRecordId) => [
        idHex(sourceRecordId),
        sourceRecordId,
      ]),
    ).values(),
  ];
  const uniqueTransactionIds = [
    ...new Map(
      transactionIds.map((transactionId) => [idHex(transactionId), transactionId]),
    ).values(),
  ];
  const assertionRows =
    uniqueTransactionIds.length === 0
      ? []
      : (db
          .prepare(
            `SELECT provenance.source_record_id AS sourceRecordId,
                    provenance.commit_id AS commitId
               FROM assertion_provenance provenance
               JOIN assertions assertion ON assertion.assertion_id=provenance.assertion_id
              WHERE assertion.transaction_id IN (${uniqueTransactionIds
                .map(() => "?")
                .join(",")})
              ORDER BY provenance.source_record_id,provenance.commit_id`,
          )
          .all(...uniqueTransactionIds) as Array<{
          sourceRecordId: Uint8Array;
          commitId: Uint8Array;
        }>);
  const allSourceRecordIds = [
    ...new Map(
      [
        ...directSourceRecordIds,
        ...assertionRows.map((row) => row.sourceRecordId),
      ].map((sourceRecordId) => [idHex(sourceRecordId), sourceRecordId]),
    ).values(),
  ].sort((left, right) => idHex(left).localeCompare(idHex(right)));
  const placeholders = allSourceRecordIds.map(() => "?").join(",");
  const provenanceRows =
    allSourceRecordIds.length === 0
      ? []
      : (db
          .prepare(
            `SELECT source_record_id AS sourceRecordId,capture_id AS captureId,
                    commit_id AS commitId
               FROM source_record_provenance
              WHERE source_record_id IN (${placeholders})
              ORDER BY source_record_id,capture_id,commit_id`,
          )
          .all(...allSourceRecordIds) as Array<{
          sourceRecordId: Uint8Array;
          captureId: Uint8Array;
          commitId: Uint8Array;
        }>);
  if (allSourceRecordIds.length === 0 && uniqueTransactionIds.length === 0)
    return digest("investment-funding-relation-support-v2");
  return digest(
    "investment-funding-relation-support-v2",
    ...uniqueTransactionIds.map(idHex).sort(),
    ...allSourceRecordIds.map(idHex),
    ...provenanceRows.flatMap((row) => [
      idHex(row.sourceRecordId),
      idHex(row.captureId),
      idHex(row.commitId),
    ]),
    ...assertionRows.flatMap((row) => [
      idHex(row.sourceRecordId),
      idHex(row.commitId),
    ]),
  );
}

function observeRelationWithSupport(
  db: DatabaseSync,
  relationId: Uint8Array,
  reasonPrefix: string,
  supportFingerprint: string,
  eventWriter: RelationEventWriter,
): boolean {
  const reason = `${reasonPrefix}:${supportFingerprint}`;
  const latest = db
    .prepare(
      `SELECT event_kind AS eventKind,reason
         FROM investment_funding_relation_events
        WHERE relation_id=?
        ORDER BY recorded_at_utc_us DESC,rowid DESC LIMIT 1`,
    )
    .get(relationId) as { eventKind: string; reason: string } | undefined;
  if (latest?.eventKind === "observed" && latest.reason === reason)
    return false;
  db.prepare(
    `INSERT OR IGNORE INTO investment_funding_relation_events(
       event_id,relation_id,event_kind,reason,commit_id,recorded_at_utc_us
     ) VALUES(?,?,'observed',?,?,?)`,
  ).run(
    uuidV7(),
    relationId,
    reason,
    eventWriter.ensureCommit(),
    eventWriter.nextEventTime(),
  );
  return true;
}

type RelationEventWriter = {
  ensureCommit: () => Buffer;
  nextEventTime: () => number;
};

function withdrawCurrentRelations(
  db: DatabaseSync,
  investmentAccountId: Uint8Array,
  settlementGroupKey: string,
  eventWriter: RelationEventWriter,
  reason: string,
  exceptRelationId?: Uint8Array,
): number {
  const rows = db
    .prepare(
      `SELECT relation.relation_id AS relationId
         FROM investment_funding_relations relation
         JOIN investment_funding_relation_events event
           ON event.relation_id=relation.relation_id
        WHERE relation.investment_account_id=?
          AND relation.settlement_group_key=?
          AND event.event_kind='observed'
          AND ${currentStateSql("event")}`,
    )
    .all(investmentAccountId, settlementGroupKey) as Array<{
    relationId: Uint8Array;
  }>;
  let withdrawn = 0;
  for (const row of rows) {
    if (
      exceptRelationId &&
      Buffer.from(row.relationId).equals(Buffer.from(exceptRelationId))
    )
      continue;
    db.prepare(
      `INSERT OR IGNORE INTO investment_funding_relation_events(
         event_id,relation_id,event_kind,reason,commit_id,recorded_at_utc_us
       ) VALUES(?,?,'withdrawn',?,?,?)`,
    ).run(
      uuidV7(),
      row.relationId,
      reason,
      eventWriter.ensureCommit(),
      eventWriter.nextEventTime(),
    );
    withdrawn += 1;
  }
  return withdrawn;
}

/** Amount is only a discriminator after the provider-specific settlement
 * contract supplies the grouping model; the bank capture supplies the actual
 * account, booking date, and fixed Institution-generated note. */
function relationStorePath(store: RelationResolutionStore): string {
  const databasePath = store.databasePath;
  if (!databasePath)
    throw new Error("Canonical investment relation resolver requires a database path.");
  return databasePath;
}

function resolveCanonicalInvestmentFundingRelationsInQueue(
  store: RelationResolutionStore,
): { resolved: number; noAdmission: number; reasons: string[] } {
  const sourceRows = store.db
    .prepare(
      `SELECT it.transaction_id AS transactionId,it.account_id AS investmentAccountId,
              it.source_record_id AS sourceRecordId,it.commit_id AS commitId,
              it.action,it.cash_coefficient AS cashCoefficient,
              it.cash_scale AS cashScale,it.cash_currency AS cashCurrency,
              it.effective_on AS effectiveOn,
              it.funding_evidence_json AS fundingEvidenceJson
         FROM investment_transactions it
        WHERE it.action IN ('buy','sell')
        ORDER BY it.account_id,it.effective_on,it.transaction_id`,
    )
    .all() as InvestmentRow[];
  const groups = new Map<
    string,
    Array<InvestmentRow & { evidence: InvestmentFundingEvidence }>
  >();
  for (const row of sourceRows) {
    const evidence = JSON.parse(
      row.fundingEvidenceJson,
    ) as InvestmentFundingEvidence;
    const key =
      evidence.kind === "source-linked-account"
        ? `${idHex(row.investmentAccountId)}\0${evidence.settlementGroupKey}`
        : evidence.kind === "source-settlement-contract"
          ? `${idHex(row.investmentAccountId)}\0${row.cashCurrency}\0${evidence.settlementMarket}\0${addSettlementBusinessDays(row.effectiveOn, row.action, evidence.settlementMarket) ?? "unsupported-calendar"}`
          : "";
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push({ ...row, evidence });
    groups.set(key, group);
  }

  let resolved = 0;
  let noAdmission = 0;
  const reasons = new Set<string>();
  let resolutionCommitId: Buffer | null = null;
  let resolutionCommitRecordedAt: number | null = null;
  let resolutionEventOrdinal = 0;
  const ensureResolutionCommit = (): Buffer => {
    if (resolutionCommitId) return resolutionCommitId;
    const nextSequence =
      Number(
        (
          store.db
            .prepare(
              "SELECT COALESCE(MAX(commit_sequence), 0) AS value FROM canonical_commits",
            )
            .get() as { value?: number }
        ).value ?? 0,
      ) + 1;
    const latestRecordedAt = Number(
      (
        store.db
          .prepare(
            "SELECT COALESCE(MAX(recorded_at_utc_us), -1) AS value FROM canonical_commits",
          )
          .get() as { value?: number }
      ).value ?? -1,
    );
    resolutionCommitRecordedAt = Math.max(
      store.commitClock(),
      latestRecordedAt + 1,
    );
    resolutionCommitId = uuidV7();
    store.db
      .prepare(
        `INSERT INTO canonical_commits(
           commit_id,commit_sequence,recorded_at_utc_us,authority_route,commit_kind
         ) VALUES(?,?,?,'canonical/investment-funding-relation-resolution-v1',
                  'relation_resolution')`,
      )
      .run(
        resolutionCommitId,
        nextSequence,
        resolutionCommitRecordedAt,
      );
    return resolutionCommitId;
  };
  const eventWriter: RelationEventWriter = {
    ensureCommit: ensureResolutionCommit,
    nextEventTime: () => {
      if (resolutionCommitRecordedAt === null)
        throw new Error("Relation resolution event requires a resolution commit.");
      resolutionEventOrdinal += 1;
      return resolutionCommitRecordedAt + resolutionEventOrdinal;
    },
  };
  store.db.exec("BEGIN IMMEDIATE");
  try {
    for (const group of groups.values()) {
      const first = group[0]!;
      const evidence = first.evidence;
      if (evidence.kind === "source-settlement-contract") {
        if (
          evidence.settlementMarket !==
            YUANTA_FOREIGN_SETTLEMENT_MARKET_US_EQUITY ||
          evidence.settlementMarketContractVersion !==
            YUANTA_FOREIGN_SETTLEMENT_MARKET_CONTRACT_VERSION
        ) {
          noAdmission += 1;
          reasons.add("unsupported-settlement-market");
          continue;
        }
        const settlementEffectiveOn = addSettlementBusinessDays(
          first.effectiveOn,
          first.action,
          evidence.settlementMarket,
        );
        if (!settlementEffectiveOn) {
          noAdmission += 1;
          reasons.add("unsupported-settlement-calendar");
          continue;
        }
        const settlementGroupKey = digest(
          "yuanta-foreign-settlement-group-v1",
          idHex(first.investmentAccountId),
          first.cashCurrency,
          evidence.settlementMarket,
          settlementEffectiveOn,
        );
        const tradeIntervalStart = group.reduce(
          (earliest, row) =>
            row.effectiveOn < earliest ? row.effectiveOn : earliest,
          first.effectiveOn,
        );
        if (
          !hasCompleteInvestmentCoverage(
            store.db,
            group.map((row) => row.sourceRecordId),
            tradeIntervalStart,
            settlementEffectiveOn,
          )
        ) {
          noAdmission += 1;
          reasons.add("incomplete-investment-coverage");
          continue;
        }
        const inconsistent = group.some(
          (row) =>
            row.evidence.kind !== "source-settlement-contract" ||
            row.evidence.settlementModel !== evidence.settlementModel ||
            row.evidence.contractVersion !==
              YUANTA_FOREIGN_SETTLEMENT_CONTRACT_VERSION ||
            row.evidence.linkageContractVersion !==
              evidence.linkageContractVersion ||
            row.evidence.sourceLinkageKey !== evidence.sourceLinkageKey ||
            row.evidence.settlementMarket !== evidence.settlementMarket ||
            row.evidence.settlementMarketContractVersion !==
              evidence.settlementMarketContractVersion ||
            row.cashCurrency !== first.cashCurrency ||
            addSettlementBusinessDays(
              row.effectiveOn,
              row.action,
              row.evidence.settlementMarket,
            ) !==
              settlementEffectiveOn,
        );
        if (inconsistent) {
          noAdmission += 1;
          reasons.add("inconsistent-settlement-group");
          continue;
        }
        const targetScale = Math.max(...group.map((row) => row.cashScale));
        const signed = group.reduce((sum, row) => {
          const amount = scaledInteger(
            row.cashCoefficient,
            row.cashScale,
            targetScale,
          );
          return sum + (row.action === "buy" ? amount : -amount);
        }, 0n);
        if (signed === 0n) {
          noAdmission += 1;
          reasons.add("zero-net-settlement");
          if (
            fundingCoverageState(
              store.db,
              settlementEffectiveOn,
              first.cashCurrency,
              null,
              evidence.sourceLinkageKey,
            ) === "complete"
          )
            withdrawCurrentRelations(
              store.db,
              first.investmentAccountId,
              settlementGroupKey,
              eventWriter,
              "complete-resolution:zero-net-settlement",
            );
          continue;
        }
        const direction = signed > 0n ? "outflow" : "inflow";
        const expected = signed < 0n ? -signed : signed;
        const fundingCoverage = fundingCoverageState(
          store.db,
          settlementEffectiveOn,
          first.cashCurrency,
          direction,
          evidence.sourceLinkageKey,
        );
        const candidateRows = fundingCandidates(
          store.db,
          settlementEffectiveOn,
          first.cashCurrency,
          direction,
          expected,
          targetScale,
          evidence.sourceLinkageKey,
        );
        if (fundingCoverage !== "complete" || candidateRows.length !== 1) {
          noAdmission += 1;
          const reason =
            fundingCoverage !== "complete" || candidateRows.length === 0
              ? "no-complete-funding-candidate"
              : "ambiguous-funding-candidate";
          reasons.add(reason);
          if (fundingCoverage === "complete")
            withdrawCurrentRelations(
              store.db,
              first.investmentAccountId,
              settlementGroupKey,
              eventWriter,
              `complete-resolution:${reason}`,
            );
          continue;
        }
        const candidate = candidateRows[0]!;
        const relationKey = digest(
          "investment-funding-relation-v1",
          idHex(first.investmentAccountId),
          idHex(candidate.transactionId),
          ...group.map((row) => idHex(row.transactionId)).sort(),
        );
        const sourceLinkageKey = digest(
          "investment-funding-linkage-set-v1",
          ...group
            .map((row) =>
              row.evidence.kind === "source-settlement-contract"
                ? row.evidence.sourceLinkageKey
                : "",
            )
            .sort(),
        );
        const existing = store.db
          .prepare(
            "SELECT relation_id AS relationId FROM investment_funding_relations WHERE relation_key=?",
          )
          .get(relationKey) as { relationId: Uint8Array } | undefined;
        const relationId = existing?.relationId ?? uuidV7();
        if (!existing) {
          store.db
            .prepare(
              `INSERT INTO investment_funding_relations(
                 relation_id,relation_key,settlement_group_key,investment_account_id,
                 funding_account_id,funding_transaction_id,funding_source_record_id,
                 settlement_effective_on,settlement_model,coefficient,scale,currency,
                 direction,source_linkage_key,evidence_contract_version,created_commit_id
               ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            )
            .run(
              relationId,
              relationKey,
              settlementGroupKey,
              first.investmentAccountId,
              candidate.accountId,
              candidate.transactionId,
              candidate.sourceRecordId,
              settlementEffectiveOn,
              "account-currency-date-net",
              expected.toString(),
              targetScale,
              first.cashCurrency,
              direction,
              sourceLinkageKey,
              YUANTA_FOREIGN_SETTLEMENT_CONTRACT_VERSION,
              ensureResolutionCommit(),
            );
          const insertMember = store.db.prepare(
            `INSERT INTO investment_funding_relation_members(
               relation_id,investment_transaction_id,investment_source_record_id,
               action,coefficient,scale,currency
             ) VALUES(?,?,?,?,?,?,?)`,
          );
          for (const row of group)
            insertMember.run(
              relationId,
              row.transactionId,
              row.sourceRecordId,
              row.action,
              row.cashCoefficient,
              row.cashScale,
              row.cashCurrency,
            );
        }
        observeRelationWithSupport(
          store.db,
          relationId,
          "verified-yuanta-settlement-note",
          relationSupportFingerprint(store.db, [
            ...group.map((row) => row.sourceRecordId),
            candidate.sourceRecordId,
          ], [
            ...group.map((row) => row.transactionId),
            candidate.transactionId,
          ]),
          eventWriter,
        );
        withdrawCurrentRelations(
          store.db,
          first.investmentAccountId,
          settlementGroupKey,
          eventWriter,
          "stronger-current-resolution",
          relationId,
        );
        resolved += 1;
        continue;
      }
      if (evidence.kind !== "source-linked-account") continue;
      const inconsistent = group.some(
        (row) => {
          if (row.evidence.kind !== "source-linked-account") return true;
          return (
            row.evidence.fundingAccountKey !== evidence.fundingAccountKey ||
            row.evidence.settlementEffectiveOn !==
              evidence.settlementEffectiveOn ||
            row.evidence.settlementModel !== evidence.settlementModel ||
            row.cashCurrency !== first.cashCurrency
          );
        },
      );
      if (
        inconsistent ||
        (evidence.settlementModel === "single-transaction" &&
          group.length !== 1)
      ) {
        noAdmission += 1;
        reasons.add("inconsistent-settlement-group");
        continue;
      }

      const fundingAccounts = completeFundingAccounts(
        store.db,
        evidence.fundingAccountNumber,
        first.cashCurrency,
        evidence.settlementEffectiveOn,
      );
      const targetScale = Math.max(...group.map((row) => row.cashScale));
      const signed = group.reduce((sum, row) => {
        const amount = scaledInteger(
          row.cashCoefficient,
          row.cashScale,
          targetScale,
        );
        return sum + (row.action === "buy" ? amount : -amount);
      }, 0n);
      if (signed === 0n) {
        noAdmission += 1;
        reasons.add("zero-net-settlement");
        if (fundingAccounts.length > 0)
          withdrawCurrentRelations(
            store.db,
            first.investmentAccountId,
            evidence.settlementGroupKey,
            eventWriter,
            "complete-resolution:zero-net-settlement",
          );
        continue;
      }
      const direction = signed > 0n ? "outflow" : "inflow";
      const expected = signed < 0n ? -signed : signed;
      const candidates: Array<{
        accountId: Uint8Array;
        transactionId: Uint8Array;
        sourceRecordId: Uint8Array;
        coefficient: string;
        scale: number;
      }> = [];
      for (const account of fundingAccounts) {
        const rows = store.db
          .prepare(
            `SELECT t.transaction_id AS transactionId,r.source_record_id AS sourceRecordId,
                    r.amount_coefficient AS coefficient,r.amount_scale AS scale
               FROM financial_transactions t
               JOIN current_transactions c ON c.transaction_id=t.transaction_id
               JOIN transaction_revisions r ON r.revision_id=c.revision_id
              WHERE t.account_id=? AND r.effective_on=? AND r.direction=?
                AND r.currency=? AND r.posting_status='posted'
                AND r.economic_status='normal' AND r.administrative_state='active'`,
          )
          .all(
            account.accountId,
            evidence.settlementEffectiveOn,
            direction,
            first.cashCurrency,
          ) as Array<{
          transactionId: Uint8Array;
          sourceRecordId: Uint8Array;
          coefficient: string;
          scale: number;
        }>;
        for (const row of rows) {
          const comparisonScale = Math.max(targetScale, row.scale);
          if (
            scaledInteger(row.coefficient, row.scale, comparisonScale) ===
            scaledInteger(
              expected.toString(),
              targetScale,
              comparisonScale,
            )
          )
            candidates.push({ ...row, accountId: account.accountId });
        }
      }
      if (candidates.length !== 1) {
        noAdmission += 1;
        const reason =
          candidates.length === 0
            ? "no-complete-funding-candidate"
            : "ambiguous-funding-candidate";
        reasons.add(reason);
        if (fundingAccounts.length > 0)
          withdrawCurrentRelations(
            store.db,
            first.investmentAccountId,
            evidence.settlementGroupKey,
            eventWriter,
            `complete-resolution:${reason}`,
          );
        continue;
      }

      const candidate = candidates[0]!;
      const relationKey = digest(
        "investment-funding-relation-v1",
        idHex(first.investmentAccountId),
        idHex(candidate.transactionId),
        ...group.map((row) => idHex(row.transactionId)).sort(),
      );
      const sourceLinkageKey = digest(
        "investment-funding-linkage-set-v1",
        ...group
          .map((row) =>
            row.evidence.kind === "source-linked-account"
              ? row.evidence.sourceLinkageKey
              : "",
          )
          .sort(),
      );
      const existing = store.db
        .prepare(
          "SELECT relation_id AS relationId FROM investment_funding_relations WHERE relation_key=?",
        )
        .get(relationKey) as { relationId: Uint8Array } | undefined;
      const relationId = existing?.relationId ?? uuidV7();
      if (!existing) {
        store.db
          .prepare(
            `INSERT INTO investment_funding_relations(
               relation_id,relation_key,settlement_group_key,investment_account_id,
               funding_account_id,funding_transaction_id,funding_source_record_id,
               settlement_effective_on,settlement_model,coefficient,scale,currency,
               direction,source_linkage_key,evidence_contract_version,created_commit_id
             ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            relationId,
            relationKey,
            evidence.settlementGroupKey,
            first.investmentAccountId,
            candidate.accountId,
            candidate.transactionId,
            candidate.sourceRecordId,
            evidence.settlementEffectiveOn,
            evidence.settlementModel,
            expected.toString(),
            targetScale,
            first.cashCurrency,
            direction,
            sourceLinkageKey,
            evidence.contractVersion,
            ensureResolutionCommit(),
          );
        const insertMember = store.db.prepare(
          `INSERT INTO investment_funding_relation_members(
             relation_id,investment_transaction_id,investment_source_record_id,
             action,coefficient,scale,currency
           ) VALUES(?,?,?,?,?,?,?)`,
        );
        for (const row of group)
          insertMember.run(
            relationId,
            row.transactionId,
            row.sourceRecordId,
            row.action,
            row.cashCoefficient,
            row.cashScale,
            row.cashCurrency,
          );
      }

      withdrawCurrentRelations(
        store.db,
        first.investmentAccountId,
        evidence.settlementGroupKey,
        eventWriter,
        "stronger-current-resolution",
        relationId,
      );
      observeRelationWithSupport(
        store.db,
        relationId,
        "verified-settlement-account",
        relationSupportFingerprint(store.db, [
          ...group.map((row) => row.sourceRecordId),
          candidate.sourceRecordId,
        ], [
          ...group.map((row) => row.transactionId),
          candidate.transactionId,
        ]),
        eventWriter,
      );
      resolved += 1;
    }
    store.db.exec("COMMIT");
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
  return { resolved, noAdmission, reasons: [...reasons].sort() };
}

export async function resolveCanonicalInvestmentFundingRelations(
  store: RelationResolutionStore,
): Promise<{ resolved: number; noAdmission: number; reasons: string[] }> {
  assertValidatedCanonicalDatabase(store.db);
  return withCanonicalWriterQueue(relationStorePath(store), () =>
    resolveCanonicalInvestmentFundingRelationsInQueue(store),
  );
}

export function queryCanonicalInvestmentFundingRelationsInSnapshot(
  store: RelationResolutionStore,
  sourceConnectionKey: string,
) {
  assertValidatedCanonicalDatabase(store.db);
  return store.db
      .prepare(
        `SELECT r.relation_key AS relationKey,r.settlement_group_key AS settlementGroupKey,
                r.settlement_effective_on AS settlementEffectiveOn,
                r.settlement_model AS settlementModel,r.coefficient,r.scale,
                r.currency,r.direction,r.source_linkage_key AS sourceLinkageKey,
                COUNT(m.investment_transaction_id) AS investmentTransactionCount
           FROM investment_funding_relations r
           JOIN investment_accounts a ON a.account_id=r.investment_account_id
           JOIN source_connections c ON c.source_connection_id=a.source_connection_id
           JOIN investment_funding_relation_members m ON m.relation_id=r.relation_id
           JOIN investment_funding_relation_events e ON e.relation_id=r.relation_id
          WHERE c.source_connection_key=? AND e.event_kind='observed'
            AND ${currentStateSql("e")}
          GROUP BY r.relation_id ORDER BY r.settlement_effective_on,r.relation_key`,
      )
      .all(sourceConnectionKey);
}

export function queryCanonicalInvestmentFundingRelations(
  store: RelationResolutionStore,
  sourceConnectionKey: string,
) {
  assertValidatedCanonicalDatabase(store.db);
  return withCanonicalSnapshot(store.db, () =>
    queryCanonicalInvestmentFundingRelationsInSnapshot(
      store,
      sourceConnectionKey,
    ),
  );
}
