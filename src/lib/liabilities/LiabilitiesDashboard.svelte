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
    type AccountKind,
    type AccountRowDto,
  } from "$lib/shared-ledger/types.ts";
  import { awaitingFirstData } from "$lib/shared-ledger/first-data.ts";
  import { totalIncomplete } from "$lib/shared-ledger/preview-account.ts";
  import { accountShares, dateInTimeZone, valuationDateFor } from "$lib/shared-ledger/twd-valuation.ts";
  import { indexExchangeRates } from "$lib/shared-money/exchange-rates.ts";
  import { currencyCount, formatMoney } from "$lib/shared-money/money.ts";
  import StackedBalanceChart from "$lib/shared-accounts/components/StackedBalanceChart.svelte";
  import { localizeAccount, localizeAccounts } from "$lib/shared-accounts/localize-account.ts";
  import {
    buildStackedBalanceChartData,
    chartCurrenciesFor,
    type BalanceChartFilter,
  } from "$lib/shared-accounts/components/stacked-balance-chart-data.ts";
  import DashboardShell from "$lib/shared-shell/components/DashboardShell.svelte";
  import EmptyPanel from "$lib/shared-shell/components/EmptyPanel.svelte";
  import EmptySourceBanner from "$lib/shared-shell/components/EmptySourceBanner.svelte";
  import PreviewMarker from "$lib/shared-shell/components/PreviewMarker.svelte";

  export let liabilities: LiabilitiesPageDto;
  export let focusAccountId: string | null = null;

  const DUE_SOON_DAYS = 3;
  const CARD_COLOR = liabilityColor("credit-card");
  const EMPTY_TILE_COLOR = "color-mix(in oklch, var(--muted) 45%, transparent)";

  let search = "";
  let chartCurrency = "TWD";
  let accountFilter: BalanceChartFilter = "all";
  let marginFilter: AccountKind | "all" = "all";




  $: today = dateInTimeZone(new Date(), $systemTimezone);
  $: stackedChart = buildStackedBalanceChartData({
    accounts: localizeAccounts(liabilities.accounts, $t),
    dailyHistoryByAccount: liabilities.dailyHistoryByAccount,
    filter: accountFilter,
    currency: chartCurrency,
    mode: "liability",
  });
  $: summary = readLiabilitiesSummary(liabilities, { today });
  $: liabilityAccounts = liabilities.accounts;
  $: isEmpty = awaitingFirstData(liabilities);
  $: usesEstimatedCredit = liabilities.accounts.some((account) =>
    account.amountLines.some((amount) =>
      amount.traces?.some((trace) => trace.estimateKind === "estimate"),
    ),
  );
  $: incomplete = totalIncomplete(liabilities.accounts);
  $: includesPreview = summary.state === "ready" && summary.includesPreview;
  $: sideValue = isEmpty
    ? "—"
    : incomplete
      ? $t.preview.incomplete
      : summary.state === "ready" ? formatTwd(summary.total, $locale) : "--";
  $: sideSub = isEmpty ? $t.liabilities.empty.side : $t.liabilities.sideSub(
    liabilityAccounts.length,
    currencyCount(liabilityAccounts.map((account) => account.amountLines)),
  );
  $: chartCurrencies = chartCurrenciesFor(liabilities.dailyHistory, "liabilities");
  $: if (!chartCurrencies.includes(chartCurrency)) chartCurrency = chartCurrencies[0] ?? "TWD";

  function marginShares(accounts: AccountRowDto[]) {
    return accountShares(
      accounts,
      indexExchangeRates(liabilities.exchangeRates),
      valuationDateFor(liabilities.dailyHistory, accounts, today),
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
  sideValueSensitive={!incomplete}
  sideIncludesPreview={!isEmpty && includesPreview}
  searchPlaceholder={$t.liabilities.searchPlaceholder}
  bind:search
>
  <div class="content">
    {#if isEmpty}
      <div class="empty-banner">
        <EmptySourceBanner title={$t.liabilities.empty.bannerTitle} body={$t.liabilities.empty.bannerBody} />
      </div>
    {:else}
      <ProjectionStateBanner projection={liabilities} />
    {/if}
    <div class="block-frame">
      <PageTotalCard
        label={isEmpty ? $t.liabilities.empty.totalLabel : $t.liabilities.total(liabilities.accounts.length)}
        ariaLabel={$t.liabilities.metricsAria}
        goodWhen="down"
        total={summary.state === "ready" ? summary.total : null}
        trailing={summary.state === "ready" ? summary.trailing : null}
        {incomplete}
        {includesPreview}
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
    </div>

    <div class="block-frame">
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
        {#if stackedChart.includesPreview}<PreviewMarker align="end" />{/if}
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
    </div>

    <div class="block-frame">
      <AccountTable
        accounts={liabilities.accounts}
        mode="liability"
        bind:search
        bind:filter={accountFilter}
        transactionsByAccount={liabilities.transactionsByAccount}
        dailyHistoryByAccount={liabilities.dailyHistoryByAccount}
        shares={summary.state === "ready" ? summary.shares : new Map()}
        focusAccountId={focusAccountId}
      />
    </div>

    <div class="block-frame">
      {#if liabilities.marginAccounts.length > 0}
        <section class="card margin-exposure" aria-label={$t.liabilities.marginExposure}>
        <div class="panel-title">
          <h2>{$t.liabilities.marginExposure}</h2>
        </div>
        <AccountTable
          accounts={liabilities.marginAccounts}
          mode="liability"
          bind:search
          bind:filter={marginFilter}
          transactionsByAccount={liabilities.transactionsByAccount}
          dailyHistoryByAccount={liabilities.dailyHistoryByAccount}
          shares={marginShares(liabilities.marginAccounts)}
        />
        </section>
      {/if}
    </div>
  </div>
</DashboardShell>

<style>
  .block-frame { position: relative; min-width: 0; }
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
