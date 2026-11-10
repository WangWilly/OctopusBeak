/**
 * Canonical investment staging: the step that turns an investment source's
 * admitted captures into staged items (ADR 0127). Each source still builds its
 * own captures at its own grain, inside `admitInvestments`; this step owns
 * the item keys, the commit command and the relation command each item
 * carries.
 */
import type { InvestmentCaptureInput } from "../ledger/canonical/investment-financial-admission.ts";
import {
  PGLITE_CANONICAL_INVESTMENT_COMMIT_COMMAND,
  PGLITE_CANONICAL_INVESTMENT_RELATIONS_RESOLVE_COMMAND,
} from "../ledger/pglite/workflow-commands.ts";
import type { ProductCollectionHandle, ProductStageRequest } from "../lib/automation/product-collection.ts";

/** What a source's whole-run admission decided; a source may carry its own counts beside the captures. */
export type InvestmentDecision = Readonly<{ captures: readonly InvestmentCaptureInput[] }>;

declare const admittedThroughValidate: unique symbol;

/** A decision made inside `product.validate`. Only `admitInvestments` makes one. */
export type InvestmentAdmission<Decision extends InvestmentDecision = InvestmentDecision> =
  Decision & Readonly<{ [admittedThroughValidate]: true }>;

/**
 * Run a source's investment admission as the product's validation check
 * (ADR 0106), so a thrown admission fails as a validation failure in every
 * source. Keep browser, network and ledger reads outside `admit`.
 */
export async function admitInvestments<Decision extends InvestmentDecision>(
  product: Pick<ProductCollectionHandle, "validate">,
  admit: () => Decision | Promise<Decision>,
): Promise<InvestmentAdmission<Decision>> {
  return await product.validate(admit) as InvestmentAdmission<Decision>;
}

function investmentItem(capture: InvestmentCaptureInput): ProductStageRequest {
  return {
    product: "investment",
    itemKey: capture.captureId,
    command: { kind: PGLITE_CANONICAL_INVESTMENT_COMMIT_COMMAND, request: { capture } },
    relationCommands: () => [{
      kind: PGLITE_CANONICAL_INVESTMENT_RELATIONS_RESOLVE_COMMAND,
      request: {
        sourceConnectionKey: capture.identity.sourceConnectionKey,
        observedAt: capture.observedAt,
      },
    }],
  };
}

/** Stage every admitted capture in admission order in one call. With no captures it stages nothing. */
export function stageCanonicalInvestments(
  product: Pick<ProductCollectionHandle, "stage" | "signal">,
  admission: InvestmentAdmission,
): void {
  product.signal.throwIfAborted();
  if (admission.captures.length === 0) return;
  product.stage(...admission.captures.map(investmentItem));
}
