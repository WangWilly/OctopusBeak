import { browser, field, link, localized, type VerifiedSource, verifiedWorkflow } from "./verified-source.ts";
import type { AutomationExternalPrerequisite } from "../../types.ts";

export const YUANTA_SERVISIGN_PREREQUISITE: AutomationExternalPrerequisite = {
  id: "yuanta-servisign",
  provider: "Yuanta",
  component: "YuanTa security component",
  downloadUrl:
    "https://global.yuanta.com.tw/NexusPVM/webimage/servisign/YuanTaCGCryptServiSignSetup.pkg",
  allowedHosts: ["global.yuanta.com.tw"],
  unavailableEventCode: "servisign-unavailable",
  instructions: {
    en: "Download and install the official YuanTa security component. After installation, return here and press Run again.",
    "zh-TW":
      "下載並安裝元大官方安全元件。安裝完成後回到這裡，按「重新執行」再試一次。",
  },
};

export const YUANTA_TRADE_SOURCE: VerifiedSource = {
  id: "yuanta-trade",
  label: "Yuanta Trade",
  enabledKey: "LIBRETTO_CLOUD_YUANTA_TRADE_ENABLED",
  displayName: localized(
    "Yuanta Securities",
    "元大證券（Yuanta Securities）",
  ),
  searchAliases: ["Yuanta Trade", "Yuanta Securities", "元大證券"],
  credentialFields: [
    field(
      "LIBRETTO_CLOUD_YUANTA_TRADE_USER_ID",
      "Taiwan ID number",
      "台灣身分證字號",
      "text",
      "partial",
    ),
    field(
      "LIBRETTO_CLOUD_YUANTA_TRADE_PASSWORD",
      "Yuanta Securities password",
      "元大證券登入密碼",
      "password",
    ),
    field(
      "LIBRETTO_CLOUD_YUANTA_TRADE_CA_PATH",
      "Certificate file",
      "憑證檔案",
      "certificate-file",
    ),
    field(
      "LIBRETTO_CLOUD_YUANTA_TRADE_CA_PASSWORD",
      "Certificate password",
      "憑證密碼",
      "password",
    ),
  ],
  setupGuide: {
    summary: localized(
      "Yuanta Securities requires your sign-in details and an exported certificate file for statement access.",
      "元大證券需要登入資料，以及已匯出的憑證檔案才能取得帳務資料。",
    ),
    requirements: [
      localized(
        "Your Taiwan ID number and Yuanta Securities password",
        "台灣身分證字號與元大證券登入密碼",
      ),
      localized(
        "A .pfx or .p12 certificate file and its password",
        ".pfx 或 .p12 憑證檔案及憑證密碼",
      ),
    ],
    steps: [
      localized(
        "Confirm that you can sign in to Yuanta Securities.",
        "先確認可以登入元大證券。",
      ),
      localized(
        "Apply for or renew the certificate, then export a backup certificate file.",
        "申請或更新憑證後，匯出一份憑證備份檔。",
      ),
      localized(
        "Return here, choose the certificate file, and enter its password.",
        "回到這裡選擇憑證檔案並輸入憑證密碼。",
      ),
    ],
    links: [
      link(
        "service",
        "Open securities service (Chinese)",
        "前往證券服務",
        "https://global.yuanta.com.tw/NexusWebTrade/Login/OTPLogin?urlid=6020",
        ["global.yuanta.com.tw"],
      ),
      link(
        "certificate-guide",
        "View certificate application and component installation guide (Chinese)",
        "查看憑證申請與元件安裝說明",
        "https://www.yuanta.com.tw/eYuanta/Securities/Node/Index?C1=2018031206314695&ID=2018031206314695&Level=1&MainId=00414",
        ["www.yuanta.com.tw"],
      ),
      link(
        "installer",
        "Download Yuanta certificate component",
        "下載元大憑證元件",
        "https://global.yuanta.com.tw/NexusPVM/webimage/servisign/YuanTaCGCryptServiSignSetup.pkg",
        ["global.yuanta.com.tw"],
      ),
    ],
    extra: {
      title: localized("Yuanta certificate component", "元大憑證元件"),
      steps: [
        localized(
          "Download and install the official component before using the certificate service.",
          "請先下載並安裝元大官方憑證元件。",
        ),
        localized(
          "After installation, return to Yuanta Securities to apply for, renew, or export the certificate.",
          "安裝完成後回到元大證券，申請、更新或匯出憑證。",
        ),
        localized(
          "Keep the exported file in a stable location; this app stores its original path and does not copy it.",
          "請把匯出的憑證檔放在固定位置；本應用程式只記錄原始路徑，不會複製檔案。",
        ),
      ],
    },
  },
  integrationNamespace: "yuanta-trade",
  coverage: [{ institution: "yuanta-securities", product: "securities" }],
  statementSelection: {
    key: "LIBRETTO_CLOUD_YUANTA_TRADE_STATEMENT_TYPES",
    products: [
      { id: "securities", stream: "investment" },
    ],
  },
  task: {
    id: "yuanta-trade-statements",
    label: "Yuanta trade statements",
    kind: "crawler",
    externalPrerequisites: [YUANTA_SERVISIGN_PREREQUISITE],
  },
  workflow: verifiedWorkflow({
    requiresFinancialCommit: true,
    runtime: browser("https://global.yuanta.com.tw/NexusWebTrade/Login/OTPLogin?urlid=6020"),
    verification: {
      async route(request, { onChallengeCaptured, ...dependencies }) {
        const { routeYuantaTradeAppAssistanceRequest } = await import("../yuanta-trade-assistance.ts");
        return await routeYuantaTradeAppAssistanceRequest(request, {
          ...dependencies,
          routeOptions: { onChallengeCaptured },
        });
      },
    },
    input: { credentials: true },
    async load() {
      return (await import("../../../../workflows/yuanta-trade-statements.ts")).runYuantaTradeProviderWorkflow;
    },
  }),
};
