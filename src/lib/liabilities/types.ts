import type {
  AccountRowDto,
  CurrentProjectionStateDto,
  DailyHistoryRowDto,
  TransactionRowDto,
} from "$lib/shared-ledger/types.ts";
import type { FinancialSectionResult } from "$lib/shared-ledger/financial-section.ts";

export type LiabilitiesPageDto = CurrentProjectionStateDto & {
  accounts: AccountRowDto[];
  marginAccounts: AccountRowDto[];
  transactionsByAccount: Record<string, TransactionRowDto[]>;
  dailyHistoryByAccount: Record<string, DailyHistoryRowDto[]>;
  dailyHistory: DailyHistoryRowDto[];
};

export type LiabilitiesPrimaryDto = Omit<LiabilitiesPageDto, "knowledgePoint" | "dailyHistoryByAccount" | "dailyHistory"> & {
  knowledgePoint: number;
};

export type LiabilitiesSecondaryDto = Pick<LiabilitiesPageDto, "dailyHistoryByAccount" | "dailyHistory"> & {
  knowledgePoint: number;
};

export type LiabilitiesPrimarySection = FinancialSectionResult<"primary", LiabilitiesPrimaryDto>;
export type LiabilitiesSecondarySection = FinancialSectionResult<"secondary", LiabilitiesSecondaryDto>;
