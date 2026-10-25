import { browser, field, link, localized, type VerifiedSource, verifiedWorkflow } from "./verified-source.ts";
import { isFubonDuplicateLoginConfirm } from "../../fubon-dialog.ts";

export const FUBON_SOURCE: VerifiedSource = {
  id: "fubon",
  label: "Fubon",
  enabledKey: "LIBRETTO_CLOUD_FUBON_ENABLED",
  displayName: localized(
    "Taipei Fubon Bank",
    "台北富邦銀行（Taipei Fubon Bank）",
  ),
  searchAliases: ["Fubon", "富邦", "台北富邦"],
  credentialFields: [
    field(
      "LIBRETTO_CLOUD_FUBON_USER_ID",
      "Taiwan ID number",
      "台灣身分證字號",
      "text",
      "partial",
    ),
    field(
      "LIBRETTO_CLOUD_FUBON_ACCOUNT",
      "Online banking code",
      "網路銀行代碼",
      "password",
      "full",
    ),
    field(
      "LIBRETTO_CLOUD_FUBON_PASSWORD",
      "Online banking password",
      "網路銀行密碼",
      "password",
    ),
  ],
  sessionTakeover: {
    notice: localized(
      "Every sync, including daily scheduled collection, confirms Taipei Fubon Bank's duplicate sign-in prompt (code 0212), which signs you out of Taipei Fubon online banking elsewhere.",
      "每次同步（包括每日排程收集）都會確認台北富邦的重複登入提示（代碼 0212），讓你在其他地方的台北富邦網路銀行登出。",
    ),
    prompt: { phase: "while-settling", dialog: isFubonDuplicateLoginConfirm },
  },
  setupGuide: {
    summary: localized(
      "Use the same ID number, user code, and password you use for Taipei Fubon online banking.",
      "請準備登入台北富邦網路銀行時使用的身分證字號、使用者代碼與密碼。",
    ),
    requirements: [
      localized(
        "An active Taipei Fubon online banking account",
        "已啟用的台北富邦網路銀行服務",
      ),
      localized(
        "Your online banking user code and password",
        "網路銀行使用者代碼與密碼",
      ),
    ],
    steps: [
      localized(
        "Open Taipei Fubon online banking and confirm that you can sign in.",
        "先開啟台北富邦網路銀行，確認可以正常登入。",
      ),
      localized(
        "Return here and enter the same sign-in details.",
        "回到這裡輸入相同的登入資料。",
      ),
    ],
    links: [
      link(
        "service",
        "Open online banking (Chinese)",
        "前往網路銀行",
        "https://ebank.taipeifubon.com.tw/B2C/common/Index.faces",
        ["ebank.taipeifubon.com.tw"],
      ),
      link(
        "guide",
        "View online banking information (Chinese)",
        "查看申請／取得說明",
        "https://www.fubon.com/banking/personal/digitalService/index.htm",
        ["www.fubon.com"],
      ),
    ],
  },
  integrationNamespace: "fubon",
  coverage: [
    { institution: "fubon", product: "deposit" },
    { institution: "fubon", product: "credit_card" },
  ],
  statementSelection: {
    key: "LIBRETTO_CLOUD_FUBON_STATEMENT_TYPES",
    products: [
      { id: "deposit", stream: "domestic-deposit" },
      { id: "credit_card", stream: "credit-card" },
      { id: "loan", stream: "loan" },
    ],
  },
  task: {
    id: "fubon-all-statements",
    label: "Fubon all statements",
    kind: "crawler",
  },
  workflow: verifiedWorkflow({
    requiresFinancialCommit: true,
    requiresAccountIdentity: true,
    runtime: browser("https://ebank.taipeifubon.com.tw/B2C/common/Index.faces"),
    verification: { rejection: { frame: "txnFrame", text: { pattern: /^0290\s*驗證碼輸入錯誤$/u } } },
    input: { credentials: true, managedIdentitySecret: true, statementTypes: true },
    async load() {
      return (await import("../../../../workflows/fubon-all-statements.ts")).runFubonAllStatementsWorkflow;
    },
  }),
};
