<script lang="ts">
  import type { AssetsPageDto } from "$lib/assets/types.ts";
  import ReportDataIssueModal from "$lib/data-issues/ReportDataIssueModal.svelte";
  import type { DataIssueCreateInput } from "$lib/data-issues/types.ts";
  import { t, type Translation } from "$lib/i18n/i18n.ts";
  import AccountTable from "$lib/shared-accounts/components/AccountTable.svelte";
  import {
    historyPointKey,
    type AccountKind,
    type AccountRowDto,
    type CurrencyAmountDto,
    type SummaryMetricDto,
  } from "$lib/shared-ledger/types.ts";
  import { currencyCount, formatAmountLines } from "$lib/shared-money/money.ts";
  import StackedBalanceChart from "$lib/shared-accounts/components/StackedBalanceChart.svelte";
  import {
    buildStackedBalanceChartData,
    type BalanceChartFilter,
  } from "$lib/shared-accounts/components/stacked-balance-chart-data.ts";
  import SummaryStrip from "$lib/shared-metrics/components/SummaryStrip.svelte";
  import DashboardShell from "$lib/shared-shell/components/DashboardShell.svelte";

  export let assets: AssetsPageDto;
  export let focusAccountId: string | null = null;

  let search = "";
  let chartCurrency = "TWD";
  let accountFilter: BalanceChartFilter = "all";
  let reportOpen = false;
  let reportAccount: AccountRowDto | null = null;

  $: assetBreakdown = [
    { kind: "bank" as const, label: $t.accounts.bank },
    { kind: "fund" as const, label: $t.accounts.fund },
    { kind: "brokerage" as const, label: $t.accounts.brokerage },
    { kind: "crypto" as const, label: $t.accounts.crypto },
    { kind: "foreign" as const, label: $t.accounts.foreign },
  ] satisfies Array<{ kind: AccountKind; label: string }>;
  $: assetAccounts = assets.accounts;
  $: metrics = buildMetrics(assetAccounts, $t);
  $: assetValue = metrics[0]?.amounts ?? [];
  $: sideValue = formatAmountLines(assetValue.slice(0, 1));
  $: sideSub = $t.assets.sideSub(
    assetAccounts.length,
    currencyCount(assetAccounts.map((account) => account.amountLines)),
  );
  $: chartRows = [...assets.dailyHistory].sort((left, right) => historyPointKey(left).localeCompare(historyPointKey(right))).slice(-30);
  $: chartCurrencies = [
    ...new Set(chartRows.flatMap((row) => row.assets.map((amount) => amount.currency))),
  ].sort((left, right) => currencyOrder(left) - currencyOrder(right) || left.localeCompare(right));
  $: if (!chartCurrencies.includes(chartCurrency)) chartCurrency = chartCurrencies[0] ?? "TWD";
  $: chartData = buildStackedBalanceChartData({
    accounts: assetAccounts,
    dailyHistoryByAccount: assets.dailyHistoryByAccount,
    filter: accountFilter,
    currency: chartCurrency,
    mode: "asset",
  });

  function buildMetrics(accounts: AccountRowDto[], dictionary: Translation): SummaryMetricDto[] {
    const largest = largestAccount(accounts);
    const bankAccounts = accounts.filter((account) => account.kind === "bank");
    const foreignAccounts = accounts.filter((account) => account.kind === "foreign");
    const metrics: SummaryMetricDto[] = [
      {
        label: dictionary.assets.metricAssetValue,
        amounts: totalAmounts(accounts),
        breakdown: assetBreakdown
          .map((item) => {
            const count = accounts.filter((account) => account.kind === item.kind).length;
            return count ? dictionary.common.countLabel(item.label, count) : null;
          })
          .filter(Boolean) as string[],
      },
    ];

    if (largest) {
      metrics.push({
        label: dictionary.assets.metricLargestAccount,
        amounts: largest.amountLines,
        breakdown: [largest.label],
      });
    }
    if (bankAccounts.length > 0) {
      metrics.push({
        label: dictionary.assets.metricLiquidCash,
        amounts: totalAmounts(bankAccounts),
        breakdown: bankAccounts.map((account) => account.institution).slice(0, 3),
      });
    }
    if (foreignAccounts.length > 0) {
      metrics.push({
        label: dictionary.assets.metricForeignBalance,
        amounts: totalAmounts(foreignAccounts),
        breakdown: foreignAccounts.map((account) => account.institution).slice(0, 3),
      });
    }
    return metrics;
  }

  function totalAmounts(accounts: AccountRowDto[]): CurrencyAmountDto[] {
    const bucket = new Map<string, number>();
    for (const account of accounts) {
      for (const amount of account.amountLines) {
        bucket.set(amount.currency, (bucket.get(amount.currency) ?? 0) + amount.value);
      }
    }
    return [...bucket.entries()]
      .filter(([, value]) => Math.abs(value) > 0.000001)
      .sort(([left], [right]) => currencyOrder(left) - currencyOrder(right) || left.localeCompare(right))
      .map(([currency, value]) => ({ currency, value }));
  }

  function largestAccount(accounts: AccountRowDto[]) {
    return [...accounts].sort((left, right) => primaryValue(right) - primaryValue(left))[0] ?? null;
  }

  function primaryValue(account: AccountRowDto) {
    return Math.abs(account.amountLines.find((amount) => amount.currency === "TWD")?.value ?? account.amountLines[0]?.value ?? 0);
  }

  function currencyOrder(value: string) {
    return value === "TWD" ? 0 : value === "USD" ? 1 : value === "JPY" ? 2 : 3;
  }

  function selectValue(event: Event) {
    return (event.currentTarget as HTMLSelectElement).value;
  }

  function openReport(account: AccountRowDto) {
    reportAccount = account;
    reportOpen = true;
  }

  async function createReport(input: DataIssueCreateInput) {
    const issue = await window.octopusBeak.dataIssues.create(input);
    location.hash = `/data-issues/${issue.dataIssueId}`;
  }
</script>

<DashboardShell
  active="assets"
  eyebrow={$t.assets.eyebrow}
  title={$t.assets.title}
  sideLabel={$t.assets.sideLabel}
  {sideValue}
  {sideSub}
  searchPlaceholder={$t.assets.searchPlaceholder}
  bind:search
>
  <div class="content">
    <section aria-label={$t.assets.metricsAria}>
      <SummaryStrip {metrics} />
    </section>

    <section class="card balance-history" aria-label={$t.assets.balanceHistoryAria}>
      <div class="panel-title">
        <h2>{$t.assets.assetBalance}</h2>
        {#if chartCurrencies.length > 0}
          <label class="chip select-chip" for="asset-balance-currency">
            <select
              id="asset-balance-currency"
              aria-label={$t.assets.assetBalanceCurrency}
              bind:value={chartCurrency}
              onchange={(event) => (chartCurrency = selectValue(event))}
              oninput={(event) => (chartCurrency = selectValue(event))}
            >
              {#each chartCurrencies as option}
                <option>{option}</option>
              {/each}
            </select>
          </label>
        {/if}
        <span class="chip">{$t.common.days30}</span>
      </div>
      <div class="pad balance-chart">
        <StackedBalanceChart chart={chartData} currency={chartCurrency} label={$t.overview.assetAllocation} />
      </div>
    </section>

    <AccountTable
      accounts={assetAccounts}
      mode="asset"
      bind:search
      bind:filter={accountFilter}
      positionsByAccount={assets.positionsByAccount}
      transactionsByAccount={assets.transactionsByAccount}
      dailyHistoryByAccount={assets.dailyHistoryByAccount}
      focusAccountId={focusAccountId}
      onReportDataIssue={openReport}
    />
  </div>
</DashboardShell>

<ReportDataIssueModal bind:open={reportOpen} account={reportAccount} onSubmit={createReport} />
