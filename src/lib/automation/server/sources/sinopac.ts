import { browser, field, link, localized, type VerifiedSource } from "./verified-source.ts";
import { ATTACHED_PREVIEW_PRODUCTS } from "../../../preview-sources/attached-products.ts";

export const SINOPAC_SOURCE: VerifiedSource = {
  id: "sinopac",
  label: "SinoPac",
  enabledKey: "LIBRETTO_CLOUD_SINOPAC_ENABLED",
  displayName: localized("Bank SinoPac", "永豐銀行（Bank SinoPac）"),
  searchAliases: ["SinoPac", "MMA", "永豐"],
  credentialFields: [
    field(
      "LIBRETTO_CLOUD_SINOPAC_USER_ID",
      "Taiwan ID number",
      "台灣身分證字號",
      "text",
      "partial",
    ),
    field(
      "LIBRETTO_CLOUD_SINOPAC_ACCOUNT",
      "Online banking code",
      "網路銀行代碼",
      "password",
      "full",
    ),
    field(
      "LIBRETTO_CLOUD_SINOPAC_PASSWORD",
      "Online banking password",
      "網路銀行密碼",
      "password",
    ),
  ],
  sessionTakeoverNotice: localized(
    "SinoPac allows one online banking sign-in at a time. Every sync, including daily scheduled collection, confirms SinoPac's duplicate sign-in prompt, which signs you out of SinoPac online banking or its phone App elsewhere.",
    "永豐同一時間只允許一處網路銀行登入。每次同步（包括每日排程收集）都會確認永豐的重複登入提示，讓你在其他地方的永豐網路銀行或手機 App 登出。",
  ),
  setupGuide: {
    summary: localized(
      "Use the ID number, user code, and password registered for Bank SinoPac MMA online banking.",
      "請使用永豐銀行 MMA 網路銀行已註冊的身分證字號、使用者代碼與密碼。",
    ),
    requirements: [
      localized(
        "An active MMA online banking account",
        "已啟用的 MMA 網路銀行服務",
      ),
      localized(
        "Your user code and online password",
        "網路銀行使用者代碼與網路密碼",
      ),
    ],
    steps: [
      localized(
        "Open MMA online banking and confirm that you can sign in.",
        "先前往 MMA 網路銀行確認可以登入。",
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
        "https://mma.sinopac.com/MemberPortal/Member/MMALogin.aspx",
        ["mma.sinopac.com"],
      ),
      link(
        "guide",
        "View sign-in details guide (Chinese)",
        "查看申請／取得說明",
        "https://bank.sinopac.com/searchmb/FAQ/content.aspx?catID=MMAb2c&no=340&sid=MMA&subCatID=%E7%B6%B2%E9%8A%80%E5%AF%86%E7%A2%BC",
        ["bank.sinopac.com"],
      ),
    ],
  },
  integrationNamespace: "sinopac",
  coverage: [{ institution: "sinopac", product: "deposit" }],
  statementSelection: {
    key: "LIBRETTO_CLOUD_SINOPAC_STATEMENT_TYPES",
    products: [
      { id: "deposit", stream: "domestic-deposit" },
    ],
  },
  task: {
    id: "sinopac-statements",
    label: "SinoPac statements",
    kind: "crawler",
  },
  workflow: {
    requiresFinancialCommit: true,
    attachedPreviewProducts: ATTACHED_PREVIEW_PRODUCTS.sinopac,
    runtime: browser("https://mma.sinopac.com/MemberPortal/Member/MMALogin.aspx"),
    verification: { ownsSubmissionOutcome: true },
    input: { credentials: true, statementTypes: true },
    async load() {
      return (await import("../../../../workflows/sinopac-statements.ts")).runSinopacProviderWorkflow;
    },
  },
};
