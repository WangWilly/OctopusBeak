import type { AccountRowDto, AssetPositionDto, TransactionRowDto } from "$lib/shared-ledger/types.ts";

export type AssetsPageDto = {
  accounts: AccountRowDto[];
  positionsByAccount: Record<string, AssetPositionDto[]>;
  transactionsByAccount: Record<string, TransactionRowDto[]>;
};
