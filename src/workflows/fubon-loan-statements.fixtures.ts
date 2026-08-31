/**
 * Sanitized provider-shape fixtures for Fubon's statement pager. These keep
 * the observed JS postback contract versioned without retaining account,
 * amount, or response data from a live session.
 */
export const FUBON_LOAN_PAGINATION_FIXTURES_V1 = Object.freeze({
  activePage: `<input name="resultGrid:dataGridCurrentPage" value="1"><span class="pager">第 1 頁</span><a onclick="setDataGridCurrentPage('resultGrid:dataGridCurrentPage', 2, 'resultGrid:dataGridCurrentPage')">下一頁</a>`,
  terminalPage: `<input name="resultGrid:dataGridCurrentPage" value="2"><span class="pager">第 2 頁</span><a class="disabled" aria-disabled="true">下一頁</a>`,
  ambiguousTable: `<table><tr><td>交易日期</td></tr></table>`,
} as const);
