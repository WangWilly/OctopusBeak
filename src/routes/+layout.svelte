<script lang="ts">
  import { onMount } from "svelte";
  import "../app.css";

  onMount(() => {
    if ("octopusBeak" in window) document.documentElement.classList.add("desktop-shell");
  });
</script>

<slot />
