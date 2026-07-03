<script lang="ts">
  import AllocationDonutCard from "$lib/overview/components/AllocationDonutCard.svelte";
  import DailyHistoryTable from "$lib/overview/components/DailyHistoryTable.svelte";
  import SnapshotSparkline from "$lib/overview/components/SnapshotSparkline.svelte";
  import { t, type Translation } from "$lib/i18n/i18n.ts";
  import type { OverviewPageDto } from "$lib/overview/types.ts";
  import type { SummaryMetricDto } from "$lib/shared-ledger/types.ts";
  import DashboardShell from "$lib/shared-shell/components/DashboardShell.svelte";
  import SummaryStrip from "$lib/shared-metrics/components/SummaryStrip.svelte";
  import { formatAmountLines, formatMoney } from "$lib/shared-money/money.ts";

  export let overview: OverviewPageDto;

  let snapshotCurrency = "TWD";
  let dailyCurrency = "TWD";

  $: metrics = overview.summary.slice(0, 3).map((metric) => translateSummaryMetric(metric, $t));
  $: netMetric = metrics[0] ?? null;
  $: netAmounts = netMetric?.amounts ?? [];
  $: sideValue = formatAmountLines(netAmounts.slice(0, 1));
  $: sideSub =
    netAmounts.slice(1).map((amount) => formatMoney(amount)).join(" / ") ||
    $t.common.importedAt(formatImportedAt(overview.importedAt));
  $: sideSubSensitive = netAmounts.length > 1;
  $: history = overview.dailyHistory;
  $: snapshotHistory = [...history].sort((left, right) => left.date.localeCompare(right.date)).slice(-30);

  function formatImportedAt(value: string | null) {
    return value?.slice(0, 16).replace("T", " ") ?? $t.common.notYet;
  }

  function selectValue(event: Event) {
    return (event.currentTarget as HTMLSelectElement).value;
  }

  function translateSummaryMetric(metric: SummaryMetricDto, dictionary: Translation): SummaryMetricDto {
    return {
      ...metric,
      label: translateKnownLabel(metric.label, dictionary),
      breakdown: metric.breakdown.map((item) => translateBreakdown(item, dictionary)),
    };
  }

  function translateKnownLabel(value: string, dictionary: Translation) {
    return (dictionary.knownLabels as Record<string, string>)[value] ?? value;
  }

  function translateBreakdown(value: string, dictionary: Translation) {
    const assetMatch = value.match(/^(\d+) asset accounts$/);
    if (assetMatch) return dictionary.common.assetAccountCount(Number(assetMatch[1]));
    const debtMatch = value.match(/^(\d+) debt accounts$/);
    if (debtMatch) return dictionary.common.debtAccountCount(Number(debtMatch[1]));
    const countMatch = value.match(/^(Bank|Fund|Brokerage|Foreign|Credit card|Loan|Other) (\d+)$/);
    if (countMatch) return dictionary.common.countLabel(translateKnownLabel(countMatch[1], dictionary), Number(countMatch[2]));
    return value;
  }
</script>

<DashboardShell
  active="overview"
  eyebrow={$t.overview.eyebrow}
  title={$t.overview.title}
  sideLabel={$t.overview.sideLabel}
  {sideValue}
  {sideSub}
  {sideSubSensitive}
  syncLabel={$t.common.importedAt(formatImportedAt(overview.importedAt))}
>
  <div class="content">
    <section aria-label={$t.overview.summaryAria}>
      <SummaryStrip {metrics} />
    </section>

    <section class="grid layout-2">
      <article class="card">
        <div class="panel-title">
          <h2>{$t.overview.snapshotHistory}</h2>
          <label class="chip select-chip" for="snapshot-currency">
            <select
              id="snapshot-currency"
              aria-label={$t.overview.snapshotHistoryCurrency}
              bind:value={snapshotCurrency}
              onchange={(event) => (snapshotCurrency = selectValue(event))}
              oninput={(event) => (snapshotCurrency = selectValue(event))}
            >
              <option>TWD</option>
              <option>JPY</option>
              <option>USD</option>
            </select>
          </label>
          <span class="chip">{$t.common.days30}</span>
        </div>
        <div class="card pad">
          <SnapshotSparkline rows={snapshotHistory} currency={snapshotCurrency} label={$t.overview.snapshotHistory} diverging />
          {#key snapshotCurrency}
            <DailyHistoryTable rows={snapshotHistory} compact netLabel={$t.overview.sideLabel} currency={snapshotCurrency} />
          {/key}
        </div>
      </article>

      <div class="overview-allocation-stack">
        <AllocationDonutCard title={$t.overview.assetAllocation} accounts={overview.accounts} mode="asset" />
        <AllocationDonutCard title={$t.overview.liabilityExposure} accounts={overview.accounts} mode="liability" />
      </div>
    </section>

    <section class="card daily-card">
      <div class="panel-title">
        <h2>{$t.overview.dailyAssetChanges}</h2>
        <label class="chip select-chip" for="daily-base-currency">
          {$t.common.base}
          <select
            id="daily-base-currency"
            aria-label={$t.overview.dailyAssetChangesBaseCurrency}
            bind:value={dailyCurrency}
            onchange={(event) => (dailyCurrency = selectValue(event))}
            oninput={(event) => (dailyCurrency = selectValue(event))}
          >
            <option>TWD</option>
            <option>USD</option>
            <option>JPY</option>
          </select>
        </label>
      </div>
      {#key dailyCurrency}
        <DailyHistoryTable rows={history} currency={dailyCurrency} paginate />
      {/key}
    </section>
  </div>
</DashboardShell>

<style>
  .overview-allocation-stack {
    min-width: 0;
    display: grid;
    gap: var(--space-4);
  }
</style>
