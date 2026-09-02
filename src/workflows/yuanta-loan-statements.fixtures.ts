/**
 * Sanitized provider-shape fixtures for Yuanta's statement pager. These keep
 * the observed client-side page action versioned without retaining account,
 * amount, or response data from a live session.
 */
export const YUANTA_LOAN_PAGINATION_FIXTURES_V1 = Object.freeze({
  activePage: `<div id="resultdiv"><input name="currentPage" value="1"><div class="pagination"><span>第 1 頁</span><a class="pager" aria-disabled="false" href="javascript:goPage(2)">下一頁</a></div></div>`,
  activePageWithoutExplicitAriaState: `<div id="resultdiv"><input name="currentPage" value="1"><div class="pagination"><span>第 1 頁</span><a class="pager" href="javascript:goPage(2)">下一頁</a></div></div>`,
  terminalPage: `<div id="resultdiv"><input name="currentPage" value="2"><div class="pagination"><span>第 2 頁</span><a class="pager disabled" aria-disabled="true">下一頁</a></div></div>`,
  unrelatedPagerOnly: `<nav class="pagination"><a class="disabled" aria-disabled="true">下一頁</a></nav><table class="normalTable"><tr><td>交易日</td></tr></table>`,
  unrelatedPagerOutsideResult: `<nav class="pagination"><a class="disabled" aria-disabled="true">下一頁</a></nav><div id="resultdiv"><input name="currentPage" value="1"><table class="normalTable"><tr><td>交易日</td></tr></table></div>`,
  ambiguousTable: `<table class="normalTable"><tr><td>交易日</td></tr></table>`,
} as const);

const yuantaProviderTerminalRowsV2 =
  `<tr><td>sanitized-row</td><td>sanitized</td><td>sanitized</td><td>sanitized</td><td>sanitized</td><td>sanitized</td></tr>`;

/**
 * Live-verified Yuanta loan terminal shape (v2): the result context contains
 * one six-column `normalTable` with data rows, while the provider renders no
 * pager, page-size, current-page, or next controls. The empty-table fixture
 * proves that a result context alone is still ambiguous.
 */
export const YUANTA_LOAN_PAGINATION_FIXTURES_V2 = Object.freeze({
  providerResultTerminalWithoutPager: `<div id="resultdiv"><table class="normalTable"><thead><tr><th>交易日期</th><th>交易內容</th><th>異動金額</th><th>利率</th><th>計息起日</th><th>計息止日</th></tr></thead><tbody>${yuantaProviderTerminalRowsV2}</tbody></table></div>`,
  providerResultWithoutRows: `<div id="resultdiv"><table class="normalTable"><thead><tr><th>交易日期</th><th>交易內容</th><th>異動金額</th><th>利率</th><th>計息起日</th><th>計息止日</th></tr></thead><tbody></tbody></table></div>`,
  providerResultWrongHeaderShape: `<div id="resultdiv"><table class="normalTable"><thead><tr><th>交易日期</th><th>交易內容</th><th>異動金額</th><th>利率</th><th>計息起日</th></tr></thead><tbody>${yuantaProviderTerminalRowsV2}</tbody></table></div>`,
} as const);
