<script lang="ts">
  import PurchaseSpendingDashboard from "./components/PurchaseSpendingDashboard.svelte";
  import type { SpendingPageDto } from "./model.ts";
  import type { BlockState } from "$lib/shared-shell/block-load-state.ts";
  import type { DashboardBlockPayload } from "$lib/shared-shell/dashboard-blocks.ts";

  export let spending: SpendingPageDto;
  export let refreshSummary: () => Promise<void> = async () => {};
  export let blocks: Readonly<Record<string, BlockState<DashboardBlockPayload>>> = {};
  export let retryBlock: (key: string) => void = () => {};
</script>

<PurchaseSpendingDashboard
  {refreshSummary}
  purchaseReport={spending.purchaseReport}
  fallbackCanonical={spending.canonical}
  {blocks}
  {retryBlock}
/>
