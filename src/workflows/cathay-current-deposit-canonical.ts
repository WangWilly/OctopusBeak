import { createHash, randomUUID } from "node:crypto";

import {
  CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS,
  type CurrentDepositAuthorityRoute,
} from "../ledger/canonical/current-deposit-route-contracts.ts";
import {
  CATHAY_CURRENT_DOMESTIC_RESPONSE,
  CATHAY_CURRENT_FOREIGN_RESPONSE,
  parseCathayCurrentDepositBalanceSnapshot,
  type CathayCurrentDepositBalanceRow,
  type CathayCurrentDepositKind,
  type CathayCurrentDepositObservation,
  type CathayCurrentDepositResponse,
} from "./cathay-current-deposit-balances.ts";
import {
  assembleCurrentDepositCapture,
  captureCurrentStateSnapshots,
  type CurrentDepositBalanceEntry,
  type CurrentBalanceCaptureMatching,
  CURRENT_DEPOSIT_BALANCE_STAGING,
  type SnapshotProduct,
} from "./current-state-snapshot-capture.ts";
import type { DecodedProviderEvidence, VerifiedProviderResponse } from "./provider-response.ts";
import {
  admitForeignCurrencyDepositCapture,
  type ForeignCurrencyDepositCaptureInput,
} from "../ledger/canonical/foreign-currency-deposit-admission.ts";
import type { ProductStageRequest } from "../lib/automation/product-collection.ts";
import type {
  CurrentDepositBalanceCaptureInput,
  CurrentDepositTimeEvidence,
} from "../ledger/pglite/current-deposit-admission.ts";
import type { PGliteCanonicalFinancialCommitRequest } from "../ledger/pglite/canonical-source-store.ts";

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

function routeFor(row: CathayCurrentDepositBalanceRow): CurrentDepositAuthorityRoute {
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
  const { contractVersion } = CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS[routeFor(row)];
  return {
    effectiveAt: row.effectiveAt,
    effectiveTimeBasis: "provider-system-time",
    effectiveTimeRuleVersion: contractVersion,
    sourceField: "systemTime",
    sourceValue: row.providerSystemTime,
    contractVersion,
  };
}

function balanceEntry(
  row: CathayCurrentDepositBalanceRow,
  observation: CathayCurrentDepositObservation,
): CurrentDepositBalanceEntry {
  const route = routeFor(row);
  const identity = `${route}|${row.sourceAccountKey}|${observation.currency}|${observation.kind}`;
  const sourceRecordKey = token(
    `cathay/current-deposit-source-record/v1|${identity}|${row.sourceEvidence.responseDigest}`,
  );
  return {
    sourceRecordKey,
    providerKey: token(`cathay/current-deposit-provider-record/v1|${sourceRecordKey}`),
    observationKey: token(`cathay/current-deposit-observation/v1|${identity}`),
    balanceKind: observation.kind,
    sourceField: sourceField(row, observation.kind),
    currency: observation.currency,
    value: {
      coefficient: observation.amount.coefficient,
      scale: observation.amount.scale,
    },
    time: timeEvidence(row),
    timeInRecord: true,
    compact: {
      source: "cathay",
      endpoint: row.sourceEvidence.endpoint,
      responseDigest: row.sourceEvidence.responseDigest,
      httpDate: row.httpDate,
      providerSystemTime: row.providerSystemTime,
      sourceLexeme: observation.amount.sourceLexeme,
      ...sourceAccountEvidence(row),
    },
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
    const entries = group.rows.flatMap((currentRow) =>
      currentRow.observations.map((observation) => balanceEntry(currentRow, observation)),
    );
    const route = routeFor(row);
    const contract = CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS[route];
    const endpoint = `https://${contract.endpointHost}${row.sourceEvidence.endpoint}`;
    captures.push(assembleCurrentDepositCapture({
      captureId: randomUUID(),
      authorityRoute: route,
      contractVersion: contract.contractVersion,
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
      page: {
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
    }, entries));
  }
  return captures;
}

type CathayCurrentDepositSnapshotInput<Admitted> = Readonly<{
  /** The statement captures this product admitted; their accounts each need a balance. */
  admitted: readonly Admitted[];
  acquire: () => Promise<CathayCurrentDepositResponse>;
  product: SnapshotProduct;
}>;

/**
 * The module's parsed value has lost the provider's numeric lexemes, which
 * carry each balance's scale, so the row parser reads its decoded text.
 */
function parseOverview(
  kind: CathayCurrentDepositKind,
  decoded: DecodedProviderEvidence<CathayCurrentDepositResponse["evidence"]>,
  response: VerifiedProviderResponse<"required">,
  acquired: CathayCurrentDepositResponse,
): readonly CathayCurrentDepositBalanceRow[] {
  return parseCathayCurrentDepositBalanceSnapshot({
    kind,
    response,
    rawBody: decoded.text,
    ...(acquired.uiAccountNumbers ? { uiAccountNumbers: acquired.uiAccountNumbers } : {}),
  });
}

function requireEveryAdmittedAccount(
  admittedKeys: readonly string[],
  matched: readonly Readonly<{ row: Readonly<{ sourceAccountKey: string }> }>[],
  message: string,
): void {
  const matchedKeys = new Set(matched.map(({ row }) => row.sourceAccountKey));
  if (admittedKeys.some((key) => !matchedKeys.has(key))) throw new Error(message);
}

type CathayDomesticAdmittedRequest = Readonly<{
  capture: Pick<
    PGliteCanonicalFinancialCommitRequest["capture"],
    "sourceConnectionKey" | "identityEpoch" | "stream"
  >;
  account: Pick<PGliteCanonicalFinancialCommitRequest["account"], "sourceAccountKey">;
}>;

/**
 * Domestic balances take connection, epoch, stream, and account key from the
 * run's admitted statement captures, which must share one source identity.
 * A row for an account the run did not admit is skipped.
 */
export const cathayDomesticCurrentBalanceCaptureMatching: CurrentBalanceCaptureMatching<
  CathayCurrentDepositBalanceRow,
  CathayDomesticAdmittedRequest
> = {
  captureKey: (request) => request.account.sourceAccountKey,
  rowKey: (row) => row.sourceAccountKey,
  duplicates: "first-wins",
  // oneScope already holds every capture to one connection, epoch, and stream.
  sameIdentity: () => true,
  ambiguousMessage: "Cathay domestic admitted captures are ambiguous.",
  oneScope: {
    scope: ({ capture }) => `${capture.sourceConnectionKey}\u0000${capture.identityEpoch}\u0000${capture.stream}`,
    message: "Cathay domestic admitted captures do not share one source identity.",
  },
  unmatched: { kind: "skip" },
};

function buildDomesticCapture(
  row: CathayCurrentDepositBalanceRow,
  request: CathayDomesticAdmittedRequest,
): CurrentDepositBalanceCaptureInput {
  if (row.stream !== request.capture.stream) {
    throw new Error("Cathay domestic current balance row stream does not match its admitted capture.");
  }
  const { sourceConnectionKey, identityEpoch } = request.capture;
  return onlyCapture(buildCathayCurrentDepositBalanceCaptures([row], {
    sourceConnectionKey,
    identityEpochKey: identityEpoch,
    subjectDigest: cathayCurrentSubjectDigest(sourceConnectionKey, identityEpoch),
    observedAt: row.observedAt,
    scopeDate: row.observedAt.slice(0, 10),
  }));
}

/** Stage the domestic overview's balance for every admitted account. */
export async function captureCathayDomesticCurrentBalances(
  input: CathayCurrentDepositSnapshotInput<CathayDomesticAdmittedRequest>,
): Promise<readonly ProductStageRequest[]> {
  const { items } = await captureCurrentStateSnapshots(
    {
      product: "domestic-current-balance",
      response: CATHAY_CURRENT_DOMESTIC_RESPONSE,
      parse: (decoded, response, acquired) => parseOverview("domestic", decoded, response, acquired),
      kind: CURRENT_DEPOSIT_BALANCE_STAGING,
      matching: cathayDomesticCurrentBalanceCaptureMatching,
      build: buildDomesticCapture,
      validate: ({ matched }) => requireEveryAdmittedAccount(
        input.admitted.map((request) => request.account.sourceAccountKey),
        matched,
        "Cathay domestic current balance source omitted a selected account.",
      ),
    },
    { ...input, captures: input.admitted },
  );
  return items;
}

/** One foreign account's overview rows, one per currency it holds. */
type CathayForeignOverviewAccount = Readonly<{
  sourceAccountKey: string;
  rows: readonly CathayCurrentDepositBalanceRow[];
}>;

function groupForeignAccounts(
  rows: readonly CathayCurrentDepositBalanceRow[],
): readonly CathayForeignOverviewAccount[] {
  const accounts = new Map<string, CathayCurrentDepositBalanceRow[]>();
  for (const row of rows) {
    const account = accounts.get(row.sourceAccountKey) ?? [];
    account.push(row);
    accounts.set(row.sourceAccountKey, account);
  }
  return [...accounts].map(([sourceAccountKey, accountRows]) => ({ sourceAccountKey, rows: accountRows }));
}

type CathayForeignAdmittedIdentity = Readonly<{
  accountNo: string;
  sourceConnectionKey: string;
  identityEpochKey: string;
  subjectDigest: string;
}>;

/**
 * Cathay foreign currency keys a balance by the admitted account number. The
 * last capture for an account wins and is never checked for ambiguity, and a
 * row for an account the run did not admit is skipped silently.
 */
export const cathayForeignCurrentBalanceCaptureMatching: CurrentBalanceCaptureMatching<
  Readonly<{ sourceAccountKey: string }>,
  CathayForeignAdmittedIdentity
> = {
  captureKey: (identity) => identity.accountNo,
  rowKey: (row) => row.sourceAccountKey,
  duplicates: "last-wins",
  sameIdentity: () => true,
  ambiguousMessage: "Cathay current foreign deposit identities are ambiguous.",
  unmatched: { kind: "skip" },
};

/** Stage one balance capture per admitted foreign account, holding every currency the overview lists for it. */
export async function captureCathayForeignCurrentBalances(
  input: CathayCurrentDepositSnapshotInput<ForeignCurrencyDepositCaptureInput>,
): Promise<readonly ProductStageRequest[]> {
  const identities = input.admitted.map((capture): CathayForeignAdmittedIdentity => {
    const { identity } = admitForeignCurrencyDepositCapture(capture);
    return {
      accountNo: capture.accountNo,
      sourceConnectionKey: identity.sourceConnectionKey,
      identityEpochKey: identity.identityEpochKey,
      subjectDigest: identity.subjectDigest,
    };
  });
  const { items } = await captureCurrentStateSnapshots(
    {
      product: "foreign-current-balance",
      response: CATHAY_CURRENT_FOREIGN_RESPONSE,
      parse: (decoded, response, acquired) =>
        groupForeignAccounts(parseOverview("foreign", decoded, response, acquired)),
      kind: CURRENT_DEPOSIT_BALANCE_STAGING,
      matching: cathayForeignCurrentBalanceCaptureMatching,
      build: (account, identity) => onlyCapture(buildCathayCurrentDepositBalanceCaptures(account.rows, {
        sourceConnectionKey: identity.sourceConnectionKey,
        identityEpochKey: identity.identityEpochKey,
        subjectDigest: identity.subjectDigest,
        observedAt: account.rows[0]!.observedAt,
        scopeDate: account.rows[0]!.observedAt.slice(0, 10),
      })),
      validate: ({ matched }) => {
        if (matched.length === 0) {
          throw new Error("Cathay current foreign balance response did not contain an admitted account.");
        }
        requireEveryAdmittedAccount(
          identities.map(({ accountNo }) => accountNo),
          matched,
          "Cathay current foreign balance response omitted an admitted account.",
        );
      },
    },
    { ...input, captures: identities },
  );
  return items;
}

function onlyCapture(
  captures: readonly CurrentDepositBalanceCaptureInput[],
): CurrentDepositBalanceCaptureInput {
  if (captures.length !== 1) throw new Error("Cathay current deposit account built more than one capture.");
  return captures[0]!;
}

export function cathayCurrentSubjectDigest(
  sourceConnectionKey: string,
  identityEpochKey: string,
): string {
  return token(
    `cathay/current-deposit-subject/v1|${sourceConnectionKey}|${identityEpochKey}`,
  );
}
