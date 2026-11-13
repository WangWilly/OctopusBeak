import type { PurchaseReport } from "../../ledger/canonical/spending-purchase-report.ts";
import type { CategoryAllocationComponent } from "./transaction-detail.ts";
import type {
  SpendingCandidatePairRef,
  SpendingStrongConflict,
  SpendingSummaryDeltaLine,
} from "../spending/model.ts";

/** A decision on one Cash-flow transfer pair (ADR 0137); it never changes Spending. */
type CashFlowTransferActionRequest<A extends string, K extends string> = Readonly<{
  action: A;
  kind: K;
  outflowTransactionId: string;
  inflowTransactionId: string;
  dataVersion: number;
}>;

/** Worker-validated action from a compact, version-bound Financial page; each kind has one entry (ADR 0136). */
export type FinancialPageActionRequest = Readonly<{
  action: "confirm" | "deny";
  kind: "candidate";
  candidateId: string;
  invoiceIdentityId: string;
  transactionIdentityId: string;
  dataVersion: number;
}> | Readonly<{
  action: "confirm";
  kind: "direct";
  invoiceIdentityId: string;
  transactionIdentityId: string;
  dataVersion: number;
}> | Readonly<{
  action: "revoke";
  kind: "revoke";
  invoiceIdentityId: string;
  transactionIdentityId: string;
  dataVersion: number;
}> | Readonly<{
  /** Set or, with a null code, clear the user's category on one purchase (ADR 0038). */
  action: "categorize";
  kind: "category";
  purchaseId: string;
  categoryCode: string | null;
  dataVersion: number;
}> | Readonly<{
  /** 合併所有高度相符: confirm exactly the strong pairs the user was shown, in one commit or none. */
  action: "confirm";
  kind: "strong";
  /** The data version the shown pairs came from; a newer unrelated commit does not reject. */
  shownKnowledgeAt: number;
  /** `YYYY-MM`: the strong set is recomputed inside this month only. Omitted means every month. */
  month?: string | null;
  pairs: readonly SpendingCandidatePairRef[];
}>
  | CashFlowTransferActionRequest<"confirm", "transfer_confirm">
  | CashFlowTransferActionRequest<"deny", "transfer_deny">
  | CashFlowTransferActionRequest<"revoke", "transfer_revoke">
  /** Pair two transactions the person chose, without the candidate date window. */
  | CashFlowTransferActionRequest<"pair", "transfer_pair">
  | Readonly<{
    /**
     * Split one purchase's transaction across categories with a complete
     * Category Allocation; it supersedes any user category the transaction has.
     * Clearing goes back to automatic through `category` with a null code.
     */
    action: "allocate";
    kind: "allocation";
    purchaseId: string;
    components: readonly CategoryAllocationComponent[];
    dataVersion: number;
  }>
  | Readonly<{
    /** Set or, with null, clear the person's note on one canonical transaction. */
    action: "annotate";
    kind: "note";
    transactionId: string;
    note: string | null;
    dataVersion: number;
  }>
  | Readonly<{
    /** Apply a Transaction Tag by label, creating the User Tag when no tag has that normalized label. */
    action: "add";
    kind: "tag_add";
    transactionId: string;
    label: string;
    dataVersion: number;
  }>
  | Readonly<{
    /** Withdraw one Transaction Tag from one transaction; the User Tag itself stays. */
    action: "remove";
    kind: "tag_remove";
    transactionId: string;
    tagId: string;
    dataVersion: number;
  }>;

/** The page actions that always commit, or fail: every kind but the strong batch. */
export type FinancialCommittingPageActionRequest = Exclude<FinancialPageActionRequest, Readonly<{ kind: "strong" }>>;

/** The identities whose Purchase records an action read before and after its write. */
export type FinancialPageActionSubject = Readonly<{
  invoiceIds: readonly string[];
  transactionIds: readonly string[];
}>;

export type FinancialPageActionResult = Readonly<{
  status: "committed";
  action: FinancialPageActionRequest["action"];
  kind: FinancialPageActionRequest["kind"];
  /** The compact summary version the action validated before writing. */
  baseKnowledgeAt: number;
  /** The exact version containing this action's committed change; equal to the base when nothing changed. */
  knowledgeAt: number;
  subject: FinancialPageActionSubject;
  /** Purchase rows before/after the action; their amounts use exact decimals. */
  summaryDelta: Readonly<{
    before: readonly SpendingSummaryDeltaLine[];
    after: readonly SpendingSummaryDeltaLine[];
  }>;
  /** Only rows that contain an identity of the subject. */
  affectedRecords: readonly PurchaseReport["records"][number][];
}>;

/** What a page action answers: its committed result, or a strong batch's conflict. */
export type FinancialPageActionReply = FinancialPageActionResult | SpendingStrongConflict;

/** Whether a Purchase record belongs to an action's subject, so its row is replaced by the action's records. */
export function inFinancialPageActionSubject(
  subject: FinancialPageActionSubject,
  record: Readonly<{ invoice?: Readonly<{ invoiceId: string }> | null; transaction?: Readonly<{ transactionId: string }> | null }>,
): boolean {
  return (record.invoice != null && subject.invoiceIds.includes(record.invoice.invoiceId))
    || (record.transaction != null && subject.transactionIds.includes(record.transaction.transactionId));
}
