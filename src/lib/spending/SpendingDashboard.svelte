<script lang="ts">
  import CanonicalSpendingDashboard from "./components/CanonicalSpendingDashboard.svelte";
  import PurchaseSpendingDashboard from "./components/PurchaseSpendingDashboard.svelte";
  import type { SpendingPageDto } from "./model.ts";
  import type {
    SpendingActionReconciliationOptions,
    SpendingPendingCommandIdentity,
  } from "./spending-action-lifecycle.ts";

  export let spending: SpendingPageDto;
  /** Reconcile a stale rejection or uncertain write using a fresh Spending generation. */
  export let onActionReconciliation: ((
    identity?: SpendingPendingCommandIdentity,
    options?: SpendingActionReconciliationOptions,
  ) => Promise<void>) | undefined = undefined;
  /** Purchase matching is secondary data and may lag the canonical primary view. */
  export let purchaseReportReady = true;
</script>

{#if purchaseReportReady && spending.purchaseReport}
  <PurchaseSpendingDashboard
    purchaseReport={spending.purchaseReport}
    fallbackCanonical={spending.canonical}
    {onActionReconciliation}
  />
{:else}
  <CanonicalSpendingDashboard
    spending={spending.canonical}
    invoices={purchaseReportReady ? spending.invoices : []}
  />
{/if}
