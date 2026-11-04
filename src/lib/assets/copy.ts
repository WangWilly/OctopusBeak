import type { Locale } from "../i18n/locale.ts";

const en = {
  assets: {
    eyebrow: "Assets",
    title: "Asset accounts",
    sideLabel: "Asset value",
    searchPlaceholder: "Search asset accounts",
    metricsAria: "Asset metrics",
    balanceHistoryAria: "Asset balance history",
    assetBalance: "Asset balance",
    assetBalanceCurrency: "Asset balance currency",
    sideSub: (accounts: number, currencies: number) =>
      `${accounts} accounts / ${currencies} currencies`,
    total: "Total assets",
    empty: {
      bannerTitle: "No asset accounts yet",
      bannerBody:
        "Add sign-in details for a bank, brokerage, or crypto exchange and finish the first sync to see total assets, allocation, and each account's balance here.",
      totalNote: "No asset data imported yet",
      side: "No asset accounts yet",
      chartTitle: "No asset trend yet",
      chartBody: "After the first sync, asset balances by category will show here over time.",
      listTitle: "No asset accounts",
      listBody: "Once a bank, brokerage, or exchange is connected, each account's balance and share are listed here.",
    },
  },
};

const zh: typeof en = {
  assets: {
    eyebrow: "資產",
    title: "資產帳戶",
    sideLabel: "資產價值",
    searchPlaceholder: "搜尋資產帳戶",
    metricsAria: "資產指標",
    balanceHistoryAria: "資產餘額歷史",
    assetBalance: "資產餘額",
    assetBalanceCurrency: "資產餘額幣別",
    sideSub: (accounts, currencies) =>
      `${accounts} 個帳戶 / ${currencies} 種幣別`,
    total: "資產總額",
    empty: {
      bannerTitle: "還沒有任何資產帳戶",
      bannerBody:
        "設定銀行、券商或加密貨幣交易所的登入資料並完成第一次同步，這裡就會顯示資產總額、配置與每個帳戶的餘額。",
      totalNote: "尚未匯入資產資料",
      side: "尚無資產帳戶",
      chartTitle: "還沒有資產走勢",
      chartBody: "完成第一次同步後，這裡會依類別顯示資產餘額的變化。",
      listTitle: "目前沒有資產帳戶",
      listBody: "連結銀行、券商或交易所後，每個帳戶的餘額與佔比會列在這裡。",
    },
  },
};

export type AssetsCopy = typeof en;

/** The Assets page's copy. */
export const assetsCopy = { en, "zh-TW": zh } satisfies Record<Locale, AssetsCopy>;
