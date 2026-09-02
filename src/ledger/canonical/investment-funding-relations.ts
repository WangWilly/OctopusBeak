import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { CanonicalSourceStore } from "./canonical-source-store.ts";
import { withCanonicalSnapshot } from "./canonical-runtime.ts";
import type { InvestmentFundingEvidence } from "./investment-financial.ts";

type LinkedFundingEvidence = Extract<
  InvestmentFundingEvidence,
  { kind: "source-linked-account" }
>;
type RelationResolutionStore = Pick<CanonicalSourceStore, "db" | "commitClock">;

type InvestmentRow = {
  transactionId: Uint8Array;
  investmentAccountId: Uint8Array;
  sourceRecordId: Uint8Array;
  commitId: Uint8Array;
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
): string {
  const days = action === "buy" ? 1 : 2;
  const dateValue = new Date(`${effectiveOn}T00:00:00Z`);
  let counted = 0;
  while (counted < days) {
    dateValue.setUTCDate(dateValue.getUTCDate() + 1);
    const candidate = dateValue.toISOString().slice(0, 10);
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
    if (
      !/^\d{6,20}$/.test(accountNumber) ||
      row.description !== expectedDescription ||
      parseTransactionInfo(row.payloadJson) !== expectedInfo ||
      row.completeness !== "complete-range" ||
      Number(row.terminal) !== 1 ||
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
  sourceRecordId: Uint8Array,
  effectiveOn: string,
): boolean {
  return Boolean(
    db
      .prepare(
        `SELECT 1
           FROM source_record_scopes record_scope
           JOIN capture_scopes scope ON scope.scope_id=record_scope.scope_id
          WHERE record_scope.source_record_id=?
            AND scope.scope_start<=? AND scope.scope_end>=?
            AND scope.completeness='complete-range' AND scope.terminal=1
          LIMIT 1`,
      )
      .get(sourceRecordId, effectiveOn, effectiveOn),
  );
}

/** Amount is only a discriminator after the provider-specific settlement
 * contract supplies the grouping model; the bank capture supplies the actual
 * account, booking date, and fixed Institution-generated note. */
export function resolveCanonicalInvestmentFundingRelations(
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
          ? `${idHex(row.investmentAccountId)}\0${row.cashCurrency}\0${addSettlementBusinessDays(row.effectiveOn, row.action)}`
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
  store.db.exec("BEGIN IMMEDIATE");
  try {
    for (const group of groups.values()) {
      const first = group[0]!;
      const evidence = first.evidence;
      if (evidence.kind === "source-settlement-contract") {
        const settlementEffectiveOn = addSettlementBusinessDays(
          first.effectiveOn,
          first.action,
        );
        if (
          group.some(
            (row) =>
              !hasCompleteInvestmentCoverage(
                store.db,
                row.sourceRecordId,
                row.effectiveOn,
              ),
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
            row.cashCurrency !== first.cashCurrency ||
            addSettlementBusinessDays(row.effectiveOn, row.action) !==
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
          continue;
        }
        const direction = signed > 0n ? "outflow" : "inflow";
        const expected = signed < 0n ? -signed : signed;
        const candidateRows = fundingCandidates(
          store.db,
          settlementEffectiveOn,
          first.cashCurrency,
          direction,
          expected,
          targetScale,
        );
        if (candidateRows.length !== 1) {
          noAdmission += 1;
          reasons.add(
            candidateRows.length === 0
              ? "no-complete-funding-candidate"
              : "ambiguous-funding-candidate",
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
              digest(
                "yuanta-foreign-settlement-group-v1",
                idHex(first.investmentAccountId),
                first.cashCurrency,
                settlementEffectiveOn,
              ),
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
        const latest = store.db
          .prepare(
            `SELECT event_kind AS eventKind FROM investment_funding_relation_events
              WHERE relation_id=? ORDER BY recorded_at_utc_us DESC,rowid DESC LIMIT 1`,
          )
          .get(relationId) as { eventKind: string } | undefined;
        if (latest?.eventKind !== "observed")
          store.db
            .prepare(
              `INSERT OR IGNORE INTO investment_funding_relation_events(
                 event_id,relation_id,event_kind,reason,commit_id,recorded_at_utc_us
               ) VALUES(?,?,'observed','verified-yuanta-settlement-note',?,?)`,
            )
            .run(
              uuidV7(),
              relationId,
              ensureResolutionCommit(),
              resolutionCommitRecordedAt! + 1,
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
        continue;
      }
      const direction = signed > 0n ? "outflow" : "inflow";
      const expected = signed < 0n ? -signed : signed;
      const fundingAccounts = store.db
        .prepare(
          `SELECT DISTINCT a.account_id AS accountId
             FROM financial_accounts a
             JOIN capture_scopes s ON s.account_id=a.account_id
            WHERE a.account_no=? AND a.account_type='depository'
              AND a.currency=? AND s.scope_start<=? AND s.scope_end>=?
              AND s.completeness='complete-range' AND s.terminal=1`,
        )
        .all(
          evidence.fundingAccountKey,
          first.cashCurrency,
          evidence.settlementEffectiveOn,
          evidence.settlementEffectiveOn,
        ) as Array<{ accountId: Uint8Array }>;
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
        reasons.add(
          candidates.length === 0
            ? "no-complete-funding-candidate"
            : "ambiguous-funding-candidate",
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

      const priorRelations = store.db
        .prepare(
          `SELECT r.relation_id AS relationId
             FROM investment_funding_relations r
             JOIN investment_funding_relation_events e ON e.relation_id=r.relation_id
            WHERE r.investment_account_id=? AND r.settlement_group_key=?
              AND r.relation_id<>? AND e.event_kind='observed'
              AND ${currentStateSql("e")}`,
        )
        .all(
          first.investmentAccountId,
          evidence.settlementGroupKey,
          relationId,
        ) as Array<{ relationId: Uint8Array }>;
      for (const prior of priorRelations) {
        const commitId = ensureResolutionCommit();
        store.db
          .prepare(
            `INSERT OR IGNORE INTO investment_funding_relation_events(
               event_id,relation_id,event_kind,reason,commit_id,recorded_at_utc_us
             ) VALUES(?,?,'withdrawn','stronger-current-resolution',?,?)`,
          )
          .run(uuidV7(), prior.relationId, commitId, resolutionCommitRecordedAt! + 1);
      }
      const latest = store.db
        .prepare(
          `SELECT event_kind AS eventKind FROM investment_funding_relation_events
            WHERE relation_id=? ORDER BY recorded_at_utc_us DESC,rowid DESC LIMIT 1`,
        )
        .get(relationId) as { eventKind: string } | undefined;
      if (latest?.eventKind !== "observed") {
        const commitId = ensureResolutionCommit();
        store.db
          .prepare(
            `INSERT OR IGNORE INTO investment_funding_relation_events(
               event_id,relation_id,event_kind,reason,commit_id,recorded_at_utc_us
             ) VALUES(?,?,'observed','verified-settlement-account',?,?)`,
          )
          .run(
            uuidV7(),
            relationId,
            commitId,
            resolutionCommitRecordedAt! + 2,
          );
      }
      resolved += 1;
    }
    store.db.exec("COMMIT");
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
  return { resolved, noAdmission, reasons: [...reasons].sort() };
}

export function queryCanonicalInvestmentFundingRelationsInSnapshot(
  store: CanonicalSourceStore,
  sourceConnectionKey: string,
) {
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
  store: CanonicalSourceStore,
  sourceConnectionKey: string,
) {
  return withCanonicalSnapshot(store.db, () =>
    queryCanonicalInvestmentFundingRelationsInSnapshot(
      store,
      sourceConnectionKey,
    ),
  );
}
