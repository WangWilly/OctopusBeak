<script lang="ts">
  import CanonicalSpendingDashboard from "./components/CanonicalSpendingDashboard.svelte";
  import type { SpendingPageDto } from "./model.ts";

  export let spending: SpendingPageDto;
</script>

<CanonicalSpendingDashboard spending={spending.canonical} />
