<script lang="ts">
  import ManualMarker from "$lib/manual-assets/ManualMarker.svelte";
  import type { Provenance } from "$lib/shared-ledger/provenance.ts";
  import PreviewMarker from "./PreviewMarker.svelte";

  /** The origins the figure beside these markers counts. */
  export let provenance: Provenance;
  export let placement: "below" | "above" = "below";
  export let align: "start" | "end" = "start";
</script>

{#if provenance.preview}<PreviewMarker {placement} {align} />{/if}
{#if provenance.manual}<ManualMarker {placement} {align} />{/if}
