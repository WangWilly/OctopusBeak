import type { FinancialQueryCutoff } from "./server/financial-query.ts";

/** Presentation sections that may be loaded independently for one generation. */
export const FINANCIAL_SECTIONS = ["primary", "secondary"] as const;
export type FinancialSection = typeof FINANCIAL_SECTIONS[number];

export type FinancialSectionQueryInput = Readonly<{
  cutoff?: FinancialQueryCutoff;
}>;

/**
 * A section response is always qualified by the knowledge point used to read
 * it.  Keeping the marker beside the value makes it hard for a coordinator
 * to accidentally combine responses from different generations.
 */
export type FinancialSectionResult<
  Section extends FinancialSection,
  Value,
> = Readonly<{
  section: Section;
  knowledgePoint: number;
  value: Value;
}>;

export function createFinancialSectionResult<
  Section extends FinancialSection,
  Value extends { knowledgePoint: number },
>(
  section: Section,
  value: Value,
): FinancialSectionResult<Section, Value> {
  return Object.freeze({
    section,
    knowledgePoint: value.knowledgePoint,
    value: Object.freeze(value),
  });
}

export function assertMatchingFinancialSectionKnowledgePoints(
  left: { knowledgePoint: number },
  right: { knowledgePoint: number },
): void {
  if (left.knowledgePoint !== right.knowledgePoint)
    throw new Error("financial-section-knowledge-point-mismatch");
}
