import { classifyPeriod } from "./classify-inbox.ts";

/** Where another page sends a person to open the classification inbox. */
export const CLASSIFY_INBOX_HREF = "#/spending/classify";

/**
 * Whether the Spending page still owes the person an open inbox after a
 * route change. The app rewrites the link's hash to `#/spending` as it
 * arrives, so a later read of the same arrival keeps the request it already
 * holds, and leaving the Spending route drops it.
 */
export function classifyInboxRequested(pending: boolean, route: string, hash: string): boolean {
  if (route !== "spending") return false;
  return pending || hash === CLASSIFY_INBOX_HREF;
}

/**
 * Whether a period of inclusive dates shares a day with the inbox's window,
 * so a link from it opens an inbox that can hold its purchases.
 */
export function overlapsClassifyWindow(range: Readonly<{ startDate: string; endDate: string }>, today: string): boolean {
  const window = classifyPeriod(today);
  return range.startDate <= window.endDate && range.endDate >= window.startDate;
}
