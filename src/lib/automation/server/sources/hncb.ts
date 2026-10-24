import { browser, field, link, localized, type VerifiedSource, verifiedWorkflow } from "./verified-source.ts";
import { ATTACHED_PREVIEW_PRODUCTS } from "../../../preview-sources/attached-products.ts";

export const HNCB_SOURCE: VerifiedSource = {
  id: "hncb",
  label: "HNCB",
  enabledKey: "LIBRETTO_CLOUD_HNCB_ENABLED",
  displayName: localized("Hua Nan Bank", "華南銀行（Hua Nan Bank）"),
  searchAliases: ["HNCB", "Hua Nan", "華南"],
  credentialFields: [
    field(
      "LIBRETTO_CLOUD_HNCB_USER_ID",
      "Taiwan ID number",
      "台灣身分證字號",
      "text",
      "partial",
    ),
    field(
      "LIBRETTO_CLOUD_HNCB_ACCOUNT",
      "Online banking code",
      "網路銀行代碼",
      "password",
      "full",
    ),
    field(
      "LIBRETTO_CLOUD_HNCB_PASSWORD",
      "Online banking password",
      "網路銀行密碼",
      "password",
    ),
  ],
  setupGuide: {
    summary: localized(
      "Use the ID number, user code, and password registered for Hua Nan Bank online banking.",
      "請使用華南銀行網路銀行已註冊的身分證字號、使用者代碼與密碼。",
    ),
    requirements: [
      localized(
        "An active Hua Nan Bank online banking account",
        "已啟用的華南銀行網路銀行服務",
      ),
      localized(
        "Your online banking user code and password",
        "網路銀行使用者代碼與密碼",
      ),
    ],
    steps: [
      localized(
        "Open Hua Nan Bank online banking and verify your sign-in details.",
        "先前往華南銀行網路銀行確認登入資料。",
      ),
      localized(
        "Return here and enter those details.",
        "回到這裡輸入相同資料。",
      ),
    ],
    links: [
      link(
        "service",
        "Open online banking (Chinese)",
        "前往網路銀行",
        "https://netbank.hncb.com.tw/netbank/servlet/TrxDispatcher?trx=com.lb.wibc.trx.Login&state=prompt&Recognition=private",
        ["netbank.hncb.com.tw"],
      ),
      link(
        "guide",
        "View online banking help (Chinese)",
        "查看申請／取得說明",
        "https://www.hncb.com.tw/ibankqa/index.shtml",
        ["www.hncb.com.tw"],
      ),
    ],
  },
  integrationNamespace: "hncb",
  coverage: [{ institution: "hncb", product: "deposit" }],
  statementSelection: {
    key: "LIBRETTO_CLOUD_HNCB_STATEMENT_TYPES",
    products: [
      { id: "deposit", stream: "domestic-deposit" },
    ],
  },
  task: {
    id: "hncb-statements",
    label: "HNCB statements",
    kind: "crawler",
  },
  workflow: verifiedWorkflow({
    requiresFinancialCommit: true,
    attachedPreviewProducts: ATTACHED_PREVIEW_PRODUCTS.hncb,
    runtime: browser("https://netbank.hncb.com.tw/netbank/servlet/TrxDispatcher?trx=com.lb.wibc.trx.Login&state=prompt&Recognition=private"),
    verification: { ownsSubmissionOutcome: false },
    input: { credentials: true, statementTypes: true },
    async load() {
      return (await import("../../../../workflows/hncb-statements.ts")).runHncbProviderWorkflow;
    },
  }),
};
