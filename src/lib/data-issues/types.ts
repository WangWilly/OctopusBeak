import type { AccountRowDto, CurrencyAmountDto } from "../shared-ledger/types.ts";

export type DataIssueCreateInput = {
  account: Pick<AccountRowDto, "id" | "label" | "institution" | "product" | "group" | "kind" | "typeLabel" | "amountLines" | "lastUpdated">;
  fieldKey: "balance";
  note: string;
};

export type SourceVersionId = { sourceFileId: string; importRunId: string };

export type PreviewExclusionInput = {
  dataIssueId: string;
  sourceVersion: SourceVersionId;
};

export type ConfirmExclusionInput = {
  dataIssueId: string;
  sourceVersion: SourceVersionId;
  reason: string;
  acknowledged: true;
  previewToken: string;
};

export type ConfirmRestoreInput = {
  dataIssueId: string;
  previewToken: string;
};

export type DataIssueEventDto = {
  dataIssueEventId: string;
  eventType: string;
  stage: string;
  outcome: "succeeded" | "blocked" | "failed";
  summary: string;
  details: Record<string, unknown>;
  createdAt: string;
};

export type SourceImportCandidateDto = SourceVersionId & {
  fileName: string;
  importedAt: string;
  csvRows: number;
  insertedRows: number;
  duplicateRows: number;
  affectedAccounts: number;
};

export type DataIssueListItemDto = {
  dataIssueId: string;
  accountLabel: string;
  status: "pending" | "investigating" | "resolved" | "restored";
  reportedValue: CurrencyAmountDto;
  createdAt: string;
  updatedAt: string;
};

export type DataIssueDetailDto = {
  dataIssueId: string;
  status: "pending" | "investigating" | "resolved" | "restored";
  account: DataIssueCreateInput["account"];
  fieldKey: "balance";
  reportedValue: CurrencyAmountDto;
  dataDate: string | null;
  note: string;
  candidates: SourceImportCandidateDto[];
  events: DataIssueEventDto[];
};

export type ExclusionPreviewDto = {
  sourceVersion: SourceVersionId;
  previewToken: string;
  csvRows: number;
  excludedRows: number;
  duplicateRows: number;
  affectedAccounts: Array<{
    accountId: string;
    accountLabel: string;
    before: { availability: "available" | "unavailable"; amounts: CurrencyAmountDto[] };
    after: { availability: "available" | "unavailable"; amounts: CurrencyAmountDto[] };
  }>;
};

export type RestorePreviewDto = {
  allowed: boolean;
  previewToken: string;
  blockedBy: Array<{ accountId: string; updatedAt: string }>;
  affectedAccounts: ExclusionPreviewDto["affectedAccounts"];
};
