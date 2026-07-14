<script lang="ts">
  import { onMount } from "svelte";
  import "../app.css";

  onMount(() => {
    if ("octopusBeak" in window) {
      document.documentElement.classList.add("desktop-shell");
      if (navigator.platform.startsWith("Mac")) document.documentElement.classList.add("macos-shell");
    }
  });
</script>

<slot />
