import type { AccountRowDto } from "../../lib/shared-ledger/types.ts";
import { readManualOutside } from "./outside-manual.ts";
import { readPreviewCreditOutside } from "./outside-preview-credit.ts";
import { readPreviewDepositOutside } from "./outside-preview-deposit.ts";
import { readPreviewLoanOutside } from "./outside-preview-loan.ts";
import type { BalanceSeries } from "./outside-row.ts";
import type { PreviewVisibility } from "./preview-financial-data.ts";
import type { PGliteStore, PGliteTransaction } from "./transaction.ts";

export type OutsideReader = Pick<PGliteStore, "query"> | Pick<PGliteTransaction, "query">;

export type OutsideScope = Readonly<{
  previewVisibility: PreviewVisibility;
  /** The person's local date; an ended Manual Asset still counts on its end date. */
  today: string;
}>;

/** The rows and dated balances of Outside financial data, ready to join a Financial page. */
export type OutsideFinancialData = Readonly<{ accounts: readonly AccountRowDto[]; series: readonly BalanceSeries[] }>;

/**
 * Reads every kind of Outside financial data in the caller's snapshot. A new
 * preview product adds its own `outside-*` reader here and nowhere else.
 */
export async function readOutsideFinancialData(reader: OutsideReader, scope: OutsideScope): Promise<OutsideFinancialData> {
  const parts = [
    await readPreviewDepositOutside(reader, scope.previewVisibility),
    await readPreviewCreditOutside(reader, scope.previewVisibility),
    await readPreviewLoanOutside(reader, scope.previewVisibility),
    await readManualOutside(reader, scope.today),
  ];
  return {
    accounts: parts.flatMap((part) => part.accounts),
    series: parts.flatMap((part) => part.series),
  };
}
