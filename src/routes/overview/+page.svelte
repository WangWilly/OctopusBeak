<script lang="ts">
  import OverviewDashboard from "$lib/overview/OverviewDashboard.svelte";
  import type { PageData } from "./$types";

  export let data: PageData;
</script>

<svelte:head>
  <title>LedgerLens Overview</title>
</svelte:head>

<OverviewDashboard overview={data.overview} />
