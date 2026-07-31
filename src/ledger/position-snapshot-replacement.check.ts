import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAssets } from "../lib/assets/server/load-assets.ts";
import { importDownloadsCsv } from "./import-downloads-csv.ts";

const brokerageHeaders = [
  "as_of_date",
  "account_number",
  "asset_type",
  "sub_category",
  "product_code",
  "product_name",
  "currency",
  "quantity",
  "market_date",
  "market_price",
  "market_value_original",
  "market_value_twd",
  "cost_price",
  "cost_amount",
  "unrealized_pnl_original",
  "unrealized_pnl_twd",
  "return_rate",
  "fx_rate",
];

function brokerageCsv(symbols: string[]) {
  const rows = symbols.map((symbol, index) => [
    "2026-07-31",
    "9948",
    "stock",
    "US stock",
    symbol,
    `${symbol} Incorporated`,
    "USD",
    String(index + 1),
    "2026-07-31",
    "100",
    String((index + 1) * 100),
    String((index + 1) * 3000),
    "90",
    String((index + 1) * 90),
    "10",
    "300",
    "11.11",
    "30",
  ]);
  return [brokerageHeaders, ...rows].map((row) => row.join(",")).join("\n") + "\n";
}

const fundHeaders = [
  "資料類別",
  "基金識別",
  "查詢期間",
  "基金名稱",
  "基金類型",
  "投資幣別",
  "投資金額",
  "不含息參考市值",
  "不含息參考損益",
  "不含息參考報酬率",
  "含息參考損益",
  "含息參考報酬率",
  "狀態",
];

function fundCsv(funds: string[]) {
  const rows = funds.map((fund, index) => [
    "holding",
    fund,
    "2026-07-31",
    `${fund} Fund`,
    "equity",
    "USD",
    String((index + 1) * 100),
    String((index + 1) * 110),
    "10",
    "10",
    "10",
    "10",
    "active",
  ]);
  return [fundHeaders, ...rows].map((row) => row.join(",")).join("\n") + "\n";
}

async function symbolsAfterImports(options: {
  fixtureName: string;
  sourceFolder: string;
  product: string;
  snapshots: Array<{ fileName: string; csv: string }>;
}) {
  const rootDir = await mkdtemp(join(tmpdir(), `${options.fixtureName}-`));
  try {
    const downloadsDir = join(rootDir, "downloads");
    const outputDir = join(rootDir, "ledger");
    const sourceDir = join(downloadsDir, options.sourceFolder);
    await mkdir(sourceDir, { recursive: true });

    const importInput = {
      downloadsDir,
      outputDir,
      bankFilters: ["yuanta"],
      productFilters: [options.product],
    };

    for (const snapshot of options.snapshots) {
      await writeFile(join(sourceDir, snapshot.fileName), snapshot.csv, "utf8");
      await importDownloadsCsv(importInput);
    }

    const assets = await loadAssets(outputDir);
    return Object.values(assets.positionsByAccount)
      .flat()
      .map((position) => position.symbol)
      .sort();
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

test("a newer brokerage holdings snapshot removes sold positions", async () => {
  const symbols = await symbolsAfterImports({
    fixtureName: "brokerage-snapshot-replacement",
    sourceFolder: "yuanta-trade-statements",
    product: "trade-statements",
    snapshots: [
      {
        fileName: "holdings-20260731090000.csv",
        csv: brokerageCsv(["ANET", "VRT"]),
      },
      {
        fileName: "holdings-20260731100000.csv",
        csv: brokerageCsv(["ANET"]),
      },
    ],
  });
  assert.deepEqual(symbols, ["ANET"]);
});

test("an empty brokerage holdings snapshot clears the account", async () => {
  const symbols = await symbolsAfterImports({
    fixtureName: "brokerage-empty-snapshot",
    sourceFolder: "yuanta-trade-statements",
    product: "trade-statements",
    snapshots: [
      {
        fileName: "holdings-20260731090000.csv",
        csv: brokerageCsv(["ANET"]),
      },
      {
        fileName: "holdings-20260731100000.csv",
        csv: brokerageCsv([]),
      },
    ],
  });
  assert.deepEqual(symbols, []);
});

test("a newer fund holdings snapshot removes redeemed funds", async () => {
  const symbols = await symbolsAfterImports({
    fixtureName: "fund-snapshot-replacement",
    sourceFolder: "yuanta-fund-statements",
    product: "fund-statements",
    snapshots: [
      {
        fileName: "fund-holdings-20260731090000.csv",
        csv: fundCsv(["FUND-A", "FUND-B"]),
      },
      {
        fileName: "fund-holdings-20260731100000.csv",
        csv: fundCsv(["FUND-A"]),
      },
    ],
  });
  assert.deepEqual(symbols, ["FUND-A"]);
});
