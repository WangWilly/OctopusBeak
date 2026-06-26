<script lang="ts">
  import AssetsDashboard from "$lib/assets/AssetsDashboard.svelte";
  import type { PageData } from "./$types";

  export let data: PageData;
</script>

<svelte:head>
  <title>LedgerLens Assets</title>
</svelte:head>

<AssetsDashboard assets={data.assets} />
