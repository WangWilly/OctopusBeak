import type {
  AccountRowDto,
  AssetPositionDto,
  DailyHistoryRowDto,
  TransactionRowDto,
  CurrentProjectionStateDto,
} from "$lib/shared-ledger/types.ts";
import type { FinancialSectionResult } from "$lib/shared-ledger/financial-section.ts";

export type AssetsPageDto = CurrentProjectionStateDto & {
  accounts: AccountRowDto[];
  positionsByAccount: Record<string, AssetPositionDto[]>;
  transactionsByAccount: Record<string, TransactionRowDto[]>;
  dailyHistoryByAccount: Record<string, DailyHistoryRowDto[]>;
  dailyHistory: DailyHistoryRowDto[];
};

export type AssetsPrimaryDto = Omit<AssetsPageDto, "knowledgePoint" | "dailyHistoryByAccount" | "dailyHistory"> & {
  knowledgePoint: number;
};

export type AssetsSecondaryDto = Pick<AssetsPageDto, "dailyHistoryByAccount" | "dailyHistory"> & {
  knowledgePoint: number;
};

export type AssetsPrimarySection = FinancialSectionResult<"primary", AssetsPrimaryDto>;
export type AssetsSecondarySection = FinancialSectionResult<"secondary", AssetsSecondaryDto>;
