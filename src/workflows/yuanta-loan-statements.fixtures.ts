/**
 * Sanitized provider-shape fixtures for Yuanta's statement pager. These keep
 * the observed client-side page action versioned without retaining account,
 * amount, or response data from a live session.
 */
export const YUANTA_LOAN_PAGINATION_FIXTURES_V1 = Object.freeze({
  activePage: `<div class="pagination"><span>第 1 頁</span><a class="pager" href="javascript:goPage(2)">下一頁</a></div>`,
  terminalPage: `<div class="pagination"><span>第 2 頁</span><a class="pager disabled" aria-disabled="true">下一頁</a></div>`,
  ambiguousTable: `<table class="normalTable"><tr><td>交易日</td></tr></table>`,
} as const);
