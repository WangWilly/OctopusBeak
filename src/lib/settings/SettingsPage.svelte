<script lang="ts">
  import { onMount } from "svelte";
  import { locale, localeLabels, locales, setLocale, t, type Locale } from "$lib/i18n/i18n.ts";
  import {
    DISPLAY_SCALE_DEFAULT,
    DISPLAY_SCALE_MAX,
    DISPLAY_SCALE_MIN,
    DISPLAY_SCALE_STEP,
    applyDisplayScale,
    displayScale,
  } from "$lib/settings/display-scale.ts";
  import DashboardShell from "$lib/shared-shell/components/DashboardShell.svelte";

  let displayScaleAvailable = false;
  let shortcutModifier = "Ctrl";

  onMount(() => {
    displayScaleAvailable = Boolean(window.octopusBeak?.display);
    shortcutModifier = navigator.platform.startsWith("Mac") ? "⌘" : "Ctrl";
  });

  function chooseLocale(value: Locale) {
    setLocale(value);
  }
</script>

<DashboardShell
  active="settings"
  eyebrow={$t.settings.eyebrow}
  title={$t.settings.title}
  sideLabel={$t.settings.sideLabel}
  sideValue={localeLabels[$locale]}
  sideSub={$t.settings.sideSub}
>
  <div class="content settings-content">
    <section class="card">
      <div class="panel-title">
        <div>
          <h2>{$t.settings.interfaceLanguage}</h2>
          <p class="lead">{$t.settings.languageDescription}</p>
        </div>
      </div>
      <div class="settings-body">
        <div class="language-options" aria-label={$t.settings.languageAria}>
          {#each locales as item}
            <button
              class="filter-btn"
              type="button"
              aria-pressed={$locale === item}
              onclick={() => chooseLocale(item)}
            >
              {localeLabels[item]}
            </button>
          {/each}
        </div>
        <p class="language-current">{$t.settings.currentLanguage(localeLabels[$locale])}</p>
      </div>
    </section>

    {#if displayScaleAvailable}
      <section class="card display-scale-card">
        <div class="panel-title">
          <div>
            <h2>{$t.settings.displaySize}</h2>
            <p class="lead">{$t.settings.displaySizeDescription}</p>
          </div>
        </div>
        <div class="display-scale-body">
          <output class="display-scale-value">{$displayScale}%</output>
          <div class="display-scale-slider">
            <input
              type="range"
              min={DISPLAY_SCALE_MIN}
              max={DISPLAY_SCALE_MAX}
              step={DISPLAY_SCALE_STEP}
              value={$displayScale}
              aria-label={$t.settings.displayScaleAria}
              oninput={(event) => applyDisplayScale((event.currentTarget as HTMLInputElement).valueAsNumber)}
            />
            <div class="display-scale-labels">
              <span>{DISPLAY_SCALE_MIN}%</span>
              <span>{DISPLAY_SCALE_DEFAULT}%</span>
              <span>{DISPLAY_SCALE_MAX}%</span>
            </div>
          </div>
          <button
            class="button"
            type="button"
            disabled={$displayScale === DISPLAY_SCALE_DEFAULT}
            onclick={() => applyDisplayScale(DISPLAY_SCALE_DEFAULT)}
          >{$t.settings.resetScale}</button>
          <div class="display-scale-shortcuts">
            <strong>{$t.settings.keyboardShortcuts}</strong>
            <span><kbd>{shortcutModifier} −</kbd>{$t.settings.decreaseScale}</span>
            <span><kbd>{shortcutModifier} +</kbd>{$t.settings.increaseScale}</span>
            <span><kbd>{shortcutModifier} 0</kbd>{$t.settings.resetScale}</span>
          </div>
          <p class="display-scale-range">
            {$t.settings.scaleRange(DISPLAY_SCALE_MIN, DISPLAY_SCALE_MAX)}
          </p>
        </div>
      </section>
    {/if}
  </div>
</DashboardShell>

<style>
  .settings-content {
    display: grid;
    gap: var(--space-6);
    max-width: 880px;
    margin: 0;
  }

  .settings-body {
    display: grid;
    gap: var(--space-4);
    padding: var(--space-5);
  }

  .language-options {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .language-current {
    margin: 0;
    color: var(--muted);
    font-size: 13px;
  }

  .display-scale-body {
    display: grid;
    grid-template-columns: auto minmax(240px, 1fr) auto;
    align-items: center;
    gap: var(--space-5);
    padding: var(--space-5);
  }

  .display-scale-value {
    min-width: 92px;
    font-size: 32px;
    font-weight: 750;
    font-variant-numeric: tabular-nums;
  }

  .display-scale-slider { display: grid; gap: var(--space-2); }
  .display-scale-slider input { width: 100%; accent-color: var(--accent); }
  .display-scale-labels { display: flex; justify-content: space-between; color: var(--muted); font-size: 12px; }

  .display-scale-shortcuts {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    gap: var(--space-4);
    padding-top: var(--space-4);
    border-top: 1px solid var(--border);
    color: var(--muted);
    font-size: 12px;
  }

  .display-scale-shortcuts span { display: inline-flex; align-items: center; gap: var(--space-2); }
  .display-scale-shortcuts kbd { padding: 5px 9px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-soft); color: var(--fg); font: inherit; }
  .display-scale-range { grid-column: 1 / -1; margin: 0; color: var(--muted); font-size: 12px; }

  @media (max-width: 760px) {
    .display-scale-body { grid-template-columns: 1fr; }
    .display-scale-shortcuts { grid-column: auto; align-items: flex-start; flex-direction: column; }
    .display-scale-range { grid-column: auto; }
  }
</style>
