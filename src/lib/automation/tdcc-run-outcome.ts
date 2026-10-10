import type { Translation } from "../i18n/i18n.ts";
import type { TypedWorkflowOutcome } from "./server/typed-workflow-outcome.ts";

type OutcomeCounts = NonNullable<TypedWorkflowOutcome["summary"]>["counts"];

const EXCLUSION_COUNT_NAMES: ReadonlySet<string> = new Set([
  "excludedUnknownInstitutionCount",
  "excludedNonIsoCurrencyCount",
  "excludedNonNumericAccountCount",
  "excludedTimeDepositCount",
  "hiddenAccountCount",
  "excludedBankNotUpdatedCount",
  "excludedEmptyNonIsoCurrencyCount",
]);

/** The run's other counts, which the generic summary row still lists. */
export function countsOutsideTdccExclusions(counts: OutcomeCounts): [string, number | undefined][] {
  return Object.entries(counts).filter(([name]) => !EXCLUSION_COUNT_NAMES.has(name));
}

/** Plain-words lines for the TDCC accounts a run reported but did not admit (ADR 0042), counts only. */
export function tdccExclusionLines(counts: OutcomeCounts, dictionary: Translation): string[] {
  const copy = dictionary.automation.tdccExclusions;
  const lines: ReadonlyArray<readonly [number | undefined, (count: number) => string]> = [
    [counts.excludedUnknownInstitutionCount, copy.unknownInstitution],
    [counts.excludedNonIsoCurrencyCount, copy.nonIsoCurrency],
    [counts.excludedNonNumericAccountCount, copy.nonNumericAccount],
    [counts.excludedTimeDepositCount, copy.timeDeposits],
    [counts.hiddenAccountCount, copy.hiddenAccounts],
    [counts.excludedBankNotUpdatedCount, copy.bankNotUpdated],
    [counts.excludedEmptyNonIsoCurrencyCount, copy.emptyNonIsoCurrency],
  ];
  return lines.flatMap(([count, line]) => count !== undefined && count > 0 ? [line(count)] : []);
}
