import {
  accountKindLabel,
  addCurrencyAmount,
  mergeCurrencyBuckets,
  stableId,
} from "./financial-dashboard-model.ts";
import type {
  AssetPosition,
  CurrencyBucket,
  DailyAccountChange,
  DashboardAccount,
  FinancialModel,
  NormalizedTransaction,
} from "./financial-dashboard-types.ts";

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function money(value: number, currency: string): string {
  return `${currency} ${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2,
  }).format(value)}`;
}

function currencyBucketText(bucket: CurrencyBucket | undefined): string {
  const entries = Object.entries(bucket ?? {})
    .filter(([, value]) => Number.isFinite(value))
    .sort(([left], [right]) => {
      const order = ["TWD", "USD", "JPY", "UNKNOWN"];
      const leftIndex = order.indexOf(left);
      const rightIndex = order.indexOf(right);
      if (leftIndex !== -1 || rightIndex !== -1) {
        return (leftIndex === -1 ? 999 : leftIndex) - (rightIndex === -1 ? 999 : rightIndex);
      }
      return left.localeCompare(right);
    });

  if (entries.length === 0) return "-";
  return entries.map(([currency, value]) => money(value, currency)).join(" / ");
}

function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}


type OctopusBeakGroup = "asset" | "liability" | "investment";

type OctopusBeakAccount = {
  id: string;
  label: string;
  institution: string;
  kind: DashboardAccount["kind"];
  kindLabel: string;
  group: OctopusBeakGroup;
  source: string;
  amounts: CurrencyBucket;
  positionIds: string[];
  transactionIds: string[];
};

const dashboardCurrencyOrder = ["TWD", "USD", "JPY", "UNKNOWN"];

function sortCurrencyCode(left: string, right: string): number {
  const leftIndex = dashboardCurrencyOrder.indexOf(left);
  const rightIndex = dashboardCurrencyOrder.indexOf(right);
  if (leftIndex !== -1 || rightIndex !== -1) {
    return (leftIndex === -1 ? 999 : leftIndex) - (rightIndex === -1 ? 999 : rightIndex);
  }
  return left.localeCompare(right);
}

function scaledCurrencyBucket(bucket: CurrencyBucket | undefined, scale: number): CurrencyBucket {
  const scaled: CurrencyBucket = {};
  for (const [currency, value] of Object.entries(bucket ?? {})) {
    if (Number.isFinite(value)) scaled[currency] = value * scale;
  }
  return scaled;
}

function hasCurrencyAmounts(bucket: CurrencyBucket | undefined): boolean {
  return Object.values(bucket ?? {}).some((value) => Number.isFinite(value));
}

function formatDashboardMoney(value: number, currency: string): string {
  const normalized = Object.is(value, -0) ? 0 : value;
  const digits = currency === "TWD" || currency === "JPY" ? 0 : 2;
  const formatted = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(Math.abs(normalized));
  return `${normalized < 0 ? "-" : ""}${currency} ${formatted}`;
}

function currencyBucketLines(bucket: CurrencyBucket | undefined): string[] {
  const entries = Object.entries(bucket ?? {})
    .filter(([, value]) => Number.isFinite(value))
    .sort(([left], [right]) => sortCurrencyCode(left, right));
  if (entries.length === 0) return ["-"];
  return entries.map(([currency, value]) => formatDashboardMoney(value, currency));
}

function currencyBucketSign(bucket: CurrencyBucket | undefined): "positive" | "negative" | "neutral" {
  const firstValue = Object.entries(bucket ?? {})
    .filter(([, value]) => Number.isFinite(value) && value !== 0)
    .sort(([left], [right]) => sortCurrencyCode(left, right))[0]?.[1];
  if (firstValue === undefined) return "neutral";
  return firstValue < 0 ? "negative" : "positive";
}

function latestDashboardDate(model: FinancialModel): string {
  const dates = [
    ...model.assetPositions.map((position) => position.asOfDate),
    ...model.normalizedTransactions.map((transaction) => transaction.date),
    model.generatedAt.slice(0, 10),
  ].filter((value): value is string => Boolean(value));
  return dates.sort().at(-1) ?? model.generatedAt.slice(0, 10);
}

function dailyAccountChangeSummary(changes: DailyAccountChange[]): string {
  const changed = changes
    .filter((change) => Math.abs(change.change) > 0.000001)
    .sort((left, right) => Math.abs(right.change) - Math.abs(left.change))
    .slice(0, 4);
  if (changed.length === 0) return "No account changes";
  return changed
    .map(
      (change) =>
        `${change.institution} ${change.label} ${money(
          change.change,
          change.currency,
        )}`,
    )
    .join("\n");
}

function octopusBeakGroup(account: DashboardAccount): OctopusBeakGroup {
  if (account.kind === "credit_card" || account.kind === "loan") return "liability";
  if (account.kind === "fund" || account.kind === "brokerage") return "investment";
  return "asset";
}

function accountSourceLabel(
  account: DashboardAccount,
  positionsById: Map<string, AssetPosition>,
  transactionsById: Map<string, NormalizedTransaction>,
): string {
  const source =
    account.positionIds.map((id) => positionsById.get(id)?.sourceRelativePath).find(Boolean) ??
    account.transactionIds.map((id) => transactionsById.get(id)?.sourceRelativePath).find(Boolean);
  if (!source) return account.product;
  const [folder] = source.split("/");
  return folder || source;
}

function signedAccountAmounts(
  account: DashboardAccount,
  positionsById: Map<string, AssetPosition>,
): CurrencyBucket {
  const bucket: CurrencyBucket = {};
  for (const id of account.positionIds) {
    const position = positionsById.get(id);
    if (!position || !position.includeInTotals || position.valueSign === "informational") continue;
    const sign = position.valueSign === "liability" ? -1 : 1;
    addCurrencyAmount(bucket, position.currency, position.value * sign);
  }
  if (hasCurrencyAmounts(bucket)) return bucket;

  const fallbackMetric = account.metrics.find((item) => hasCurrencyAmounts(item.amounts));
  const fallbackScale = octopusBeakGroup(account) === "liability" ? -1 : 1;
  return scaledCurrencyBucket(fallbackMetric?.amounts, fallbackScale);
}

function buildOctopusBeakAccounts(model: FinancialModel): OctopusBeakAccount[] {
  const positionsById = new Map(model.assetPositions.map((position) => [position.id, position]));
  const transactionsById = new Map(
    model.normalizedTransactions.map((transaction) => [transaction.id, transaction]),
  );
  return model.dashboard.institutions.flatMap((institution) =>
    institution.groups.flatMap((group) =>
      group.accounts.map((account) => ({
        id: account.id,
        label: account.label,
        institution: institution.label,
        kind: account.kind,
        kindLabel: accountKindLabel(account.kind),
        group: octopusBeakGroup(account),
        source: accountSourceLabel(account, positionsById, transactionsById),
        amounts: signedAccountAmounts(account, positionsById),
        positionIds: account.positionIds,
        transactionIds: account.transactionIds,
      })),
    ),
  );
}

function renderSummaryMetric(input: {
  label: string;
  amounts: CurrencyBucket;
  primary?: boolean;
  breakdown: string[];
}): string {
  const [primaryLine, ...secondaryLines] = currencyBucketLines(input.amounts);
  return `
        <div class="metric${input.primary ? " primary" : ""}">
          <span class="metric-label">${escapeHtml(input.label)}</span>
          <div class="metric-value">
            <strong><span data-sensitive>${escapeHtml(primaryLine)}</span></strong>
            ${secondaryLines.length > 0 ? `<small data-sensitive>${escapeHtml(secondaryLines.join(" / "))}</small>` : ""}
          </div>
          ${
            input.breakdown.length > 0
              ? `<div class="metric-breakdown">${input.breakdown
                  .map((item) => `<span>${escapeHtml(item)}</span>`)
                  .join("")}</div>`
              : ""
          }
        </div>`;
}

function renderOctopusBeakStyles(includeSources = false): string {
  return `
    :root {
      color-scheme: light;
      --bg: #ffffff;
      --surface: #f7f7f7;
      --surface-warm: #eeeeee;
      --fg: #111111;
      --fg-2: #3a3a3a;
      --muted: #707070;
      --border: #d9d9d9;
      --border-soft: #eeeeee;
      --accent: #111111;
      --accent-on: #ffffff;
      --success: #168a46;
      --warn: #b7791f;
      --danger: #c53030;
      --font-display: Inter, system-ui, sans-serif;
      --font-body: Inter, system-ui, sans-serif;
      --font-mono: "SF Mono", ui-monospace, Menlo, monospace;
      --text-xs: 12px;
      --text-sm: 14px;
      --text-base: 16px;
      --text-lg: 18px;
      --text-xl: 24px;
      --text-2xl: 36px;
      --text-3xl: 54px;
      --leading-body: 1.52;
      --leading-tight: 1.06;
      --space-1: 4px;
      --space-2: 8px;
      --space-3: 12px;
      --space-4: 16px;
      --space-5: 20px;
      --space-6: 24px;
      --space-8: 32px;
      --space-12: 48px;
      --radius-sm: 4px;
      --radius-md: 8px;
      --radius-lg: 12px;
      --radius-pill: 9999px;
      --elev-ring: 0 0 0 1px var(--border);
      --elev-raised: 0 16px 40px rgba(0, 0, 0, 0.10);
      --focus-ring: 0 0 0 3px rgba(17, 17, 17, 0.18);
      --motion-fast: 150ms;
      --ease-standard: cubic-bezier(0.2, 0, 0, 1);
      --container-gutter-desktop: 36px;
      --container-gutter-phone: 16px;
    }
    * { box-sizing: border-box; }
    html { min-width: 0; background: var(--bg); }
    body {
      min-width: 0;
      margin: 0;
      color: var(--fg);
      background: var(--bg);
      font: var(--text-base)/var(--leading-body) var(--font-body);
      -webkit-font-smoothing: antialiased;
      text-rendering: optimizeLegibility;
    }
    body.modal-open { overflow: hidden; }
    button, input, select { font: inherit; }
    button { cursor: pointer; }
    svg { display: block; stroke-width: 1.8; }
    h1 {
      max-width: 760px;
      margin: var(--space-1) 0 0;
      font: 650 clamp(38px, 5.2vw, var(--text-3xl))/var(--leading-tight) var(--font-display);
      letter-spacing: 0;
      text-wrap: balance;
    }
    .app {
      min-width: 0;
      min-height: 100vh;
      display: grid;
      grid-template-columns: minmax(0, 1fr);
    }
    .main {
      min-width: 0;
      padding: var(--space-6) clamp(var(--container-gutter-phone), 4vw, var(--container-gutter-desktop)) var(--space-12);
      display: grid;
      gap: var(--space-5);
    }
    .topbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: var(--space-4);
    }
    .actions {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: var(--space-3);
      flex-wrap: wrap;
    }
    .visibility-toggle {
      min-height: 42px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 0 var(--space-4);
      background: var(--surface);
      color: var(--fg);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: var(--space-2);
      font-weight: 560;
      letter-spacing: 0.02em;
      cursor: pointer;
      user-select: none;
      transition: background var(--motion-fast) var(--ease-standard), color var(--motion-fast) var(--ease-standard), transform var(--motion-fast) var(--ease-standard), box-shadow var(--motion-fast) var(--ease-standard);
    }
    .visibility-toggle:hover {
      background: var(--accent);
      color: var(--accent-on);
      transform: translateY(-1px);
      box-shadow: var(--elev-ring);
    }
    .visibility-toggle input {
      width: 16px;
      height: 16px;
      accent-color: var(--accent);
    }
    .visibility-toggle:has(input:focus-visible) {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    html[data-values-visible="false"] [data-sensitive] {
      color: var(--muted);
      filter: blur(10px);
      opacity: 0.64;
      user-select: none;
    }
    .label, .eyebrow, .table th, .chip, .metric-label {
      color: var(--muted);
      font-size: var(--text-xs);
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .btn, .segment button {
      min-height: 40px;
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      background: transparent;
      color: var(--fg-2);
      font-weight: 560;
      letter-spacing: 0.02em;
      transition: background var(--motion-fast) var(--ease-standard), color var(--motion-fast) var(--ease-standard), transform var(--motion-fast) var(--ease-standard), box-shadow var(--motion-fast) var(--ease-standard);
    }
    .btn {
      min-height: 42px;
      padding: 0 var(--space-4);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: var(--space-2);
      background: var(--surface);
      border-color: var(--border);
      color: var(--fg);
      text-decoration: none;
    }
    .btn:hover, .segment button:hover {
      background: var(--accent);
      color: var(--accent-on);
      transform: translateY(-1px);
      box-shadow: var(--elev-ring);
    }
    .btn:focus-visible, .segment button:focus-visible, .account-main:focus-visible, .tx-chip:focus-visible, .asset-chip:focus-visible, input:focus-visible, select:focus-visible, .sort-button:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    .summary-strip {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: var(--space-3);
      align-items: stretch;
    }
    .metric {
      min-width: 0;
      min-height: 142px;
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      background: var(--surface);
      box-shadow: var(--elev-ring);
      padding: var(--space-4);
      display: grid;
      align-content: space-between;
      gap: var(--space-2);
    }
    .metric.primary { border-color: var(--fg); }
    .metric-value { display: grid; gap: 2px; }
    .metric strong {
      display: block;
      font: 700 clamp(22px, 2.4vw, 32px)/1.05 var(--font-display);
      font-variant-numeric: tabular-nums;
      overflow-wrap: anywhere;
    }
    .metric-value small {
      color: var(--fg-2);
      font: 650 var(--text-sm)/1.2 var(--font-mono);
      letter-spacing: 0.01em;
    }
    .metric-breakdown {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      margin-top: var(--space-1);
    }
    .metric-breakdown span, .chip {
      min-height: 22px;
      padding: 3px 7px;
      border: 1px solid var(--border);
      border-radius: var(--radius-pill);
      background: var(--bg);
      color: var(--fg-2);
      line-height: 1.2;
      white-space: nowrap;
    }
    .workbench {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: var(--space-5);
      align-items: start;
    }
    .panel {
      min-width: 0;
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      background: var(--surface);
      box-shadow: var(--elev-ring);
      overflow: hidden;
    }
    .panel-head {
      min-height: 64px;
      padding: var(--space-5);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-4);
    }
    .panel-title { display: grid; gap: var(--space-1); }
    .panel-title strong { font: 650 var(--text-xl)/1.08 var(--font-display); }
    .panel-body { padding: var(--space-5); }
    .toolbar { display: grid; gap: var(--space-3); margin-bottom: var(--space-4); }
    .segment {
      display: flex;
      align-items: center;
      gap: var(--space-1);
      padding: var(--space-1);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      background: color-mix(in oklab, var(--surface), var(--surface-warm) 14%);
      overflow: auto;
    }
    .segment button {
      min-height: 34px;
      padding: 0 var(--space-3);
      white-space: nowrap;
      font-size: var(--text-sm);
    }
    .segment button[aria-pressed="true"] {
      background: var(--surface);
      border-color: var(--border);
      color: var(--fg);
      box-shadow: var(--elev-ring);
    }
    .search { position: relative; min-width: 0; }
    .search svg {
      position: absolute;
      left: var(--space-4);
      top: 50%;
      width: 17px;
      height: 17px;
      color: var(--muted);
      transform: translateY(-50%);
      pointer-events: none;
    }
    .search input {
      width: 100%;
      min-height: 44px;
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      background: var(--surface);
      color: var(--fg);
      padding: 0 var(--space-4) 0 44px;
      outline: none;
    }
    .account-list, .source-list { display: grid; gap: var(--space-2); }
    .account-row {
      width: 100%;
      min-width: 0;
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      background: var(--surface);
      color: var(--fg);
      padding: var(--space-4);
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      grid-template-areas: "main amount" "actions amount";
      gap: var(--space-3);
      text-align: left;
      transition: background var(--motion-fast) var(--ease-standard), border-color var(--motion-fast) var(--ease-standard), transform var(--motion-fast) var(--ease-standard);
    }
    .account-row:hover { transform: translateY(-1px); border-color: var(--accent); }
    .account-row[data-selected="true"] {
      border-color: var(--accent);
      background: color-mix(in oklab, var(--surface), var(--surface-warm) 28%);
    }
    .account-row[data-selected="true"] .account-name strong {
      text-decoration: underline;
      text-underline-offset: 4px;
      text-decoration-thickness: 1px;
    }
    .account-main {
      grid-area: main;
      min-width: 0;
      border: 0;
      border-radius: var(--radius-sm);
      background: transparent;
      color: inherit;
      padding: 0;
      text-align: left;
      cursor: pointer;
    }
    .account-name { min-width: 0; display: grid; gap: var(--space-2); }
    .account-name strong {
      overflow-wrap: anywhere;
      font: 650 var(--text-base)/1.18 var(--font-display);
    }
    .account-line, .muted {
      color: var(--muted);
      font-size: var(--text-sm);
    }
    .amount {
      grid-area: amount;
      align-self: start;
      font-family: var(--font-mono);
      font-variant-numeric: tabular-nums;
      white-space: normal;
      text-align: right;
    }
    .amount span { display: block; }
    .positive { color: var(--success); }
    .negative { color: var(--danger); }
    .neutral { color: var(--fg-2); }
    .chip-row {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      flex-wrap: wrap;
    }
    .account-actions { grid-area: actions; }
    .chip {
      display: inline-flex;
      align-items: center;
      font-size: var(--text-xs);
      font-weight: 700;
      text-transform: uppercase;
    }
    .chip.asset { color: var(--success); }
    .chip.liability { color: var(--danger); }
    .chip.investment, .chip.review { color: var(--warn); }
    .chip.ready { color: var(--success); }
    .chip.unsupported, .chip.fail { color: var(--danger); }
    .tx-chip, .asset-chip {
      cursor: pointer;
      font: inherit;
      letter-spacing: inherit;
      text-transform: inherit;
    }
    .tx-chip:hover, .asset-chip:hover {
      border-color: var(--accent);
      color: var(--fg);
      background: color-mix(in oklab, var(--surface), var(--surface-warm) 45%);
    }
    .table-wrap {
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      background: var(--surface);
      overflow: auto;
    }
    .table {
      width: 100%;
      min-width: 760px;
      border-collapse: collapse;
      font-size: var(--text-sm);
    }
    .table th, .table td {
      padding: var(--space-3) var(--space-4);
      border-bottom: 1px solid var(--border-soft);
      text-align: left;
      vertical-align: middle;
    }
    .table th { background: color-mix(in oklab, var(--surface), var(--surface-warm) 16%); }
    .table tbody tr:hover td { background: color-mix(in oklab, var(--surface), var(--surface-warm) 12%); }
    .table tr:last-child td { border-bottom: 0; }
    .table .num {
      text-align: right;
      font-family: var(--font-mono);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .sort-button {
      display: inline-flex;
      align-items: center;
      gap: var(--space-2);
      border: 0;
      background: transparent;
      color: inherit;
      cursor: pointer;
      font: inherit;
      letter-spacing: inherit;
      text-transform: inherit;
      padding: 0;
    }
    .sort-button:hover {
      color: var(--fg);
      text-decoration: underline;
      text-underline-offset: 3px;
    }
    .sort-mark {
      min-width: 1.2em;
      color: var(--muted);
      font-family: var(--font-mono);
      line-height: 1;
    }
    .modal-layer {
      position: fixed;
      inset: 0;
      z-index: 20;
      display: grid;
      place-items: center;
      padding: var(--space-5);
    }
    .modal-layer[hidden] { display: none; }
    .modal-backdrop {
      position: absolute;
      inset: 0;
      background: rgba(17, 17, 17, 0.28);
      backdrop-filter: blur(3px);
    }
    .tx-window {
      position: relative;
      z-index: 1;
      width: min(960px, 100%);
      max-height: min(760px, calc(100vh - 48px));
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      background: var(--bg);
      box-shadow: var(--elev-raised);
      display: grid;
      grid-template-rows: auto auto minmax(0, 1fr);
      overflow: hidden;
    }
    .tx-window.has-tools { grid-template-rows: auto auto auto minmax(0, 1fr); }
    .tx-window-head, .tx-window-meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-3);
      padding: var(--space-5);
      border-bottom: 1px solid var(--border-soft);
    }
    .tx-window-title {
      display: grid;
      gap: var(--space-1);
      min-width: 0;
    }
    .tx-window-title strong {
      font: 700 var(--text-xl)/1.12 var(--font-display);
      letter-spacing: 0;
      overflow-wrap: anywhere;
    }
    .tx-close {
      width: 40px;
      height: 40px;
      flex: 0 0 auto;
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      background: var(--surface);
      color: var(--fg);
      font-size: 24px;
      line-height: 1;
    }
    .tx-close:hover, .tx-close:focus-visible {
      border-color: var(--accent);
      outline: none;
      box-shadow: var(--focus-ring);
    }
    .tx-window-meta {
      justify-content: flex-start;
      flex-wrap: wrap;
      padding-top: var(--space-3);
      padding-bottom: var(--space-3);
    }
    .tx-window .table-wrap {
      border: 0;
      border-radius: 0;
      min-height: 0;
      max-height: 100%;
    }
    .tx-table-tools {
      display: grid;
      grid-template-columns: minmax(220px, 1fr) 180px auto;
      gap: var(--space-3);
      align-items: end;
      padding: var(--space-4) var(--space-5);
      border-bottom: 1px solid var(--border-soft);
      background: color-mix(in oklab, var(--surface), white 18%);
    }
    .tx-filter, .field {
      display: grid;
      gap: var(--space-2);
      color: var(--muted);
      font: 600 var(--text-xs)/1 var(--font-body);
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .tx-filter input, .tx-filter select, .field input, .field select {
      min-height: 40px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: var(--bg);
      color: var(--fg);
      font: 500 var(--text-sm)/1.2 var(--font-body);
      letter-spacing: 0;
      text-transform: none;
      padding: 0 var(--space-3);
      outline: none;
    }
    .tx-filter-count, .result-count {
      justify-self: end;
      padding-bottom: 11px;
      color: var(--muted);
      font: 600 var(--text-xs)/1 var(--font-mono);
      letter-spacing: 0.08em;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .tx-table-empty td {
      color: var(--muted);
      text-align: center;
      padding: var(--space-8);
    }
    .empty {
      border: 1px dashed var(--border);
      border-radius: var(--radius-md);
      padding: var(--space-5);
      color: var(--muted);
      background: color-mix(in oklab, var(--surface), var(--surface-warm) 12%);
    }
    .empty strong {
      display: block;
      margin-bottom: var(--space-1);
      color: var(--fg);
      font: 650 var(--text-base)/1.2 var(--font-display);
    }
    ${
      includeSources
        ? `
    .sources {
      display: grid;
      grid-template-columns: minmax(300px, 0.85fr) minmax(0, 1.15fr);
      gap: var(--space-5);
      align-items: start;
    }
    .panel-tools {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(150px, auto) auto;
      gap: var(--space-3);
      align-items: end;
      margin-bottom: var(--space-4);
    }
    .source-card {
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: var(--space-4);
      background: var(--bg);
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(96px, auto);
      gap: var(--space-3);
      align-items: center;
    }
    .source-card strong {
      display: block;
      overflow-wrap: anywhere;
    }
    .source-card span {
      color: var(--muted);
      font-size: var(--text-sm);
    }
    .source-meta {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      margin-top: var(--space-2);
      align-items: center;
    }
    .progress {
      height: 6px;
      margin-top: var(--space-2);
      border-radius: var(--radius-pill);
      background: var(--surface-warm);
      overflow: hidden;
    }
    .progress span {
      display: block;
      height: 100%;
      border-radius: inherit;
      background: var(--accent);
    }
    .table td {
      color: var(--fg-2);
      font-size: var(--text-sm);
    }
    .table td strong {
      display: block;
      color: var(--fg);
      font-weight: 650;
      overflow-wrap: anywhere;
    }
    .table-meta {
      display: block;
      margin-top: 2px;
      color: var(--muted);
      font-size: var(--text-xs);
    }`
        : ""
    }
    @media (max-width: 820px) {
      .sources { grid-template-columns: 1fr; }
      .panel-tools { grid-template-columns: 1fr; }
      .result-count { justify-self: start; padding-bottom: 0; }
    }
    @media (max-width: 720px) {
      .main { padding: var(--space-4) var(--container-gutter-phone) var(--space-8); }
      .topbar {
        align-items: stretch;
        flex-direction: column;
        display: flex;
      }
      .actions, .btn { width: 100%; }
      .summary-strip {
        grid-template-columns: 1fr;
      }
      .metric { min-height: 128px; }
      .account-row {
        grid-template-columns: 1fr;
        grid-template-areas: "main" "amount" "actions";
      }
      .amount { text-align: left; }
      .modal-layer { padding: var(--space-3); }
      .tx-window { max-height: calc(100vh - 24px); }
      .tx-window-head { align-items: flex-start; }
      .tx-window-head, .tx-window-meta, .tx-table-tools {
        padding-left: var(--space-4);
        padding-right: var(--space-4);
      }
      .tx-table-tools { grid-template-columns: 1fr; }
      .tx-filter-count { justify-self: start; padding-bottom: 0; }
      .table th, .table td { padding: var(--space-3); }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        scroll-behavior: auto !important;
        transition-duration: 0.01ms !important;
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
      }
    }`;
}

export function renderOctopusBeakDashboard(model: FinancialModel): string {
  const accounts = buildOctopusBeakAccounts(model);
  const snapshotDate = latestDashboardDate(model);
  const summaryCounts = {
    all: accounts.length,
    asset: accounts.filter((account) => account.group === "asset").length,
    liability: accounts.filter((account) => account.group === "liability").length,
    investment: accounts.filter((account) => account.group === "investment").length,
  };
  const overview = model.dashboard.overview;
  const overviewHtml = [
    renderSummaryMetric({
      label: "Net position",
      amounts: overview.netAssets,
      primary: true,
      breakdown: [
        `${summaryCounts.all} accounts`,
        `${summaryCounts.asset} asset`,
        `${summaryCounts.liability} liability`,
        `${summaryCounts.investment} investment`,
      ],
    }),
    renderSummaryMetric({
      label: "Asset value",
      amounts: mergeCurrencyBuckets(
        overview.assets.totalTwdAssets,
        overview.assets.totalForeignAssets,
      ),
      breakdown: [
        `${accounts.filter((account) => account.kind === "account").length} bank accounts`,
        `${accounts.filter((account) => account.amounts.USD || account.amounts.JPY).length} foreign deposits`,
      ],
    }),
    renderSummaryMetric({
      label: "Liabilities",
      amounts: scaledCurrencyBucket(
        mergeCurrencyBuckets(
          overview.liabilities.unbilledCreditCardAmount,
          overview.liabilities.loanTotalBalance,
        ),
        -1,
      ),
      breakdown: [
        `${accounts.filter((account) => account.kind === "loan").length} loans`,
        `${accounts.filter((account) => account.kind === "credit_card").length} credit cards`,
      ],
    }),
    renderSummaryMetric({
      label: "Investments",
      amounts: overview.assets.totalInvestmentAssets,
      breakdown: [
        `${accounts.filter((account) => account.kind === "fund").length} funds`,
        `${accounts.filter((account) => account.kind === "brokerage").length} brokerage`,
      ],
    }),
  ].join("");
  const historyRows = model.snapshotHistory.daily
    .slice(-14)
    .reverse()
    .map(
      (point) => `
        <tr>
          <td>${escapeHtml(point.date)}</td>
          <td>${escapeHtml(currencyBucketText(point.netAssets))}</td>
          <td>${escapeHtml(currencyBucketText(point.netChange))}</td>
          <td>${escapeHtml(currencyBucketText(point.assets))}</td>
          <td>${escapeHtml(currencyBucketText(point.liabilities))}</td>
          <td>${escapeHtml(dailyAccountChangeSummary(point.accountChanges)).replace(/\n/g, "<br>")}</td>
          <td class="num">${point.positionCount}</td>
        </tr>`,
    )
    .join("");
  const firstAccountId = accounts[0]?.id ?? null;
  const payload = {
    accounts,
    positions: model.assetPositions,
    transactions: model.normalizedTransactions,
    snapshotHistory: model.snapshotHistory,
    firstAccountId,
  };

  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OctopusBeak Accounts</title>
  <style>${renderOctopusBeakStyles()}</style>
</head>
<body>
  <div class="app">
    <main class="main">
      <header class="topbar">
        <div>
          <div class="eyebrow">Snapshot ${escapeHtml(snapshotDate)}</div>
          <h1>Account overview</h1>
        </div>
        <div class="actions">
          <label class="visibility-toggle">
            <input id="value-visibility" type="checkbox" checked />
            <span id="value-visibility-label">Values visible</span>
          </label>
        </div>
      </header>

      <section class="summary-strip" aria-label="Portfolio value and account counts">
        ${overviewHtml}
      </section>

      <section class="panel history-panel" aria-labelledby="history-title">
        <div class="panel-head">
          <div class="panel-title">
            <span class="label">Snapshot history</span>
            <strong id="history-title">Daily asset changes</strong>
          </div>
          <span class="result-count">${model.snapshotHistory.snapshots.length} snapshots</span>
        </div>
        <div class="panel-body">
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Net assets</th>
                  <th>Daily change</th>
                  <th>Assets</th>
                  <th>Liabilities</th>
                  <th>Account changes</th>
                  <th class="num">Positions</th>
                </tr>
              </thead>
              <tbody>${
                historyRows ||
                '<tr><td colspan="7">No snapshot history yet.</td></tr>'
              }</tbody>
            </table>
          </div>
        </div>
      </section>

      <section class="workbench" id="accounts">
        <section class="panel">
          <div class="panel-head">
            <div class="panel-title">
              <span class="label">Account list</span>
              <strong id="account-count" role="status" aria-live="polite">0 accounts</strong>
            </div>
          </div>
          <div class="panel-body">
            <div class="toolbar">
              <div class="segment" aria-label="Account type filter">
                <button type="button" data-filter="all" aria-pressed="true">All</button>
                <button type="button" data-filter="asset" aria-pressed="false">Assets</button>
                <button type="button" data-filter="liability" aria-pressed="false">Liabilities</button>
                <button type="button" data-filter="investment" aria-pressed="false">Investments</button>
              </div>
              <label class="search" aria-label="Search accounts">
                <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="11" cy="11" r="7"></circle>
                  <path d="M20 20l-3.5-3.5"></path>
                </svg>
                <input id="account-search" type="search" placeholder="Search account, bank, type" />
              </label>
            </div>
            <div class="account-list" id="account-list" role="list"></div>
          </div>
        </section>
      </section>
    </main>
  </div>

  <div class="modal-layer" id="tx-modal" hidden>
    <div class="modal-backdrop" data-close-modal></div>
    <section class="tx-window has-tools" role="dialog" aria-modal="true" aria-labelledby="tx-modal-title" aria-describedby="tx-modal-meta">
      <header class="tx-window-head">
        <div class="tx-window-title">
          <span class="label">Transactions</span>
          <strong id="tx-modal-title">-</strong>
        </div>
        <button class="tx-close" type="button" id="tx-modal-close" aria-label="Close transactions">&times;</button>
      </header>
      <div class="tx-window-meta" id="tx-modal-meta"></div>
      <div class="tx-table-tools" aria-label="Transaction table controls">
        <label class="tx-filter">
          <span>Filter</span>
          <input id="tx-table-filter" type="search" placeholder="Search date, status, description, source" />
        </label>
        <label class="tx-filter">
          <span>Status</span>
          <select id="tx-status-filter"><option value="all">All status</option></select>
        </label>
        <span class="tx-filter-count" id="tx-filter-count" role="status" aria-live="polite">0 rows</span>
      </div>
      <div class="table-wrap">
        <table class="table">
          <caption class="sr-only">Transactions for the selected account</caption>
          <thead>
            <tr>
              <th scope="col" data-sort-column="date" aria-sort="descending"><button class="sort-button" type="button" data-tx-sort="date">Date <span class="sort-mark" aria-hidden="true">↓</span></button></th>
              <th scope="col" data-sort-column="status"><button class="sort-button" type="button" data-tx-sort="status">Status <span class="sort-mark" aria-hidden="true"></span></button></th>
              <th scope="col" data-sort-column="description"><button class="sort-button" type="button" data-tx-sort="description">Description <span class="sort-mark" aria-hidden="true"></span></button></th>
              <th scope="col" data-sort-column="source"><button class="sort-button" type="button" data-tx-sort="source">Source <span class="sort-mark" aria-hidden="true"></span></button></th>
              <th scope="col" class="num" data-sort-column="amount"><button class="sort-button" type="button" data-tx-sort="amount">Amount <span class="sort-mark" aria-hidden="true"></span></button></th>
            </tr>
          </thead>
          <tbody id="tx-modal-rows"></tbody>
        </table>
      </div>
    </section>
  </div>

  <div class="modal-layer" id="asset-modal" hidden>
    <div class="modal-backdrop" data-close-asset-modal></div>
    <section class="tx-window" role="dialog" aria-modal="true" aria-labelledby="asset-modal-title" aria-describedby="asset-modal-meta">
      <header class="tx-window-head">
        <div class="tx-window-title">
          <span class="label">Assets</span>
          <strong id="asset-modal-title">-</strong>
        </div>
        <button class="tx-close" type="button" id="asset-modal-close" aria-label="Close assets">&times;</button>
      </header>
      <div class="tx-window-meta" id="asset-modal-meta"></div>
      <div class="table-wrap">
        <table class="table">
          <caption class="sr-only">Assets and current values for the selected account</caption>
          <thead><tr><th scope="col">Asset</th><th scope="col">Type</th><th scope="col">As of</th><th scope="col" class="num">Current value</th></tr></thead>
          <tbody id="asset-modal-rows"></tbody>
        </table>
      </div>
    </section>
  </div>

  <script>
    const payload = ${jsonForScript(payload)};
    const accounts = payload.accounts;
    const positionsById = Object.fromEntries(payload.positions.map(function(position) { return [position.id, position]; }));
    const transactionsById = Object.fromEntries(payload.transactions.map(function(transaction) { return [transaction.id, transaction]; }));
    const accountList = document.getElementById("account-list");
    const accountCount = document.getElementById("account-count");
    const accountSearch = document.getElementById("account-search");
    const valueVisibility = document.getElementById("value-visibility");
    const valueVisibilityLabel = document.getElementById("value-visibility-label");
    const filterButtons = Array.from(document.querySelectorAll("[data-filter]"));
    const txModal = document.getElementById("tx-modal");
    const txModalTitle = document.getElementById("tx-modal-title");
    const txModalMeta = document.getElementById("tx-modal-meta");
    const txModalRows = document.getElementById("tx-modal-rows");
    const txTableFilter = document.getElementById("tx-table-filter");
    const txStatusFilter = document.getElementById("tx-status-filter");
    const txFilterCount = document.getElementById("tx-filter-count");
    const txSortButtons = Array.from(document.querySelectorAll("[data-tx-sort]"));
    const txSortHeaders = Array.from(document.querySelectorAll("[data-sort-column]"));
    const txModalClose = document.getElementById("tx-modal-close");
    const assetModal = document.getElementById("asset-modal");
    const assetModalTitle = document.getElementById("asset-modal-title");
    const assetModalMeta = document.getElementById("asset-modal-meta");
    const assetModalRows = document.getElementById("asset-modal-rows");
    const assetModalClose = document.getElementById("asset-modal-close");
    const currencyOrder = ["TWD", "USD", "JPY", "UNKNOWN"];
    let selectedAccountId = payload.firstAccountId;
    let accountFilter = "all";
    let lastModalTrigger = null;
    let activeTxAccount = null;
    let txTableState = { filter: "", status: "all", sortKey: "date", sortDir: "desc" };
    const hiddenValueLabel = "••••";

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, function(char) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\\"": "&quot;", "'": "&#39;" }[char];
      });
    }
    function currencySort(left, right) {
      const leftIndex = currencyOrder.indexOf(left);
      const rightIndex = currencyOrder.indexOf(right);
      if (leftIndex !== -1 || rightIndex !== -1) return (leftIndex === -1 ? 999 : leftIndex) - (rightIndex === -1 ? 999 : rightIndex);
      return left.localeCompare(right);
    }
    function money(value, currency) {
      const digits = currency === "TWD" || currency === "JPY" ? 0 : 2;
      const safeValue = Object.is(value, -0) ? 0 : Number(value || 0);
      const formatted = new Intl.NumberFormat("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(Math.abs(safeValue));
      return (safeValue < 0 ? "-" : "") + currency + " " + formatted;
    }
    function bucketEntries(bucket) {
      return Object.entries(bucket || {}).filter(function(entry) {
        return Number.isFinite(entry[1]);
      }).sort(function(left, right) {
        return currencySort(left[0], right[0]);
      });
    }
    function bucketLines(bucket) {
      const entries = bucketEntries(bucket);
      if (!entries.length) return ["-"];
      return entries.map(function(entry) { return money(entry[1], entry[0]); });
    }
    function sensitiveHtml(value) {
      return '<span data-sensitive>' + escapeHtml(value) + '</span>';
    }
    function applyValueVisibility() {
      const valuesVisible = !valueVisibility || valueVisibility.checked;
      document.documentElement.dataset.valuesVisible = String(valuesVisible);
      if (valueVisibilityLabel) valueVisibilityLabel.textContent = valuesVisible ? "Values visible" : "Values hidden";
      if (valueVisibility) valueVisibility.setAttribute("aria-label", valuesVisible ? "Hide values" : "Show values");
      for (const node of Array.from(document.querySelectorAll("[data-sensitive]"))) {
        if (!node.dataset.value) node.dataset.value = node.textContent || "";
        node.textContent = valuesVisible ? node.dataset.value : hiddenValueLabel;
      }
    }
    function bucketClass(bucket) {
      const first = bucketEntries(bucket).find(function(entry) { return entry[1] !== 0; });
      if (!first) return "neutral";
      return first[1] < 0 ? "negative" : "positive";
    }
    function accountClass(account) {
      if (account.group === "liability") return "liability";
      if (account.group === "investment") return "investment";
      return "asset";
    }
    function signedClass(value) {
      if (value < 0) return "negative";
      if (value > 0) return "positive";
      return "neutral";
    }
    function matchesFilter(account) {
      if (accountFilter === "all") return true;
      return account.group === accountFilter;
    }
    function matchesSearch(account) {
      const query = accountSearch.value.trim().toLowerCase();
      if (!query) return true;
      return [account.label, account.institution, account.kindLabel, account.group, account.source].some(function(field) {
        return String(field || "").toLowerCase().includes(query);
      });
    }
    function selectedAccount() {
      return accounts.find(function(account) { return account.id === selectedAccountId; }) || accounts[0];
    }
    function rowsForAccount(account) {
      return account.transactionIds.map(function(id) { return transactionsById[id]; }).filter(Boolean);
    }
    function assetsForAccount(account) {
      return account.positionIds.map(function(id) { return positionsById[id]; }).filter(Boolean);
    }
    function maskedAccountId(account) {
      const directMask = String(account.label || "").match(/\\*{2,}\\d{4}/);
      if (directMask) return directMask[0];
      for (const asset of assetsForAccount(account)) {
        const assetMask = String(asset.label || "").match(/\\*{2,}\\d{4}/);
        if (assetMask) return assetMask[0];
      }
      return "";
    }
    function accountLine(account) {
      const mask = maskedAccountId(account);
      const parts = [account.institution, account.kindLabel];
      if (mask && mask !== account.label) parts.push(mask);
      if (account.source) parts.push(account.source);
      return parts.join(" · ");
    }
    function valueForAsset(asset) {
      const signedValue = asset.valueSign === "liability" ? -Math.abs(asset.value) : asset.value;
      return money(signedValue, asset.currency);
    }
    function sourceText(item) {
      return String(item.sourceRelativePath || "") + ":" + String(item.sourceRowIndex ?? "");
    }
    function txDateTimeLabel(row) {
      const value = String(row.occurredAt || row.date || "").trim();
      if (!value) return "";
      const normalized = value.replace("T", " ");
      if (/^\\d{4}-\\d{2}-\\d{2}$/.test(normalized)) return normalized + " 00:00:00";
      const match = normalized.match(/^(\\d{4}-\\d{2}-\\d{2})\\s+(\\d{1,2}:\\d{2})(?::(\\d{2}))?/);
      if (!match) return normalized;
      const timeParts = match[2].split(":");
      const hour = timeParts[0].padStart(2, "0");
      const minute = timeParts[1].padStart(2, "0");
      const second = (match[3] || "00").padStart(2, "0");
      return match[1] + " " + hour + ":" + minute + ":" + second;
    }
    function txCell(row, key) {
      if (key === "date") return txDateTimeLabel(row);
      if (key === "status") return row.status || "";
      if (key === "description") return row.description || "";
      if (key === "source") return sourceText(row);
      if (key === "amount") return Number(row.amountSigned);
      return "";
    }
    function txSortValue(row, key) {
      if (key === "date") {
        const timestamp = Date.parse(row.occurredAt || row.date || "");
        return Number.isFinite(timestamp) ? timestamp : 0;
      }
      if (key === "amount") {
        const amount = txCell(row, key);
        return Number.isFinite(amount) ? amount : 0;
      }
      return String(txCell(row, key)).toLowerCase();
    }
    function compareTxRows(left, right) {
      const leftValue = txSortValue(left, txTableState.sortKey);
      const rightValue = txSortValue(right, txTableState.sortKey);
      const direction = txTableState.sortDir === "asc" ? 1 : -1;
      if (leftValue > rightValue) return direction;
      if (leftValue < rightValue) return -direction;
      if (txTableState.sortKey === "date") {
        return Number(left.sourceRowIndex ?? 0) - Number(right.sourceRowIndex ?? 0);
      }
      return 0;
    }
    function matchesTxFilter(row) {
      if (txTableState.status !== "all" && row.status !== txTableState.status) return false;
      const query = txTableState.filter.trim().toLowerCase();
      if (!query) return true;
      const amountLabel = Number.isFinite(row.amountSigned) ? money(row.amountSigned, row.currency) : "";
      return [txDateTimeLabel(row), row.status, row.description, sourceText(row), row.currency, amountLabel].some(function(value) {
        return String(value ?? "").toLowerCase().includes(query);
      });
    }
    function resetTxTableControls(rows) {
      txTableState = { filter: "", status: "all", sortKey: "date", sortDir: "desc" };
      txTableFilter.value = "";
      const statuses = Array.from(new Set(rows.map(function(row) { return String(row.status || "").trim(); }).filter(Boolean))).sort();
      txStatusFilter.innerHTML = '<option value="all">All status</option>' + statuses.map(function(status) {
        return '<option value="' + escapeHtml(status) + '">' + escapeHtml(status) + '</option>';
      }).join("");
      txStatusFilter.value = "all";
    }
    function updateTxSortHeaders() {
      for (const header of txSortHeaders) {
        const key = header.dataset.sortColumn;
        const active = key === txTableState.sortKey;
        if (active) header.setAttribute("aria-sort", txTableState.sortDir === "asc" ? "ascending" : "descending");
        else header.removeAttribute("aria-sort");
        const mark = header.querySelector(".sort-mark");
        if (mark) mark.textContent = active ? (txTableState.sortDir === "asc" ? "↑" : "↓") : "";
      }
    }
    function renderTxRows(account) {
      const rows = rowsForAccount(account);
      const visibleRows = rows.filter(matchesTxFilter).sort(compareTxRows);
      txFilterCount.textContent = String(visibleRows.length) + " / " + String(rows.length) + " rows";
      updateTxSortHeaders();
      if (!visibleRows.length) {
        txModalRows.innerHTML = '<tr class="tx-table-empty"><td colspan="5">No matching transactions</td></tr>';
        return;
      }
      txModalRows.innerHTML = visibleRows.map(function(row) {
        const amount = Number(row.amountSigned);
        const amountLabel = Number.isFinite(amount) ? money(amount, row.currency) : "-";
        return '<tr><td>' + escapeHtml(txDateTimeLabel(row) || "-") + '</td><td>' + escapeHtml(row.status || "-") + '</td><td>' + escapeHtml(row.description || "-") + '</td><td>' + escapeHtml(sourceText(row)) + '</td><td class="num ' + (Number.isFinite(amount) ? signedClass(amount) : "neutral") + '">' + sensitiveHtml(amountLabel) + '</td></tr>';
      }).join("");
      applyValueVisibility();
    }
    function renderTxModal(account) {
      const rows = rowsForAccount(account);
      activeTxAccount = account;
      resetTxTableControls(rows);
      txModalTitle.textContent = account.institution + " / " + account.label;
      txModalMeta.innerHTML = '<span class="chip ' + accountClass(account) + '">' + escapeHtml(account.group) + '</span><span class="chip">' + String(rows.length) + ' tx</span><span class="chip">' + escapeHtml(account.kindLabel) + '</span><span class="chip">' + sensitiveHtml(bucketLines(account.amounts).join(" / ")) + '</span>';
      renderTxRows(account);
    }
    function setModalOpenState() {
      document.body.classList.toggle("modal-open", !txModal.hidden || !assetModal.hidden);
    }
    function focusableElements(container) {
      return Array.from(container.querySelectorAll("a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])")).filter(function(element) {
        return element.offsetParent !== null || element === document.activeElement;
      });
    }
    function trapModalFocus(event, modal) {
      const elements = focusableElements(modal);
      if (!elements.length) return;
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    }
    function openTxModal(account, trigger) {
      lastModalTrigger = trigger || document.activeElement;
      renderTxModal(account);
      txModal.hidden = false;
      setModalOpenState();
      txModalClose.focus({ preventScroll: true });
    }
    function closeTxModal() {
      txModal.hidden = true;
      activeTxAccount = null;
      setModalOpenState();
      if (lastModalTrigger && typeof lastModalTrigger.focus === "function") lastModalTrigger.focus({ preventScroll: true });
    }
    function renderAssetModal(account) {
      const assets = assetsForAccount(account);
      assetModalTitle.textContent = account.institution + " / " + account.label;
      assetModalMeta.innerHTML = '<span class="chip ' + accountClass(account) + '">' + escapeHtml(account.group) + '</span><span class="chip">' + String(assets.length) + ' ' + (assets.length === 1 ? "asset" : "assets") + '</span><span class="chip">' + escapeHtml(account.kindLabel) + '</span>';
      assetModalRows.innerHTML = assets.map(function(asset) {
        const signClass = asset.valueSign === "liability" ? "negative" : asset.valueSign === "asset" ? "positive" : "neutral";
        return '<tr><td>' + escapeHtml(asset.label) + '</td><td>' + escapeHtml(asset.assetClass) + '</td><td>' + escapeHtml(asset.asOfDate || "-") + '</td><td class="num ' + signClass + '">' + sensitiveHtml(valueForAsset(asset)) + '</td></tr>';
      }).join("");
      if (!assets.length) assetModalRows.innerHTML = '<tr class="tx-table-empty"><td colspan="4">No assets</td></tr>';
      applyValueVisibility();
    }
    function openAssetModal(account, trigger) {
      lastModalTrigger = trigger || document.activeElement;
      renderAssetModal(account);
      assetModal.hidden = false;
      setModalOpenState();
      assetModalClose.focus({ preventScroll: true });
    }
    function closeAssetModal() {
      assetModal.hidden = true;
      setModalOpenState();
      if (lastModalTrigger && typeof lastModalTrigger.focus === "function") lastModalTrigger.focus({ preventScroll: true });
    }
    function renderAccounts() {
      const filtered = accounts.filter(matchesFilter).filter(matchesSearch);
      accountCount.textContent = String(filtered.length) + " accounts";
      if (!filtered.some(function(account) { return account.id === selectedAccountId; }) && filtered[0]) selectedAccountId = filtered[0].id;
      if (!filtered.length) {
        accountList.innerHTML = '<div class="empty" role="status"><strong>No matching accounts</strong><span>Adjust the filter or search.</span></div>';
        return;
      }
      accountList.innerHTML = filtered.map(function(account) {
        const txCount = rowsForAccount(account).length;
        const assetCount = assetsForAccount(account).length;
        const amountLines = bucketLines(account.amounts).map(function(line) { return sensitiveHtml(line); }).join("");
        const assetButton = assetCount ? '<button class="chip asset-chip" type="button" data-asset-account-id="' + escapeHtml(account.id) + '" aria-haspopup="dialog" aria-controls="asset-modal">' + String(assetCount) + ' ' + (assetCount === 1 ? "asset" : "assets") + '</button>' : "";
        return '<article class="account-row" role="listitem" data-account-id="' + escapeHtml(account.id) + '" data-selected="' + String(account.id === selectedAccountId) + '"><button class="account-main" type="button" data-select-account-id="' + escapeHtml(account.id) + '" aria-pressed="' + String(account.id === selectedAccountId) + '"><span class="account-name"><strong>' + escapeHtml(account.label) + '</strong><span class="account-line">' + escapeHtml(accountLine(account)) + '</span></span></button><span class="amount ' + bucketClass(account.amounts) + '">' + amountLines + '</span><span class="chip-row account-actions"><span class="chip ' + accountClass(account) + '">' + escapeHtml(account.group) + '</span>' + assetButton + '<button class="chip tx-chip" type="button" data-tx-account-id="' + escapeHtml(account.id) + '" aria-haspopup="dialog" aria-controls="tx-modal">' + String(txCount) + ' tx</button></span></article>';
      }).join("");
      applyValueVisibility();
      for (const row of Array.from(accountList.querySelectorAll("[data-account-id]"))) {
        row.addEventListener("click", function(event) {
          if (event.target.closest("button")) return;
          selectedAccountId = row.dataset.accountId;
          renderAccounts();
        });
      }
      for (const button of Array.from(accountList.querySelectorAll("[data-select-account-id]"))) {
        button.addEventListener("click", function(event) {
          event.stopPropagation();
          selectedAccountId = button.dataset.selectAccountId;
          renderAccounts();
        });
      }
      for (const button of Array.from(accountList.querySelectorAll("[data-tx-account-id]"))) {
        button.addEventListener("click", function(event) {
          event.stopPropagation();
          selectedAccountId = button.dataset.txAccountId;
          renderAccounts();
          openTxModal(selectedAccount(), button);
        });
      }
      for (const button of Array.from(accountList.querySelectorAll("[data-asset-account-id]"))) {
        button.addEventListener("click", function(event) {
          event.stopPropagation();
          selectedAccountId = button.dataset.assetAccountId;
          renderAccounts();
          openAssetModal(selectedAccount(), button);
        });
      }
    }
    if (valueVisibility) {
      valueVisibility.addEventListener("change", applyValueVisibility);
    }
    for (const button of filterButtons) {
      button.addEventListener("click", function() {
        accountFilter = button.dataset.filter;
        for (const item of filterButtons) item.setAttribute("aria-pressed", String(item === button));
        renderAccounts();
      });
    }
    accountSearch.addEventListener("input", renderAccounts);
    txTableFilter.addEventListener("input", function() {
      txTableState.filter = txTableFilter.value;
      if (activeTxAccount) renderTxRows(activeTxAccount);
    });
    txStatusFilter.addEventListener("change", function() {
      txTableState.status = txStatusFilter.value;
      if (activeTxAccount) renderTxRows(activeTxAccount);
    });
    for (const button of txSortButtons) {
      button.addEventListener("click", function() {
        const nextKey = button.dataset.txSort;
        if (txTableState.sortKey === nextKey) txTableState.sortDir = txTableState.sortDir === "asc" ? "desc" : "asc";
        else {
          txTableState.sortKey = nextKey;
          txTableState.sortDir = nextKey === "date" || nextKey === "amount" ? "desc" : "asc";
        }
        if (activeTxAccount) renderTxRows(activeTxAccount);
      });
    }
    txModalClose.addEventListener("click", closeTxModal);
    txModal.querySelector("[data-close-modal]").addEventListener("click", closeTxModal);
    assetModalClose.addEventListener("click", closeAssetModal);
    assetModal.querySelector("[data-close-asset-modal]").addEventListener("click", closeAssetModal);
    document.addEventListener("keydown", function(event) {
      if (event.key === "Escape" && !txModal.hidden) closeTxModal();
      else if (event.key === "Escape" && !assetModal.hidden) closeAssetModal();
      else if (event.key === "Tab" && !txModal.hidden) trapModalFocus(event, txModal);
      else if (event.key === "Tab" && !assetModal.hidden) trapModalFocus(event, assetModal);
    });
    renderAccounts();
  </script>
</body>
</html>`;
}
