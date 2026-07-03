<script lang="ts">
  import { t } from "$lib/i18n/i18n.ts";

  export let visible = true;
</script>

<button
  class="switch"
  type="button"
  aria-pressed={visible}
  on:click={() => (visible = !visible)}
>
  <span>{$t.common.valuesVisible}</span>
  <span class="switch-track" aria-hidden="true"></span>
</button>
