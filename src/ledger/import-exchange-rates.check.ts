import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importDownloadsCsv } from "./import-downloads-csv.ts";

const root = await mkdtemp(join(tmpdir(), "import-exchange-rates-"));
const downloadsDir = join(root, "downloads");
const outputDir = join(root, "ledger");
const sourceDir = join(downloadsDir, "yuanta-foreign-currency-statements");
const originalFetch = globalThis.fetch;
const originalWarn = console.warn;
let fetchCalls = 0;
let warningCalls = 0;

try {
  await mkdir(sourceDir, { recursive: true });
  await writeFile(
    join(sourceDir, "usd.csv"),
    [
      '"帳務日期","交易日期","查詢幣別","幣別","帳面餘額","帳號"',
      '"2026/07/10","2026/07/10","USD","USD","100","12345678"',
      "",
    ].join("\n"),
    "utf8",
  );
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("CSV import must not fetch exchange rates");
  };
  console.warn = () => {
    warningCalls += 1;
  };

  const result = await importDownloadsCsv({
    downloadsDir,
    outputDir,
    bankFilters: ["yuanta"],
    productFilters: ["foreign-currency-statements"],
  });
  assert.equal(result.importedCsvFiles, 1);
  assert.equal(result.importedRows, 1);
  assert.equal(fetchCalls, 0);
  assert.equal(warningCalls, 0);
  assert.doesNotMatch(
    await readFile(new URL("./import-downloads-csv.ts", import.meta.url), "utf8"),
    /loadOverview|syncExchangeRates|exchange-rate-sync-warning/,
  );
} finally {
  globalThis.fetch = originalFetch;
  console.warn = originalWarn;
  await rm(root, { recursive: true, force: true });
}
