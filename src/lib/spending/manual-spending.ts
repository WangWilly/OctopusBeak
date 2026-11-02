import type { PersonalCategoryCode } from "../../ledger/canonical/personal-category-codes.ts";

/**
 * A Manual Account purchase as Spending counts it: an outflow in the
 * account's currency with its Personal Category. It never joins pairing,
 * deduplication, or the canonical record pages.
 */
export type ManualSpendingPurchase = Readonly<{
  transactionId: string;
  accountId: string;
  accountName: string;
  occurredOn: string;
  amount: string;
  currency: string;
  personalCategory: PersonalCategoryCode | null;
  note: string | null;
}>;

export type ManualSpendingDto = Readonly<{
  /** The Manual Asset revision these purchases were read at. */
  revision: number;
  /** Newest first. */
  purchases: readonly ManualSpendingPurchase[];
}>;
