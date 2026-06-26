import type { AccountRowDto, TransactionRowDto } from "$lib/shared-ledger/types.ts";

export type LiabilitiesPageDto = {
  accounts: AccountRowDto[];
  transactionsByAccount: Record<string, TransactionRowDto[]>;
};
