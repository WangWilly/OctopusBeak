<script lang="ts">
  import { t, type Translation } from "$lib/i18n/i18n.ts";
  import type { LiabilitiesPageDto } from "$lib/liabilities/types.ts";
  import AccountTable from "$lib/shared-accounts/components/AccountTable.svelte";
  import ProjectionStateBanner from "$lib/shared-accounts/components/ProjectionStateBanner.svelte";
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
  import ProgressiveBlock from "$lib/shared-shell/components/ProgressiveBlock.svelte";
  import type { BlockState } from "$lib/shared-shell/block-load-state.ts";
  import type {
    DashboardBlockPayload,
    DashboardBlockValueMap,
  } from "$lib/shared-shell/dashboard-blocks.ts";
  import {
    resolveLiabilitiesChart,
    resolveLiabilitiesDetails,
    resolveLiabilitiesList,
    resolveLiabilitiesSummary,
  } from "$lib/shared-shell/progressive-dashboard-data.ts";

  export let liabilities: LiabilitiesPageDto;
  export let focusAccountId: string | null = null;
  export let blocks: Readonly<Record<string, BlockState<DashboardBlockPayload>>> = {};
  export let retryBlock: (key: string) => void = () => {};

  let search = "";
  let chartCurrency = "TWD";
  let accountFilter: BalanceChartFilter = "all";
  let marginFilter: AccountKind | "all" = "all";

  function blockState(key: string): BlockState<DashboardBlockPayload> {
    return blocks[key] ?? { status: "loading" };
  }

  function liabilitiesBlockData<Key extends keyof DashboardBlockValueMap["liabilities"]>(
    key: Key,
    payload: DashboardBlockPayload | undefined,
  ): DashboardBlockValueMap["liabilities"][Key] | undefined {
    return payload?.route === "liabilities" && payload.block === key
      ? payload.data as DashboardBlockValueMap["liabilities"][Key]
      : undefined;
  }

  $: liabilityAccounts = liabilities.accounts;
  $: usesEstimatedCredit = liabilityAccounts.some((account) =>
    account.amountLines.some((amount) =>
      amount.traces?.some((trace) => trace.estimateKind === "estimate"),
    ),
  );
  $: metrics = buildMetrics(liabilityAccounts, $t);
  $: liabilityValue = metrics[0]?.amounts ?? [];
  $: sideValue = formatAmountLines(liabilityValue.slice(0, 1));
  $: sideSub = $t.liabilities.sideSub(
    liabilityAccounts.length,
    currencyCount(liabilityAccounts.map((account) => account.amountLines)),
  );
  $: chartRows = [...liabilities.dailyHistory].sort((left, right) => historyPointKey(left).localeCompare(historyPointKey(right))).slice(-30);
  $: chartCurrencies = [
    ...new Set(chartRows.flatMap((row) => row.liabilities.map((amount) => amount.currency))),
  ].sort((left, right) => currencyOrder(left) - currencyOrder(right) || left.localeCompare(right));
  $: if (!chartCurrencies.includes(chartCurrency)) chartCurrency = chartCurrencies[0] ?? "TWD";
  $: chartData = buildStackedBalanceChartData({
    accounts: liabilityAccounts,
    dailyHistoryByAccount: liabilities.dailyHistoryByAccount,
    filter: accountFilter,
    currency: chartCurrency,
    mode: "liability",
  });
  function buildMetrics(accounts: AccountRowDto[], dictionary: Translation): SummaryMetricDto[] {
    const largest = largestAccount(accounts);
    const cardAccounts = accounts.filter((account) => account.kind === "credit-card");
    const loanAccounts = accounts.filter((account) => account.kind === "loan");
    const cryptoAccounts = accounts.filter((account) => account.kind === "crypto");
    const otherAccounts = accounts.filter((account) => account.kind === "other");
    const foreignDebtAccounts = accounts.filter((account) =>
      account.amountLines.some((amount) => amount.currency !== "TWD"),
    );
    const metrics: SummaryMetricDto[] = [
      {
        label: dictionary.liabilities.metricTotalDebt,
        amounts: totalAmounts(accounts),
        breakdown: [
          cardAccounts.length ? dictionary.common.countLabel(dictionary.accounts.creditCard, cardAccounts.length) : null,
          loanAccounts.length ? dictionary.common.countLabel(dictionary.accounts.loan, loanAccounts.length) : null,
          cryptoAccounts.length ? dictionary.common.countLabel(dictionary.accounts.crypto, cryptoAccounts.length) : null,
          otherAccounts.length ? dictionary.common.countLabel(dictionary.accounts.other, otherAccounts.length) : null,
        ].filter(Boolean) as string[],
      },
    ];

    if (largest) {
      metrics.push({
        label: dictionary.liabilities.metricLargestFacility,
        amounts: largest.amountLines,
        breakdown: [largest.label],
      });
    }
    if (cardAccounts.length > 0) {
      metrics.push({
        label: dictionary.liabilities.metricCardBalance,
        amounts: totalAmounts(cardAccounts),
        breakdown: [cardAccounts.map((account) => account.institution).slice(0, 3).join(" + ")],
      });
    }
    if (foreignDebtAccounts.length > 0) {
      metrics.push({
        label: dictionary.liabilities.metricForeignDebt,
        amounts: totalAmounts(foreignDebtAccounts),
        breakdown: foreignDebtAccounts.map((account) => account.label).slice(0, 3),
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

</script>

<DashboardShell
  active="liabilities"
  eyebrow={$t.liabilities.eyebrow}
  title={$t.liabilities.title}
  sideLabel={$t.liabilities.sideLabel}
  {sideValue}
  {sideSub}
  searchPlaceholder={$t.liabilities.searchPlaceholder}
  bind:search
>
  <div class="content">
    <ProjectionStateBanner projection={liabilities} />
    <ProgressiveBlock label="summary" state={blockState("summary")} retry={() => retryBlock("summary")} let:data>
      {@const summaryBlock = liabilitiesBlockData("summary", data)}
      {@const summaryDataBlock = resolveLiabilitiesSummary(liabilities, summaryBlock)}
      <section aria-label={$t.liabilities.metricsAria}>
        <SummaryStrip metrics={buildMetrics(summaryDataBlock.accounts, $t)} />
        {#if usesEstimatedCredit}
          <p class="balance-basis" data-balance-basis="credit-card-estimate" role="note">
            {$t.overview.creditCardEstimateBasis}
          </p>
        {/if}
      </section>
    </ProgressiveBlock>

    <ProgressiveBlock label="chart" state={blockState("chart")} retry={() => retryBlock("chart")} let:data>
      {@const chartBlock = liabilitiesBlockData("chart", data)}
      {@const chartDataBlock = resolveLiabilitiesChart(liabilities, chartBlock)}
      <section class="card balance-history" aria-label={$t.liabilities.balanceHistoryAria}>
      <div class="panel-title">
        <h2>{$t.liabilities.debtBalance}</h2>
        {#if chartCurrencies.length > 0}
          <label class="chip select-chip" for="debt-balance-currency">
            <select
              id="debt-balance-currency"
              aria-label={$t.liabilities.debtBalanceCurrency}
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
        <StackedBalanceChart
          chart={chartBlock ? buildStackedBalanceChartData({
            accounts: chartDataBlock.accounts,
            dailyHistoryByAccount: chartDataBlock.dailyHistoryByAccount,
            filter: accountFilter,
            currency: chartCurrency,
            mode: "liability",
          }) : chartData}
          currency={chartCurrency}
          label={$t.liabilities.debtExposure}
        />
      </div>
      </section>
    </ProgressiveBlock>

    <ProgressiveBlock label="list" state={blockState("list")} retry={() => retryBlock("list")} let:data>
      {@const listBlock = liabilitiesBlockData("list", data)}
      {@const listDataBlock = resolveLiabilitiesList(liabilities, listBlock)}
      <AccountTable
        accounts={listDataBlock.accounts}
        mode="liability"
        bind:search
        bind:filter={accountFilter}
        transactionsByAccount={listDataBlock.transactionsByAccount}
        dailyHistoryByAccount={listDataBlock.dailyHistoryByAccount}
        focusAccountId={focusAccountId}
      />
    </ProgressiveBlock>

    <ProgressiveBlock label="details" state={blockState("details")} retry={() => retryBlock("details")} let:data>
      {@const detailsBlock = liabilitiesBlockData("details", data)}
      {@const detailsDataBlock = resolveLiabilitiesDetails(liabilities, detailsBlock)}
      {#if detailsDataBlock.marginAccounts.length > 0}
        <section class="card margin-exposure" aria-label={$t.liabilities.marginExposure}>
        <div class="panel-title">
          <h2>{$t.liabilities.marginExposure}</h2>
        </div>
        <AccountTable
          accounts={detailsDataBlock.marginAccounts}
          mode="liability"
          bind:search
          bind:filter={marginFilter}
          transactionsByAccount={detailsDataBlock.transactionsByAccount}
          dailyHistoryByAccount={liabilities.dailyHistoryByAccount}
        />
        </section>
      {/if}
    </ProgressiveBlock>
  </div>
</DashboardShell>
