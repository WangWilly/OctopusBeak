import { createHash } from "node:crypto";
import {
  createAdvertisedDomesticDepositPreflight,
  type AdvertisedDomesticDepositContract,
  type AdvertisedDomesticDepositPreflightInput,
} from "./advertised-domestic-deposit-preflight.ts";
import {
  admitCanonicalSourceEvidence,
  type CanonicalSourceEvidence,
} from "./canonical-source-evidence.ts";
import {
  commitCanonicalSourceEvidence,
  commitCanonicalSourceEvidenceBatch,
  type CanonicalSourceCommitResult,
  type CanonicalSourceStore,
} from "./canonical-source-store.ts";
import {
  admitCanonicalFinancialDepositCapture,
  commitCanonicalFinancialDepositCaptureBatch,
  type CanonicalFinancialDepositCommitResult,
  type CanonicalFinancialDepositRecord,
  type CanonicalFinancialDepositValidatedCapture,
  type CanonicalFinancialDepositWriterStore,
} from "./canonical-financial-deposit-writer.ts";
import {
  POST_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_ROUTE,
  POST_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_VERSION,
  POST_HUMAN_ATTESTED_V1_MANIFEST,
  ensurePostHumanAttestationEvents,
  getPostHumanAttestedV1Manifest,
  isPostHumanAttestationDurablyActive,
  isPostHumanAttestedV1Active,
  isPostHumanAttestedV1Manifest,
  latestPostHumanAttestationEvent,
  postHumanAttestedIdentityEpochKey,
  recordInitialPostHumanAttestationIfMissing,
  type PostHumanAttestedV1Manifest,
} from "./post-human-attestation.ts";

export const POST_DOMESTIC_DEPOSIT_CONTRACT = {
  source: "post",
  authority: "post/domestic-deposit/preflight-v1",
  contractVersion: "preflight-v1",
  readiness: "preflight-only",
  workflow: "postStatements",
  expectedRowWidth: 8,
  accountingDateIndex: 0,
  transactionDateIndex: 1,
  transactionTimeIndex: 2,
  provenance: {
    evidenceBasis: "provider ITEM fields normalized through DR_FLG",
    fixtureValues: "synthetic",
    liveResponseRetained: false,
  },
  outflowIndex: 4,
  inflowIndex: 5,
  completenessEvidence: "none",
  explicitNoDataEvidence: { kind: "none" },
} as const satisfies AdvertisedDomesticDepositContract;

export const POST_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1 = {
  accountIdentity: "SYNTHETIC-POST-ACCOUNT",
  scope: { startDate: "2026/01/01", endDate: "2026/06/30" },
  records: [
    {
      values: [
        "2026/01/02",
        "2026/01/02",
        "09:10:11",
        "SYNTHETIC",
        "",
        "100",
        "100",
        "",
      ],
    },
  ],
} satisfies AdvertisedDomesticDepositPreflightInput;

export const preflightPostDomesticDeposit =
  createAdvertisedDomesticDepositPreflight(POST_DOMESTIC_DEPOSIT_CONTRACT);

export const POST_DOMESTIC_DEPOSIT_EVIDENCE_VERSION =
  "capture-evidence-v1" as const;
export const POST_DOMESTIC_DEPOSIT_SOURCE_ROUTE =
  "post/domestic-deposit/capture-evidence-v1" as const;
export const POST_DOMESTIC_DEPOSIT_SOURCE_RULE_VERSION =
  "post/domestic-deposit/capture-evidence-v1" as const;
export const POST_DOMESTIC_DEPOSIT_SOURCE_RECORD_KIND =
  "post-domestic-deposit-row-v1" as const;
export const POST_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_READINESS =
  "canonical-human-attested" as const;
export const POST_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY =
  POST_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_ROUTE;
export const POST_DOMESTIC_DEPOSIT_FINANCIAL_EVIDENCE_VERSION =
  POST_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_VERSION;
export const POST_DOMESTIC_DEPOSIT_FINANCIAL_CURRENCY = "TWD" as const;
export const POST_DOMESTIC_DEPOSIT_FINANCIAL_COMPLETENESS_BASIS =
  "accepted-range-terminal-http-200-nonempty-item" as const;

export type PostDomesticDepositCaptureRow = {
  rowOrdinal: number;
  values: string[];
  directionFlag: "inflow" | "outflow" | "unknown";
};

export type PostDomesticDepositCaptureEvidence = {
  evidenceVersion: typeof POST_DOMESTIC_DEPOSIT_EVIDENCE_VERSION;
  source: "post";
  product: "domestic-deposit";
  providerGuaranteed: false;
  observedAt: string;
  account: { value: string };
  queryRange: { startDate: string; endDate: string };
  response: {
    httpStatus: number;
    itemShape: "array" | "single" | "absent";
    rows: PostDomesticDepositCaptureRow[];
    terminal: true;
  };
  provenance: {
    source: "ipost-esoaf-eb100200-inquire";
    responseBodyRetained: false;
    semantics: "unresolved";
  };
};

export type PostDomesticDepositValidatedEvidence =
  PostDomesticDepositCaptureEvidence & {
    readonly __postDomesticDepositValidated: unique symbol;
  };

export type PostDomesticDepositAdmission =
  | {
      status: "admissible";
      capture: PostDomesticDepositValidatedEvidence;
      diagnostics: readonly string[];
    }
  | {
      status: "rejected";
      capture: null;
      diagnostics: readonly string[];
    };

const VALIDATED_POST_EVIDENCE =
  new WeakSet<PostDomesticDepositCaptureEvidence>();
const SHA256_TOKEN = /^sha256:[A-Za-z0-9_-]{43}$/;
const SLASH_DATE = /^\d{4}\/\d{2}\/\d{2}$/;
const LOCAL_SECOND = /^\d{2}:\d{2}:\d{2}$/;

function normalizedCell(value: string): string {
  return value
    .replace(/[\u00a0\u3000]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function postDigest(domain: string, ...values: string[]): `sha256:${string}` {
  const digest = createHash("sha256");
  digest.update(domain);
  for (const value of values) {
    digest.update("\0");
    digest.update(value);
  }
  return `sha256:${digest.digest("base64url")}`;
}

function validCalendarDate(value: string): boolean {
  if (!SLASH_DATE.test(value)) return false;
  const [year, month, day] = value.split("/").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month! - 1 &&
    date.getUTCDate() === day
  );
}

function validLocalSecond(value: string): boolean {
  if (!LOCAL_SECOND.test(value)) return false;
  const [hour, minute, second] = value.split(":").map(Number);
  return hour! < 24 && minute! < 60 && second! < 60;
}

function validObservedAt(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function validAmount(value: string): boolean {
  const clean = normalizedCell(value).replace(/,/g, "");
  return clean === "" || /^\d+(?:\.\d+)?$/.test(clean);
}

function isNonZeroAmount(value: string): boolean {
  const clean = normalizedCell(value).replace(/,/g, "");
  return clean !== "" && Number(clean) !== 0;
}

export function admitPostDomesticDepositCaptureEvidence(
  capture: unknown,
): PostDomesticDepositAdmission {
  const diagnostics: string[] = [];
  const candidate =
    capture !== null && typeof capture === "object"
      ? (capture as Partial<PostDomesticDepositCaptureEvidence>)
      : null;
  if (
    candidate?.evidenceVersion !== POST_DOMESTIC_DEPOSIT_EVIDENCE_VERSION ||
    candidate.source !== "post" ||
    candidate.product !== "domestic-deposit" ||
    candidate.providerGuaranteed !== false
  )
    diagnostics.push("contract-invalid");
  if (
    typeof candidate?.observedAt !== "string" ||
    !validObservedAt(candidate.observedAt)
  )
    diagnostics.push("observed-at-invalid");
  if (
    typeof candidate?.account?.value !== "string" ||
    !normalizedCell(candidate.account.value)
  )
    diagnostics.push("account-invalid");
  if (
    typeof candidate?.queryRange?.startDate !== "string" ||
    typeof candidate.queryRange.endDate !== "string" ||
    !validCalendarDate(candidate.queryRange.startDate) ||
    !validCalendarDate(candidate.queryRange.endDate) ||
    candidate.queryRange.startDate > candidate.queryRange.endDate
  )
    diagnostics.push("query-range-invalid");
  if (candidate?.response?.httpStatus !== 200)
    diagnostics.push("response-status-invalid");
  if (
    candidate?.response?.itemShape !== "array" &&
    candidate?.response?.itemShape !== "single" &&
    candidate?.response?.itemShape !== "absent"
  )
    diagnostics.push("response-shape-invalid");
  if (candidate?.response?.terminal !== true)
    diagnostics.push("terminal-invalid");
  const rows = candidate?.response?.rows;
  if (!Array.isArray(rows)) {
    diagnostics.push("rows-invalid");
  } else {
    if (candidate?.response?.itemShape === "absent" && rows.length !== 0)
      diagnostics.push("response-row-conflict");
    if (candidate?.response?.itemShape !== "absent" && rows.length === 0)
      diagnostics.push("response-row-conflict");
    if (candidate?.response?.itemShape === "absent")
      diagnostics.push("empty-scope-unproven");
    for (const [index, row] of rows.entries()) {
      if (row === null || typeof row !== "object") {
        diagnostics.push("row-invalid");
        continue;
      }
      if (row.rowOrdinal !== index) diagnostics.push("row-order-invalid");
      if (!Array.isArray(row.values) || row.values.length !== 8) {
        diagnostics.push("row-width-invalid");
        continue;
      }
      if (row.values.some((value) => typeof value !== "string")) {
        diagnostics.push("row-cell-invalid");
        continue;
      }
      const cells = row.values.map(normalizedCell);
      if (!validCalendarDate(cells[0]!) || !validCalendarDate(cells[1]!))
        diagnostics.push("row-date-invalid");
      if (!validLocalSecond(cells[2]!)) diagnostics.push("row-time-invalid");
      if (!validAmount(cells[4]!) || !validAmount(cells[5]!))
        diagnostics.push("row-amount-invalid");
      const hasOutflow = isNonZeroAmount(cells[4]!);
      const hasInflow = isNonZeroAmount(cells[5]!);
      if (hasOutflow && hasInflow) diagnostics.push("row-amount-conflict");
      if (
        (row.directionFlag === "outflow" && (!hasOutflow || hasInflow)) ||
        (row.directionFlag === "inflow" && (!hasInflow || hasOutflow)) ||
        (row.directionFlag === "unknown" && (hasOutflow || hasInflow))
      )
        diagnostics.push("row-direction-conflict");
      if (!normalizedCell(cells[6]!) || !validAmount(cells[6]!))
        diagnostics.push("row-balance-invalid");
    }
  }
  if (
    candidate?.provenance?.source !== "ipost-esoaf-eb100200-inquire" ||
    candidate?.provenance?.responseBodyRetained !== false ||
    candidate?.provenance?.semantics !== "unresolved"
  )
    diagnostics.push("provenance-invalid");

  if (diagnostics.length > 0)
    return { status: "rejected", capture: null, diagnostics };
  VALIDATED_POST_EVIDENCE.add(capture as PostDomesticDepositCaptureEvidence);
  return {
    status: "admissible" as const,
    capture: capture as PostDomesticDepositValidatedEvidence,
    diagnostics,
  };
}

export function isAdmittedPostDomesticDepositCaptureEvidence(
  value: unknown,
): value is PostDomesticDepositValidatedEvidence {
  return (
    value !== null &&
    typeof value === "object" &&
    VALIDATED_POST_EVIDENCE.has(value as PostDomesticDepositCaptureEvidence)
  );
}

function dateShape(value: string): "slash-date" | "other" {
  return validCalendarDate(normalizedCell(value)) ? "slash-date" : "other";
}

function timeShape(value: string): "local-second" | "other" {
  return validLocalSecond(normalizedCell(value)) ? "local-second" : "other";
}

export function createPostDomesticDepositSourceEvidence(
  capture: PostDomesticDepositValidatedEvidence,
  captureId: string,
): CanonicalSourceEvidence {
  if (!isAdmittedPostDomesticDepositCaptureEvidence(capture))
    throw new Error("Post source evidence requires structural admission.");
  if (!captureId.trim())
    throw new Error("Post source evidence capture ID is required.");
  const account = normalizedCell(capture.account.value);
  const subjectDigest = postDigest("post-source-subject-v1", account);
  const rows = capture.response.rows;
  return {
    captureId: captureId.trim(),
    integrationNamespace: "post",
    sourceConnectionKey: postDigest(
      "post-source-connection-v1",
      "personal-session-visible-account-scope",
    ),
    identityEpoch: postDigest(
      "post-source-identity-epoch-v1",
      POST_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
    ),
    stream: "domestic-deposit",
    recordKind: POST_DOMESTIC_DEPOSIT_SOURCE_RECORD_KIND,
    routeKey: POST_DOMESTIC_DEPOSIT_SOURCE_ROUTE,
    contractVersion: POST_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
    subjectDigest,
    observedAt: capture.observedAt,
    scope: {
      startDate: capture.queryRange.startDate.replaceAll("/", ""),
      endDate: capture.queryRange.endDate.replaceAll("/", ""),
      kind: "bounded-range",
      completeness: "single-page",
      ruleVersion: POST_DOMESTIC_DEPOSIT_SOURCE_RULE_VERSION,
    },
    pages: [
      {
        pageOrdinal: 0,
        responseCode: "200",
        rowCount: rows.length,
        terminal: true,
        metadata: {
          accountSubjectDigest: subjectDigest,
          itemShape: capture.response.itemShape,
          columnCount: 8,
          completeness: "unproven",
          absenceAuthority: null,
        },
      },
    ],
    records: rows.map((row) => {
      const cells = row.values.map(normalizedCell);
      const rowDigest = postDigest(
        "post-source-row-v1",
        String(row.rowOrdinal),
        ...cells,
      );
      return {
        occurrenceKey: postDigest(
          "post-source-occurrence-v1",
          subjectDigest,
          String(row.rowOrdinal),
          rowDigest,
        ),
        collisionKey: postDigest(
          "post-source-collision-v1",
          subjectDigest,
          rowDigest,
        ),
        providerKey: rowDigest,
        contentHash: postDigest("post-source-content-v1", rowDigest),
        compact: {
          evidenceVersion: capture.evidenceVersion,
          rowOrdinal: row.rowOrdinal,
          rowDigest,
          columnCount: cells.length,
          accountingDateShape: dateShape(cells[0]!),
          transactionDateShape: dateShape(cells[1]!),
          transactionTimeShape: timeShape(cells[2]!),
          amountDirection: row.directionFlag,
          balanceShape: validAmount(cells[6]!) ? "decimal" : "other",
          providerGuaranteed: false,
          canonicalAdmission: "blocked",
          sourceStage: "source-only",
          semanticStatus: "observed-structural-only",
        },
      };
    }),
  };
}

export async function commitPostDomesticDepositSourceEvidence(
  store: CanonicalSourceStore,
  capture: PostDomesticDepositValidatedEvidence,
  captureId: string,
): Promise<CanonicalSourceCommitResult> {
  return commitCanonicalSourceEvidence(
    store,
    admitCanonicalSourceEvidence(
      createPostDomesticDepositSourceEvidence(capture, captureId),
    ),
  );
}

export async function commitPostDomesticDepositSourceEvidenceBatch(
  store: CanonicalSourceStore,
  captures: readonly {
    capture: PostDomesticDepositValidatedEvidence;
    captureId: string;
  }[],
): Promise<CanonicalSourceCommitResult[]> {
  if (captures.length === 0)
    throw new Error("Post source evidence batch cannot be empty.");
  return commitCanonicalSourceEvidenceBatch(
    store,
    captures.map(({ capture, captureId }) =>
      admitCanonicalSourceEvidence(
        createPostDomesticDepositSourceEvidence(capture, captureId),
      ),
    ),
  );
}

export type PostDomesticDepositFinancialAdmissionInput = {
  capture: PostDomesticDepositValidatedEvidence;
  captureId: string;
  humanAttestation?: PostHumanAttestedV1Manifest;
};

export type PostDomesticDepositFinancialAdmissionResult = {
  status: "admitted" | "blocked";
  capture: CanonicalFinancialDepositValidatedCapture | null;
  diagnostics: string[];
};

export class PostDomesticDepositFinancialAdmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostDomesticDepositFinancialAdmissionError";
  }
}

function postFinancialAmount(
  value: string,
  allowZero = false,
): { coefficient: string; scale: number } | null {
  const normalized = normalizedCell(value).replace(/,/g, "");
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null;
  const [whole = "", fraction = ""] = normalized.split(".");
  const coefficient = `${whole}${fraction}`.replace(/^0+(?=\d)/, "") || "0";
  if (!allowZero && BigInt(coefficient) === 0n) return null;
  return { coefficient, scale: fraction.length };
}

function postIsoDate(value: string): string | null {
  const normalized = normalizedCell(value);
  return validCalendarDate(normalized) ? normalized.replaceAll("/", "-") : null;
}

function postFinancialRecord(
  subjectDigest: string,
  row: PostDomesticDepositCaptureRow,
): { record: CanonicalFinancialDepositRecord | null; diagnostics: string[] } {
  const diagnostics: string[] = [];
  const cells = row.values.map(normalizedCell);
  const accountingDate = postIsoDate(cells[0] ?? "");
  const transactionDate = postIsoDate(cells[1] ?? "");
  const transactionTime = cells[2] ?? "";
  if (!accountingDate) diagnostics.push("accounting-date-invalid");
  if (!transactionDate) diagnostics.push("transaction-date-invalid");
  if (!validLocalSecond(transactionTime))
    diagnostics.push("transaction-time-invalid");
  if (!accountingDate || !transactionDate || !validLocalSecond(transactionTime))
    return { record: null, diagnostics };
  const outflow = postFinancialAmount(cells[4] ?? "");
  const inflow = postFinancialAmount(cells[5] ?? "");
  if (row.directionFlag === "unknown")
    diagnostics.push("row-direction-unknown");
  if (
    (row.directionFlag === "outflow" && (!outflow || inflow)) ||
    (row.directionFlag === "inflow" && (!inflow || outflow)) ||
    (row.directionFlag === "unknown" && (outflow || inflow))
  )
    diagnostics.push("row-direction-conflict");
  const amount = row.directionFlag === "outflow" ? outflow : inflow;
  const direction =
    row.directionFlag === "outflow"
      ? "outflow"
      : row.directionFlag === "inflow"
        ? "inflow"
        : null;
  const balanceAfter = postFinancialAmount(cells[6] ?? "", true);
  if (!amount) diagnostics.push("amount-invalid");
  if (!balanceAfter) diagnostics.push("balance-invalid");
  if (!amount || !direction || !balanceAfter)
    return { record: null, diagnostics };
  const epochMilliseconds = Date.parse(
    `${transactionDate}T${transactionTime}+08:00`,
  );
  if (!Number.isSafeInteger(epochMilliseconds)) {
    diagnostics.push("effective-time-invalid");
    return { record: null, diagnostics };
  }
  const description = cells[3] ?? "";
  const note = cells[7] ?? "";
  const coreKey = postDigest(
    "post-observed-composite-fence-v1",
    subjectDigest,
    accountingDate,
    transactionDate,
    transactionTime,
    direction,
    amount.coefficient,
    String(amount.scale),
    balanceAfter.coefficient,
    String(balanceAfter.scale),
  );
  const occurrenceKey = postDigest(
    "post-observed-composite-occurrence-v1",
    coreKey,
    description,
    note,
  );
  return {
    record: {
      occurrenceKey,
      collisionKey: coreKey,
      providerKey: coreKey,
      contentHash: postDigest("post-observed-content-v1", ...cells),
      sequenceLexeme: String(row.rowOrdinal),
      compactJson: JSON.stringify({
        evidenceVersion: POST_DOMESTIC_DEPOSIT_FINANCIAL_EVIDENCE_VERSION,
        subjectDigest,
        rowOrdinal: row.rowOrdinal,
        accountingDate,
        transactionDate,
        transactionTime,
        direction,
        amount,
        balanceAfter,
        descriptionDigest: postDigest("post-description-v1", description),
        noteDigest: postDigest("post-note-v1", note),
        providerGuaranteed: false,
      }),
      amount,
      balanceAfter,
      currency: POST_DOMESTIC_DEPOSIT_FINANCIAL_CURRENCY,
      direction,
      sourceTime: {
        localDate: transactionDate,
        localTime: transactionTime,
        timeZone: "Asia/Taipei",
        epochMilliseconds,
      },
      effectiveOn: accountingDate,
      transactionDateTimeLocal: `${transactionDate}T${transactionTime}`,
    },
    diagnostics,
  };
}

export function admitPostDomesticDepositFinancialCapture(
  input: PostDomesticDepositFinancialAdmissionInput,
): PostDomesticDepositFinancialAdmissionResult {
  const diagnostics: string[] = [];
  if (!input || typeof input !== "object")
    return {
      status: "blocked",
      capture: null,
      diagnostics: ["capture-missing"],
    };
  if (!isAdmittedPostDomesticDepositCaptureEvidence(input.capture))
    diagnostics.push("runtime-evidence-brand-missing");
  if (!input.captureId?.trim()) diagnostics.push("scope-invalid");
  const manifest = input.humanAttestation;
  if (!manifest) diagnostics.push("human-attestation-missing");
  else if (!isPostHumanAttestedV1Manifest(manifest))
    diagnostics.push("human-attestation-mismatch");
  if (!isPostHumanAttestedV1Active())
    diagnostics.push("human-attestation-revoked");
  if (!isAdmittedPostDomesticDepositCaptureEvidence(input.capture))
    return { status: "blocked", capture: null, diagnostics };
  if (
    input.capture.response.httpStatus !== 200 ||
    input.capture.response.terminal !== true ||
    input.capture.response.itemShape === "absent" ||
    input.capture.response.rows.length === 0
  )
    diagnostics.push("terminal-completeness-unproven");
  const subjectDigest = postDigest(
    "post-source-subject-v1",
    normalizedCell(input.capture.account.value),
  );
  const sourceConnectionKey = postDigest(
    "post-source-connection-v1",
    "personal-session-visible-account-scope",
  );
  const seen = new Map<string, string>();
  const records: CanonicalFinancialDepositRecord[] = [];
  const rangeStart = input.capture.queryRange.startDate.replaceAll("/", "-");
  const rangeEnd = input.capture.queryRange.endDate.replaceAll("/", "-");
  for (const row of input.capture.response.rows) {
    const transactionDate = postIsoDate(row.values[1] ?? "");
    if (
      transactionDate &&
      (transactionDate < rangeStart || transactionDate > rangeEnd)
    )
      diagnostics.push("row-outside-query-range");
    const result = postFinancialRecord(subjectDigest, row);
    diagnostics.push(...result.diagnostics);
    if (!result.record) continue;
    const previous = seen.get(result.record.collisionKey);
    if (previous !== undefined) {
      diagnostics.push("occurrence-ambiguous");
      if (previous !== result.record.occurrenceKey)
        diagnostics.push("composite-occurrence-collision");
      continue;
    }
    seen.set(result.record.collisionKey, result.record.occurrenceKey);
    records.push(result.record);
  }
  const uniqueDiagnostics = [...new Set(diagnostics)];
  if (uniqueDiagnostics.length > 0)
    return { status: "blocked", capture: null, diagnostics: uniqueDiagnostics };
  const contractFingerprint = postDigest(
    "post-contract-v1",
    POST_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
    POST_HUMAN_ATTESTED_V1_MANIFEST.provenance.attestationContractFingerprint,
  );
  const preflightFingerprint = postDigest(
    "post-preflight-v1",
    subjectDigest,
    rangeStart,
    rangeEnd,
  );
  const capture = admitCanonicalFinancialDepositCapture({
    captureId: input.captureId.trim(),
    authorityRoute: POST_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
    contractVersion: POST_DOMESTIC_DEPOSIT_FINANCIAL_EVIDENCE_VERSION,
    identity: {
      integrationNamespace: "post",
      sourceConnectionKey,
      identityEpochKey: postHumanAttestedIdentityEpochKey(
        manifest ?? getPostHumanAttestedV1Manifest(),
      ),
      stream: "domestic-deposit",
      recordKind: "post-domestic-deposit",
      subjectDigest,
      accountNo: input.capture.account.value,
      accountType: "depository",
      currency: POST_DOMESTIC_DEPOSIT_FINANCIAL_CURRENCY,
    },
    observedAt: input.capture.observedAt,
    scope: {
      startDate: rangeStart,
      endDate: rangeEnd,
      scopeKind: "bounded-range",
      completeness: "complete-range",
      completenessBasis: POST_DOMESTIC_DEPOSIT_FINANCIAL_COMPLETENESS_BASIS,
      completenessRuleVersion: POST_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
      absenceAuthority: null,
      contractFingerprint,
      preflightFingerprint,
      pageCount: 1,
      withdrawalPolicy: "never-infer",
    },
    semantics: {
      postingStatus: "posted",
      postingOrigin: "human-attested",
      postingBasis: "statement-posted-history",
      postingRuleVersion: POST_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
      economicStatus: "normal",
      administrativeState: "active",
      semanticRuleVersion: POST_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
      effectiveTimeBasis: "accounting",
      effectiveTimeRuleVersion: POST_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
      timeZone: "Asia/Taipei",
      timePrecision: "second",
      timeOrigin: "source_reported",
      requireBalance: true,
      providerGuaranteed: false,
      occurrenceProviderGuaranteed: false,
    },
    pages: [
      {
        pageOrdinal: 0,
        responseCode: "200",
        terminal: true,
        rowCount: records.length,
        responseDigest: postDigest(
          "post-response-v1",
          ...input.capture.response.rows.flatMap((row) =>
            row.values.map(normalizedCell),
          ),
        ),
        proofKind: POST_DOMESTIC_DEPOSIT_FINANCIAL_COMPLETENESS_BASIS,
        contractFingerprint,
        preflightFingerprint,
        metadataJson: JSON.stringify({
          itemShape: input.capture.response.itemShape,
          rowCount: records.length,
          providerGuaranteed: false,
          absenceAuthority: null,
        }),
      },
    ],
    records,
  });
  return { status: "admitted", capture, diagnostics: [] };
}

export async function commitCanonicalPostDomesticDepositCaptureBatch(
  store: CanonicalFinancialDepositWriterStore,
  inputs: readonly PostDomesticDepositFinancialAdmissionInput[],
): Promise<CanonicalFinancialDepositCommitResult[]> {
  ensurePostHumanAttestationEvents(store.db);
  let latest: ReturnType<typeof latestPostHumanAttestationEvent>;
  try {
    latest = latestPostHumanAttestationEvent(store.db);
  } catch {
    throw new PostDomesticDepositFinancialAdmissionError(
      "Post human attestation chain is invalid.",
    );
  }
  if (latest?.eventKind === "revoked" || !isPostHumanAttestedV1Active())
    throw new PostDomesticDepositFinancialAdmissionError(
      "Post human attestation is revoked; future admission is blocked.",
    );
  const admissions = inputs.map(admitPostDomesticDepositFinancialCapture);
  const blocked = admissions.flatMap((admission) => admission.diagnostics);
  if (blocked.length > 0 || admissions.some((admission) => !admission.capture))
    throw new PostDomesticDepositFinancialAdmissionError(
      `Post domestic deposit canonical admission blocked: ${[
        ...new Set(blocked),
      ].join(", ")}`,
    );
  recordInitialPostHumanAttestationIfMissing(
    store.db,
    inputs[0]?.capture.observedAt,
  );
  return commitCanonicalFinancialDepositCaptureBatch(
    store,
    admissions.map((admission) => admission.capture!),
  );
}

export function isPostSourceOnlyFinancialDiagnostic(
  diagnostic: string,
): boolean {
  return new Set([
    "human-attestation-missing",
    "human-attestation-mismatch",
    "human-attestation-revoked",
    "row-direction-unknown",
  ]).has(diagnostic);
}

export function isPostHumanAttestationReady(
  store: CanonicalFinancialDepositWriterStore,
): boolean {
  return isPostHumanAttestationDurablyActive(store.db);
}

export function isPostSha256Token(value: string): boolean {
  return SHA256_TOKEN.test(value);
}
