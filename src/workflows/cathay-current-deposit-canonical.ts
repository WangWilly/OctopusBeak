import { createHash, randomUUID } from "node:crypto";

import {
  CATHAY_CURRENT_DEPOSIT_HOST,
  CATHAY_CURRENT_DEPOSIT_CONTRACT_VERSION,
  type CathayCurrentDepositBalanceRow,
  type CathayCurrentDepositObservation,
} from "./cathay-current-deposit-balances.ts";
import {
  admitCurrentDepositBalanceCapture,
  commitCurrentDepositBalanceCapture,
  currentDepositSourceRecord,
  currentDepositSourceRecordContentHash,
  type CurrentDepositBalanceCaptureInput,
  type CurrentDepositBalanceCommitResult,
  type CurrentDepositBalanceObservationInput,
  type CurrentDepositBalanceWriterStore,
  type CurrentDepositSourceRecordInput,
  type CurrentDepositTimeEvidence,
} from "../ledger/canonical/current-deposit-balance-writer.ts";
import {
  canonicalSqlitePath,
  createCanonicalSourceStore,
} from "../ledger/canonical/canonical-source-store.ts";

export const CATHAY_CURRENT_DOMESTIC_BALANCE_AUTHORITY_ROUTE =
  "cathay/domestic-deposit/current-balance-v1" as const;
export const CATHAY_CURRENT_FOREIGN_BALANCE_AUTHORITY_ROUTE =
  "cathay/foreign-currency/current-balance-v1" as const;

export type CathayCurrentDepositCanonicalContext = Readonly<{
  sourceConnectionKey: string;
  identityEpochKey: string;
  subjectDigest: string;
  observedAt: string;
  scopeDate: string;
}>;

type Group = {
  readonly row: CathayCurrentDepositBalanceRow;
  readonly rows: readonly CathayCurrentDepositBalanceRow[];
};

function token(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("base64url")}`;
}

function routeFor(row: CathayCurrentDepositBalanceRow): string {
  return row.kind === "domestic"
    ? CATHAY_CURRENT_DOMESTIC_BALANCE_AUTHORITY_ROUTE
    : CATHAY_CURRENT_FOREIGN_BALANCE_AUTHORITY_ROUTE;
}

function sourceField(
  row: CathayCurrentDepositBalanceRow,
  kind: CathayCurrentDepositObservation["kind"],
): string {
  if (row.kind === "foreign") return "balance";
  return kind === "ledger" ? "accountBalance" : "avaliableBalance";
}

function sourceAccountEvidence(row: CathayCurrentDepositBalanceRow): Record<string, unknown> {
  if (row.kind === "domestic") {
    return {
      uiAccountNumber: row.uiAccountNumber,
      providerAccountNumber: row.providerAccountNumber,
    };
  }
  return {
    providerAccountNumber: row.accountNumber,
    currencySourceCode: row.currencySourceCode,
  };
}

function timeEvidence(
  row: CathayCurrentDepositBalanceRow,
): CurrentDepositTimeEvidence {
  return {
    effectiveAt: row.effectiveAt,
    effectiveTimeBasis: "provider-system-time",
    effectiveTimeRuleVersion: CATHAY_CURRENT_DEPOSIT_CONTRACT_VERSION,
    sourceField: "systemTime",
    sourceValue: row.providerSystemTime,
    contractVersion: CATHAY_CURRENT_DEPOSIT_CONTRACT_VERSION,
  };
}

function observationInput(
  row: CathayCurrentDepositBalanceRow,
  observation: CathayCurrentDepositObservation,
): CurrentDepositBalanceObservationInput {
  const route = routeFor(row);
  const identity = `${route}|${row.sourceAccountKey}|${observation.currency}|${observation.kind}`;
  return {
    observationKey: token(`cathay/current-deposit-observation/v1|${identity}`),
    balanceKind: observation.kind,
    balance: {
      coefficient: observation.amount.coefficient,
      scale: observation.amount.scale,
    },
    currency: observation.currency,
    time: timeEvidence(row),
    sourceRecordKey: token(
      `cathay/current-deposit-source-record/v1|${identity}|${row.sourceEvidence.responseDigest}`,
    ),
    sourceField: sourceField(row, observation.kind),
  };
}

function sourceRecord(
  row: CathayCurrentDepositBalanceRow,
  observation: CathayCurrentDepositObservation,
  sourceObservation: CurrentDepositBalanceObservationInput,
): CurrentDepositSourceRecordInput {
  const time = timeEvidence(row);
  const compactEvidence = {
    source: "cathay",
    endpoint: row.sourceEvidence.endpoint,
    responseDigest: row.sourceEvidence.responseDigest,
    httpDate: row.httpDate,
    providerSystemTime: row.providerSystemTime,
    sourceLexeme: observation.amount.sourceLexeme,
    ...sourceAccountEvidence(row),
  };
  const provisional = currentDepositSourceRecord({
    sourceRecordKey: sourceObservation.sourceRecordKey,
    providerKey: token(
      `cathay/current-deposit-provider-record/v1|${sourceObservation.sourceRecordKey}`,
    ),
    contentHash: "pending",
    sourceField: sourceObservation.sourceField,
    balanceKind: sourceObservation.balanceKind,
    currency: sourceObservation.currency,
    value: sourceObservation.balance,
    time,
    compact: compactEvidence,
  });
  return {
    ...provisional,
    contentHash: currentDepositSourceRecordContentHash(provisional.compact),
  };
}

function groupRows(
  rows: readonly CathayCurrentDepositBalanceRow[],
): readonly Group[] {
  if (rows.length === 0) {
    throw new Error("Cathay current deposit balance capture has no rows.");
  }
  const groups = new Map<string, CathayCurrentDepositBalanceRow[]>();
  for (const row of rows) {
    const key = `${row.kind}\u0000${row.stream}\u0000${row.sourceAccountKey}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({ row: group[0]!, rows: group }));
}

function validateGroupMetadata(group: Group): void {
  const first = group.row;
  for (const row of group.rows) {
    if (
      row.sourceEvidence.endpoint !== first.sourceEvidence.endpoint ||
      row.sourceEvidence.responseDigest !== first.sourceEvidence.responseDigest ||
      row.providerSystemTime !== first.providerSystemTime ||
      row.effectiveAt !== first.effectiveAt ||
      row.httpDate !== first.httpDate ||
      row.observedAt !== first.observedAt
    ) {
      throw new Error("Cathay current deposit account rows have inconsistent source metadata.");
    }
  }
}

export function buildCathayCurrentDepositBalanceCaptures(
  rows: readonly CathayCurrentDepositBalanceRow[],
  context: CathayCurrentDepositCanonicalContext,
): readonly CurrentDepositBalanceCaptureInput[] {
  const captures: CurrentDepositBalanceCaptureInput[] = [];
  for (const group of groupRows(rows)) {
    validateGroupMetadata(group);
    const row = group.row;
    if (context.observedAt !== row.observedAt) {
      throw new Error(
        "Cathay current deposit capture observedAt must be sampled after the provider response.",
      );
    }
    const observations = group.rows.flatMap((currentRow) =>
      currentRow.observations.map((entry) => observationInput(currentRow, entry)),
    );
    const records = group.rows.flatMap((currentRow) =>
      currentRow.observations.map((entry) => {
        const observation = observationInput(currentRow, entry);
        return sourceRecord(currentRow, entry, observation);
      }),
    );
    const route = routeFor(row);
    const endpoint = `https://${CATHAY_CURRENT_DEPOSIT_HOST}${row.sourceEvidence.endpoint}`;
    captures.push({
      captureId: randomUUID(),
      authorityRoute: route,
      contractVersion: CATHAY_CURRENT_DEPOSIT_CONTRACT_VERSION,
      subjectDigest: context.subjectDigest,
      identity: {
        integrationNamespace: "cathay",
        sourceConnectionKey: context.sourceConnectionKey,
        identityEpochKey: context.identityEpochKey,
        stream: row.stream,
        sourceAccountKey: row.sourceAccountKey,
      },
      observedAt: context.observedAt,
      scope: {
        startDate: context.scopeDate,
        endDate: context.scopeDate,
        contractFingerprint: route,
        preflightFingerprint: `${route}/source-page-v1`,
      },
      providerResponse: {
        endpoint,
        status: 200,
      },
      pages: [
        {
          pageOrdinal: 0,
          responseCode: "200",
          rowCount: records.length,
          terminal: true,
          responseDigest: row.sourceEvidence.responseDigest,
          proofKind: "cathay-current-deposit-provider-snapshot",
          contractFingerprint: route,
          preflightFingerprint: `${route}/source-page-v1`,
          metadata: {
            source: "cathay",
            endpoint: row.sourceEvidence.endpoint,
            uiPath: row.sourceEvidence.uiPath,
            httpDate: row.httpDate,
            providerSystemTime: row.providerSystemTime,
            responseDigest: row.sourceEvidence.responseDigest,
            scopeDate: context.scopeDate,
          },
        },
      ],
      records,
      observations,
    });
  }
  return captures;
}

export async function commitCathayCurrentDepositBalanceCaptures(
  ledgerDir: string,
  captures: readonly CurrentDepositBalanceCaptureInput[],
  storeFactory: (
    path: string,
  ) => CurrentDepositBalanceWriterStore = (path) =>
    createCanonicalSourceStore(path),
): Promise<readonly CurrentDepositBalanceCommitResult[]> {
  if (captures.length === 0) return [];
  if (!ledgerDir.trim()) {
    throw new Error("Cathay current deposit canonical ledger directory is required.");
  }
  const store = storeFactory(canonicalSqlitePath(ledgerDir));
  try {
    const results: CurrentDepositBalanceCommitResult[] = [];
    for (const capture of captures) {
      const admitted = admitCurrentDepositBalanceCapture(capture);
      results.push(await commitCurrentDepositBalanceCapture(store, admitted));
    }
    return results;
  } finally {
    store.close();
  }
}

export function cathayCurrentSubjectDigest(
  sourceConnectionKey: string,
  identityEpochKey: string,
): string {
  return token(
    `cathay/current-deposit-subject/v1|${sourceConnectionKey}|${identityEpochKey}`,
  );
}
