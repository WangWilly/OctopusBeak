<script lang="ts">
  import LiabilitiesDashboard from "$lib/liabilities/LiabilitiesDashboard.svelte";
  import type { PageData } from "./$types";

  export let data: PageData;
</script>

<svelte:head>
  <title>LedgerLens Liabilities</title>
</svelte:head>

<LiabilitiesDashboard liabilities={data.liabilities} />
