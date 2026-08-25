/**
 * Foreign-currency SinoPac source evidence uses the same structural adapter
 * as domestic deposits, but keeps a distinct product stream, route, and
 * identity epoch so the two provider exports cannot collide.
 */
export {
  SINOPAC_FOREIGN_DEPOSIT_EVIDENCE_VERSION,
  SINOPAC_FOREIGN_DEPOSIT_IDENTITY_EPOCH,
  SINOPAC_FOREIGN_DEPOSIT_SOURCE_EVIDENCE_RECORD_KIND,
  SINOPAC_FOREIGN_DEPOSIT_SOURCE_EVIDENCE_ROUTE,
  SINOPAC_FOREIGN_DEPOSIT_SOURCE_EVIDENCE_RULE_VERSION,
  SINOPAC_FOREIGN_STATEMENTS_EVIDENCE_VERSION,
  SINOPAC_FOREIGN_STATEMENTS_IDENTITY_EPOCH,
  SINOPAC_FOREIGN_STATEMENTS_SOURCE_EVIDENCE_RECORD_KIND,
  SINOPAC_FOREIGN_STATEMENTS_SOURCE_EVIDENCE_ROUTE,
  SINOPAC_FOREIGN_STATEMENTS_SOURCE_EVIDENCE_RULE_VERSION,
  createSinopacForeignCurrencySourceEvidence,
} from "./sinopac-domestic-deposit.ts";
export type {
  SinopacStatementCaptureDiagnostic,
  SinopacStatementCaptureEvidence,
  SinopacStatementCaptureValidationResult,
  SinopacStatementDownloadEvidence,
  SinopacStatementValidatedCapture,
  SinopacSourceRow,
} from "./sinopac-domestic-deposit.ts";

import {
  admitSinopacStatementCaptureEvidence,
  isAdmittedSinopacStatementCaptureEvidence,
  type SinopacStatementCaptureEvidence,
  type SinopacStatementCaptureValidationResult,
  type SinopacStatementValidatedCapture,
} from "./sinopac-domestic-deposit.ts";
import {
  admitForeignCurrencyDepositCapture,
  type ForeignCurrencyDepositAdmittedCapture,
  type ForeignCurrencyDepositCaptureInput,
} from "./foreign-currency-deposit.ts";

export const SINOPAC_FOREIGN_CURRENCY_HUMAN_ATTESTED_V1 = Object.freeze({
  authorityRoute: "sinopac/foreign-currency/deposit/human-attested-v1",
  evidenceVersion: "foreign-currency/sinopac/human-attested-v1",
  attestedAt: "2026-08-25",
  attestedBy: "user-confirmed-live-run",
  providerGuaranteed: false,
  occurrenceProviderGuaranteed: false,
  sourceKeyFields: [
    "account",
    "currency",
    "DataText1",
    "DataText4",
    "DataText5",
  ],
  derivedFieldsExcluded: ["DataText9"],
  collisionPolicy: "reject-colliding-tuples",
} as const);

function normalizedCell(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function sourceDate(value: string): string {
  const normalized = normalizedCell(value).replaceAll("/", "-");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized))
    throw new Error("SinoPac foreign source identity date is invalid.");
  return normalized;
}

function sourceTime(value: string): string {
  const normalized = normalizedCell(value);
  if (!/^\d{2}:\d{2}(?::\d{2})?$/.test(normalized))
    throw new Error("SinoPac foreign source identity time is invalid.");
  return normalized;
}

function exactDecimal(value: string, label: string): string {
  const normalized = normalizedCell(value).replaceAll(",", "");
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(normalized))
    throw new Error(`SinoPac foreign ${label} is not an exact decimal.`);
  const [whole, fraction = ""] = normalized.split(".");
  const trimmedFraction = fraction.replace(/0+$/, "");
  return trimmedFraction ? `${whole}.${trimmedFraction}` : whole!;
}

/**
 * Converts admitted source evidence into the user-attested foreign-currency
 * contract. DataText9 is intentionally unavailable here because it is only
 * the provider's display concatenation of DataText4 and DataText5.
 */
export function buildSinopacForeignCurrencyCaptureInput(
  capture: SinopacStatementValidatedCapture,
  captureOccurrenceId: string,
): ForeignCurrencyDepositCaptureInput {
  if (!isAdmittedSinopacForeignCurrencyCaptureEvidence(capture))
    throw new Error(
      "SinoPac foreign canonical input requires admitted evidence.",
    );
  if (!captureOccurrenceId.trim())
    throw new Error("SinoPac foreign capture occurrence identity is required.");
  const accountNo = normalizedCell(capture.account.value);
  const currency = normalizedCell(capture.account.currency).toUpperCase();
  const sourceKeys = new Set<string>();
  const records = capture.downloads.flatMap((download) =>
    download.rows.map((row) => {
      const values = row.values;
      const localDate = sourceDate(values[0] ?? "");
      const localTime = sourceTime(values[2] ?? "");
      const outflowText = normalizedCell(values[4]);
      const inflowText = normalizedCell(values[5]);
      if (outflowText.length > 0 === inflowText.length > 0)
        throw new Error(
          "SinoPac foreign row must prove exactly one amount direction.",
        );
      const direction = outflowText
        ? ("outflow" as const)
        : ("inflow" as const);
      const amount = exactDecimal(outflowText || inflowText, "amount");
      const balanceAfter = exactDecimal(values[6] ?? "", "balance");
      const signedAmount = `${direction === "outflow" ? "-" : "+"}${amount}`;
      const sourceKey = [
        accountNo,
        currency,
        `${localDate}T${localTime}`,
        signedAmount,
        balanceAfter,
      ].join(":");
      if (sourceKeys.has(sourceKey))
        throw new Error(
          "SinoPac foreign human-attested source identity collision.",
        );
      sourceKeys.add(sourceKey);
      const reportedRateText = normalizedCell(values[8]);
      return {
        sourceKey,
        sequence: `${localDate}T${localTime}`,
        amount,
        direction,
        currencyEvidence: { kind: "scope" as const, currency },
        balanceAfter,
        sourceTime: {
          localDate,
          localTime,
          precision:
            localTime.length === 5 ? ("minute" as const) : ("second" as const),
        },
        originalAmount: { amount, currency },
        sourceReportedRate: reportedRateText
          ? {
              rate: exactDecimal(reportedRateText, "reported rate"),
              baseCurrency: currency,
              quoteCurrency: "TWD",
              observedOn: localDate,
            }
          : null,
        description: normalizedCell(values[3]) || null,
        sourcePayload: {
          identityAuthority: "human-attested",
          identityContract:
            SINOPAC_FOREIGN_CURRENCY_HUMAN_ATTESTED_V1.evidenceVersion,
          accountingDate: sourceDate(values[1] ?? ""),
          note: normalizedCell(values[7]),
          derivedFieldsExcluded:
            SINOPAC_FOREIGN_CURRENCY_HUMAN_ATTESTED_V1.derivedFieldsExcluded,
        },
      };
    }),
  );
  return {
    source: "sinopac",
    accountNo,
    sourceConnectionKey: "sinopac-foreign-current-login",
    identityEpochKey:
      SINOPAC_FOREIGN_CURRENCY_HUMAN_ATTESTED_V1.evidenceVersion,
    accountType: "depository",
    captureCurrencyScope: { kind: "currency", currency },
    captureOccurrenceId,
    zeroResultAuthority:
      capture.zeroResultAuthority === "provider-explicit-no-data"
        ? capture.zeroResultAuthority
        : undefined,
    observedAt: capture.observedAt,
    startDate: sourceDate(
      capture.queryRange.startDate.replace(
        /^(\d{4})(\d{2})(\d{2})$/,
        "$1-$2-$3",
      ),
    ),
    endDate: sourceDate(
      capture.queryRange.endDate.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3"),
    ),
    completeness: "complete-range",
    records,
  };
}

export function admitSinopacForeignCurrencyFinancialCapture(
  capture: SinopacStatementValidatedCapture,
  captureOccurrenceId: string,
): ForeignCurrencyDepositAdmittedCapture {
  return admitForeignCurrencyDepositCapture(
    buildSinopacForeignCurrencyCaptureInput(capture, captureOccurrenceId),
  );
}

export function admitSinopacForeignCurrencyCaptureEvidence(
  capture: SinopacStatementCaptureEvidence,
): SinopacStatementCaptureValidationResult {
  if (capture.product !== "foreign-currency") {
    return {
      status: "rejected",
      capture: null,
      diagnostics: ["product-invalid"],
    };
  }
  return admitSinopacStatementCaptureEvidence(capture);
}

export function isAdmittedSinopacForeignCurrencyCaptureEvidence(
  value: unknown,
): value is SinopacStatementValidatedCapture {
  return (
    isAdmittedSinopacStatementCaptureEvidence(value) &&
    value.product === "foreign-currency"
  );
}
