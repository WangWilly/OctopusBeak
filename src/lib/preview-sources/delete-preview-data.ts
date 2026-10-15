import type { PGlitePreviewFinancialDataPort } from "../../ledger/pglite/preview-financial-data.ts";
import type { DataVersionStore } from "../shared-shell/data-version.ts";

export async function deleteAllPreviewData(
  preview: Pick<PGlitePreviewFinancialDataPort, "deleteAll">,
  versions: Pick<DataVersionStore, "markStale">,
) {
  await preview.deleteAll();
  versions.markStale("preview-data-changed");
}
