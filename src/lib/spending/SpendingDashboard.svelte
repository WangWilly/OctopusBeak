<script lang="ts">
  import CanonicalSpendingDashboard from "./components/CanonicalSpendingDashboard.svelte";
  import PurchaseSpendingDashboard from "./components/PurchaseSpendingDashboard.svelte";
  import type { SpendingPageDto } from "./model.ts";

  export let spending: SpendingPageDto;
</script>

{#if spending.purchaseReport}
  <PurchaseSpendingDashboard
    purchaseReport={spending.purchaseReport}
    fallbackCanonical={spending.canonical}
  />
{:else}
  <CanonicalSpendingDashboard spending={spending.canonical} invoices={spending.invoices} />
{/if}
