<script lang="ts">
  import CanonicalSpendingDashboard from "./components/CanonicalSpendingDashboard.svelte";
  import PurchaseSpendingDashboard from "./components/PurchaseSpendingDashboard.svelte";
  import type { SpendingPageDto } from "./model.ts";
  import type { BlockState } from "$lib/shared-shell/block-load-state.ts";

  export let spending: SpendingPageDto;
  export let blocks: Readonly<Record<string, BlockState<unknown>>> = {};
  export let retryBlock: (key: string) => void = () => {};
</script>

{#if spending.purchaseReport}
  <PurchaseSpendingDashboard
    purchaseReport={spending.purchaseReport}
    fallbackCanonical={spending.canonical}
    {blocks}
    {retryBlock}
  />
{:else}
  <CanonicalSpendingDashboard
    spending={spending.canonical}
    invoices={spending.invoices}
    {blocks}
    {retryBlock}
  />
{/if}
