<script lang="ts">
  import { t } from "$lib/i18n/i18n.ts";
  import type { PersonalCategoryCode } from "../../../ledger/canonical/personal-category-codes.ts";
  import { SPENDING_CATEGORY_GROUP_IDS, type SpendingCategoryGroup } from "../category-groups.ts";
  import { CLASSIFY_CODE_KEYS, classifyGroupCodes, classifyGroupKey } from "../classify-inbox.ts";
  import { SPENDING_GROUP_COLORS } from "../spending-display.ts";

  export let group: SpendingCategoryGroup | null;
  export let code: PersonalCategoryCode | null;
  export let disabled = false;
  export let onGroup: (group: SpendingCategoryGroup) => void;
  export let onCode: (code: PersonalCategoryCode) => void;

  $: codes = group ? classifyGroupCodes(group) : [];
</script>

<div class="picker" data-category-key-picker>
  <div class="groups" role="group" aria-label={$t.classifyInbox.groupsAria}>
    {#each SPENDING_CATEGORY_GROUP_IDS as id (id)}
      <button
        type="button"
        class="key-option"
        aria-pressed={group === id}
        aria-keyshortcuts={classifyGroupKey(id)}
        data-picker-group={id}
        {disabled}
        onclick={() => onGroup(id)}
      >
        <kbd>{classifyGroupKey(id)}</kbd>
        <span class="dot" style:background={SPENDING_GROUP_COLORS[id]} aria-hidden="true"></span>
        {$t.spending.categoryGroups[id]}
      </button>
    {/each}
  </div>
  {#if group}
    <div class="codes" role="group" aria-label={$t.classifyInbox.codesAria}>
      {#each codes as option, index (option)}
        <button
          type="button"
          class="key-option"
          aria-pressed={code === option}
          aria-keyshortcuts={CLASSIFY_CODE_KEYS[index]?.toUpperCase()}
          data-picker-code={option}
          {disabled}
          onclick={() => onCode(option)}
        >
          <kbd>{CLASSIFY_CODE_KEYS[index]?.toUpperCase()}</kbd>
          {$t.spending.personalCategories[option]}
          {#if index === 0}<span class="default-tag">{$t.classifyInbox.defaultCode}</span>{/if}
        </button>
      {/each}
    </div>
  {:else}
    <p class="hint">{$t.classifyInbox.pickGroup}</p>
  {/if}
</div>

<style>
  .picker { display: grid; gap: var(--space-2); }
  .groups, .codes { display: flex; flex-wrap: wrap; gap: 6px; }
  .key-option { display: inline-flex; align-items: center; gap: 6px; min-height: 32px; padding: 0 10px 0 6px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--fg); font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
  .key-option:hover:not(:disabled, [aria-pressed="true"]) { background: var(--surface-soft); }
  .key-option[aria-pressed="true"] { border-color: var(--fg); background: var(--fg); color: var(--surface); }
  .key-option:disabled { cursor: default; opacity: 0.55; }
  .key-option:focus-visible { outline: none; box-shadow: 0 0 0 3px color-mix(in oklch, var(--accent) 18%, transparent); }
  kbd { display: inline-grid; place-items: center; min-width: 20px; height: 20px; padding: 0 4px; border: 1px solid var(--border); border-radius: 5px; background: var(--surface-soft); color: var(--muted); font-family: var(--font-body); font-size: 11px; font-weight: 700; }
  .key-option[aria-pressed="true"] kbd { border-color: transparent; background: color-mix(in oklch, var(--surface) 22%, transparent); color: var(--surface); }
  .dot { flex: none; width: 7px; height: 7px; border-radius: 999px; }
  .default-tag { padding: 1px 6px; border-radius: 999px; background: var(--accent-soft); color: var(--accent); font-size: 11px; font-weight: 700; }
  .hint { margin: 0; color: var(--muted); font-size: 12px; }
</style>
