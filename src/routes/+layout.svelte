<script lang="ts">
  import { onMount } from "svelte";
  import { isMacPlatform } from "$lib/desktop/platform.ts";
  import "../app.css";

  onMount(() => {
    if ("octopusBeak" in window) {
      document.documentElement.classList.add("desktop-shell");
      if (isMacPlatform(navigator)) document.documentElement.classList.add("macos-shell");
    }
  });
</script>

<slot />
