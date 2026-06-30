<script lang="ts">
  import AutomationDashboard from "$lib/automation/AutomationDashboard.svelte";
  import type { PageData } from "./$types";

  export let data: PageData;
</script>

<svelte:head>
  <title>OctopusBeak Automation</title>
</svelte:head>

<AutomationDashboard automation={data.automation} credentialKeys={data.credentialKeys} />
