// Synthetic Fubon pages for the attached foreign-currency checks. Every number is made up.
export const FUBON_FX_NOW = "2026-10-15T02:00:00.000Z";
export const FUBON_FX_DATE = "Thu, 15 Oct 2026 01:59:00 GMT";
export const FUBON_BALANCE_PATH = "/B2C/cboqu/cboqu003/CBOQU003_Home.faces";
export const FUBON_QUERY_PATH = "/B2C/cdsqu/cdsqu001/CDSQU001_Home.faces";

export const TWD_NO = "00123456789012";
export const USD_NO = "00987654321098";
const FIXED_NO = "00555555555555";

export type BalanceRow = readonly [string, string, string, string, string, string, string];

/** 帳號, 帳戶暱稱, 存款類別, 分行, 幣別, 即時餘額, 可用餘額 */
export const BALANCE_ROWS: readonly BalanceRow[] = [
  [TWD_NO, "主要", "活儲存款", "012", "臺幣", "5,000", "5,000"],
  [USD_NO, "美金", "外幣活存", "012", "美金", "1,300.00", "1,250.00"],
  [FIXED_NO, "定存", "外幣定存", "012", "USD", "3,000.00", "0"],
];

export type QueryOption = Readonly<{ value: string; label: string }>;

export const QUERY_OPTIONS: readonly QueryOption[] = [
  { value: `012-00${TWD_NO}-TWD-01`, label: `${TWD_NO} (台北分行)` },
  { value: `012-00${USD_NO}-USD-01`, label: `${USD_NO} (台北分行)` },
];

export const STATEMENT_HEADERS = ["帳務日期", "交易時間", "摘要", "支出金額", "存入金額", "即時餘額", "附註"] as const;

export const USD_ROWS: readonly (readonly string[])[] = [
  ["2026/10/02", "09:10:11", "國外匯入", "", "1,000.00", "1,500.00", ""],
  ["2026/10/05", "10:00:00", "換匯", "200.00", "", "1,300.00", "備註"],
];

const nav = `<a href="javascript:void(0)">存款交易查詢</a> <a href="${FUBON_BALANCE_PATH}">我的存款</a>`;

export function homePage(): string {
  return `<p>首頁</p>${nav}`;
}

export function balancePage(rows: readonly BalanceRow[] = BALANCE_ROWS): string {
  const headers = ["帳號", "帳戶暱稱", "存款類別", "分行", "幣別", "即時餘額", "可用餘額", "存單號碼", "到期日", "功能"];
  const body = rows.map((cells) => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}<td></td><td></td>
    <td><a class="input_sel fastFunctionLinks" href="javascript:void(0)">快速功能</a>
      <a class="btn_sel" href="javascript:void(0)" onclick="location.href='${FUBON_QUERY_PATH}'">交易明細查詢</a></td>
    <td class="hide">x</td><td class="hide">y</td></tr>`).join("");
  return `${nav}<table id="form1:resultGrid_DataGridBody" class="tb_bkBody m10">
    <tr>${headers.map((header) => `<th>${header}</th>`).join("")}</tr>${body}</table>`;
}

export function resultGrid(rows: readonly (readonly string[])[], headers: readonly string[] = STATEMENT_HEADERS): string {
  return `<input name="resultGrid:dataGridCurrentPage" value="1"><input name="resultGrid:dataGridCurrentPageSize" value="48">
    <table id="resultGrid" class="tb1 queryResult"><tr>${headers.map((header) => `<th>${header}</th>`).join("")}</tr>
    ${rows.map((cells) => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</table>`;
}

export function queryPage(options: readonly QueryOption[], selected: string, result: string): string {
  return `<script>function setupComboBox() {} var comboAccountItems = [];</script>
    <form id="form1" method="post" action="${FUBON_QUERY_PATH}">
      <select id="form1:comboAccount" name="form1:comboAccount">
        <option value="none">請選擇帳戶</option>
        ${options.map((option) => `<option value="${option.value}"${option.value === selected ? " selected" : ""}>${option.label}</option>`).join("")}
      </select>
      <input type="radio" id="form1:rdoDay180" name="form1:rdoGroup3" value="180">
      <input type="radio" id="form1:rdoDay180_365" name="form1:rdoGroup3" value="180_365">
      <input id="form1:startDate" name="form1:startDate" value="">
      <input id="form1:endDate" name="form1:endDate" value="">
      <a id="form1:doValidateAndSubmit" href="javascript:void(0)">查詢</a>
      ${result}
    </form>
    <script>
      setupComboBox("form1:comboAccount", "", "${selected}");
      ${options.map((option, index) => `comboAccountItems[${index}] = new Array("${option.label}", "${option.value}");`).join("\n")}
    </script>`;
}
