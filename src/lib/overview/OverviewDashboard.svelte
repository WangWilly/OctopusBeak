<script lang="ts">
  import DailyHistoryTable from "$lib/overview/components/DailyHistoryTable.svelte";
  import SnapshotSparkline from "$lib/overview/components/SnapshotSparkline.svelte";
  import type { OverviewPageDto } from "$lib/overview/types.ts";
  import type { AccountKind, AccountRowDto } from "$lib/shared-ledger/types.ts";
  import DashboardShell from "$lib/shared-shell/components/DashboardShell.svelte";
  import SummaryStrip from "$lib/shared-metrics/components/SummaryStrip.svelte";
  import { amountValue, formatAmountLines, formatMoney } from "$lib/shared-money/money.ts";

  export let overview: OverviewPageDto;

  let snapshotCurrency = "TWD";
  let dailyCurrency = "TWD";

  const allocationOrder: Array<{ kind: AccountKind; label: string; className: string }> = [
    { kind: "brokerage", label: "Brokerage", className: "accent" },
    { kind: "fund", label: "Fund", className: "domain" },
    { kind: "bank", label: "Bank", className: "" },
    { kind: "foreign", label: "Foreign", className: "" },
  ];

  $: metrics = overview.summary.slice(0, 3);
  $: netMetric = metrics.find((metric) => metric.label === "Net position") ?? metrics[0] ?? null;
  $: netAmounts = netMetric?.amounts ?? [];
  $: sideValue = formatAmountLines(netAmounts.slice(0, 1));
  $: sideSub =
    netAmounts.slice(1).map((amount) => formatMoney(amount)).join(" / ") ||
    `Imported ${formatImportedAt(overview.importedAt)}`;
  $: sideSubSensitive = netAmounts.length > 1;
  $: assetAccounts = overview.accounts.filter((account) => account.group !== "liability");
  $: allocation = buildAllocation(assetAccounts);
  $: history = overview.dailyHistory;
  $: snapshotHistory = [...history].sort((left, right) => left.date.localeCompare(right.date)).slice(-30);

  function buildAllocation(accounts: AccountRowDto[]) {
    const total = accounts.reduce((sum, account) => sum + amountValue(account.amountLines), 0);
    return allocationOrder
      .map((item) => {
        const value = accounts
          .filter((account) => account.kind === item.kind)
          .reduce((sum, account) => sum + amountValue(account.amountLines), 0);
        return {
          ...item,
          percent: total > 0 ? Math.round((value / total) * 1000) / 10 : 0,
        };
      })
      .filter((item) => item.percent > 0);
  }

  function formatImportedAt(value: string | null) {
    return value?.slice(0, 16).replace("T", " ") ?? "not yet";
  }

  function selectValue(event: Event) {
    return (event.currentTarget as HTMLSelectElement).value;
  }
</script>

<DashboardShell
  active="overview"
  eyebrow="Overview"
  title="Portfolio"
  sideLabel="Net position"
  {sideValue}
  {sideSub}
  {sideSubSensitive}
  syncLabel={`Imported ${formatImportedAt(overview.importedAt)}`}
>
  <div class="content">
    <section aria-label="Summary metrics">
      <SummaryStrip {metrics} />
    </section>

    <section class="grid layout-2">
      <article class="card">
        <div class="panel-title">
          <h2>Snapshot history</h2>
          <label class="chip select-chip" for="snapshot-currency">
            <select
              id="snapshot-currency"
              aria-label="Snapshot history currency"
              bind:value={snapshotCurrency}
              onchange={(event) => (snapshotCurrency = selectValue(event))}
              oninput={(event) => (snapshotCurrency = selectValue(event))}
            >
              <option>TWD</option>
              <option>JPY</option>
              <option>USD</option>
            </select>
          </label>
          <span class="chip">30 days</span>
        </div>
        <div class="card pad">
          <SnapshotSparkline rows={snapshotHistory} currency={snapshotCurrency} />
          {#key snapshotCurrency}
            <DailyHistoryTable rows={snapshotHistory} compact netLabel="Net position" currency={snapshotCurrency} />
          {/key}
        </div>
      </article>

      <article class="card">
        <div class="panel-title">
          <h2>Asset allocation</h2>
        </div>
        <div class="card pad bars">
          {#each allocation as item}
            <div>
              <div class="bar-head">
                <span>{item.label}</span>
                <span class="money">{item.percent.toFixed(1)}%</span>
              </div>
              <div class="bar-track">
                <div class={`bar-fill ${item.className}`} style={`width:${item.percent}%`}></div>
              </div>
            </div>
          {:else}
            <p class="lead">No asset allocation data yet.</p>
          {/each}
        </div>
      </article>
    </section>

    <section class="card daily-card">
      <div class="panel-title">
        <h2>Daily asset changes</h2>
        <label class="chip select-chip" for="daily-base-currency">
          Base
          <select
            id="daily-base-currency"
            aria-label="Daily asset changes base currency"
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
