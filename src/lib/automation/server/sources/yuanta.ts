import { browser, field, link, localized, type VerifiedSource, verifiedWorkflow } from "./verified-source.ts";

const RELOGIN = '#reloginBT, a:has-text("立即登入")';

export const YUANTA_SOURCE: VerifiedSource = {
  id: "yuanta",
  label: "Yuanta",
  enabledKey: "LIBRETTO_CLOUD_YUANTA_ENABLED",
  displayName: localized("Yuanta Bank", "元大銀行（Yuanta Bank）"),
  searchAliases: ["Yuanta", "元大銀行"],
  credentialFields: [
    field(
      "LIBRETTO_CLOUD_YUANTA_USER_ID",
      "Taiwan ID number",
      "台灣身分證字號",
      "text",
      "partial",
    ),
    field(
      "LIBRETTO_CLOUD_YUANTA_ACCOUNT",
      "Online banking code",
      "網路銀行代碼",
      "password",
      "full",
    ),
    field(
      "LIBRETTO_CLOUD_YUANTA_PASSWORD",
      "Online banking password",
      "網路銀行密碼",
      "password",
    ),
  ],
  sessionTakeover: {
    notice: localized(
      "When Yuanta Bank reports another active sign-in, every sync, including daily scheduled collection, chooses to sign in now, which signs you out of Yuanta Bank online banking elsewhere.",
      "當元大銀行回報已有其他登入時，每次同步（包括每日排程收集）都會選擇「立即登入」，讓你在其他地方的元大網路銀行登出。",
    ),
    prompt: {
      phase: "while-settling",
      frame: "main",
      selector: RELOGIN,
      control: { selector: RELOGIN, force: true },
    },
  },
  setupGuide: {
    summary: localized(
      "Use the ID number, user code, and password registered for Yuanta Bank online banking.",
      "請使用元大銀行網路銀行已註冊的身分證字號、使用者代碼與密碼。",
    ),
    requirements: [
      localized(
        "An active Yuanta Bank online banking account",
        "已啟用的元大銀行網路銀行服務",
      ),
      localized(
        "Your online banking user code and password",
        "網路銀行使用者代碼與密碼",
      ),
    ],
    steps: [
      localized(
        "Open Yuanta Bank online banking and confirm that you can sign in.",
        "先前往元大銀行網路銀行確認可以登入。",
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
        "https://ebank.yuantabank.com.tw/nib/ibanc.jsp",
        ["ebank.yuantabank.com.tw"],
      ),
      link(
        "guide",
        "View digital banking information (Chinese)",
        "查看申請／取得說明",
        "https://www.yuantabank.com.tw/bankwebIMG/event/Bank_Act2025/MobileBankingAPP/index.html",
        ["www.yuantabank.com.tw"],
      ),
    ],
  },
  integrationNamespace: "yuanta",
  coverage: [
    { institution: "yuanta-bank", product: "deposit" },
    { institution: "yuanta-bank", product: "credit_card" },
    { institution: "yuanta-bank", product: "fund" },
  ],
  statementSelection: {
    key: "LIBRETTO_CLOUD_YUANTA_STATEMENT_TYPES",
    products: [
      { id: "deposit", stream: "domestic-deposit" },
      { id: "foreign_currency", stream: "foreign-currency-deposit" },
      { id: "credit_card", stream: "credit-card" },
      { id: "loan", stream: "loan" },
      { id: "fund", stream: "investment", integrationNamespace: "yuanta-fund" },
    ],
  },
  task: {
    id: "yuanta-all-statements",
    label: "Yuanta all statements",
    kind: "crawler",
  },
  workflow: verifiedWorkflow({
    requiresFinancialCommit: true,
    runtime: browser("https://ebank.yuantabank.com.tw/nib/ibanc.jsp"),
    verification: { rejection: { dialog: { exact: "驗證碼不正確，請重新輸入" } } },
    input: { credentials: true, managedIdentitySecret: true, statementTypes: true },
    async load() {
      return (await import("../../../../workflows/yuanta-all-statements.ts")).runYuantaAllStatementsWorkflow;
    },
  }),
};
