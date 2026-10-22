import { field, link, localized, NONBROWSER, type VerifiedSource } from "./verified-source.ts";

function maicoinInput(environment: NodeJS.ProcessEnv) {
  return {
    credentials: {
      accessKey: environment.MAX_ACCESS_KEY ?? "",
      secretKey: environment.MAX_SECRET_KEY ?? "",
      subAccount: environment.MAX_SUB_ACCOUNT?.trim() || "main",
      ...(environment.MAX_PROVIDER_EMAIL?.trim()
        ? { providerEmail: environment.MAX_PROVIDER_EMAIL.trim() }
        : {}),
    },
  };
}

export const MAICOIN_SOURCE: VerifiedSource = {
  id: "maicoin",
  label: "MaiCoin",
  enabledKey: "MAX_ENABLED",
  displayName: localized("MaiCoin", "MaiCoin"),
  searchAliases: ["MaiCoin", "MAX", "MAX Exchange"],
  credentialFields: [
    field(
      "MAX_ACCESS_KEY",
      "MAX API access key",
      "MAX API 存取金鑰",
      "password",
    ),
    field(
      "MAX_SECRET_KEY",
      "MAX API secret key",
      "MAX API 私密金鑰",
      "password",
    ),
    field("MAX_SUB_ACCOUNT", "MAX sub-account", "MAX 子帳戶"),
  ],
  setupGuide: {
    summary: localized(
      "Create a MAX API token to synchronize your MAX wallet and transaction records.",
      "請建立 MAX API 金鑰，以同步 MAX 錢包與交易紀錄。",
    ),
    requirements: [
      localized("A verified MAX account", "已完成驗證的 MAX 帳戶"),
      localized(
        "An API access key and secret key",
        "API 存取金鑰與私密金鑰",
      ),
      localized(
        "The sub-account name, if you use one",
        "如有使用子帳戶，請準備子帳戶名稱",
      ),
    ],
    steps: [
      localized(
        "Sign in to MAX and open Profile settings.",
        "登入 MAX 後開啟個人資料設定。",
      ),
      localized(
        "Open API Token Settings and create a token.",
        "進入 API Token 設定並建立金鑰。",
      ),
      localized(
        "Enable only the read permissions needed for synchronization; withdrawal permission is not required.",
        "只啟用同步所需的讀取權限；不需要開啟提領權限。",
      ),
      localized(
        "Copy the access and secret keys here. Enter a sub-account only when the token belongs to one.",
        "將存取金鑰與私密金鑰填入這裡；只有金鑰屬於子帳戶時才填寫子帳戶。",
      ),
    ],
    links: [
      link(
        "service",
        "Open MAX",
        "前往 MAX",
        "https://max.maicoin.com/signin",
        ["max.maicoin.com"],
        "https://max.maicoin.com/signin?lang=en",
      ),
      link(
        "api-guide",
        "View API key setup guide",
        "查看 API 金鑰設定說明",
        "https://campaign.maicoin.com/api",
        ["campaign.maicoin.com"],
        "https://campaign.maicoin.com/en/api",
      ),
      link(
        "api-docs",
        "Open MAX API documentation",
        "前往 MAX API 文件",
        "https://campaign.maicoin.com/api-document",
        ["campaign.maicoin.com"],
        "https://campaign.maicoin.com/en/api-document",
      ),
    ],
    extra: {
      title: localized("MAX API", "MAX API"),
      steps: [
        localized(
          "The secret key may only be shown once. Copy it before leaving the MAX setup screen.",
          "私密金鑰可能只顯示一次，離開 MAX 設定畫面前請先複製。",
        ),
        localized(
          "If you rotate or revoke the token later, return here and replace both keys.",
          "日後若輪替或撤銷金鑰，請回到這裡同時更新兩把金鑰。",
        ),
      ],
    },
  },
  integrationNamespace: "maicoin",
  overview: { defaultStream: "investment" },
  task: {
    id: "sync-maicoin",
    label: "MaiCoin sync",
    kind: "sync",
  },
  workflow: {
    requiresFinancialCommit: true,
    requiresMaicoinPersistence: true,
    runtime: NONBROWSER,
    input: { extra: maicoinInput },
    async load() {
      return (await import("../../maicoin-workflow.ts")).createMaicoinWorkflow().run;
    },
  },
};
