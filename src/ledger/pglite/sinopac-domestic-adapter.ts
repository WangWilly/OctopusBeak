import { createHash } from "node:crypto";
import type {
  CanonicalFinancialDepositCapture,
  CanonicalFinancialDepositRecord,
  CanonicalFinancialDepositValidatedCapture,
} from "../canonical/canonical-financial-deposit-writer.ts";
import type {
  SinopacSourceRow,
  SinopacStatementValidatedCapture,
} from "../canonical/sinopac-domestic-deposit.ts";
import type { SinopacHumanAttestedV1Manifest } from "../canonical/sinopac-human-attestation.ts";

const SINOPAC_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY =
  "sinopac/domestic-deposit/human-attested-v1";
const SINOPAC_DOMESTIC_DEPOSIT_FINANCIAL_EVIDENCE_VERSION =
  "human-attested-v1";

export type SinopacPGliteFinancialCaptureInput = Readonly<{
  capture: SinopacStatementValidatedCapture;
  captureId: string;
  humanAttestation: SinopacHumanAttestedV1Manifest;
}>;

export type SinopacPGliteFinancialCaptureResult = Readonly<{
  status: "admitted" | "blocked";
  capture: CanonicalFinancialDepositValidatedCapture | null;
  diagnostics: string[];
}>;

type SinopacIdentity = {
  sourceConnectionKey: `sha256:${string}`;
  identityEpochKey: `sha256:${string}`;
  subjectDigest: `sha256:${string}`;
};

function sinopacDigest(
  domain: string,
  ...values: readonly string[]
): `sha256:${string}` {
  const hash = createHash("sha256").update(domain);
  for (const value of values) hash.update("\0").update(value);
  return `sha256:${hash.digest("base64url")}`;
}

function stableSourceJson(value: Record<string, unknown>): string {
  const canonicalize = (entry: unknown): unknown =>
    Array.isArray(entry)
      ? entry.map(canonicalize)
      : entry !== null && typeof entry === "object"
        ? Object.fromEntries(
            Object.entries(entry as Record<string, unknown>)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([key, nested]) => [key, canonicalize(nested)]),
          )
        : entry;
  return JSON.stringify(canonicalize(value));
}

function normalizedCell(value: unknown): string {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalSinopacDate(value: string): string | null {
  const compact = normalizedCell(value).replaceAll("/", "");
  if (!/^\d{8}$/.test(compact)) return null;
  const formatted = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
  const parsed = new Date(`${formatted}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== formatted
    ? null
    : formatted;
}

function canonicalSinopacTime(value: string): string | null {
  const match = normalizedCell(value).match(/^([0-2]\d):([0-5]\d)(?::([0-5]\d))?$/);
  if (!match || Number(match[1]) > 23) return null;
  return match[3] === undefined
    ? `${match[1]}:${match[2]}`
    : `${match[1]}:${match[2]}:${match[3]}`;
}

function financialAmount(
  value: string,
  allowZero = false,
): { coefficient: string; scale: number } | null {
  const normalized = normalizedCell(value).replaceAll(",", "");
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null;
  const [whole = "", fractional = ""] = normalized.split(".");
  const coefficient = `${whole}${fractional}`.replace(/^0+(?=\d)/, "") || "0";
  if (!allowZero && BigInt(coefficient) === 0n) return null;
  return { coefficient, scale: fractional.length };
}

function unsupportedSinopacMarker(values: readonly string[]): boolean {
  return /撤銷|撤销|沖正|冲正|更正|取消|退回|回沖|回冲|reversal|reversed|correction|cancel/i.test(
    values.map(normalizedCell).join(" "),
  );
}

function unsupportedSinopacAuthority(label: string): boolean {
  return /共同|共有|聯名|联名|代理|代管|joint|shared|co[- ]?owner|authorized/i.test(
    label,
  );
}

function deriveSinopacIdentity(
  capture: SinopacStatementValidatedCapture,
): SinopacIdentity {
  const product = capture.product;
  const subjectDigest = sinopacDigest(
    `sinopac-${product}-subject-v1`,
    normalizedCell(capture.account.value),
    normalizedCell(capture.account.currency),
  );
  return {
    sourceConnectionKey: sinopacDigest(
      `sinopac-${product}-connection-v1`,
      product,
    ),
    identityEpochKey: sinopacDigest(
      `sinopac-${product}-identity-epoch-v1`,
      product,
    ),
    subjectDigest,
  };
}

function combineDescription(description: unknown, note: unknown): string | null {
  const parts = [description, note]
    .map((value) => String(value ?? "").trim())
    .filter((value) => value.length > 0);
  const uniqueParts = [...new Set(parts)];
  return uniqueParts.length > 0 ? uniqueParts.join(" · ") : null;
}

function sinopacFinancialRecord(
  capture: SinopacStatementValidatedCapture,
  row: SinopacSourceRow,
  pageOrdinal: number,
): { record: CanonicalFinancialDepositRecord | null; diagnostics: string[] } {
  const values = row.values;
  const diagnostics: string[] = [];
  const accountingDate = canonicalSinopacDate(values[0] ?? "");
  const transactionDate = canonicalSinopacDate(values[1] ?? "");
  const transactionTime = canonicalSinopacTime(values[2] ?? "");
  if (!accountingDate) diagnostics.push("accounting-date-invalid");
  if (!transactionDate) diagnostics.push("transaction-date-invalid");
  if (!transactionTime) diagnostics.push("transaction-time-invalid");
  if (!accountingDate || !transactionDate || !transactionTime)
    return { record: null, diagnostics };
  const epochMilliseconds = Date.parse(
    `${transactionDate}T${transactionTime}+08:00`,
  );
  if (!Number.isSafeInteger(epochMilliseconds)) {
    diagnostics.push("effective-time-invalid");
    return { record: null, diagnostics };
  }
  const outflowText = normalizedCell(values[4]);
  const inflowText = normalizedCell(values[5]);
  const outflow = financialAmount(outflowText);
  const inflow = financialAmount(inflowText);
  if ((Boolean(outflowText) && Boolean(inflowText)) || (!outflow && !inflow))
    diagnostics.push("amount-column-conflict");
  if ((outflowText && !outflow) || (inflowText && !inflow))
    diagnostics.push("amount-invalid");
  const balanceAfter = financialAmount(values[6] ?? "", true);
  if (!balanceAfter) diagnostics.push("balance-invalid");
  if (unsupportedSinopacMarker(values))
    diagnostics.push("cancellation-marker-unsupported");
  const amount = outflow ?? inflow;
  const direction = outflow ? "outflow" : inflow ? "inflow" : null;
  if (!amount || !direction || !balanceAfter || diagnostics.length > 0)
    return { record: null, diagnostics };
  const identity = deriveSinopacIdentity(capture);
  const contentHash = sinopacDigest(
    "sinopac-observed-content-v1",
    ...values.map(normalizedCell),
  );
  const collisionKey = sinopacDigest(
    "sinopac-observed-composite-fence-v1",
    identity.subjectDigest,
    accountingDate,
    transactionDate,
    transactionTime,
    direction,
    amount.coefficient,
    String(amount.scale),
    balanceAfter.coefficient,
    String(balanceAfter.scale),
  );
  const occurrenceKey = sinopacDigest(
    "sinopac-observed-composite-occurrence-v1",
    collisionKey,
    normalizedCell(values[3]),
    normalizedCell(values[7]),
    normalizedCell(values[8]),
  );
  const description = combineDescription(values[3], values[7]);
  return {
    diagnostics,
    record: {
      occurrenceKey,
      collisionKey,
      providerKey: collisionKey,
      contentHash,
      sequenceLexeme: `${pageOrdinal}:${row.rowOrdinal}`,
      compactJson: stableSourceJson({
        evidenceVersion: SINOPAC_DOMESTIC_DEPOSIT_FINANCIAL_EVIDENCE_VERSION,
        accountingDate,
        transactionDate,
        transactionTime,
        direction,
        amount,
        balanceAfter,
        descriptionDigest: sinopacDigest(
          "sinopac-description-v1",
          normalizedCell(values[3]),
        ),
        noteDigest: sinopacDigest("sinopac-note-v1", normalizedCell(values[7])),
        referenceDigest: sinopacDigest(
          "sinopac-reference-v1",
          normalizedCell(values[8]),
        ),
        providerGuaranteed: false,
      }),
      amount,
      balanceAfter,
      currency: "TWD",
      description,
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
  };
}

function identityEpochKey(manifest: SinopacHumanAttestedV1Manifest): string {
  const value = [
    "sinopac-human-attested-identity-epoch-v1",
    manifest.attestationId,
    manifest.evidenceVersion,
    manifest.provenance.attestationContractFingerprint,
  ].join("\u0000");
  return `sha256:${Buffer.from(value).toString("base64url")}`;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value as object)) {
    const child = (value as Record<PropertyKey, unknown>)[key];
    if (child !== null && typeof child === "object") deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

/** Build financial facts for the PGlite worker from provider-admitted evidence. */
export function buildSinopacDomesticDepositFinancialCaptureForPGlite(
  input: SinopacPGliteFinancialCaptureInput,
): SinopacPGliteFinancialCaptureResult {
  const diagnostics: string[] = [];
  if (input.capture.product !== "domestic-deposit")
    diagnostics.push("unsupported-product");
  if (input.capture.account.currency !== "TWD")
    diagnostics.push("unsupported-currency");
  const manifest = input.humanAttestation;
  if (
    manifest.attestationId !== "sinopac-domestic-deposit-human-attested-v1" ||
    manifest.evidenceVersion !== SINOPAC_DOMESTIC_DEPOSIT_FINANCIAL_EVIDENCE_VERSION ||
    manifest.authorityRoute !== SINOPAC_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY ||
    manifest.provenance.attestationContractFingerprint !==
      "sha256:ec011375014d525e074d9928cb78ed72355048652a655548904ff9ae3c4d90a1" ||
    manifest.providerGuaranteed !== false
  )
    diagnostics.push("human-attestation-mismatch");
  else if (manifest.status !== "active")
    diagnostics.push("human-attestation-revoked");
  if (unsupportedSinopacAuthority(input.capture.account.label))
    diagnostics.push("authority-shared-account");
  if (!input.captureId.trim()) diagnostics.push("capture-id-missing");
  if (input.capture.downloads.some((download) => !download.terminal))
    diagnostics.push("terminal-evidence-missing");
  if (
    input.capture.downloads.every((download) => download.rows.length === 0) &&
    input.capture.zeroResultAuthority !== "provider-explicit-no-data"
  )
    diagnostics.push("zero-result-authority-unproven");
  const records: CanonicalFinancialDepositRecord[] = [];
  for (const [pageOrdinal, download] of input.capture.downloads.entries()) {
    for (const row of download.rows) {
      const converted = sinopacFinancialRecord(input.capture, row, pageOrdinal);
      diagnostics.push(...converted.diagnostics);
      if (converted.record) records.push(converted.record);
    }
  }
  if (diagnostics.length > 0)
    return { status: "blocked", capture: null, diagnostics: [...new Set(diagnostics)] };

  const identity = deriveSinopacIdentity(input.capture);
  const queryStart = canonicalSinopacDate(input.capture.queryRange.startDate);
  const queryEnd = canonicalSinopacDate(input.capture.queryRange.endDate);
  if (!queryStart || !queryEnd)
    return { status: "blocked", capture: null, diagnostics: ["query-range-invalid"] };
  const contractFingerprint = sinopacDigest(
    "sinopac-contract-v1",
    SINOPAC_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
    SINOPAC_DOMESTIC_DEPOSIT_FINANCIAL_EVIDENCE_VERSION,
  );
  const preflightFingerprint = sinopacDigest(
    "sinopac-preflight-v1",
    identity.subjectDigest,
    queryStart,
    queryEnd,
  );
  const capture: CanonicalFinancialDepositCapture = {
    captureId: input.captureId.trim(),
    authorityRoute: SINOPAC_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
    contractVersion: SINOPAC_DOMESTIC_DEPOSIT_FINANCIAL_EVIDENCE_VERSION,
    identity: {
      integrationNamespace: "sinopac",
      sourceConnectionKey: identity.sourceConnectionKey,
      identityEpochKey: identityEpochKey(manifest),
      stream: "domestic-deposit",
      recordKind: "sinopac-domestic-deposit",
      subjectDigest: identity.subjectDigest,
      accountNo: input.capture.account.value,
      ...(input.capture.account.accountNumber
        ? { accountNumber: input.capture.account.accountNumber }
        : {}),
      accountType: "depository",
      currency: "TWD",
    },
    observedAt: input.capture.observedAt,
    scope: {
      startDate: queryStart,
      endDate: queryEnd,
      scopeKind: "bounded-range",
      completeness: "complete-range",
      completenessBasis: "bounded-terminal-query",
      completenessRuleVersion: SINOPAC_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
      absenceAuthority: records.length === 0 ? "provider-explicit-no-data" : null,
      contractFingerprint,
      preflightFingerprint,
      pageCount: input.capture.downloads.length,
      withdrawalPolicy: "never-infer",
    },
    semantics: {
      postingStatus: "posted",
      postingOrigin: "human-attested",
      postingBasis: "statement-posted-history",
      postingRuleVersion: SINOPAC_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
      economicStatus: "normal",
      administrativeState: "active",
      semanticRuleVersion: SINOPAC_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
      effectiveTimeBasis: "transaction-time",
      effectiveTimeRuleVersion: SINOPAC_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
      timeZone: "Asia/Taipei",
      timePrecision: "minute",
      timeOrigin: "source_reported",
      requireBalance: true,
      providerGuaranteed: false,
      occurrenceProviderGuaranteed: false,
    },
    pages: input.capture.downloads.map((download, pageOrdinal) => ({
      pageOrdinal,
      responseCode: "200",
      terminal: download.terminal,
      rowCount: download.rows.length,
      responseDigest: download.contentDigest,
      proofKind: "bounded-terminal-query",
      contractFingerprint,
      preflightFingerprint,
      metadataJson: stableSourceJson({
        pageOrdinal,
        rowCount: download.rows.length,
        zeroResultAuthority: input.capture.zeroResultAuthority ?? null,
        providerGuaranteed: false,
      }),
    })),
    records,
  };
  const frozenCapture = deepFreeze(capture) as CanonicalFinancialDepositValidatedCapture;
  return { status: "admitted", capture: frozenCapture, diagnostics: [] };
}
