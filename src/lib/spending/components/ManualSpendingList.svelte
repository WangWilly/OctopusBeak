<script lang="ts">
  import { locale, t } from "$lib/i18n/i18n.ts";
  import ManualMarker from "$lib/manual-assets/ManualMarker.svelte";
  import { exactFromManualAmount } from "$lib/manual-assets/manual-assets.ts";
  import { spendingCategoryGroup } from "$lib/spending/category-groups.ts";
  import type { ManualSpendingPurchase } from "$lib/spending/manual-spending.ts";
  import type { CategoryBreakdownKey } from "$lib/spending/spending-insights.ts";
  import { moneyText } from "./money-text.ts";

  export let purchases: readonly ManualSpendingPurchase[] = [];
  export let month: string;
  export let day: string | null = null;
  export let group: CategoryBreakdownKey | null = null;
  export let query = "";

  $: needle = query.trim().toLowerCase();
  $: shown = purchases.filter((purchase) =>
    purchase.occurredOn.startsWith(`${month}-`)
    && (day === null || purchase.occurredOn === day)
    && (group === null || (purchase.personalCategory === null ? group === "unclassified" : spendingCategoryGroup(purchase.personalCategory) === group))
    && (needle === "" || `${purchase.accountName} ${purchase.note ?? ""}`.toLowerCase().includes(needle)));
</script>

{#if shown.length > 0}
  <section class="manual-spending" aria-labelledby="manual-spending-title" data-manual-spending>
    <div class="head">
      <h3 id="manual-spending-title">{$t.manualAssets.spendingTitle}</h3>
      <ManualMarker align="end" />
    </div>
    <p class="note">{$t.manualAssets.spendingNote}</p>
    <ul>
      {#each shown as purchase (purchase.transactionId)}
        <li data-manual-purchase={purchase.personalCategory ?? "unclassified"}>
          <span class="date num">{purchase.occurredOn}</span>
          <span class="what">
            <strong>{purchase.note ?? purchase.accountName}</strong>
            <small>{purchase.accountName} · {purchase.personalCategory ? $t.spending.personalCategories[purchase.personalCategory] : $t.manualAssets.unclassified}</small>
          </span>
          <span class="money" data-sensitive>{moneyText({ ...exactFromManualAmount(purchase.amount), currency: purchase.currency }, $locale)}</span>
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .manual-spending {
    margin-top: var(--space-4);
    padding-top: var(--space-4);
    border-top: 1px solid var(--border);
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }

  h3 {
    margin: 0;
    font-size: 13px;
    font-weight: 700;
  }

  .note {
    margin: var(--space-1) 0 var(--space-3);
    color: var(--muted);
    font-size: 12px;
  }

  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) 0;
  }

  li + li {
    border-top: 1px solid var(--border);
  }

  .date {
    color: var(--muted);
    font-size: 12px;
  }

  .what {
    display: grid;
    min-width: 0;
  }

  .what strong {
    overflow: hidden;
    font-size: 13px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .what small {
    color: var(--muted);
    font-size: 12px;
  }

  .money {
    font-weight: 650;
  }
</style>
