/**
 * Canonical loan staging: the step that turns a loan source's admitted
 * captures into staged items (ADR 0127). Each source still admits its own
 * captures, one at a time through `admitLoan`, so its own loop keeps its
 * progress events. This step owns the item keys, the commit command and the
 * repayment-mandate relation command each item carries (ADR 0016).
 */
import type { LoanCaptureInput } from "../ledger/canonical/loan-financial-contracts.ts";
import {
  PGLITE_CANONICAL_LOAN_COMMIT_COMMAND,
  PGLITE_CANONICAL_LOAN_RELATIONS_RESOLVE_COMMAND,
} from "../ledger/pglite/workflow-commands.ts";
import type { ProductCollectionHandle, ProductStageRequest } from "../lib/automation/product-collection.ts";

/**
 * The source's evidence that repayments of this loan go to `accountValue`.
 * The step binds it to the capture's identity and scope.
 */
export type LoanRepaymentMandate = Readonly<{
  accountValue: string;
  /** The capture record the evidence is anchored to. */
  sourceRecordKey: string;
  sourceField: string;
  contractVersion: string;
}>;

/** What one capture's admission decided, before the step keys it. */
export type LoanDecision = Readonly<{
  capture: LoanCaptureInput;
  /** The Source Connection the relations resolve under. */
  sourceConnectionKey: string;
  integrationNamespace: string;
  /** Absent when the source proved no repayment account; the loan still commits. */
  repaymentMandate?: LoanRepaymentMandate;
}>;

declare const admittedThroughValidate: unique symbol;

/** A decision made inside `product.validate`. Only `admitLoan` makes one. */
export type LoanAdmission = LoanDecision & Readonly<{ [admittedThroughValidate]: true }>;

/**
 * Run one capture's admission as the product's validation check (ADR 0106),
 * so a thrown admission fails as a validation failure in every source. Keep
 * browser, network and ledger reads outside `admit`.
 */
export async function admitLoan(
  product: Pick<ProductCollectionHandle, "validate">,
  admit: () => LoanDecision | Promise<LoanDecision>,
): Promise<LoanAdmission> {
  return await product.validate(admit) as LoanAdmission;
}

function loanItem({ capture, sourceConnectionKey, integrationNamespace, repaymentMandate }: LoanAdmission): ProductStageRequest {
  return {
    product: "loan",
    itemKey: capture.captureId,
    command: { kind: PGLITE_CANONICAL_LOAN_COMMIT_COMMAND, request: { capture } },
    relationCommands: () => [{
      kind: PGLITE_CANONICAL_LOAN_RELATIONS_RESOLVE_COMMAND,
      request: {
        sourceConnectionKey,
        integrationNamespace,
        observedAt: capture.observedAt,
        counterpartyEvidence: repaymentMandate
          ? [{
              captureId: capture.captureId,
              sourceRecordKey: repaymentMandate.sourceRecordKey,
              sourceConnectionKey: capture.identity.sourceConnectionKey,
              identityEpochKey: capture.identity.identityEpochKey,
              accountValue: repaymentMandate.accountValue,
              role: "beneficiary",
              purpose: "loan_repayment",
              scope: "loan_contract",
              evidenceKind: "repayment-mandate",
              sourceField: repaymentMandate.sourceField,
              contractVersion: repaymentMandate.contractVersion,
              effectiveStartDate: capture.scope.startDate,
              effectiveEndDate: capture.scope.endDate,
              accountKey: capture.identity.accountKey,
            }]
          : [],
      },
    }],
  };
}

/** Stage every admission in admission order in one call. With no admissions it stages nothing. */
export function stageCanonicalLoans(
  product: Pick<ProductCollectionHandle, "stage" | "signal">,
  admissions: readonly LoanAdmission[],
): void {
  product.signal.throwIfAborted();
  if (admissions.length === 0) return;
  product.stage(...admissions.map(loanItem));
}
