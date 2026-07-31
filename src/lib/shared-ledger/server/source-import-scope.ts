export type SourceImportScope = `${string}|${string}`;

export function sourceImportScopeKey(
  value: { sourceFileId: string; importRunId: string },
): SourceImportScope {
  return `${value.sourceFileId}|${value.importRunId}`;
}
