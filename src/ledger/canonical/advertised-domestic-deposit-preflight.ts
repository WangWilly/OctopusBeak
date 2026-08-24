export type AdvertisedDomesticDepositSource =
  "fubon" | "yuanta" | "hncb" | "ctbc" | "post" | "sinopac";

export type ExplicitNoDataEvidence =
  | { kind: "none" }
  | { kind: "code"; code: string }
  | { kind: "message"; pattern: RegExp }
  | { kind: "status-message"; status: string; message: string };

export type AdvertisedDomesticDepositContract = {
  source: AdvertisedDomesticDepositSource;
  authority: `${AdvertisedDomesticDepositSource}/domestic-deposit/preflight-v1`;
  contractVersion: "preflight-v1";
  readiness: "preflight-only";
  workflow: string;
  provenance: {
    evidenceBasis: string;
    fixtureValues: "synthetic";
    liveResponseRetained: false;
  };
  expectedRowWidth: number;
  accountingDateIndex: number;
  transactionDateIndex: number;
  transactionTimeIndex: number;
  outflowIndex: number;
  inflowIndex: number;
  completenessEvidence: "none" | "pagination-termination" | "response-count";
  explicitNoDataEvidence: ExplicitNoDataEvidence;
};

export type AdvertisedDomesticDepositRecord = {
  values: string[];
  /** Not supplied by any current workflow. Reserved for a future evidence version. */
  sourceOccurrenceId?: string;
  /** Not supplied by any current workflow. It must not be inferred from a date or balance. */
  sourcePostingStatus?: string;
  /** Not supplied by any current workflow. Amount-column position is not provider semantics. */
  sourceDirection?: string;
};

export type AdvertisedDomesticDepositPreflightInput = {
  accountIdentity: string;
  scope: { startDate: string; endDate: string };
  records: AdvertisedDomesticDepositRecord[];
  transport?: {
    reportedCount?: number;
    pageNumbers?: number[];
    terminalPageObserved?: boolean;
    noDataCode?: string;
    noDataStatus?: string;
    noDataMessage?: string;
  };
};

export type AdvertisedDomesticDepositDiagnosticCode =
  | "account-identity-missing"
  | "scope-invalid"
  | "row-width-invalid"
  | "date-evidence-missing"
  | "amount-evidence-missing"
  | "amount-evidence-invalid"
  | "reported-count-invalid"
  | "reported-count-mismatch"
  | "page-number-invalid"
  | "page-number-duplicate"
  | "page-number-gap"
  | "pagination-terminal-missing"
  | "empty-scope-unproven"
  | "unsupported-source-semantics"
  | "account-identity-unproven"
  | "occurrence-identity-unproven"
  | "direction-semantics-unproven"
  | "posting-semantics-unproven"
  | "effective-time-semantics-unproven"
  | "completeness-semantics-unproven"
  | "authority-semantics-unproven";

export type AdvertisedDomesticDepositPreflightResult = {
  status: "blocked";
  readiness: "preflight-only";
  source: AdvertisedDomesticDepositSource;
  contractVersion: "preflight-v1";
  structuralStatus: "observed" | "defective";
  zeroResultEvidence: "not-applicable" | "provider-explicit" | "unproven";
  recordCount: number;
  diagnostics: Array<{
    code: AdvertisedDomesticDepositDiagnosticCode;
    rowIndex?: number;
  }>;
};

export const ADVERTISED_DOMESTIC_DEPOSIT_SEMANTIC_BLOCKERS = [
  "account-identity-unproven",
  "occurrence-identity-unproven",
  "direction-semantics-unproven",
  "posting-semantics-unproven",
  "effective-time-semantics-unproven",
  "completeness-semantics-unproven",
  "authority-semantics-unproven",
] as const satisfies readonly AdvertisedDomesticDepositDiagnosticCode[];

export type AdvertisedDomesticDepositSemanticBlocker =
  (typeof ADVERTISED_DOMESTIC_DEPOSIT_SEMANTIC_BLOCKERS)[number];

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function validDate(value: string): boolean {
  const match = clean(value).match(/^(\d{4})[\/-]?(\d{2})[\/-]?(\d{2})$/);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function validScope(
  scope: AdvertisedDomesticDepositPreflightInput["scope"],
): boolean {
  if (!validDate(scope.startDate) || !validDate(scope.endDate)) return false;
  const compact = (value: string) => value.replace(/\D/g, "");
  return compact(scope.startDate) <= compact(scope.endDate);
}

function validAmountEvidence(value: string): boolean {
  return /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(clean(value).replace(/,/g, ""));
}

function explicitNoDataObserved(
  evidence: ExplicitNoDataEvidence,
  transport: AdvertisedDomesticDepositPreflightInput["transport"],
): boolean {
  if (!transport || evidence.kind === "none") return false;
  if (evidence.kind === "code")
    return clean(transport.noDataCode) === evidence.code;
  if (evidence.kind === "message")
    return evidence.pattern.test(clean(transport.noDataMessage));
  return (
    clean(transport.noDataStatus) === evidence.status &&
    clean(transport.noDataMessage) === evidence.message
  );
}

function diagnostic(
  diagnostics: AdvertisedDomesticDepositPreflightResult["diagnostics"],
  code: AdvertisedDomesticDepositDiagnosticCode,
  rowIndex?: number,
): void {
  diagnostics.push({ code, ...(rowIndex === undefined ? {} : { rowIndex }) });
}

/**
 * Validates only evidence already retained by the statement workflows. The
 * result intentionally cannot contain accepted canonical rows: transport and
 * table shape are not occurrence identity, posting, time, or authority proof.
 */
export function preflightAdvertisedDomesticDeposit(
  contract: AdvertisedDomesticDepositContract,
  input: AdvertisedDomesticDepositPreflightInput,
): AdvertisedDomesticDepositPreflightResult {
  const diagnostics: AdvertisedDomesticDepositPreflightResult["diagnostics"] =
    [];
  if (!clean(input.accountIdentity))
    diagnostic(diagnostics, "account-identity-missing");
  if (!validScope(input.scope)) diagnostic(diagnostics, "scope-invalid");

  input.records.forEach((record, rowIndex) => {
    if (record.values.length !== contract.expectedRowWidth) {
      diagnostic(diagnostics, "row-width-invalid", rowIndex);
      return;
    }
    if (
      ![contract.accountingDateIndex, contract.transactionDateIndex].some(
        (index) => validDate(record.values[index] ?? ""),
      )
    ) {
      diagnostic(diagnostics, "date-evidence-missing", rowIndex);
    }
    const amounts = [contract.outflowIndex, contract.inflowIndex]
      .map((index) => clean(record.values[index]))
      .filter(Boolean);
    if (amounts.length === 0) {
      diagnostic(diagnostics, "amount-evidence-missing", rowIndex);
    } else if (amounts.some((amount) => !validAmountEvidence(amount))) {
      diagnostic(diagnostics, "amount-evidence-invalid", rowIndex);
    }
    if (
      clean(record.sourceOccurrenceId) ||
      clean(record.sourcePostingStatus) ||
      clean(record.sourceDirection)
    ) {
      diagnostic(diagnostics, "unsupported-source-semantics", rowIndex);
    }
  });

  const transport = input.transport;
  if (transport?.reportedCount !== undefined) {
    if (
      !Number.isSafeInteger(transport.reportedCount) ||
      transport.reportedCount < 0
    ) {
      diagnostic(diagnostics, "reported-count-invalid");
    } else if (transport.reportedCount !== input.records.length) {
      diagnostic(diagnostics, "reported-count-mismatch");
    }
  }

  if (transport?.pageNumbers !== undefined) {
    const seen = new Set<number>();
    for (const pageNumber of transport.pageNumbers) {
      if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) {
        diagnostic(diagnostics, "page-number-invalid");
      } else if (seen.has(pageNumber)) {
        diagnostic(diagnostics, "page-number-duplicate");
      }
      seen.add(pageNumber);
    }
    [...seen]
      .sort((left, right) => left - right)
      .forEach((pageNumber, index) => {
        if (pageNumber !== index + 1)
          diagnostic(diagnostics, "page-number-gap");
      });
    if (
      contract.completenessEvidence === "pagination-termination" &&
      transport.terminalPageObserved !== true
    ) {
      diagnostic(diagnostics, "pagination-terminal-missing");
    }
  }

  let zeroResultEvidence: AdvertisedDomesticDepositPreflightResult["zeroResultEvidence"] =
    "not-applicable";
  if (input.records.length === 0) {
    zeroResultEvidence = explicitNoDataObserved(
      contract.explicitNoDataEvidence,
      transport,
    )
      ? "provider-explicit"
      : "unproven";
    if (zeroResultEvidence === "unproven")
      diagnostic(diagnostics, "empty-scope-unproven");
  }

  const structuralDefectCodes =
    new Set<AdvertisedDomesticDepositDiagnosticCode>([
      "account-identity-missing",
      "scope-invalid",
      "row-width-invalid",
      "date-evidence-missing",
      "amount-evidence-missing",
      "amount-evidence-invalid",
      "reported-count-invalid",
      "reported-count-mismatch",
      "page-number-invalid",
      "page-number-duplicate",
      "page-number-gap",
      "pagination-terminal-missing",
      "empty-scope-unproven",
      "unsupported-source-semantics",
    ]);
  const structuralStatus = diagnostics.some(({ code }) =>
    structuralDefectCodes.has(code),
  )
    ? "defective"
    : "observed";
  ADVERTISED_DOMESTIC_DEPOSIT_SEMANTIC_BLOCKERS.forEach((code) =>
    diagnostic(diagnostics, code),
  );

  return {
    status: "blocked",
    readiness: contract.readiness,
    source: contract.source,
    contractVersion: contract.contractVersion,
    structuralStatus,
    zeroResultEvidence,
    recordCount: input.records.length,
    diagnostics,
  };
}

export function createAdvertisedDomesticDepositPreflight(
  contract: AdvertisedDomesticDepositContract,
): (
  input: AdvertisedDomesticDepositPreflightInput,
) => AdvertisedDomesticDepositPreflightResult {
  return (input) => preflightAdvertisedDomesticDeposit(contract, input);
}
