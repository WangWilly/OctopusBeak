<script lang="ts">
  import CanonicalSpendingDashboard from "./components/CanonicalSpendingDashboard.svelte";
  import PurchaseSpendingDashboard from "./components/PurchaseSpendingDashboard.svelte";
  import type { SpendingPageDto } from "./model.ts";
  import type { BlockState } from "$lib/shared-shell/block-load-state.ts";
  import type { DashboardBlockPayload } from "$lib/shared-shell/dashboard-blocks.ts";
  import { isEmptySpendingPage } from "$lib/shared-shell/progressive-dashboard-data.ts";

  export let spending: SpendingPageDto;
  export let refreshSummary: () => Promise<void> = async () => {};
  export let blocks: Readonly<Record<string, BlockState<DashboardBlockPayload>>> = {};
  export let retryBlock: (key: string) => void = () => {};
</script>

{#if isEmptySpendingPage(spending)}
  <CanonicalSpendingDashboard
    spending={spending.canonical}
    invoices={spending.invoices}
    {blocks}
    {retryBlock}
  />
{:else if spending.purchaseReport}
  <PurchaseSpendingDashboard
    {refreshSummary}
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
