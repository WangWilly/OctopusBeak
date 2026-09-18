<script lang="ts">
  import DailyHistoryTable from "$lib/overview/components/DailyHistoryTable.svelte";
  import OverviewSankeyCard from "$lib/overview/components/OverviewSankeyCard.svelte";
  import { locale } from "$lib/i18n/i18n.ts";
  import type { AssetsSecondaryDto } from "$lib/assets/types.ts";
  import type { LiabilitiesSecondaryDto } from "$lib/liabilities/types.ts";
  import type { OverviewSecondaryDto } from "$lib/overview/types.ts";
  import type { SpendingSecondaryDto } from "$lib/spending/model.ts";
  import { exactToNumber } from "$lib/shared-money/exact.ts";
  import { formatMoney } from "$lib/shared-money/money.ts";

  type FinancialSecondaryFallbackKind = "overview" | "assets" | "liabilities" | "spending";
  type FinancialSecondaryData = OverviewSecondaryDto | AssetsSecondaryDto | LiabilitiesSecondaryDto | SpendingSecondaryDto;

  export let kind: FinancialSecondaryFallbackKind;
  export let data: FinancialSecondaryData;

  $: overview = kind === "overview" ? data as OverviewSecondaryDto : null;
  $: assets = kind === "assets" ? data as AssetsSecondaryDto : null;
  $: liabilities = kind === "liabilities" ? data as LiabilitiesSecondaryDto : null;
  $: spending = kind === "spending" ? data as SpendingSecondaryDto : null;

  function amountText(amount: { coefficient: string; scale: number; currency: string } | null) {
    if (!amount) return $locale === "zh-TW" ? "金額未提供" : "Amount unavailable";
    return formatMoney({ currency: amount.currency, value: exactToNumber(amount), exact: amount }, { locale: $locale });
  }

  function recordLabel(record: NonNullable<SpendingSecondaryDto["purchaseReport"]>["records"][number]) {
    return record.description
      ?? record.invoice?.revision.seller.name
      ?? record.transaction?.description
      ?? ($locale === "zh-TW" ? "未提供描述" : "Description unavailable");
  }

  function basisLabel(value: string) {
    if (value === "linked") return $locale === "zh-TW" ? "已配對購買" : "Linked purchase";
    if (value === "invoice") return $locale === "zh-TW" ? "電子發票購買" : "E-Invoice purchase";
    if (value === "refund") return $locale === "zh-TW" ? "退款" : "Refund";
    return $locale === "zh-TW" ? "銀行交易" : "Bank transaction";
  }
</script>

<section
  class="card route-secondary-state"
  data-secondary-ready
  data-secondary-fallback={kind}
  data-secondary-knowledge-point={data.knowledgePoint}
  aria-labelledby="secondary-fallback-title"
>
  <div class="secondary-fallback-heading">
    <div>
      <p class="eyebrow">{$locale === "zh-TW" ? "次要資料" : "Secondary data"}</p>
      <h2 id="secondary-fallback-title">
        {kind === "overview"
          ? ($locale === "zh-TW" ? "歷史與資產流向" : "History and portfolio flow")
          : kind === "assets"
            ? ($locale === "zh-TW" ? "資產歷史" : "Asset history")
            : kind === "liabilities"
              ? ($locale === "zh-TW" ? "負債歷史" : "Liability history")
              : ($locale === "zh-TW" ? "購買與候選配對" : "Purchases and candidate matches")}
      </h2>
    </div>
    <span class="chip">{$locale === "zh-TW" ? `知識點 ${data.knowledgePoint}` : `Knowledge point ${data.knowledgePoint}`}</span>
  </div>

  {#if overview}
    {#if overview.dailyHistory.length > 0}
      <section class="secondary-fallback-panel" aria-label={$locale === "zh-TW" ? "歷史快照" : "Snapshot history"}>
        <h3>{$locale === "zh-TW" ? "歷史快照" : "Snapshot history"}</h3>
        <DailyHistoryTable rows={overview.dailyHistory} compact paginate />
      </section>
    {/if}
    {#if overview.sankey}
      <section class="secondary-fallback-panel" aria-label={$locale === "zh-TW" ? "資產流向" : "Portfolio flow"}>
        <h3>{$locale === "zh-TW" ? "資產流向" : "Portfolio flow"}</h3>
        <OverviewSankeyCard
          graph={overview.sankey}
          exchangeRates={overview.sankeyExchangeRates}
        />
      </section>
    {/if}
    {#if overview.dailyHistory.length === 0 && !overview.sankey}
      <p class="panel-meta">{$locale === "zh-TW" ? "目前沒有可呈現的歷史資料。" : "No history is available for this generation."}</p>
    {/if}
  {:else if assets}
    <section class="secondary-fallback-panel" aria-label={$locale === "zh-TW" ? "資產餘額歷史" : "Asset balance history"}>
      <h3>{$locale === "zh-TW" ? "資產餘額歷史" : "Asset balance history"}</h3>
      <DailyHistoryTable rows={assets.dailyHistory} compact paginate />
    </section>
  {:else if liabilities}
    <section class="secondary-fallback-panel" aria-label={$locale === "zh-TW" ? "負債餘額歷史" : "Liability balance history"}>
      <h3>{$locale === "zh-TW" ? "負債餘額歷史" : "Liability balance history"}</h3>
      <DailyHistoryTable rows={liabilities.dailyHistory} compact paginate />
    </section>
  {:else if spending}
    <section class="secondary-fallback-panel" aria-label={$locale === "zh-TW" ? "唯讀購買明細" : "Read-only purchase records"}>
      <h3>{$locale === "zh-TW" ? "唯讀購買明細" : "Read-only purchase records"}</h3>
      <p class="panel-meta">
        {$locale === "zh-TW"
          ? `${spending.purchaseReport.records.length} 筆紀錄，${spending.purchaseReport.candidates.filter((candidate) => candidate.status === "candidate").length} 筆待確認候選。主要資料目前無法載入，因此此區僅供檢視。`
          : `${spending.purchaseReport.records.length} records and ${spending.purchaseReport.candidates.filter((candidate) => candidate.status === "candidate").length} pending candidates. Primary data is unavailable, so this section is read-only.`}
      </p>
      <div class="secondary-record-list" role="list">
        {#each spending.purchaseReport.records as record (record.purchaseId)}
          <article class="secondary-record" role="listitem" data-secondary-record={record.purchaseId}>
            <div>
              <strong>{recordLabel(record)}</strong>
              <span>{record.occurrence.value.slice(0, 10)} · {basisLabel(record.basis)}</span>
            </div>
            <strong class="money" data-sensitive>{amountText(record.amount)}</strong>
          </article>
        {:else}
          <p class="panel-meta">{$locale === "zh-TW" ? "目前沒有可呈現的購買紀錄。" : "No purchase records are available."}</p>
        {/each}
      </div>
      {#if spending.purchaseReport.candidates.some((candidate) => candidate.status === "candidate")}
        <p class="panel-meta" data-secondary-candidates>
          {$locale === "zh-TW" ? "候選配對已載入；請等主要資料恢復後再執行寫入操作。" : "Candidate matches are loaded; wait for primary data before performing a write action."}
        </p>
      {/if}
    </section>
  {/if}
</section>

<style>
  .route-secondary-state {
    display: grid;
    gap: var(--space-4);
    margin: 0 var(--space-4) var(--space-5);
    padding: var(--space-5);
  }

  .secondary-fallback-heading {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-4);
  }

  .secondary-fallback-heading h2,
  .secondary-fallback-panel h3 {
    margin: 0;
  }

  .secondary-fallback-panel {
    display: grid;
    gap: var(--space-3);
    min-width: 0;
  }

  .secondary-record-list {
    display: grid;
    gap: var(--space-2);
  }

  .secondary-record {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-4);
    padding: var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }

  .secondary-record > div {
    display: grid;
    gap: 4px;
    min-width: 0;
  }

  .secondary-record span,
  .panel-meta {
    color: var(--muted);
    font-size: var(--font-size-sm);
  }

  .secondary-record strong:first-child {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
