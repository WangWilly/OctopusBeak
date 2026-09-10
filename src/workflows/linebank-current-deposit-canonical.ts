import { createHash, randomUUID } from "node:crypto";

import {
  currentDepositSourceRecord,
  currentDepositSourceRecordContentHash,
  type CurrentDepositBalanceCaptureInput,
  type CurrentDepositBalanceObservationInput,
  type CurrentDepositExactAmount,
  type CurrentDepositSourceRecordInput,
} from "../ledger/canonical/current-deposit-balance-writer.ts";
import {
  LINEBANK_CURRENT_DEPOSIT_BALANCE_CONTRACT_VERSION,
  LINEBANK_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH,
  LINEBANK_CURRENT_DEPOSIT_BALANCE_FEATURE_TYPE_CODE,
  LINEBANK_CURRENT_DEPOSIT_BALANCE_HOST,
  type LineBankCurrentDepositBalanceRow,
} from "./linebank-current-deposit-balances.ts";

export const LINEBANK_CURRENT_DOMESTIC_BALANCE_AUTHORITY_ROUTE =
  "linebank/domestic-deposit/current-balance-v1" as const;

type ExistingLineBankFinancialCapture = Readonly<{
  accountKey: string;
  sourceConnection: string;
  identityEpoch: number;
  observedAt: string;
}>;

function token(...parts: readonly string[]): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(parts.join("\u0000"), "utf8").digest("hex")}`;
}

function timeEvidence(row: LineBankCurrentDepositBalanceRow) {
  return {
    effectiveAt: row.effectiveAt,
    effectiveTimeBasis: "provider-http-date" as const,
    effectiveTimeRuleVersion: row.sourceEvidence.contractVersion,
    sourceField: "HTTP Date",
    sourceValue: row.providerHttpDate,
    contractVersion: row.sourceEvidence.contractVersion,
  };
}

/**
 * Join the payables balance to an already admitted transaction identity.
 * The current-balance source is never allowed to create a new account.
 */
export function buildLinebankCurrentDepositBalanceCapture(
  row: LineBankCurrentDepositBalanceRow,
  financialCapture: ExistingLineBankFinancialCapture,
): CurrentDepositBalanceCaptureInput {
  if (row.stream !== "domestic-deposit" || row.currency !== "TWD")
    throw new Error("LINE Bank current deposit row has the wrong stream.");
  if (row.sourceAccountKey !== financialCapture.accountKey)
    throw new Error("LINE Bank current deposit row does not match an existing account.");
  if (!Number.isSafeInteger(financialCapture.identityEpoch) || financialCapture.identityEpoch < 0)
    throw new Error("LINE Bank current deposit identity epoch is invalid.");

  const balance: CurrentDepositExactAmount = {
    coefficient: row.available.coefficient,
    scale: row.available.scale,
  };
  const sourceField = "wdrwAvblAmt";
  const identity = `${row.sourceAccountKey}|${row.currency}|available|${row.effectiveAt}`;
  const sourceRecordKey = token("linebank-current-deposit-source-record-v1", identity);
  const compact = {
    source: "linebank",
    accountNumber: row.accountNumber,
    arrangementId: row.arrangementId,
    sourceAccountKey: row.sourceAccountKey,
    currency: row.currency,
    sourceLexeme: row.available.sourceLexeme,
    effectiveAt: row.effectiveAt,
    effectiveTimeSourceField: "HTTP Date",
    effectiveTimeSourceValue: row.providerHttpDate,
    sourceEvidence: { ...row.sourceEvidence },
  };
  const provisional = currentDepositSourceRecord({
    sourceRecordKey,
    providerKey: token("linebank-current-deposit-provider-record-v1", identity),
    contentHash: "sha256:placeholder",
    sourceField,
    balanceKind: "available",
    currency: row.currency,
    value: balance,
    time: timeEvidence(row),
    compact,
  });
  const record: CurrentDepositSourceRecordInput = {
    ...provisional,
    contentHash: currentDepositSourceRecordContentHash(provisional.compact),
  };
  const observation: CurrentDepositBalanceObservationInput = {
    observationKey: token(
      "linebank-current-deposit-observation-v1",
      row.sourceAccountKey,
    ),
    balanceKind: "available",
    balance,
    currency: row.currency,
    time: timeEvidence(row),
    sourceRecordKey,
    sourceField,
  };
  const endpoint = `https://${LINEBANK_CURRENT_DEPOSIT_BALANCE_HOST}${LINEBANK_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH}?featureTypeCode=${LINEBANK_CURRENT_DEPOSIT_BALANCE_FEATURE_TYPE_CODE}`;
  const sourceConnectionKey = token(
    "linebank-connection",
    financialCapture.sourceConnection,
  );
  const identityEpochKey = token(
    "linebank-epoch",
    financialCapture.sourceConnection,
    String(financialCapture.identityEpoch),
  );
  return {
    captureId: `linebank-current-${randomUUID()}`,
    authorityRoute: LINEBANK_CURRENT_DOMESTIC_BALANCE_AUTHORITY_ROUTE,
    contractVersion: LINEBANK_CURRENT_DEPOSIT_BALANCE_CONTRACT_VERSION,
    subjectDigest: financialCapture.accountKey,
    identity: {
      integrationNamespace: "linebank",
      sourceConnectionKey,
      identityEpochKey,
      stream: "domestic-deposit",
      sourceAccountKey: financialCapture.accountKey,
    },
    observedAt: row.observedAt,
    scope: {
      startDate: row.effectiveAt.slice(0, 10),
      endDate: row.effectiveAt.slice(0, 10),
      contractFingerprint: token(
        "linebank-current-deposit-contract-v1",
        LINEBANK_CURRENT_DEPOSIT_BALANCE_CONTRACT_VERSION,
      ),
      preflightFingerprint: token(
        "linebank-current-deposit-preflight-v1",
        row.sourceEvidence.responseDigest,
      ),
    },
    providerResponse: {
      endpoint,
      status: 200,
      cacheControl: row.sourceEvidence.cacheControl,
    },
    pages: [
      {
        pageOrdinal: 0,
        responseCode: "200",
        rowCount: 1,
        terminal: true,
        responseDigest: row.sourceEvidence.responseDigest,
        proofKind: "linebank-current-deposit-payables-snapshot",
        contractFingerprint: token(
          "linebank-current-deposit-contract-v1",
          LINEBANK_CURRENT_DEPOSIT_BALANCE_CONTRACT_VERSION,
        ),
        preflightFingerprint: token(
          "linebank-current-deposit-preflight-v1",
          row.sourceEvidence.responseDigest,
        ),
        metadata: {
          source: "linebank-current-deposit-payables",
          endpoint: LINEBANK_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH,
          featureTypeCode: LINEBANK_CURRENT_DEPOSIT_BALANCE_FEATURE_TYPE_CODE,
          accountNumber: row.accountNumber,
          arrangementId: row.arrangementId,
          providerHttpDate: row.providerHttpDate,
          responseDigest: row.sourceEvidence.responseDigest,
        },
      },
    ],
    records: [record],
    observations: [observation],
  };
}

export function buildLinebankCurrentDepositBalanceCaptures(
  rows: readonly LineBankCurrentDepositBalanceRow[],
  financialCaptures: readonly ExistingLineBankFinancialCapture[],
): readonly CurrentDepositBalanceCaptureInput[] {
  const byAccount = new Map<string, ExistingLineBankFinancialCapture>();
  for (const capture of financialCaptures) {
    const previous = byAccount.get(capture.accountKey);
    if (
      previous &&
      (previous.sourceConnection !== capture.sourceConnection ||
        previous.identityEpoch !== capture.identityEpoch)
    )
      throw new Error("LINE Bank current deposit identities are ambiguous.");
    byAccount.set(capture.accountKey, capture);
  }
  return rows.map((row) => {
    const financialCapture = byAccount.get(row.sourceAccountKey);
    if (!financialCapture)
      throw new Error("LINE Bank current deposit has no admitted financial identity.");
    return buildLinebankCurrentDepositBalanceCapture(row, financialCapture);
  });
}
