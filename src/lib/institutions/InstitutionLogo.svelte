<script lang="ts">
  import { institutionLogoFile, type InstitutionKey } from "./institutions.ts";

  export let institution: InstitutionKey | null;
  export let size = 20;

  const logos = import.meta.glob<string>("../../../site/assets/logos/*.webp", {
    eager: true,
    query: "?url",
    import: "default",
  });

  $: src = institution ? logos[`../../../site/assets/logos/${institutionLogoFile(institution)}`] : undefined;
</script>

{#if src}
  <img class="institution-logo" {src} width={size} height={size} alt="" decoding="async" />
{/if}

<style>
  .institution-logo {
    flex: none;
    object-fit: contain;
    border-radius: 4px;
  }
</style>
