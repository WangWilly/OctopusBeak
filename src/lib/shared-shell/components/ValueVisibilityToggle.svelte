<script lang="ts">
  import { t } from "$lib/i18n/i18n.ts";

  export let visible = true;
</script>

<button
  class="switch"
  type="button"
  aria-label={$t.common.valuesVisible}
  aria-pressed={visible}
  title={$t.common.valuesVisible}
  onclick={() => (visible = !visible)}
>
  <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
    <path fill="currentColor" d="M12 5c-5.2 0-9.3 4.5-10 6.4a1.8 1.8 0 0 0 0 1.2C2.7 14.5 6.8 19 12 19s9.3-4.5 10-6.4a1.8 1.8 0 0 0 0-1.2C21.3 9.5 17.2 5 12 5Zm0 12c-4 0-7.5-3.4-8.2-5 .7-1.6 4.2-5 8.2-5s7.5 3.4 8.2 5c-.7 1.6-4.2 5-8.2 5Zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z" />
  </svg>
  <span class="switch-track" aria-hidden="true"></span>
</button>
