<script lang="ts">
  import { BarChart, Bars, Tooltip } from "layerchart";
  import { locale, t } from "$lib/i18n/i18n.ts";
  import { kindSeriesColor } from "$lib/overview/overview-format.ts";
  import { formatSparklineTick } from "$lib/overview/components/sparkline-format.ts";
  import type { CreditCardStatementDto } from "$lib/shared-ledger/types.ts";
  import { formatMoney } from "$lib/shared-money/money.ts";

  /** Newest first, as the table lists them. */
  export let statements: CreditCardStatementDto[] = [];
  /** The statement unfolded in the table. */
  export let selectedId: string | null = null;
  /** The statement under the pointer in the table. */
  export let hoverId: string | null = null;
  export let onSelect: (statementId: string) => void = () => {};

  type StatementBar = { id: string; cycleEnd: string; value: number; statement: CreditCardStatementDto };

  const BAR_COLOR = kindSeriesColor("credit-card", "liability") ?? "var(--danger)";

  $: bars = [...statements].reverse().map((statement): StatementBar => ({
    id: statement.statementId,
    cycleEnd: statement.cycleEnd,
    value: statement.statementBalance.value,
    statement,
  }));
  $: spansYears = new Set(bars.map((bar) => bar.cycleEnd.slice(0, 4))).size > 1;
  $: marked = bars.filter((bar) => bar.id === selectedId || bar.id === hoverId);
  $: top = Math.max(0, ...bars.map((bar) => bar.value));
  $: yDomain = [Math.min(0, ...bars.map((bar) => bar.value)), top === 0 ? 1 : top * 1.08];
  $: step = (yDomain[1] - yDomain[0]) / 4;
  // Every other month once a row of bars would crowd the axis.
  $: labelled = new Set(bars.filter((_, index) => bars.length <= 14 || (bars.length - 1 - index) % 2 === 0).map((bar) => bar.id));

  function monthDate(day: string) {
    return new Date(`${day.slice(0, 7)}-01T00:00:00Z`);
  }

  function monthTick(value: unknown) {
    const bar = bars.find((item) => item.id === value);
    if (!bar || !labelled.has(bar.id)) return "";
    const january = bar.cycleEnd.slice(5, 7) === "01";
    const withYear = spansYears && (bar === bars[0] || january);
    return new Intl.DateTimeFormat($locale, { month: "short", ...(withYear ? { year: "2-digit" } : {}), timeZone: "UTC" })
      .format(monthDate(bar.cycleEnd));
  }

  function shortDay(day: string) {
    return day.slice(5).replace("-", "/");
  }

  function selectBar(_event: MouseEvent, detail: { data: StatementBar | null }) {
    if (detail.data) onSelect(detail.data.id);
  }
</script>

<div class="statement-chart" data-statement-chart>
  <div class="statement-chart-plot" role="img" aria-label={$t.statements.chartTitle}>
    <BarChart
      data={bars}
      x="id"
      y="value"
      {yDomain}
      height={168}
      bandPadding={0.32}
      rule={false}
      grid={{ y: true }}
      padding={{ top: 8, right: 8, bottom: 24, left: 52 }}
      tooltipContext={{ mode: "band", onclick: selectBar }}
      props={{
        xAxis: { class: "sparkline-axis", format: monthTick, ticks: bars.map((bar) => bar.id) },
        yAxis: {
          class: "sparkline-axis",
          format: (value: unknown) => formatSparklineTick(Number(value), step),
          tickLabelProps: { "data-sensitive": "" },
          ticks: 3,
        },
        grid: { class: "sparkline-grid" },
      }}
    >
      {#snippet marks()}
        <Bars data={bars} radius={3} rounded="edge" fill={BAR_COLOR} fillOpacity={0.78} key={(bar: StatementBar) => bar.id} />
        {#each marked as bar (bar.id)}
          <Bars
            data={[bar]}
            radius={3}
            rounded="edge"
            fill={BAR_COLOR}
            stroke="var(--fg)"
            strokeWidth={bar.id === selectedId ? 2 : 1}
            class="statement-chart-marked"
          />
        {/each}
      {/snippet}
      {#snippet tooltip({ context })}
        <Tooltip.Root {context} class="sparkline-tooltip" variant="none" portal={false}>
          {#snippet children({ data }: { data: StatementBar })}
            <div class="sparkline-tooltip-body statement-chart-tooltip">
              <span>{$t.statements.statementMonth(Number(data.cycleEnd.slice(0, 4)), Number(data.cycleEnd.slice(5, 7)))}</span>
              <strong data-sensitive>{formatMoney(data.statement.statementBalance, { locale: $locale })}</strong>
              <span class="detail num">{shortDay(data.statement.cycleStart)} – {shortDay(data.statement.cycleEnd)}</span>
              {#if data.statement.minimumPayment}
                <span class="detail" data-sensitive>{$t.statements.minimumPayment} {formatMoney(data.statement.minimumPayment, { locale: $locale })}</span>
              {/if}
              {#if data.statement.dueDate}
                <span class="detail num">{$t.statements.dueDate} {shortDay(data.statement.dueDate)}</span>
              {/if}
            </div>
          {/snippet}
        </Tooltip.Root>
      {/snippet}
    </BarChart>
  </div>
</div>

<style>
  .statement-chart { min-width: 0; }
  .statement-chart-plot { min-width: 0; cursor: pointer; }
  .statement-chart :global(.statement-chart-marked) { pointer-events: none; }
  .statement-chart-tooltip { min-width: 164px; }

  .statement-chart-tooltip .detail {
    font-size: 11px;
    font-weight: 650;
    opacity: 0.86;
  }
</style>
