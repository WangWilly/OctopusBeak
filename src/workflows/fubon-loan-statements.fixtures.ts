/**
 * Sanitized provider-shape fixtures for Fubon's statement pager. These keep
 * the observed JS postback contract versioned without retaining account,
 * amount, or response data from a live session.
 */
export const FUBON_LOAN_PAGINATION_FIXTURES_V1 = Object.freeze({
  activePage: `<form id="form1"><input name="form1:opaque_DataGrid:dataGridCurrentPage" value="1"><input name="form1:opaque_DataGrid:dataGridCurrentPageSize" value="1"><table id="form1:opaque_DataGrid_DataGridBody"><tr><td>交易日期</td><td>交易內容</td><td>異動金額</td><td>利率</td><td>計息起日</td><td>計息止日</td><td>餘額</td><td>備註</td></tr><tr><td>sanitized</td></tr></table><a aria-disabled="false" onclick="setDataGridCurrentPage('opaque', 2, 'form1:opaque_DataGrid:dataGridCurrentPage')">下一頁</a></form>`,
  activePageWithoutExplicitAriaState: `<form id="form1"><input name="form1:opaque_DataGrid:dataGridCurrentPage" value="1"><input name="form1:opaque_DataGrid:dataGridCurrentPageSize" value="1"><table id="form1:opaque_DataGrid_DataGridBody"><tr><td>交易日期</td><td>交易內容</td><td>異動金額</td><td>利率</td><td>計息起日</td><td>計息止日</td><td>餘額</td><td>備註</td></tr><tr><td>sanitized</td></tr></table><a onclick="setDataGridCurrentPage('opaque', 2, 'form1:opaque_DataGrid:dataGridCurrentPage')">下一頁</a></form>`,
  terminalPage: `<form id="form1"><input name="form1:opaque_DataGrid:dataGridCurrentPage" value="1"><select name="form1:opaque_DataGrid:dataGridCurrentPageSize"><option value="12">12</option><option value="48" selected>48</option></select><table id="form1:opaque_dynamic_result" class="tb1 queryResult"><tbody><tr><td>交易日期</td><td>交易內容</td><td>異動金額</td><td>利率</td><td>計息起日</td><td>計息止日</td><td>餘額</td><td>備註</td></tr><tr><td>sanitized</td></tr></tbody></table></form>`,
  unrelatedPagerOnly: `<nav class="pager"><a class="disabled" aria-disabled="true">下一頁</a></nav><table><tr><td>交易日期</td></tr></table>`,
  unrelatedPagerOutsideResult: `<nav class="pager"><a class="disabled" aria-disabled="true">下一頁</a></nav><form id="form1"><input name="form1:opaque_DataGrid:dataGridCurrentPage" value="1"><table id="form1:opaque_DataGrid_DataGridBody"><tr><td>不是交易日期</td><td>交易內容</td><td>異動金額</td><td>利率</td><td>計息起日</td><td>計息止日</td><td>餘額</td><td>備註</td></tr></table></form>`,
  ambiguousTable: `<table><tr><td>交易日期</td></tr></table>`,
} as const);

const fubonProviderTerminalRowsV2 = Array.from(
  { length: 12 },
  (_, index) =>
    `<tr><td>sanitized-row-${index + 1}</td><td>sanitized</td><td>sanitized</td><td>sanitized</td><td>sanitized</td><td>sanitized</td><td>sanitized</td><td>sanitized</td></tr>`,
).join("");

/**
 * Live-verified Fubon loan terminal shape (v2): the provider query-result
 * table contains rows and a current-page field rendered outside the result
 * form, while page-size, pager, and next-page controls are absent. No source
 * statement values are retained.
 */
export const FUBON_LOAN_PAGINATION_FIXTURES_V2 = Object.freeze({
  providerResultTerminalWithoutPager: `<input name="resultGrid:dataGridCurrentPage" value="1"><form id="form1"><table id="resultGrid" class="tb1 queryResult"><tbody><tr><td>交易日期</td><td>交易內容</td><td>異動金額</td><td>利率</td><td>計息起日</td><td>計息止日</td><td>餘額</td><td>備註</td></tr>${fubonProviderTerminalRowsV2}</tbody></table></form>`,
  providerResultWithoutRows: `<input name="resultGrid:dataGridCurrentPage" value="1"><form id="form1"><table id="resultGrid" class="tb1 queryResult"><tbody><tr><td>交易日期</td><td>交易內容</td><td>異動金額</td><td>利率</td><td>計息起日</td><td>計息止日</td><td>餘額</td><td>備註</td></tr></tbody></table></form>`,
  providerResultWithoutCurrentPageField: `<form id="form1"><table id="resultGrid_DataGridBody" class="tb1 queryResult"><tbody><tr><td>交易日期</td><td>交易內容</td><td>異動金額</td><td>利率</td><td>計息起日</td><td>計息止日</td><td>餘額</td><td>備註</td></tr>${fubonProviderTerminalRowsV2}</tbody></table></form>`,
  unrelatedTable: `<input name="unrelated:dataGridCurrentPage" value="1"><form id="form1"><table id="unrelated" class="unrelated-result"><tbody><tr><td>其他資料</td><td>欄位二</td><td>欄位三</td><td>欄位四</td><td>欄位五</td><td>欄位六</td><td>欄位七</td><td>欄位八</td></tr>${fubonProviderTerminalRowsV2}</tbody></table></form>`,
  providerResultWithActiveNext: `<input name="resultGrid:dataGridCurrentPage" value="1"><form id="form1"><table id="resultGrid" class="tb1 queryResult"><tbody><tr><td>交易日期</td><td>交易內容</td><td>異動金額</td><td>利率</td><td>計息起日</td><td>計息止日</td><td>餘額</td><td>備註</td></tr>${fubonProviderTerminalRowsV2}</tbody></table><a onclick="setDataGridCurrentPage('opaque', 2, 'resultGrid:dataGridCurrentPage')">下一頁</a></form>`,
} as const);
