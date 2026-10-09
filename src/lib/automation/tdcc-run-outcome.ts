import type { Translation } from "../i18n/i18n.ts";
import type { TypedWorkflowOutcome } from "./server/typed-workflow-outcome.ts";

type OutcomeCounts = NonNullable<TypedWorkflowOutcome["summary"]>["counts"];

/** Plain-words lines for the TDCC accounts a run reported but did not admit (ADR 0042), counts only. */
export function tdccExclusionLines(counts: OutcomeCounts, dictionary: Translation): string[] {
  const copy = dictionary.automation.tdccExclusions;
  const lines: ReadonlyArray<readonly [number | undefined, (count: number) => string]> = [
    [counts.excludedUnknownInstitutionCount, copy.unknownInstitution],
    [counts.excludedNonIsoCurrencyCount, copy.nonIsoCurrency],
    [counts.excludedTimeDepositCount, copy.timeDeposits],
    [counts.hiddenAccountCount, copy.hiddenAccounts],
  ];
  return lines.flatMap(([count, line]) => count !== undefined && count > 0 ? [line(count)] : []);
}
