<script lang="ts">
  import PurchaseSpendingDashboard from "./components/PurchaseSpendingDashboard.svelte";
  import type { SpendingPageDto } from "./model.ts";

  export let spending: SpendingPageDto;
  export let refreshSummary: () => Promise<void> = async () => {};
</script>

<PurchaseSpendingDashboard
  {refreshSummary}
  purchaseReport={spending.purchaseReport}
  fallbackCanonical={spending.canonical}
/>
