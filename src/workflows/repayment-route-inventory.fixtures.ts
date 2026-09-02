import type { RepaymentRouteAnchorSnapshot } from "./repayment-route-inventory.ts";

/**
 * Sanitized shapes observed at the authenticated menu boundary. These are
 * route labels and inert route metadata only; no live account, CID, or
 * credential values belong in a fixture.
 */
export const FUBON_POST_AUTH_MENU_FIXTURE = [
  {
    label: "我的存款",
    href: "/B2C/cdsqu/cdsqu001/CDSQU001_Home.faces",
  },
  {
    label: "貸款交易明細查詢",
    href: "/B2C/lnq/lnq001/LoanTransaction.faces",
  },
  {
    label: "自動扣繳設定",
    href: "/B2C/autodebit/settings.faces",
  },
  {
    label: "聯絡客服",
    href: "/B2C/service/contact.faces",
  },
] satisfies readonly RepaymentRouteAnchorSnapshot[];

export const YUANTA_POST_AUTH_MENU_FIXTURE = [
  {
    label: "臺幣交易明細查詢",
    href: "/nib/tx/transactiondetails?type=page",
  },
  {
    label: "貸款繳款明細查詢",
    onclick: "doAction('/nib/tx/loantransactiondetails', 'loan-route')",
  },
  {
    label: "自動扣繳服務",
    action: "autodebit-menu",
  },
  {
    label: "基金交易明細",
    href: "/nib/tx/fundtransactiondetails",
  },
] satisfies readonly RepaymentRouteAnchorSnapshot[];

/**
 * The Yuanta shell places these links in the authenticated `fmenu` frame.
 * Keep unrelated and hidden entries here so frame traversal cannot pass only
 * because every fixture anchor happens to be a candidate.
 */
export const YUANTA_FMENU_MENU_FIXTURE = [
  {
    label: "帳務總覽",
    href: "/nib/home",
  },
  {
    label: "貸款繳款明細查詢",
    onclick: "doAction('/nib/tx/loantransactiondetails', 'loan-route')",
  },
  {
    label: "自動扣繳服務",
    action: "autodebit-menu",
  },
  {
    label: "隱藏貸款明細",
    href: "/nib/tx/loantransactiondetails",
    visible: false,
  },
] satisfies readonly RepaymentRouteAnchorSnapshot[];
