<script lang="ts">
  import { CalendarX, ChartLine } from "@lucide/svelte";

  import { locale, t, type Translation } from "$lib/i18n/i18n.ts";
  import {
    readLiabilitiesSummary,
    type UpcomingPayment,
  } from "$lib/liabilities/liabilities-summary.ts";
  import type { LiabilitiesPageDto } from "$lib/liabilities/types.ts";
  import { formatShare, formatShortDate, formatTwd, formatTwdNumber, liabilityColor } from "$lib/overview/overview-format.ts";
  import { systemTimezone } from "$lib/settings/system-timezone-store.ts";
  import AccountTable from "$lib/shared-accounts/components/AccountTable.svelte";
  import PageTotalCard from "$lib/shared-accounts/components/PageTotalCard.svelte";
  import ProjectionStateBanner from "$lib/shared-accounts/components/ProjectionStateBanner.svelte";
  import SummaryTile from "$lib/shared-accounts/components/SummaryTile.svelte";
  import {
    historyPointKey,
    type AccountKind,
    type AccountRowDto,
  } from "$lib/shared-ledger/types.ts";
  import { accountShares, dateInTimeZone, valuationDateFor } from "$lib/shared-ledger/twd-valuation.ts";
  import { indexExchangeRates } from "$lib/shared-money/exchange-rates.ts";
  import { currencyCount, formatMoney } from "$lib/shared-money/money.ts";
  import StackedBalanceChart from "$lib/shared-accounts/components/StackedBalanceChart.svelte";
  import { localizeAccount, localizeAccounts } from "$lib/shared-accounts/localize-account.ts";
  import {
    buildStackedBalanceChartData,
    type BalanceChartFilter,
  } from "$lib/shared-accounts/components/stacked-balance-chart-data.ts";
  import DashboardShell from "$lib/shared-shell/components/DashboardShell.svelte";
  import EmptyPanel from "$lib/shared-shell/components/EmptyPanel.svelte";
  import EmptySourceBanner from "$lib/shared-shell/components/EmptySourceBanner.svelte";
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

  const DUE_SOON_DAYS = 3;
  const CARD_COLOR = liabilityColor("credit-card");
  const EMPTY_TILE_COLOR = "color-mix(in oklch, var(--muted) 45%, transparent)";

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

  function settledSummaryBlock(states: typeof blocks) {
    const state = states.summary;
    return liabilitiesBlockData("summary", state && "data" in state ? state.data : undefined);
  }

  $: today = dateInTimeZone(new Date(), $systemTimezone);
  $: summaryInput = resolveLiabilitiesSummary(liabilities, settledSummaryBlock(blocks));
  $: summary = readLiabilitiesSummary(summaryInput, { today });
  $: liabilityAccounts = liabilities.accounts;
  $: isEmpty = liabilities.availability === "empty";
  $: usesEstimatedCredit = summaryInput.accounts.some((account) =>
    account.amountLines.some((amount) =>
      amount.traces?.some((trace) => trace.estimateKind === "estimate"),
    ),
  );
  $: sideValue = isEmpty ? "—" : summary.state === "ready" ? formatTwd(summary.total, $locale) : "--";
  $: sideSub = isEmpty ? $t.liabilities.empty.side : $t.liabilities.sideSub(
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

  function marginShares(accounts: AccountRowDto[]) {
    return accountShares(
      accounts,
      indexExchangeRates(summaryInput.exchangeRates),
      valuationDateFor(summaryInput.dailyHistory, accounts, today),
    );
  }

  function paymentHead(payment: UpcomingPayment, dictionary: Translation) {
    return payment.kind === "statement"
      ? `${formatShortDate(payment.dueDate, $locale)} · ${dictionary.liabilities.dueIn(payment.daysUntil)}`
      : dictionary.liabilities.cardInUse;
  }

  function paymentAmount(payment: UpcomingPayment) {
    return payment.amount.currency === "TWD"
      ? formatTwdNumber(payment.amount.value, $locale)
      : formatMoney(payment.amount, { locale: $locale });
  }

  function accountShort(account: AccountRowDto, dictionary: Translation) {
    const { institution, product } = localizeAccount(account, dictionary);
    return `${institution} ${product}`;
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
    {#if isEmpty}
      <div class="empty-banner">
        <EmptySourceBanner title={$t.liabilities.empty.bannerTitle} body={$t.liabilities.empty.bannerBody} />
      </div>
    {/if}
    <ProjectionStateBanner projection={liabilities} />
    <ProgressiveBlock label="summary" state={blockState("summary")} retry={() => retryBlock("summary")}>
      <PageTotalCard
        label={isEmpty ? $t.liabilities.empty.totalLabel : $t.liabilities.total(summaryInput.accounts.length)}
        ariaLabel={$t.liabilities.metricsAria}
        goodWhen="down"
        total={summary.state === "ready" ? summary.total : null}
        trailing={summary.state === "ready" ? summary.trailing : null}
        notes={isEmpty ? [$t.liabilities.empty.totalNote] : [
          summary.state === "ready" && summary.unconvertedCurrencies.length > 0
            ? $t.overview.unconverted(summary.unconvertedCurrencies.join(", "))
            : "",
          usesEstimatedCredit ? $t.overview.creditCardEstimateBasis : "",
        ].filter(Boolean)}
      >
        {#if isEmpty}
          <div class="empty-payments">
            <strong><CalendarX size={15} strokeWidth={1.8} aria-hidden="true" />{$t.liabilities.empty.paymentsTitle}</strong>
            <span>{$t.liabilities.empty.paymentsBody}</span>
          </div>
          <SummaryTile color={EMPTY_TILE_COLOR} head={$t.liabilities.utilization} value="—" sub="–" share={0} />
        {:else if summary.state === "ready"}
          {#each summary.payments as payment (payment.account.id)}
            <SummaryTile
              color={CARD_COLOR}
              head={paymentHead(payment, $t)}
              urgent={payment.kind === "statement" && payment.daysUntil <= DUE_SOON_DAYS}
              approx={payment.kind === "card-estimate"}
              value={paymentAmount(payment)}
              sub={accountShort(payment.account, $t)}
              subTitle={localizeAccount(payment.account, $t).label}
              share={payment.share}
            />
          {/each}
          {#if summary.utilization}
            <SummaryTile
              color={CARD_COLOR}
              head={$t.liabilities.utilization}
              value={formatShare(summary.utilization.ratio, $locale)}
              sub={`${formatTwdNumber(summary.utilization.used, $locale)} / ${formatTwdNumber(summary.utilization.limit, $locale)}`}
              subSensitive
              share={summary.utilization.ratio}
            />
          {/if}
        {/if}
      </PageTotalCard>
    </ProgressiveBlock>

    <ProgressiveBlock label="chart" state={blockState("chart")} retry={() => retryBlock("chart")} let:data>
      {@const chartBlock = liabilitiesBlockData("chart", data)}
      {@const chartDataBlock = resolveLiabilitiesChart(liabilities, chartBlock)}
      {@const stackedChart = chartBlock ? buildStackedBalanceChartData({
        accounts: localizeAccounts(chartDataBlock.accounts, $t),
        dailyHistoryByAccount: chartDataBlock.dailyHistoryByAccount,
        filter: accountFilter,
        currency: chartCurrency,
        mode: "liability",
      }) : chartData}
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
        {#if stackedChart.series.length > 0}
          <span class="chip">{$t.common.days30}</span>
        {/if}
      </div>
      <div class="pad balance-chart">
        {#if isEmpty}
          <EmptyPanel icon={ChartLine} title={$t.liabilities.empty.chartTitle} body={$t.liabilities.empty.chartBody} />
        {:else}
          <StackedBalanceChart
            chart={stackedChart}
            currency={chartCurrency}
            label={$t.liabilities.debtExposure}
          />
        {/if}
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
        shares={summary.state === "ready" ? summary.shares : new Map()}
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
          shares={marginShares(detailsDataBlock.marginAccounts)}
        />
        </section>
      {/if}
    </ProgressiveBlock>
  </div>
</DashboardShell>

<style>
  .empty-banner {
    margin-bottom: var(--space-6);
  }

  .empty-payments {
    display: grid;
    align-content: start;
    gap: 6px;
    min-width: 0;
    padding-right: var(--space-4);
    border-right: 1px solid var(--border);
  }

  .empty-payments strong {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    font-weight: 700;
  }

  .empty-payments span {
    color: var(--muted);
    font-size: 12px;
    line-height: 1.5;
  }
</style>
