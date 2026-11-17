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
