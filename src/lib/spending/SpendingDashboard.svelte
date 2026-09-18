<script lang="ts">
  import CanonicalSpendingDashboard from "./components/CanonicalSpendingDashboard.svelte";
  import PurchaseSpendingDashboard from "./components/PurchaseSpendingDashboard.svelte";
  import type { SpendingPageDto } from "./model.ts";

  export let spending: SpendingPageDto;
  /** Reconcile an uncertain write by loading a fresh Spending generation. */
  export let onActionReconciliation: (() => Promise<void>) | undefined = undefined;
</script>

{#if spending.purchaseReport}
  <PurchaseSpendingDashboard
    purchaseReport={spending.purchaseReport}
    fallbackCanonical={spending.canonical}
    {onActionReconciliation}
  />
{:else}
  <CanonicalSpendingDashboard spending={spending.canonical} invoices={spending.invoices} />
{/if}
