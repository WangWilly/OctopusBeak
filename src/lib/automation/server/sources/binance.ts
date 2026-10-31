import type { CollectionPeriodDeclaration } from "../../collection-period.ts";
import { field, link, localized, NONBROWSER, type VerifiedSource, verifiedWorkflow } from "./verified-source.ts";

/**
 * ADR 0084: the quote assets of the Bounded trade history. A trade is
 * requested only for a pair whose base is an observed asset and whose quote
 * is one of these; adding a quote asset is a change here.
 */
export const BINANCE_QUOTE_ASSETS = ["USDT", "FDUSD", "USDC", "BTC", "BNB", "ETH"] as const;

/**
 * ADR 0077 and 0084: two years back, in the widest window each history
 * endpoint accepts. Binance keeps internal transfers for about six months
 * and refuses an older range (-5026), so transfers look back six months.
 */
export const BINANCE_COLLECTION_PERIODS = {
  trades: { lookBack: { years: 2 } },
  fundHistory: { lookBack: { years: 2 }, maxWindow: { days: 90 } },
  transfers: { lookBack: { months: 6 }, maxWindow: { days: 30 } },
} as const satisfies Readonly<Record<string, CollectionPeriodDeclaration>>;

export const BINANCE_SOURCE: VerifiedSource = {
  id: "binance",
  label: "Binance",
  enabledKey: "LIBRETTO_CLOUD_BINANCE_ENABLED",
  displayName: localized("Binance", "幣安 Binance"),
  searchAliases: ["Binance", "幣安"],
  credentialFields: [
    field("LIBRETTO_CLOUD_BINANCE_API_KEY", "Binance API key", "Binance API 金鑰", "password"),
    field("LIBRETTO_CLOUD_BINANCE_API_SECRET", "Binance API secret", "Binance API 私密金鑰", "password"),
  ],
  setupGuide: {
    summary: localized(
      "Create a read-only Binance API key to synchronize your spot and funding wallets, trades, deposits and withdrawals.",
      "請建立唯讀的 Binance API 金鑰，以同步現貨與資金錢包、成交、充值與提領紀錄。",
    ),
    requirements: [
      localized("A verified Binance account", "已完成驗證的 Binance 帳戶"),
      localized("An API key and secret key", "API 金鑰與私密金鑰"),
    ],
    steps: [
      localized(
        "Sign in to Binance and open API Management.",
        "登入 Binance 後開啟 API 管理。",
      ),
      localized(
        "Create a system-generated API key.",
        "建立系統生成的 API 金鑰。",
      ),
      localized(
        "Keep only Enable Reading on; trading, withdrawal and transfer permissions are not required.",
        "只保留「允許讀取」；不需要開啟交易、提領或劃轉權限。",
      ),
      localized(
        "Copy the API key and secret key here.",
        "將 API 金鑰與私密金鑰填入這裡。",
      ),
    ],
    links: [
      link(
        "service",
        "Open Binance API Management",
        "前往 Binance API 管理",
        "https://www.binance.com/zh-TC/my/settings/api-management",
        ["www.binance.com"],
        "https://www.binance.com/en/my/settings/api-management",
      ),
      link(
        "api-docs",
        "Open Binance API documentation (English)",
        "前往 Binance API 文件（英文）",
        "https://developers.binance.com/docs/binance-spot-api-docs",
        ["developers.binance.com"],
      ),
    ],
    extra: {
      title: localized("Binance API", "Binance API"),
      steps: [
        localized(
          "The secret key is shown only once. Copy it before leaving the Binance setup screen.",
          "私密金鑰只會顯示一次，離開 Binance 設定畫面前請先複製。",
        ),
        localized(
          "Trades are collected for pairs of the assets you hold, deposited, withdrew or transferred against USDT, FDUSD, USDC, BTC, BNB and ETH, so the trade history is never complete.",
          "成交紀錄只收集你持有、充值、提領或劃轉過的資產對 USDT、FDUSD、USDC、BTC、BNB、ETH 的交易對，因此不會是完整的成交紀錄。",
        ),
      ],
    },
  },
  integrationNamespace: "binance",
  overview: { defaultStream: "investment" },
  task: {
    id: "sync-binance",
    label: "Binance sync",
    kind: "sync",
  },
  workflow: verifiedWorkflow({
    requiresFinancialCommit: true,
    runtime: NONBROWSER,
    input: { credentials: true },
    async load() {
      return (await import("../../binance-workflow.ts")).createBinanceWorkflow().run;
    },
  }),
};
