import { createHash } from "node:crypto";
import type {
  LineBankAccount,
  LineBankTransactionPage,
  LineBankTransactionRow,
} from "../../workflows/linebank-statements.ts";
import { linebankEpochMillisecondsFromSourceDateTime } from "../../workflows/linebank-statements.ts";
import {
  admitCanonicalFinancialDepositCapture,
  type CanonicalFinancialDepositValidatedCapture,
} from "./canonical-financial-deposit-admission.ts";
import {
  DOMESTIC_DEPOSIT_FINANCIAL_ADMISSION_BLOCKERS,
  type DomesticDepositExactAmount,
  type DomesticDepositSourceTime,
} from "./domestic-deposit-contract.ts";
import { combineDomesticDepositDescription } from "./domestic-deposit-description.ts";

/**
 * Admission for LINE Bank TWD main-account history: validate one
 * human-attested v13 capture, then turn it into the shared canonical deposit
 * capture the PGlite commit command stages. The contract version stays
 * "preflight-v4" because it is part of every opaque occurrence key.
 */
const LINEBANK_INTEGRATION_NAMESPACE = "linebank";
const LINEBANK_DOMESTIC_DEPOSIT_STREAM = "domestic-deposit";
const LINEBANK_DOMESTIC_DEPOSIT_CONTRACT_VERSION = "preflight-v4";
const LINEBANK_DOMESTIC_DEPOSIT_TIME_ZONE = "Asia/Taipei";

/** Optional depository number evidence carried beside the opaque composite key. */
const LINEBANK_DOMESTIC_DEPOSIT_ACCOUNT_NUMBER_EVIDENCE_VERSION =
  "linebank/domestic-deposit/account-number-v1" as const;
export type LineBankDomesticDepositAccountNumberEvidence = Readonly<{
  value: string;
  kind: "depository-account";
  evidenceVersion: typeof LINEBANK_DOMESTIC_DEPOSIT_ACCOUNT_NUMBER_EVIDENCE_VERSION;
  sourceField: "transactions.content.acctNbr";
}>;

/**
 * Public evidence narrows currency only for the explicitly staged domestic
 * main-account route. No provider product code is claimed here: the
 * descriptor is the versioned adapter contract the workflow supplies after
 * establishing the source scope.
 */
const LINEBANK_DOMESTIC_DEPOSIT_SCOPE_EVIDENCE_VERSION =
  "domestic-main-twd-v1" as const;
export const LINEBANK_DOMESTIC_DEPOSIT_SUPPORTED_SCOPE = {
  evidenceVersion: LINEBANK_DOMESTIC_DEPOSIT_SCOPE_EVIDENCE_VERSION,
  route: "/transaction",
  productDescriptor: "domestic-main-account-demand-savings",
  accountRole: "main-account",
  currency: "TWD",
} as const;

const LINEBANK_DOMESTIC_DEPOSIT_OCCURRENCE_MATCHING_RULE_VERSION =
  "occurrence-v1" as const;

type LineBankOccurrenceCaptureContext = {
  namespace: typeof LINEBANK_INTEGRATION_NAMESPACE;
  sourceConnection: "accessibility.linebank.com.tw";
  stream: typeof LINEBANK_DOMESTIC_DEPOSIT_STREAM;
  /** Contract versions are part of the key so migrations cannot collide. */
  contractVersion: string;
  identityEpoch: number;
  account: LineBankAccount;
};

type LineBankSourceOccurrenceKey = {
  matchingRuleVersion: typeof LINEBANK_DOMESTIC_DEPOSIT_OCCURRENCE_MATCHING_RULE_VERSION;
  /** Opaque SHA-256 digest; raw account and row fields never leave the helper. */
  tupleDigest: string;
  /** Opaque digest without txDtm, used only to detect time collisions. */
  baseDigest: string;
  /** Opaque comparison fingerprint; never used as an identity key. */
  changeFingerprint: string;
};


type LineBankDomesticDepositScopeEvidence = {
  evidenceVersion: string;
  route: string;
  productDescriptor: string;
  accountRole: string;
  currency: string;
};

const LINEBANK_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V13_EVIDENCE_VERSION =
  "human-attested-v13" as const;

/**
 * Human-attested integration evidence is an explicit versioned fence. It is
 * not a claim that LINE Bank publicly guarantees these semantics; the
 * attestation is the authority for this first internal admission version.
 */
export const LINEBANK_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V13_EVIDENCE = {
  evidenceVersion:
    LINEBANK_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V13_EVIDENCE_VERSION,
  providerGuaranteed: false,
  postedHistory: true,
  timeBasis: "transaction-time",
  timeZone: LINEBANK_DOMESTIC_DEPOSIT_TIME_ZONE,
  occurrenceRule: "txSeqNbr+crrnDpstNthCnt+txDtm",
  directionCodes: { "1": "inflow", "2": "outflow" },
  cancellationRule: "exact-N-N-only",
  completenessRule: "requested-scope-all-pages-stable-totals",
  sharedMemberRule:
    "future-membership-effective-date-required-source-unavailable-v1",
} as const;

export type LineBankHumanAttestedV13Authority = {
  kind: "personal-main";
  membershipEffectiveDate: null;
};
type LineBankHumanAttestedV13FutureSharedAuthority = {
  kind: "shared-member";
  membershipEffectiveDate: string;
};

export type LineBankHumanAttestedV13Record = {
  sourceOccurrenceKey: string;
  baseOccurrenceKey: string;
  sourceChangeFingerprint: string;
  sourceSequence: string;
  occurrenceCounter: number;
  sourceTime: DomesticDepositSourceTime;
  direction: "inflow" | "outflow";
  sourceDirectionCode: "1" | "2";
  amount: DomesticDepositExactAmount;
  balanceAfter: DomesticDepositExactAmount | null;
  currency: "TWD";
  /** Source-provided transaction description and note, or null when absent. */
  description?: string | null;
  cancellationFlags: { cncdTxYn: "N"; cnclTxYn: "N" };
};

export type LineBankHumanAttestedV13Capture = {
  captureId: string;
  sourceConnection: "accessibility.linebank.com.tw";
  stream: typeof LINEBANK_DOMESTIC_DEPOSIT_STREAM;
  contractVersion: typeof LINEBANK_DOMESTIC_DEPOSIT_CONTRACT_VERSION;
  identityEpoch: number;
  accountKey: string;
  accountNumber?: LineBankDomesticDepositAccountNumberEvidence;
  scope: { startDate: string; endDate: string };
  pages: LineBankTransactionPage[];
  records: LineBankHumanAttestedV13Record[];
  authority: LineBankHumanAttestedV13Authority;
  humanAttestation: typeof LINEBANK_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V13_EVIDENCE;
  postingStatus: "posted";
  effectiveTimeBasis: "transaction-time";
  timeZone: typeof LINEBANK_DOMESTIC_DEPOSIT_TIME_ZONE;
  completeness: "complete-range";
  providerGuaranteed: false;
  sourceScopeEvidence: typeof LINEBANK_DOMESTIC_DEPOSIT_SUPPORTED_SCOPE;
  observedAt: string;
  totalCount: number;
  pageCount: number;
  readiness: "canonical-live";
  liveValidation: "complete";
  canonicalAdmission: "admitted";
  financialAdmissionBlockers: readonly [];
};

export type LineBankHumanAttestedV13ValidatedCapture =
  LineBankHumanAttestedV13Capture & {
    readonly __runtimeValidatedLineBankFinancialCapture: "human-attested-v13";
  };

/**
 * The staged pages live only long enough to project compact records; the
 * validated capture never carries the response envelope.
 */
export type LineBankHumanAttestedV13Input = {
  account: LineBankAccount;
  scope: { startDate: string; endDate: string };
  pages: LineBankTransactionPage[];
  /**
   * Explicit staged evidence from the source adapter. It is separate from
   * provider `pdCd`/`pdNm` values because no public source contract maps
   * those values to a product identity yet.
   */
  sourceScopeEvidence?: LineBankDomesticDepositScopeEvidence;
  captureId: string;
  sourceConnection: "accessibility.linebank.com.tw";
  identityEpoch: number;
  observedAt: string;
  humanAttestation?:
    typeof LINEBANK_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V13_EVIDENCE | undefined;
  authority?:
    | LineBankHumanAttestedV13Authority
    | LineBankHumanAttestedV13FutureSharedAuthority;
};

export type LineBankHumanAttestedV13Diagnostic =
  | "human-attestation-missing"
  | "human-attestation-mismatch"
  | "scope-invalid"
  | "pages-missing"
  | "page-sequence-invalid"
  | "page-count-drift"
  | "totals-drift"
  | "page-row-count-mismatch"
  | "terminal-page-missing"
  | "source-account-identity-incomplete"
  | "source-account-identity-mismatch"
  | "identity-epoch-mismatch"
  | "authority-role-unknown"
  | "authority-shared-account"
  | "authority-membership-date-missing"
  | "member-effective-date-before-transaction"
  | "occurrence-invalid"
  | "occurrence-collision"
  | "direction-unknown"
  | "amount-invalid"
  | "source-time-invalid"
  | "unsupported-cancellation"
  | "transaction-order-ambiguous"
  | "currency-scope-invalid";

export type LineBankHumanAttestedV13ValidationResult = {
  status: "admissible" | "rejected";
  capture: LineBankHumanAttestedV13ValidatedCapture | null;
  diagnostics: LineBankHumanAttestedV13Diagnostic[];
  readiness: "canonical-live" | "blocked";
  liveValidation: "complete" | "failed";
  financialAdmissionBlockers:
    readonly [] | typeof DOMESTIC_DEPOSIT_FINANCIAL_ADMISSION_BLOCKERS;
};

function v13Diagnostic(
  diagnostics: LineBankHumanAttestedV13Diagnostic[],
  code: LineBankHumanAttestedV13Diagnostic,
): void {
  if (!diagnostics.includes(code)) diagnostics.push(code);
}

export function linebankHumanAttestedV13AuthorityKind(
  source: LineBankTransactionPage["source"],
): "personal-main" | "shared-member" | null {
  if (!source || typeof source.jntAcctMbrTpCd !== "string") return null;
  if (source.jntAcctMbrTpCd === "personal-main-account") return "personal-main";
  if (source.jntAcctMbrTpCd === "shared-member") return "shared-member";
  if (
    source.jntAcctMbrTpCd === "" &&
    source.jntMbrListCnt === 0 &&
    source.totJntAcctMbrCnt === 0 &&
    source.isSecuAcctBndg === false
  ) {
    return "personal-main";
  }
  return null;
}

function exactPersonalMainAuthority(
  value: unknown,
): value is LineBankHumanAttestedV13Authority {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).sort().join("\u0000") ===
      "kind\u0000membershipEffectiveDate" &&
    record.kind === "personal-main" &&
    record.membershipEffectiveDate === null
  );
}

function futureSharedAuthority(
  value: unknown,
): value is LineBankHumanAttestedV13FutureSharedAuthority {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).sort().join("\u0000") ===
      "kind\u0000membershipEffectiveDate" &&
    record.kind === "shared-member" &&
    typeof record.membershipEffectiveDate === "string"
  );
}

function v13OpaqueDigest(value: unknown): string {
  return `sha256:${opaqueFingerprint(value)}`;
}

/**
 * Validate the human-attested v13 financial-admission seam.  The returned
 * capture contains only compact typed records and structural page metadata;
 * the response pages and account values never cross this boundary.
 */
export function validateLineBankHumanAttestedV13Capture(
  input: LineBankHumanAttestedV13Input,
): LineBankHumanAttestedV13ValidationResult {
  const diagnostics: LineBankHumanAttestedV13Diagnostic[] = [];
  const accountComposite = candidateAccountKey(input.account);
  const accountKey = canonicalOpaqueAccountKey(input.account);
  if (
    !input.humanAttestation ||
    input.humanAttestation !==
      LINEBANK_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V13_EVIDENCE
  ) {
    v13Diagnostic(
      diagnostics,
      input.humanAttestation
        ? "human-attestation-mismatch"
        : "human-attestation-missing",
    );
  }
  if (
    input.sourceConnection !== "accessibility.linebank.com.tw" ||
    !clean(input.captureId)
  ) {
    v13Diagnostic(diagnostics, "scope-invalid");
  }
  if (!Number.isSafeInteger(input.identityEpoch) || input.identityEpoch < 0) {
    v13Diagnostic(diagnostics, "identity-epoch-mismatch");
  }
  if (!accountComposite || !accountKey) {
    v13Diagnostic(diagnostics, "source-account-identity-incomplete");
  }
  if (
    !validDate(input.scope.startDate) ||
    !validDate(input.scope.endDate) ||
    clean(input.scope.startDate) > clean(input.scope.endDate)
  ) {
    v13Diagnostic(diagnostics, "scope-invalid");
  }
  if (
    !canonicalScopeMatches(input.sourceScopeEvidence) ||
    input.sourceScopeEvidence?.currency !== "TWD"
  ) {
    v13Diagnostic(diagnostics, "currency-scope-invalid");
  }
  if (
    !clean(input.observedAt) ||
    !Number.isFinite(Date.parse(input.observedAt))
  ) {
    v13Diagnostic(diagnostics, "scope-invalid");
  }
  const authorityValue: unknown = input.authority;
  const authority = exactPersonalMainAuthority(authorityValue)
    ? authorityValue
    : null;
  const sharedAuthority = futureSharedAuthority(authorityValue)
    ? authorityValue
    : null;
  if (sharedAuthority) {
    v13Diagnostic(diagnostics, "authority-shared-account");
    if (!validDate(sharedAuthority.membershipEffectiveDate))
      v13Diagnostic(diagnostics, "authority-membership-date-missing");
    else if (
      clean(input.scope.startDate) < sharedAuthority.membershipEffectiveDate
    )
      v13Diagnostic(diagnostics, "member-effective-date-before-transaction");
  } else if (!authority) {
    v13Diagnostic(diagnostics, "authority-role-unknown");
  }

  const pages = input.pages;
  if (!Array.isArray(pages) || pages.length === 0) {
    v13Diagnostic(diagnostics, "pages-missing");
  }
  const firstPage = pages[0];
  const expectedPageCapacity = firstPage?.pageCnt;
  const expectedTotal = firstPage?.totTxCnt;
  const accountNumber =
    firstPage?.source &&
    sourceAccountIdentityStatus(input.account, firstPage.source) === "match"
      ? deriveLineBankDomesticDepositAccountNumberEvidence(firstPage.source)
      : null;
  if (
    !firstPage ||
    !Number.isSafeInteger(expectedPageCapacity) ||
    expectedPageCapacity < 1 ||
    !Number.isSafeInteger(expectedTotal) ||
    expectedTotal < 0
  ) {
    v13Diagnostic(diagnostics, "page-count-drift");
  }
  const rows: Array<{
    row: LineBankTransactionRow;
    page: LineBankTransactionPage;
    rowIndex: number;
  }> = [];
  const seenTuple = new Set<string>();
  const seenBase = new Map<string, string>();
  let totalRows = 0;
  for (const [pageIndex, page] of pages.entries()) {
    if (
      page.responseCode !== "200" ||
      page.pageNbr !== pageIndex + 1 ||
      page.pageCnt !== expectedPageCapacity
    ) {
      v13Diagnostic(diagnostics, "page-sequence-invalid");
    }
    if (page.pageCnt !== expectedPageCapacity)
      v13Diagnostic(diagnostics, "page-count-drift");
    if (page.totTxCnt !== expectedTotal)
      v13Diagnostic(diagnostics, "totals-drift");
    if (
      !Number.isSafeInteger(page.txCnt) ||
      page.txCnt !== page.rows.length ||
      page.txCnt > page.pageCnt ||
      (pageIndex < pages.length - 1 && page.txCnt !== page.pageCnt)
    )
      v13Diagnostic(diagnostics, "page-row-count-mismatch");
    totalRows += page.rows.length;
    if (page.source === undefined) {
      v13Diagnostic(diagnostics, "source-account-identity-incomplete");
      v13Diagnostic(diagnostics, "authority-role-unknown");
    } else {
      const sourceStatus = sourceAccountIdentityStatus(
        input.account,
        page.source,
      );
      if (sourceStatus === "missing")
        v13Diagnostic(diagnostics, "source-account-identity-incomplete");
      if (sourceStatus === "mismatch")
        v13Diagnostic(diagnostics, "source-account-identity-mismatch");
      if (
        !Number.isSafeInteger(page.source.opnDtm) ||
        page.source.opnDtm !== input.identityEpoch
      ) {
        v13Diagnostic(diagnostics, "identity-epoch-mismatch");
      }
      const role = linebankHumanAttestedV13AuthorityKind(page.source);
      if (role === null) v13Diagnostic(diagnostics, "authority-role-unknown");
      if (role === "shared-member")
        v13Diagnostic(diagnostics, "authority-shared-account");
      if (page.source.isSecuAcctBndg !== false)
        v13Diagnostic(diagnostics, "authority-role-unknown");
      if (
        authority &&
        (role !== "personal-main" ||
          page.source.jntMbrListCnt !== 0 ||
          page.source.totJntAcctMbrCnt !== 0)
      ) {
        v13Diagnostic(diagnostics, "authority-shared-account");
      }
      if (sharedAuthority && role !== "shared-member")
        v13Diagnostic(diagnostics, "authority-shared-account");
    }
    for (const [rowIndex, row] of page.rows.entries()) {
      rows.push({ row, page, rowIndex });
      const direction = clean(row.dpstWdrwDsCd);
      if (direction !== "1" && direction !== "2")
        v13Diagnostic(diagnostics, "direction-unknown");
      const amount = exactDomesticAmount(row.txAmt);
      if (amount === null) v13Diagnostic(diagnostics, "amount-invalid");
      if (exactDomesticAmount(row.afTxBal) === null)
        v13Diagnostic(diagnostics, "amount-invalid");
      const epoch = occurrenceEpoch(row.txDtm);
      const sequence = occurrenceSequence(row.txSeqNbr);
      const counter = occurrenceCounter(row.crrnDpstNthCnt);
      if (!epoch || !sequence || !counter) {
        v13Diagnostic(diagnostics, "occurrence-invalid");
      } else {
        const key = linebankBuildSourceOccurrenceKey(
          {
            namespace: LINEBANK_INTEGRATION_NAMESPACE,
            sourceConnection: input.sourceConnection,
            stream: LINEBANK_DOMESTIC_DEPOSIT_STREAM,
            contractVersion: LINEBANK_DOMESTIC_DEPOSIT_CONTRACT_VERSION,
            identityEpoch: input.identityEpoch,
            account: input.account,
          },
          row,
        );
        if (!key) v13Diagnostic(diagnostics, "occurrence-invalid");
        else {
          if (seenTuple.has(key.tupleDigest))
            v13Diagnostic(diagnostics, "occurrence-collision");
          const priorTuple = seenBase.get(key.baseDigest);
          if (priorTuple !== undefined && priorTuple !== key.tupleDigest)
            v13Diagnostic(diagnostics, "occurrence-collision");
          seenTuple.add(key.tupleDigest);
          seenBase.set(key.baseDigest, key.tupleDigest);
        }
      }
      if (row.cncdTxYn !== "N" || row.cnclTxYn !== "N")
        v13Diagnostic(diagnostics, "unsupported-cancellation");
      if (
        !validDate(row.txDt) ||
        !validTime(row.txTm) ||
        !validTransactionEffectiveTime(row.txDtm)
      ) {
        v13Diagnostic(diagnostics, "source-time-invalid");
      } else {
        try {
          if (
            linebankEpochMillisecondsFromSourceDateTime(row.txDt, row.txTm) !==
            row.txDtm
          )
            v13Diagnostic(diagnostics, "source-time-invalid");
        } catch {
          v13Diagnostic(diagnostics, "source-time-invalid");
        }
      }
      if (
        validDate(row.txDt) &&
        (clean(row.txDt) < clean(input.scope.startDate) ||
          clean(row.txDt) > clean(input.scope.endDate))
      )
        v13Diagnostic(diagnostics, "scope-invalid");
      if (
        sharedAuthority &&
        validDate(row.txDt) &&
        clean(row.txDt) < sharedAuthority.membershipEffectiveDate
      ) {
        v13Diagnostic(diagnostics, "member-effective-date-before-transaction");
      }
    }
  }
  const requiredPageCount =
    expectedTotal === undefined || expectedPageCapacity === undefined
      ? 0
      : Math.max(1, Math.ceil(expectedTotal / expectedPageCapacity));
  if (
    requiredPageCount !== pages.length ||
    pages.at(-1)?.pageNbr !== pages.length
  )
    v13Diagnostic(diagnostics, "terminal-page-missing");
  if (expectedTotal !== totalRows) v13Diagnostic(diagnostics, "totals-drift");

  const prepared = rows
    .map(({ row, page, rowIndex }) => ({
      row,
      page,
      rowIndex,
      amount: exactDomesticAmount(row.txAmt),
      balance: exactDomesticAmount(row.afTxBal),
    }))
    .filter(
      (
        entry,
      ): entry is typeof entry & {
        amount: DomesticDepositExactAmount;
        balance: DomesticDepositExactAmount;
      } => entry.amount !== null && entry.balance !== null,
    )
    .sort((left, right) => (left.row.txDtm ?? 0) - (right.row.txDtm ?? 0));
  const transactionTimes = new Set<number>();
  for (const current of prepared) {
    if (
      current.row.txDtm !== undefined &&
      transactionTimes.has(current.row.txDtm)
    )
      v13Diagnostic(diagnostics, "transaction-order-ambiguous");
    if (current.row.txDtm !== undefined)
      transactionTimes.add(current.row.txDtm);
  }
  for (let index = 1; index < prepared.length; index += 1) {
    const previous = prepared[index - 1]!;
    const current = prepared[index]!;
    if (current.row.txDtm === previous.row.txDtm) continue;
    const scale = Math.max(
      previous.balance.scale,
      current.balance.scale,
      current.amount.scale,
    );
    const scaled = (value: DomesticDepositExactAmount) =>
      BigInt(value.coefficient) * 10n ** BigInt(scale - value.scale);
    const delta = scaled(current.balance) - scaled(previous.balance);
    const magnitude = scaled(current.amount);
    const expected = current.row.dpstWdrwDsCd === "2" ? -magnitude : magnitude;
    if (
      (current.row.dpstWdrwDsCd === "1" || current.row.dpstWdrwDsCd === "2") &&
      delta !== expected
    ) {
      v13Diagnostic(diagnostics, "amount-invalid");
    }
  }
  if (expectedTotal !== undefined && expectedTotal !== totalRows)
    v13Diagnostic(diagnostics, "totals-drift");
  if (diagnostics.length > 0)
    return {
      status: "rejected",
      capture: null,
      diagnostics,
      readiness: "blocked",
      liveValidation: "failed",
      financialAdmissionBlockers: DOMESTIC_DEPOSIT_FINANCIAL_ADMISSION_BLOCKERS,
    };

  const records: LineBankHumanAttestedV13Record[] = [];
  for (const { row } of rows) {
    const key = linebankBuildSourceOccurrenceKey(
      {
        namespace: LINEBANK_INTEGRATION_NAMESPACE,
        sourceConnection: input.sourceConnection,
        stream: LINEBANK_DOMESTIC_DEPOSIT_STREAM,
        contractVersion: LINEBANK_DOMESTIC_DEPOSIT_CONTRACT_VERSION,
        identityEpoch: input.identityEpoch,
        account: input.account,
      },
      row,
    )!;
    const amount = exactDomesticAmount(row.txAmt)!;
    const balanceAfter = exactDomesticAmount(row.afTxBal);
    records.push({
      sourceOccurrenceKey: v13OpaqueDigest(key.tupleDigest),
      baseOccurrenceKey: v13OpaqueDigest(key.baseDigest),
      sourceChangeFingerprint: v13OpaqueDigest(key.changeFingerprint),
      sourceSequence: occurrenceSequence(row.txSeqNbr)!,
      occurrenceCounter: Number(occurrenceCounter(row.crrnDpstNthCnt)!),
      sourceTime: {
        localDate: row.txDt!,
        localTime: row.txTm!,
        timeZone: LINEBANK_DOMESTIC_DEPOSIT_TIME_ZONE,
        epochMilliseconds: row.txDtm!,
        basis: "source_observed",
      },
      direction: row.dpstWdrwDsCd === "1" ? "inflow" : "outflow",
      sourceDirectionCode: row.dpstWdrwDsCd as "1" | "2",
      amount,
      balanceAfter,
      currency: "TWD",
      description: linebankTransactionDescription(row),
      cancellationFlags: { cncdTxYn: "N", cnclTxYn: "N" },
    });
  }
  const capture = freezeLineBankHumanAttestedV13Capture({
    captureId: input.captureId,
    sourceConnection: input.sourceConnection,
    stream: LINEBANK_DOMESTIC_DEPOSIT_STREAM,
    contractVersion: LINEBANK_DOMESTIC_DEPOSIT_CONTRACT_VERSION,
    identityEpoch: input.identityEpoch,
    accountKey,
    ...(accountNumber ? { accountNumber } : {}),
    scope: {
      startDate: clean(input.scope.startDate),
      endDate: clean(input.scope.endDate),
    },
    pages: pages.map((page) => ({
      pageNbr: page.pageNbr,
      pageCnt: page.pageCnt,
      totTxCnt: page.totTxCnt,
      txCnt: page.txCnt,
      rows: [],
    })),
    records,
    authority: { ...authority! } as LineBankHumanAttestedV13Authority,
    humanAttestation: LINEBANK_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V13_EVIDENCE,
    postingStatus: "posted",
    effectiveTimeBasis: "transaction-time",
    timeZone: LINEBANK_DOMESTIC_DEPOSIT_TIME_ZONE,
    completeness: "complete-range",
    providerGuaranteed: false,
    sourceScopeEvidence: LINEBANK_DOMESTIC_DEPOSIT_SUPPORTED_SCOPE,
    observedAt: input.observedAt,
    totalCount: expectedTotal!,
    pageCount: requiredPageCount,
    readiness: "canonical-live",
    liveValidation: "complete",
    canonicalAdmission: "admitted",
    financialAdmissionBlockers: [],
  });
  return {
    status: "admissible",
    capture,
    diagnostics,
    readiness: "canonical-live",
    liveValidation: "complete",
    financialAdmissionBlockers: [],
  };
}

/** Freeze the validated capture and its nested evidence before it leaves this module. */
function freezeLineBankHumanAttestedV13Capture(
  capture: LineBankHumanAttestedV13Capture,
): LineBankHumanAttestedV13ValidatedCapture {
  for (const page of capture.pages) Object.freeze(page);
  for (const record of capture.records) {
    Object.freeze(record.sourceTime);
    Object.freeze(record.amount);
    if (record.balanceAfter) Object.freeze(record.balanceAfter);
    Object.freeze(record.cancellationFlags);
    Object.freeze(record);
  }
  Object.freeze(capture.pages);
  Object.freeze(capture.records);
  Object.freeze(capture.scope);
  Object.freeze(capture.authority);
  Object.freeze(capture.humanAttestation.directionCodes);
  Object.freeze(capture.humanAttestation);
  Object.freeze(capture.sourceScopeEvidence);
  Object.freeze(capture.financialAdmissionBlockers);
  Object.freeze(capture);
  return capture as LineBankHumanAttestedV13ValidatedCapture;
}

const LINEBANK_V13_AUTHORITY = "linebank/domestic-deposit/human-attested-v13";
const LINEBANK_V13_RECORD_KIND = "linebank-domestic-deposit-financial-v13";

function linebankCanonicalToken(...parts: string[]): string {
  return `sha256:${createHash("sha256").update(parts.join("\u0000")).digest("hex")}`;
}

function linebankCanonicalDate(value: string): string {
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

function linebankCanonicalDateTime(value: DomesticDepositSourceTime): string {
  return `${linebankCanonicalDate(value.localDate)}T${value.localTime.slice(0, 2)}:${value.localTime.slice(2, 4)}:${value.localTime.slice(4, 6)}`;
}

function linebankCompactFinancialRecord(
  capture: LineBankHumanAttestedV13ValidatedCapture,
  record: LineBankHumanAttestedV13ValidatedCapture["records"][number],
): string {
  return JSON.stringify({
    sourceOccurrenceKey: record.sourceOccurrenceKey,
    baseOccurrenceKey: record.baseOccurrenceKey,
    sourceChangeFingerprint: record.sourceChangeFingerprint,
    accountKey: capture.accountKey,
    sourceConnection: capture.sourceConnection,
    stream: capture.stream,
    contractVersion: capture.contractVersion,
    identityEpoch: capture.identityEpoch,
    sourceSequence: record.sourceSequence,
    occurrenceCounter: record.occurrenceCounter,
    sourceSequenceKey: record.sourceOccurrenceKey,
    sourceTime: record.sourceTime,
    direction: record.direction,
    sourceDirectionCode: record.sourceDirectionCode,
    amount: record.amount,
    balanceAfter: record.balanceAfter,
    currency: record.currency,
    description: record.description ?? null,
    cancellation: "N",
    cancellationFlags: record.cancellationFlags,
    provenance: { matchingRuleVersion: "occurrence-v1" },
  });
}

/** Keep LINE Bank's provider vocabulary in the adapter before execution. */
export function normalizeLineBankFinancialCapture(
  capture: LineBankHumanAttestedV13ValidatedCapture,
): CanonicalFinancialDepositValidatedCapture {
  const contractFingerprint = linebankCanonicalToken(
    "linebank-v13-contract",
    capture.contractVersion,
    capture.humanAttestation.evidenceVersion,
  );
  const preflightFingerprint = linebankCanonicalToken(
    "linebank-v13-scope",
    capture.sourceScopeEvidence.evidenceVersion,
    capture.authority.kind,
    capture.authority.membershipEffectiveDate ?? "personal-main",
  );
  return admitCanonicalFinancialDepositCapture({
    captureId: capture.captureId,
    authorityRoute: LINEBANK_V13_AUTHORITY,
    contractVersion: "human-attested-v13",
    identity: {
      integrationNamespace: "linebank",
      sourceConnectionKey: linebankCanonicalToken(
        "linebank-connection",
        capture.sourceConnection,
      ),
      identityEpochKey: linebankCanonicalToken(
        "linebank-epoch",
        capture.sourceConnection,
        String(capture.identityEpoch),
      ),
      stream: capture.stream,
      recordKind: LINEBANK_V13_RECORD_KIND,
      subjectDigest: capture.accountKey,
      accountNo: capture.accountKey,
      sourceAccountKey: capture.accountKey,
      accountNumber: capture.accountNumber ?? null,
      accountType: "depository",
      currency: "TWD",
    },
    observedAt: capture.observedAt,
    scope: {
      startDate: linebankCanonicalDate(capture.scope.startDate),
      endDate: linebankCanonicalDate(capture.scope.endDate),
      scopeKind: "bounded-range",
      completeness: "complete-range",
      completenessBasis:
        "human-attested-requested-scope-all-pages-stable-totals",
      completenessRuleVersion: "linebank/domestic-deposit/human-attested-v13",
      absenceAuthority: "comparable-complete-range",
      contractFingerprint,
      preflightFingerprint,
      pageCount: capture.pageCount,
    },
    semantics: {
      postingStatus: capture.postingStatus,
      postingOrigin: "human_attested_history",
      postingBasis: "human-attested-formally-posted",
      postingRuleVersion: "linebank/domestic-deposit/human-attested-v13",
      economicStatus: "normal",
      administrativeState: "active",
      semanticRuleVersion: "linebank/domestic-deposit/human-attested-v13",
      effectiveTimeBasis: capture.effectiveTimeBasis,
      effectiveTimeRuleVersion: "linebank/domestic-deposit/human-attested-v13",
      timeZone: capture.timeZone,
      timePrecision: "second",
      timeOrigin: "source_reported",
      requireBalance: true,
    },
    pages: capture.pages.map((page) => ({
      pageOrdinal: page.pageNbr - 1,
      responseCode: "200",
      terminal: page.pageNbr === capture.pageCount,
      rowCount: page.txCnt,
      responseDigest: linebankCanonicalToken(
        "linebank-v13-page",
        capture.captureId,
        String(page.pageNbr),
        String(page.txCnt),
      ),
      proofKind: "human-attested-requested-scope-all-pages-stable-totals",
      contractFingerprint,
      preflightFingerprint,
      metadataJson: JSON.stringify({
        pageNbr: page.pageNbr,
        pageCapacity: page.pageCnt,
        totalCount: page.totTxCnt,
        rowCount: page.txCnt,
      }),
    })),
    records: capture.records.map((record) => ({
      occurrenceKey: record.sourceOccurrenceKey,
      collisionKey: record.baseOccurrenceKey,
      providerKey: record.sourceOccurrenceKey,
      contentHash: record.sourceChangeFingerprint,
      sequenceLexeme: record.sourceOccurrenceKey,
      compactJson: linebankCompactFinancialRecord(capture, record),
      amount: record.amount,
      balanceAfter: record.balanceAfter,
      currency: record.currency,
      description: record.description ?? null,
      direction: record.direction,
      sourceTime: {
        localDate: linebankCanonicalDate(record.sourceTime.localDate),
        localTime: `${record.sourceTime.localTime.slice(0, 2)}:${record.sourceTime.localTime.slice(2, 4)}:${record.sourceTime.localTime.slice(4, 6)}`,
        timeZone: record.sourceTime.timeZone,
        epochMilliseconds: record.sourceTime.epochMilliseconds,
      },
      effectiveOn: linebankCanonicalDate(record.sourceTime.localDate),
      transactionDateTimeLocal: linebankCanonicalDateTime(record.sourceTime),
    })),
  });
}

const DATE_RE = /^(\d{4})(\d{2})(\d{2})$/;
const TIME_RE = /^(\d{2})(\d{2})(\d{2})$/;
const DECIMAL_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function candidateAccountKey(account: LineBankAccount): string {
  const acctNbr = clean(account.acctNbr);
  const arrId = clean(account.arrId);
  return acctNbr && arrId ? `${acctNbr}:${arrId}` : "";
}

/**
 * LINE Bank's account list and transaction envelope both expose `acctNbr`.
 * The transaction envelope is checked against the requested account before
 * this evidence is attached, while `arrId` remains part of the stable opaque
 * account key and is never discarded.
 */
function deriveLineBankDomesticDepositAccountNumberEvidence(
  account: LineBankAccount,
): LineBankDomesticDepositAccountNumberEvidence | null {
  const value = clean(account.acctNbr);
  if (!/^\d{6,24}$/.test(value)) return null;
  return {
    value,
    kind: "depository-account",
    evidenceVersion: LINEBANK_DOMESTIC_DEPOSIT_ACCOUNT_NUMBER_EVIDENCE_VERSION,
    sourceField: "transactions.content.acctNbr",
  };
}

type SourceAccountIdentityStatus = "match" | "missing" | "mismatch";

function sourceAccountIdentityStatus(
  account: LineBankAccount,
  source: LineBankTransactionPage["source"],
): SourceAccountIdentityStatus {
  const expected = candidateAccountKey(account);
  const actual = source ? candidateAccountKey(source) : "";
  if (!expected || !actual) return "missing";
  return expected === actual ? "match" : "mismatch";
}

function opaqueFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function occurrenceSequence(value: unknown): string | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  }
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return null;
  const normalized = value.trim();
  return BigInt(normalized) > 0n ? BigInt(normalized).toString() : null;
}

function occurrenceCounter(value: unknown): string | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? String(value)
    : null;
}

function occurrenceEpoch(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function occurrenceContextParts(
  context: LineBankOccurrenceCaptureContext,
): [string, string, string, string, string, string, string] | null {
  const accountComposite = candidateAccountKey(context.account);
  const identityEpoch = occurrenceEpoch(context.identityEpoch);
  if (
    context.namespace !== LINEBANK_INTEGRATION_NAMESPACE ||
    context.sourceConnection !== "accessibility.linebank.com.tw" ||
    context.stream !== LINEBANK_DOMESTIC_DEPOSIT_STREAM ||
    !clean(context.contractVersion) ||
    !accountComposite ||
    identityEpoch === null
  ) {
    return null;
  }
  return [
    LINEBANK_INTEGRATION_NAMESPACE,
    "accessibility.linebank.com.tw",
    LINEBANK_DOMESTIC_DEPOSIT_STREAM,
    clean(context.contractVersion),
    String(identityEpoch),
    accountComposite,
    LINEBANK_DOMESTIC_DEPOSIT_OCCURRENCE_MATCHING_RULE_VERSION,
  ];
}

/**
 * Build an opaque occurrence key.  This helper never returns source values;
 * null means the capture must be rejected by the caller.
 */
function linebankBuildSourceOccurrenceKey(
  context: LineBankOccurrenceCaptureContext,
  row: LineBankTransactionRow,
): LineBankSourceOccurrenceKey | null {
  const contextParts = occurrenceContextParts(context);
  const txDtm = occurrenceEpoch(row.txDtm);
  const txSeqNbr = occurrenceSequence(row.txSeqNbr);
  const crrnDpstNthCnt = occurrenceCounter(row.crrnDpstNthCnt);
  if (
    contextParts === null ||
    txDtm === null ||
    txSeqNbr === null ||
    crrnDpstNthCnt === null
  ) {
    return null;
  }
  const baseParts = [...contextParts, txSeqNbr, crrnDpstNthCnt];
  const tupleParts = [...baseParts, String(txDtm)];
  return {
    matchingRuleVersion:
      LINEBANK_DOMESTIC_DEPOSIT_OCCURRENCE_MATCHING_RULE_VERSION,
    baseDigest: opaqueFingerprint(baseParts),
    tupleDigest: opaqueFingerprint(tupleParts),
    changeFingerprint: opaqueFingerprint([
      row.txDt ?? null,
      row.txTm ?? null,
      row.dpstWdrwDsCd ?? null,
      row.txAmt ?? null,
      row.afTxBal ?? null,
      row.cncdTxYn ?? null,
      row.cnclTxYn ?? null,
    ]),
  };
}

function validDate(value: unknown): boolean {
  const match = clean(value).match(DATE_RE);
  if (!match) return false;
  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  return (
    date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() === Number(match[2]) - 1 &&
    date.getUTCDate() === Number(match[3])
  );
}

function validTime(value: unknown): boolean {
  const match = clean(value).match(TIME_RE);
  return Boolean(
    match &&
    Number(match[1]) < 24 &&
    Number(match[2]) < 60 &&
    Number(match[3]) < 60,
  );
}

function validTransactionEffectiveTime(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function decimalLexeme(value: unknown): string | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) return null;
    value = String(value);
  }
  if (typeof value !== "string") return null;
  const lexeme = value.trim();
  return DECIMAL_RE.test(lexeme) ? lexeme : null;
}

function exactDomesticAmount(
  value: unknown,
): DomesticDepositExactAmount | null {
  const lexeme = decimalLexeme(value);
  if (lexeme === null || lexeme.startsWith("-")) return null;
  const [whole, fraction = ""] = lexeme.split(".");
  const coefficient = `${whole}${fraction}`.replace(/^0+(?=\d)/, "");
  return { coefficient, scale: fraction.length };
}

function canonicalOpaqueAccountKey(account: LineBankAccount): string {
  const composite = candidateAccountKey(account);
  return composite
    ? `sha256:${opaqueFingerprint([LINEBANK_INTEGRATION_NAMESPACE, "account", composite])}`
    : "";
}

function canonicalScopeMatches(
  scope: LineBankDomesticDepositScopeEvidence | undefined,
): boolean {
  return Boolean(
    scope &&
    scope.evidenceVersion ===
      LINEBANK_DOMESTIC_DEPOSIT_SUPPORTED_SCOPE.evidenceVersion &&
    scope.route === LINEBANK_DOMESTIC_DEPOSIT_SUPPORTED_SCOPE.route &&
    scope.productDescriptor ===
      LINEBANK_DOMESTIC_DEPOSIT_SUPPORTED_SCOPE.productDescriptor &&
    scope.accountRole ===
      LINEBANK_DOMESTIC_DEPOSIT_SUPPORTED_SCOPE.accountRole &&
    scope.currency === LINEBANK_DOMESTIC_DEPOSIT_SUPPORTED_SCOPE.currency,
  );
}

function linebankTransactionDescription(
  row: LineBankTransactionRow,
): string | null {
  const noteParts = [row.txRmkCont, row.txMemoVal]
    .map(clean)
    .filter(Boolean);
  const note = [...new Set(noteParts)].join(" ");
  return combineDomesticDepositDescription(row.bizTxFuncTpNm, note);
}
