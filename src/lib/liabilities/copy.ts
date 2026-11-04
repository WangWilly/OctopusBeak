import type { Locale } from "../i18n/locale.ts";

const en = {
  liabilities: {
    eyebrow: "Liabilities",
    title: "Debt accounts",
    sideLabel: "Liabilities",
    searchPlaceholder: "Search liabilities",
    metricsAria: "Liability metrics",
    balanceHistoryAria: "Debt balance history",
    debtBalance: "Debt balance",
    debtBalanceCurrency: "Debt balance currency",
    debtExposure: "Debt exposure",
    sideSub: (accounts: number, currencies: number) =>
      `${accounts} debt accounts / ${currencies} currencies`,
    total: (accounts: number) => `Total debt · ${accounts} debt account${accounts === 1 ? "" : "s"}`,
    dueIn: (days: number) => (days === 0 ? "due today" : days === 1 ? "in 1 day" : `in ${days} days`),
    cardInUse: "In use · estimate",
    utilization: "Card utilization",
    mortgageRepaid: "Mortgage repaid",
    mortgageOriginalMissing: "Some mortgages report no original amount",
    marginExposure: "Investment margin exposure",
    empty: {
      bannerTitle: "No debt accounts yet",
      bannerBody:
        "Connect a credit card or loan to see amounts due, due dates, and your debt trend here. If you have no credit cards or loans, this page stays empty.",
      totalLabel: "Total debt",
      totalNote: "No debt data imported yet",
      side: "No debt accounts yet",
      paymentsTitle: "No payments due",
      paymentsBody: "Once connected, card statements and loan payments are listed by due date",
      chartTitle: "No debt trend yet",
      chartBody: "After credit card or loan data is imported, daily debt balances will show here.",
      listTitle: "No debt accounts",
      listBody: "After you add credit card or loan sign-in details and sync, the accounts are listed here.",
    },
  },
};

const zh: typeof en = {
  liabilities: {
    eyebrow: "負債",
    title: "負債帳戶",
    sideLabel: "負債",
    searchPlaceholder: "搜尋負債",
    metricsAria: "負債指標",
    balanceHistoryAria: "負債餘額歷史",
    debtBalance: "負債餘額",
    debtBalanceCurrency: "負債餘額幣別",
    debtExposure: "負債曝險",
    sideSub: (accounts, currencies) =>
      `${accounts} 個負債帳戶 / ${currencies} 種幣別`,
    total: (accounts) => `總負債 · ${accounts} 個負債帳戶`,
    dueIn: (days) => (days === 0 ? "今天到期" : `${days} 天後`),
    cardInUse: "目前已用 · 估算",
    utilization: "信用卡使用率",
    mortgageRepaid: "房貸已還",
    mortgageOriginalMissing: "部分房貸未提供原始金額",
    marginExposure: "投資融資曝險",
    empty: {
      bannerTitle: "還沒有任何負債帳戶",
      bannerBody:
        "連結信用卡或貸款後，這裡會列出應繳金額、到期日與負債走勢。如果你沒有信用卡或貸款，這一頁會一直保持空白。",
      totalLabel: "總負債",
      totalNote: "尚未匯入負債資料",
      side: "尚無負債帳戶",
      paymentsTitle: "尚無應繳款項",
      paymentsBody: "連結後會依到期日列出信用卡帳單與貸款扣款",
      chartTitle: "還沒有負債走勢",
      chartBody: "匯入信用卡或貸款資料後，這裡會顯示每天的負債餘額變化。",
      listTitle: "目前沒有負債帳戶",
      listBody: "設定信用卡或貸款的登入資料並完成同步後，帳戶會列在這裡。",
    },
  },
};

export type LiabilitiesCopy = typeof en;

/** The Liabilities page's copy. */
export const liabilitiesCopy = { en, "zh-TW": zh } satisfies Record<Locale, LiabilitiesCopy>;
