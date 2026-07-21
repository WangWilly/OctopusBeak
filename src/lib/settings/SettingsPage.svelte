<script lang="ts">
  import { onMount } from "svelte";
  import { CircleAlert, CircleCheck } from "@lucide/svelte";
  import { isMacPlatform } from "$lib/desktop/platform.ts";
  import { locale, localeLabels, locales, setLocale, t, type Locale } from "$lib/i18n/i18n.ts";
  import {
    DISPLAY_SCALE_DEFAULT,
    DISPLAY_SCALE_MAX,
    DISPLAY_SCALE_MIN,
    DISPLAY_SCALE_STEP,
    applyDisplayScale,
    displayScale,
    supportsDisplayScale,
  } from "$lib/settings/display-scale.ts";
  import {
    applySystemSettings,
    exchangeRateUpdateTime,
    systemTimezone,
  } from "$lib/settings/system-timezone-store.ts";
  import DashboardShell from "$lib/shared-shell/components/DashboardShell.svelte";

  const timezones = ["Asia/Taipei", "Asia/Tokyo", "America/New_York", "Europe/London", "UTC"];
  const hours = Array.from({ length: 12 }, (_, index) => String(index + 1).padStart(2, "0"));
  const minutes = Array.from({ length: 60 }, (_, index) => String(index).padStart(2, "0"));
  let displayScaleAvailable = false;
  let shortcutModifier = "Ctrl";
  let selectedTimezone = $systemTimezone;
  $: timezoneOptions = timezones.includes(selectedTimezone)
    ? timezones
    : [selectedTimezone, ...timezones];
  let selectedUpdateTime = $exchangeRateUpdateTime;
  let selectedHour = "06";
  let selectedMinute = "00";
  let selectedMeridiem = "AM";
  let saveStatus: "pending" | "success" | "error" = "success";
  let saveError = "";
  let saveVersion = 0;
  let saveQueue = Promise.resolve();

  setSelectedUpdateTime(selectedUpdateTime);

  onMount(() => {
    displayScaleAvailable = supportsDisplayScale(window.octopusBeak);
    shortcutModifier = isMacPlatform(navigator) ? "⌘" : "Ctrl";
  });

  function chooseLocale(value: Locale) {
    setLocale(value);
  }

  function setSelectedUpdateTime(value: string) {
    selectedUpdateTime = value;
    const [hour, minute] = value.split(":").map(Number);
    selectedHour = String(hour % 12 || 12).padStart(2, "0");
    selectedMinute = String(minute).padStart(2, "0");
    selectedMeridiem = hour < 12 ? "AM" : "PM";
  }

  function selectedTime() {
    const hour = Number(selectedHour) % 12 + (selectedMeridiem === "PM" ? 12 : 0);
    return `${String(hour).padStart(2, "0")}:${selectedMinute}`;
  }

  function saveSystemSettings() {
    const version = ++saveVersion;
    const input = {
      systemTimezone: selectedTimezone,
      exchangeRateUpdateTime: selectedUpdateTime,
    };
    saveStatus = "pending";
    saveError = "";
    saveQueue = saveQueue.catch(() => undefined).then(async () => {
      try {
        const value = await window.octopusBeak.settings.save(input);
        if (version !== saveVersion) return;
        applySystemSettings(value);
        selectedTimezone = value.systemTimezone;
        setSelectedUpdateTime(value.exchangeRateUpdateTime);
        saveStatus = "success";
      } catch (error) {
        if (version !== saveVersion) return;
        saveError = error instanceof Error ? error.message : String(error);
        saveStatus = "error";
      }
    });
  }

  function updateScheduledTime() {
    selectedUpdateTime = selectedTime();
    saveSystemSettings();
  }

  function changeDisplayScale(value: number) {
    applyDisplayScale(value);
  }

  function saveTimezone() {
    saveSystemSettings();
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
  <svelte:fragment slot="topbar-actions">
    <span
      id="settings-save-status"
      class:pending={saveStatus === "pending"}
      class:error={saveStatus === "error"}
      class="settings-save-status"
      role={saveStatus === "error" ? "alert" : "status"}
      aria-live="polite"
    >
      {#if saveStatus === "error"}
        <CircleAlert size={18} strokeWidth={2.25} aria-hidden="true" />
        {$t.settings.settingsSaveFailed(saveError)}
      {:else}
        <CircleCheck size={18} strokeWidth={2.25} aria-hidden="true" />
        {saveStatus === "pending" ? $t.settings.saving : $t.settings.allChangesSaved}
      {/if}
    </span>
  </svelte:fragment>

  <div class="content settings-content">
    <section class="card settings-group schedule-group">
      <div class="panel-title group-title">
        <div>
          <h2>{$t.settings.scheduleSettings}</h2>
          <p class="lead">{$t.settings.systemSettingsDescription}</p>
        </div>
      </div>
      <div class="settings-rows">
        <div class="setting-row">
          <label for="system-timezone">{$t.settings.systemTimezone}</label>
          <select id="system-timezone" bind:value={selectedTimezone} onchange={saveTimezone}>
            {#each timezoneOptions as timezone}<option value={timezone}>{timezone}</option>{/each}
          </select>
        </div>
        <div class="setting-row">
          <span class="setting-label">{$t.settings.exchangeRateUpdateTime}</span>
          <div class="time-selects" aria-label={$t.settings.exchangeRateUpdateTime}>
            <select id="update-hour" aria-label={$t.settings.hour} bind:value={selectedHour} onchange={updateScheduledTime}>
              {#each hours as hour}<option value={hour}>{hour}</option>{/each}
            </select>
            <select id="update-minute" aria-label={$t.settings.minute} bind:value={selectedMinute} onchange={updateScheduledTime}>
              {#each minutes as minute}<option value={minute}>{minute}</option>{/each}
            </select>
            <select id="update-meridiem" aria-label={$t.settings.meridiem} bind:value={selectedMeridiem} onchange={updateScheduledTime}>
              <option value="AM">AM</option><option value="PM">PM</option>
            </select>
          </div>
        </div>
      </div>
    </section>

    <section class="card settings-group personal-group">
      <div class="panel-title group-title">
        <div>
          <h2>{$t.settings.languageDisplaySettings}</h2>
          <p class="lead">{$t.settings.languageDescription} {$t.settings.displaySizeDescription}</p>
        </div>
      </div>
      <div class="settings-rows">
        <div class="setting-row">
          <span class="setting-label">{$t.settings.interfaceLanguage}</span>
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
        </div>
        {#if displayScaleAvailable}
          <div class="setting-row scale-row">
            <span class="setting-label">{$t.settings.displaySize}</span>
            <div class="scale-controls">
              <button class="scale-step" type="button" aria-label={$t.settings.decreaseScale} disabled={$displayScale <= DISPLAY_SCALE_MIN} onclick={() => changeDisplayScale($displayScale - DISPLAY_SCALE_STEP)}>−</button>
              <output class="display-scale-value">{$displayScale}%</output>
              <button class="scale-step" type="button" aria-label={$t.settings.increaseScale} disabled={$displayScale >= DISPLAY_SCALE_MAX} onclick={() => changeDisplayScale($displayScale + DISPLAY_SCALE_STEP)}>＋</button>
              <small class="display-scale-shortcuts">{shortcutModifier}− {$t.settings.decreaseScale} · {shortcutModifier}+ {$t.settings.increaseScale} · {shortcutModifier}0 {$t.settings.resetScale}</small>
              <button class="button secondary scale-reset" type="button" disabled={$displayScale === DISPLAY_SCALE_DEFAULT} onclick={() => changeDisplayScale(DISPLAY_SCALE_DEFAULT)}>{$t.settings.resetScale}</button>
              <p class="display-scale-range">{$t.settings.scaleRange(DISPLAY_SCALE_MIN, DISPLAY_SCALE_MAX)}</p>
            </div>
          </div>
        {/if}
      </div>
    </section>
  </div>
</DashboardShell>

<style>
  .settings-content {
    display: grid;
    gap: var(--space-5);
    max-width: 1060px;
    margin: 0;
  }

  .settings-save-status {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--success);
    font-size: 13px;
    font-weight: 720;
  }

  .settings-save-status.pending { color: var(--muted); }
  .settings-save-status.error { color: var(--danger); }

  .settings-group { overflow: hidden; }
  .settings-group .group-title { padding: var(--space-5); background: linear-gradient(105deg, #e7e7e7, #fff); }
  .group-title h2 { color: var(--fg); }

  .settings-rows { display: grid; }
  .setting-row {
    display: grid;
    grid-template-columns: minmax(180px, 1fr) minmax(320px, 430px);
    align-items: center;
    gap: var(--space-5);
    min-height: 88px;
    margin: 0 var(--space-5);
    border-bottom: 1px solid var(--border);
  }

  .setting-row:last-child { border-bottom: 0; }
  .setting-row > label,
  .setting-label { font-size: 14px; font-weight: 720; }
  .setting-row select { width: 100%; min-height: 44px; padding: 0 var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--fg); font: inherit; }

  .time-selects { display: grid; grid-template-columns: 1fr 1fr 96px; gap: var(--space-2); }

  .language-options {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .scale-controls {
    display: grid;
    grid-template-columns: 44px auto 44px minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--space-3);
  }

  .scale-row { grid-template-columns: 160px minmax(0, 1fr); }

  .display-scale-value {
    min-width: 70px;
    text-align: center;
    font-size: 26px;
    font-weight: 750;
    font-variant-numeric: tabular-nums;
  }

  .scale-step { width: 44px; min-height: 44px; padding: 0; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--fg); font-size: 22px; cursor: pointer; }
  .scale-step:hover { background: var(--surface-soft); }
  .scale-reset { justify-self: end; }

  .display-scale-shortcuts {
    min-width: 0;
    color: var(--muted);
    font-size: 11px;
    line-height: 1.6;
    white-space: nowrap;
  }

  .display-scale-range { grid-column: 1 / -1; margin: 0; color: var(--muted); font-size: 12px; }

  @media (max-width: 760px) {
    .setting-row { grid-template-columns: 1fr; gap: var(--space-3); padding: var(--space-4) 0; }
    .scale-row { grid-template-columns: 1fr; }
    .time-selects { max-width: 100%; }
    .scale-controls { grid-template-columns: 44px auto 44px 1fr; }
    .display-scale-shortcuts { white-space: normal; }
    .scale-reset { grid-column: 1 / -1; justify-self: start; }
  }
</style>
