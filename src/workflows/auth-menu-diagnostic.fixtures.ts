import type { AuthMenuAnchorSnapshot } from "./auth-menu-diagnostic.ts";

export const FUBON_AUTH_MENU_DIAGNOSTIC_FIXTURE = [
  {
    label: "貸款交易明細查詢",
    href: "/B2C/lnq/lnq001/LoanTransaction.faces?type=page",
    frameName: "frame1",
  },
  {
    label: "自動扣繳設定",
    action: "autodebit-menu",
    task: "autodebit-task",
    menu: "loan-menu",
    frameName: "frame1",
  },
] satisfies readonly AuthMenuAnchorSnapshot[];
export const YUANTA_AUTH_MENU_DIAGNOSTIC_FIXTURE = [
  {
    label: "貸款繳款明細查詢",
    onclick: "doAction('/nib/tx/loantransactiondetails', 'loan-route')",
    id: "menu_loan",
    frameName: "fmenu",
  },
  {
    label: "自動扣繳服務",
    action: "autodebit-menu",
    frameName: "fmenu",
  },
] satisfies readonly AuthMenuAnchorSnapshot[];
