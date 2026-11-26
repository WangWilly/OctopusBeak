<script lang="ts">
  import { getContext, onMount, tick } from "svelte";
  import { readable } from "svelte/store";
  import {
    ChartColumn,
    Check,
    ChevronsUpDown,
    CircleAlert,
    CircleCheck,
    CircleHelp,
    CircleStop,
    Clock,
    Compass,
    DatabaseZap,
    Download,
    FlaskConical,
    FolderOpen,
    Globe,
    Languages,
    RotateCcw,
  } from "@lucide/svelte";
  import { isMacPlatform } from "$lib/desktop/platform.ts";
  import {
    cleanupEstimateView,
    cleanupProgressBar,
    megabytes,
    resumeLedgerCleanup,
    runLedgerCleanup,
    type LedgerCleanupView,
  } from "$lib/settings/ledger-cleanup.ts";
  import {
    ledgerResetChoices,
    runLedgerReset,
    tickLedgerResetPart,
    type LedgerResetOutcome,
  } from "$lib/settings/ledger-reset.ts";
  import Modal from "$lib/shared-shell/components/Modal.svelte";
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
    nextDailyRun,
    utcOffsetLabel,
    type ExchangeRateRun,
  } from "$lib/settings/settings-status.ts";
  import {
    applySystemSettings,
    exchangeRateUpdateTime,
    previewFeaturesEnabled,
    usageStatisticsEnabled,
    appUpdatesAutoDownload,
    appUpdatesEnabled,
    scheduledCollection,
    systemTimezone,
  } from "$lib/settings/system-timezone-store.ts";
  import { dateInTimeZone } from "$lib/shared-ledger/twd-valuation.ts";
  import DashboardShell from "$lib/shared-shell/components/DashboardShell.svelte";
  import type { AppUpdateState } from "$lib/settings/app-updates.ts";
  import {
    APP_UPDATE_CONTEXT_KEY,
    downloadPercent,
    type AppUpdateUiContext,
  } from "$lib/shared-shell/app-update-context.ts";
  import type { CleanupBackupDto, LedgerResetPart, SettingsFocus, SignInDataStatus } from "$lib/desktop/api.ts";
  import { signInDataGuidance } from "$lib/automation/credentials-unreadable.ts";
  import { activeSectionAt } from "$lib/settings/section-spy.ts";

  export let onboardingStatus: "active" | "exited" | "completed" | null = null;
  /** When onboarding completed or exited; null for records from before it was kept. */
  export let onboardingEndedAt: string | null = null;
  export let onboardingLinkedSources = 0;
  export let onboardingFirstSyncSucceeded = false;
  export let exchangeRateLastRun: ExchangeRateRun | null = null;
  export let onRestartOnboarding: () => void = () => {};
  export let onboardingRestartPending = false;
  export let onboardingRestartError: string | null = null;
  /** Opened from a notification or a source waiting for a Canonical Reset: show that section. */
  export let focus: SettingsFocus | null = null;
  export let onFocused: () => void = () => {};

  const SECTIONS = [
    { id: "settings-schedule", icon: Clock },
    { id: "settings-display", icon: Languages },
    { id: "settings-preview", icon: FlaskConical },
    { id: "settings-usage", icon: ChartColumn },
    { id: "settings-updates", icon: Download },
    { id: "settings-data", icon: DatabaseZap },
    { id: "settings-onboarding", icon: Compass },
  ] as const;
  const SCALE_TICKS = [75, 100, 125, 150];
  const timezones = ["Asia/Taipei", "Asia/Tokyo", "America/New_York", "Europe/London", "UTC"];
  const hours = Array.from({ length: 24 }, (_, index) => String(index).padStart(2, "0"));
  const minutes = Array.from({ length: 60 }, (_, index) => String(index).padStart(2, "0"));
  let displayScaleAvailable = false;
  /** The value under the slider thumb while dragging; the app zoom applies on release. */
  let draftScale: number | null = null;
  let shortcutModifier = "Ctrl";
  let activeSection: (typeof SECTIONS)[number]["id"] = SECTIONS[0].id;
  /** A section is the one being read once its heading passes this far below the window top, under the top bar. */
  const SECTION_READING_LINE = 120;
  /** A section chosen in the nav stays active until the person scrolls on their own; near the page end it may never reach the line. */
  let chosenSection: (typeof SECTIONS)[number]["id"] | null = null;
  let now = new Date();
  let selectedTimezone = $systemTimezone;
  $: timezoneOptions = timezones.includes(selectedTimezone)
    ? timezones
    : [selectedTimezone, ...timezones];
  let selectedUpdateTime = $exchangeRateUpdateTime;
  let selectedHour = "06";
  let selectedMinute = "00";
  let collectionEnabled = $scheduledCollection.enabled;
  let [collectionHour, collectionMinute] = $scheduledCollection.time.split(":");
  let previewEnabled = $previewFeaturesEnabled;
  let usageEnabled = $usageStatisticsEnabled;
  // The one-time question can be answered while Settings is open.
  $: usageEnabled = $usageStatisticsEnabled;
  let updatesEnabled = $appUpdatesEnabled;
  let updatesAutoDownload = $appUpdatesAutoDownload;
  const appUpdates = getContext<AppUpdateUiContext | undefined>(APP_UPDATE_CONTEXT_KEY);
  const updateView = appUpdates?.view ?? readable(null);
  $: updateState = $updateView?.state ?? null;
  $: updateLine = updateState ? updateStatusLine(updateState, $t, $systemTimezone) : "";
  let usagePayload: string | null = null;
  let usagePayloadStatus: "idle" | "pending" | "error" = "idle";
  /** The Reset ledger dialog: open while choosing and while the reset runs. */
  let resetOpen = false;
  let resetPending = false;
  let resetTicked: ReadonlySet<LedgerResetPart> = new Set();
  let resetOutcome: LedgerResetOutcome | null = null;
  $: resetChoices = ledgerResetChoices(resetTicked);
  /** Unknown until read; a failed read shows nothing extra rather than a guess. */
  let signInStatus: SignInDataStatus | null = null;
  let signInStatusRead = 0;
  $: signInGuidance = signInDataGuidance(signInStatus);
  let collectStatus: "idle" | "pending" | "started" | "error" = "idle";
  let cleanupView: LedgerCleanupView = { kind: "idle" };
  let cleanupStopping = false;
  // Stops following a cleanup once Settings closes; the cleanup itself goes on.
  const cleanupFollow = new AbortController();
  // Ticked by default (ADR 0156); offered only when the disk has room for the run and the backup.
  let cleanupKeepBackup = true;
  /** What the last run asked for, which Try again repeats. */
  let cleanupRequest = { backup: true, keepBackup: true };
  let cleanupBackup: CleanupBackupDto | null = null;
  let cleanupBackupStatus: "idle" | "confirming" | "pending" | "error" = "idle";
  $: cleanupBusy = cleanupView.kind === "checking" || cleanupView.kind === "running";
  $: cleanupBar = cleanupView.kind === "running" ? cleanupProgressBar(cleanupView.progress) : null;
  $: dataActionPending = resetPending || cleanupBusy || cleanupBackupStatus === "pending";
  let saveStatus: "idle" | "pending" | "success" | "error" = "idle";
  let saveError = "";
  let saveVersion = 0;
  let saveQueue = Promise.resolve();

  $: sectionTitles = {
    "settings-schedule": $t.settings.scheduleSettings,
    "settings-display": $t.settings.languageDisplaySettings,
    "settings-preview": $t.settings.previewFeatures,
    "settings-usage": $t.settings.usageStatistics,
    "settings-updates": $t.settings.appUpdates,
    "settings-data": $t.settings.dataSection,
    "settings-onboarding": $t.settings.onboardingSection,
  };
  $: timezoneName = zoneName(selectedTimezone, $locale);
  $: nextRun = nextDailyRun(selectedUpdateTime, selectedTimezone, now);
  $: nextCollectionRun = nextDailyRun(`${collectionHour}:${collectionMinute}`, selectedTimezone, now);
  $: scaleTickLabels = SCALE_TICKS.map((value) => ({
    value,
    offset: (value - DISPLAY_SCALE_MIN) / (DISPLAY_SCALE_MAX - DISPLAY_SCALE_MIN),
  }));
  $: onboardingMeta = onboardingSummary(
    onboardingStatus,
    onboardingEndedAt,
    onboardingLinkedSources,
    onboardingFirstSyncSucceeded,
    $t,
    $systemTimezone,
  );

  setSelectedUpdateTime(selectedUpdateTime);

  onMount(() => {
    displayScaleAvailable = supportsDisplayScale(window.octopusBeak);
    void readSignInStatus();
    void readCleanupBackup();
    // A cleanup started before Settings was left is still running in the worker, and its dialog shows again;
    // a failed one shows until the person starts again, across restarts.
    void resumeLedgerCleanup(window.octopusBeak.settings, showCleanup, { signal: cleanupFollow.signal });
    shortcutModifier = isMacPlatform(navigator) ? "⌘" : "Ctrl";
    const clock = setInterval(() => (now = new Date()), 60_000);
    // Every scroll re-reads every section, so a section still in view is never
    // skipped because it did not cross an edge this time.
    const followScroll = () => {
      const scroller = document.scrollingElement ?? document.documentElement;
      const id = activeSectionAt(
        SECTIONS.map((section) => ({ id: section.id, top: document.getElementById(section.id)?.getBoundingClientRect().top ?? Infinity })),
        SECTION_READING_LINE,
        scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2,
      );
      if (chosenSection) activeSection = chosenSection;
      else if (id) activeSection = id as typeof activeSection;
    };
    const releaseChoice = () => (chosenSection = null);
    // A press anywhere but the nav (the scrollbar, autoscroll) is the person taking over the scroll.
    const releaseOnPress = (event: PointerEvent) => {
      if (!(event.target instanceof Element && event.target.closest(".settings-nav"))) releaseChoice();
    };
    followScroll();
    window.addEventListener("scroll", followScroll, { passive: true, capture: true });
    window.addEventListener("resize", followScroll);
    for (const type of ["wheel", "touchmove", "keydown"] as const) window.addEventListener(type, releaseChoice, { passive: true });
    window.addEventListener("pointerdown", releaseOnPress, { passive: true });
    return () => {
      cleanupFollow.abort();
      clearInterval(clock);
      window.removeEventListener("scroll", followScroll, { capture: true });
      window.removeEventListener("resize", followScroll);
      for (const type of ["wheel", "touchmove", "keydown"] as const) window.removeEventListener(type, releaseChoice);
      window.removeEventListener("pointerdown", releaseOnPress);
    };
  });

  function zoneName(timeZone: string, language: Locale) {
    return new Intl.DateTimeFormat(language, { timeZone, timeZoneName: "shortGeneric" })
      .formatToParts(new Date())
      .find((part) => part.type === "timeZoneName")?.value ?? timeZone;
  }

  /** `M/D HH:mm` in the system timezone, as the rate schedule reads. */
  function scheduleTime(value: string, timeZone: string) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
      timeZone,
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(value)).map((part) => [part.type, part.value]));
    return `${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
  }

  function updateStatusLine(state: AppUpdateState, dictionary: typeof $t, timeZone: string) {
    switch (state.status) {
      case "off":
        return dictionary.settings.appUpdatesOff;
      case "unsupported":
        return state.reason === "not-in-applications"
          ? dictionary.settings.appUpdatesNotInApplications
          : dictionary.settings.appUpdatesDevelopmentBuild;
      case "idle":
        return state.checkedAt
          ? dictionary.settings.appUpdatesUpToDate(scheduleTime(state.checkedAt, timeZone))
          : dictionary.settings.appUpdatesNotChecked;
      case "checking":
        return dictionary.settings.appUpdatesChecking;
      case "available":
        return dictionary.settings.appUpdatesAvailable(state.release.version);
      case "downloading":
        return dictionary.settings.appUpdatesDownloading(
          state.release.version,
          downloadPercent(state.received, state.release.size),
        );
      case "installing":
        return dictionary.settings.appUpdatesInstalling(state.release.version);
      case "ready":
        return dictionary.settings.appUpdatesReady(state.version);
      case "failed":
        return state.code === "check-failed"
          ? dictionary.settings.appUpdatesFailed
          : dictionary.settings.appUpdatesDownloadFailed[state.code](state.release.version);
    }
  }

  function toggleAppUpdates() {
    updatesEnabled = !updatesEnabled;
    saveSystemSettings();
  }

  function toggleAppUpdatesAutoDownload() {
    updatesAutoDownload = !updatesAutoDownload;
    saveSystemSettings();
  }

  function onboardingSummary(
    status: typeof onboardingStatus,
    endedAt: string | null,
    linkedSources: number,
    firstSyncSucceeded: boolean,
    dictionary: typeof $t,
    timeZone: string,
  ) {
    if (status !== "exited" && status !== "completed") return [];
    const ended = endedAt
      ? dictionary.settings.onboardingEnded(status, dateInTimeZone(new Date(endedAt), timeZone).replaceAll("-", "/"))
      : null;
    const detail = status === "exited"
      ? dictionary.settings.onboardingRestartHint
      : linkedSources > 0
        ? dictionary.settings.onboardingLinkedSources(linkedSources, firstSyncSucceeded)
        : null;
    return [ended, detail].filter((part): part is string => Boolean(part));
  }

  function showSection(id: typeof activeSection) {
    activeSection = id;
    chosenSection = id;
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function focusSection(target: SettingsFocus) {
    await tick();
    if (target === "financial-data-deletion" || target === "sign-in-data") {
      showSection("settings-data");
      document.getElementById("reset-ledger")?.focus({ preventScroll: true });
    } else {
      showSection("settings-updates");
    }
    onFocused();
  }

  $: if (focus) void focusSection(focus);

  function chooseLocale(value: Locale) {
    setLocale(value);
  }

  function setSelectedUpdateTime(value: string) {
    selectedUpdateTime = value;
    [selectedHour, selectedMinute] = value.split(":");
  }

  function saveSystemSettings() {
    const version = ++saveVersion;
    const input = {
      systemTimezone: selectedTimezone,
      exchangeRateUpdateTime: selectedUpdateTime,
      scheduledCollectionEnabled: collectionEnabled,
      scheduledCollectionTime: `${collectionHour}:${collectionMinute}`,
      previewFeaturesEnabled: previewEnabled,
      usageStatisticsEnabled: usageEnabled,
      appUpdatesEnabled: updatesEnabled,
      appUpdatesAutoDownload: updatesAutoDownload,
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
        collectionEnabled = value.scheduledCollectionEnabled;
        [collectionHour, collectionMinute] = value.scheduledCollectionTime.split(":");
        previewEnabled = value.previewFeaturesEnabled;
        usageEnabled = value.usageStatisticsEnabled;
        updatesEnabled = value.appUpdatesEnabled;
        updatesAutoDownload = value.appUpdatesAutoDownload;
        saveStatus = "success";
      } catch (error) {
        if (version !== saveVersion) return;
        saveError = error instanceof Error ? error.message : String(error);
        saveStatus = "error";
      }
    });
  }

  function updateScheduledTime() {
    selectedUpdateTime = `${selectedHour}:${selectedMinute}`;
    saveSystemSettings();
  }

  function toggleScheduledCollection() {
    collectionEnabled = !collectionEnabled;
    saveSystemSettings();
  }

  function togglePreviewFeatures() {
    previewEnabled = !previewEnabled;
    saveSystemSettings();
  }

  function toggleUsageStatistics() {
    usageEnabled = !usageEnabled;
    saveSystemSettings();
  }

  async function toggleUsagePayload() {
    if (usagePayload !== null) {
      usagePayload = null;
      return;
    }
    usagePayloadStatus = "pending";
    try {
      usagePayload = JSON.stringify(await window.octopusBeak.settings.previewUsagePing(), null, 2);
      usagePayloadStatus = "idle";
    } catch {
      usagePayloadStatus = "error";
    }
  }

  function openReset() {
    resetTicked = new Set();
    resetOpen = true;
    // Whether clearing sign-in data would also need the financial data deleted.
    void readSignInStatus();
  }

  async function resetLedger() {
    if (!resetChoices.canConfirm) return;
    resetPending = true;
    collectStatus = "idle";
    const outcome = await runLedgerReset(window.octopusBeak.settings, resetChoices.parts);
    resetPending = false;
    resetOpen = false;
    resetOutcome = outcome;
    // The reset deletes the Cleanup Backup; the sign-in status changes with a clear.
    if (outcome.done.includes("financial")) void readCleanupBackup();
    await readSignInStatus();
  }

  /** Names for a list of parts, in the person's language. */
  function partList(parts: readonly LedgerResetPart[], dictionary: typeof $t) {
    return dictionary.settings.resetLedgerList(parts.map((part) => dictionary.settings.resetLedgerParts[part]));
  }

  /** Shows the cleanup's state; once a run ends, its backup may have appeared or gone. */
  function showCleanup(view: LedgerCleanupView) {
    const ended = cleanupView.kind === "running" && view.kind !== "running";
    cleanupView = view;
    if (ended) void readCleanupBackup();
  }

  async function estimateCleanup() {
    cleanupView = { kind: "checking" };
    cleanupKeepBackup = true;
    try {
      cleanupView = cleanupEstimateView(await window.octopusBeak.settings.ledgerCleanupEstimate());
    } catch {
      cleanupView = { kind: "failed", freedBytes: 0 };
    }
  }

  async function cleanUp(request: { backup: boolean; keepBackup: boolean }) {
    cleanupRequest = request;
    cleanupStopping = false;
    await runLedgerCleanup(window.octopusBeak.settings, request, showCleanup, { signal: cleanupFollow.signal });
  }

  function confirmCleanup() {
    if (cleanupView.kind !== "estimated") return;
    const backup = cleanupView.backup.kind === "fits";
    void cleanUp({ backup, keepBackup: backup && cleanupKeepBackup });
  }

  async function stopCleanup() {
    cleanupStopping = true;
    try {
      await window.octopusBeak.settings.stopLedgerCleanup();
    } catch {
      cleanupStopping = false;
    }
  }

  async function readCleanupBackup() {
    try {
      cleanupBackup = await window.octopusBeak.settings.cleanupBackup();
    } catch {
      // Shows what was read last; the next run or visit reads again.
    }
  }

  async function revealCleanupBackup() {
    try {
      await window.octopusBeak.settings.revealCleanupBackup();
    } catch {
      // Finder did not open; nothing in Settings changed.
    }
  }

  async function deleteCleanupBackup() {
    cleanupBackupStatus = "pending";
    try {
      cleanupBackup = await window.octopusBeak.settings.deleteCleanupBackup();
      cleanupBackupStatus = "idle";
    } catch {
      cleanupBackupStatus = "error";
      void readCleanupBackup();
    }
  }

  /** The day a backup expires, as the system timezone reads it. */
  function backupDate(value: string, timeZone: string) {
    return dateInTimeZone(new Date(value), timeZone).replaceAll("-", "/");
  }

  async function collectAllSources() {
    collectStatus = "pending";
    try {
      const result = await window.octopusBeak.settings.collectAllSources();
      collectStatus = result.started.length > 0 ? "started" : "error";
    } catch {
      collectStatus = "error";
    }
  }

  async function readSignInStatus() {
    const read = ++signInStatusRead;
    try {
      const next = await window.octopusBeak.settings.signInDataStatus();
      // A slower earlier read must not overwrite a later one, such as the read after a clear.
      if (read === signInStatusRead) signInStatus = next;
    } catch {
      // A failed read keeps what an earlier read knew.
    }
  }

  function changeDisplayScale(value: number) {
    applyDisplayScale(value);
  }

  function saveTimezone() {
    saveSystemSettings();
  }

  let restartConfirming = false;

  function confirmRestart() {
    restartConfirming = false;
    onRestartOnboarding();
  }
</script>

<DashboardShell
  active="settings"
  eyebrow={$t.settings.eyebrow}
  title={$t.settings.title}
  sideLabel={$t.settings.sideLabel}
  sideValue={localeLabels[$locale]}
  sideValueSensitive={false}
  sideSub={$t.settings.sideSub}
>
  <svelte:fragment slot="topbar-actions">
    <span
      id="settings-save-status"
      class:success={saveStatus === "success"}
      class:error={saveStatus === "error"}
      class="settings-save-status"
      role="status"
      aria-live="polite"
    >
      {#if saveStatus === "error"}
        <CircleAlert size={18} strokeWidth={2.25} aria-hidden="true" />
        {$t.settings.settingsNotSaved}
      {:else}
        <CircleCheck size={18} strokeWidth={2.25} aria-hidden="true" />
        {saveStatus === "pending" ? $t.settings.saving : $t.settings.allChangesSaved}
      {/if}
    </span>
  </svelte:fragment>

  <div class="content settings-content">
    <nav class="settings-nav" aria-label={$t.settings.settingsSections}>
      <ul>
        {#each SECTIONS as section}
          <li>
            <a
              href={`#${section.id}`}
              aria-current={activeSection === section.id ? "true" : undefined}
              onclick={(event) => {
                event.preventDefault();
                showSection(section.id);
              }}
            >
              <svelte:component this={section.icon} size={17} strokeWidth={2} aria-hidden="true" />
              {sectionTitles[section.id]}
            </a>
          </li>
        {/each}
      </ul>
    </nav>

    <div class="settings-sections">
      <section id="settings-schedule" class="settings-section" aria-labelledby="settings-schedule-title">
        <header>
          <h2 id="settings-schedule-title">{$t.settings.scheduleSettings}</h2>
          <p>{$t.settings.systemSettingsDescription}</p>
        </header>
        <div class="card settings-card">
          <div class="setting-row">
            <div class="setting-label-group">
              <label class="setting-label" for="system-timezone">{$t.settings.systemTimezone}</label>
              <small class="setting-hint">{$t.settings.timezoneHint}</small>
            </div>
            <div class="field select-field">
              <Globe size={16} strokeWidth={2} aria-hidden="true" />
              <span class="field-value">{selectedTimezone}</span>
              <span class="field-note">{utcOffsetLabel(selectedTimezone, now)}</span>
              <ChevronsUpDown class="field-chevron" size={16} strokeWidth={2} aria-hidden="true" />
              <select id="system-timezone" bind:value={selectedTimezone} onchange={saveTimezone}>
                {#each timezoneOptions as timezone}<option value={timezone}>{timezone} · {utcOffsetLabel(timezone, now)}</option>{/each}
              </select>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-label-group">
              <span class="setting-label" id="update-time-label">{$t.settings.exchangeRateUpdateTime}</span>
              <small class="setting-hint">{$t.settings.exchangeRateHint}</small>
            </div>
            <div class="setting-control">
              <div class="field time-field" role="group" aria-labelledby="update-time-label">
                <Clock size={16} strokeWidth={2} aria-hidden="true" />
                <select id="update-hour" class="num" aria-label={$t.settings.hour} bind:value={selectedHour} onchange={updateScheduledTime}>
                  {#each hours as hour}<option value={hour}>{hour}</option>{/each}
                </select>
                <span class="time-colon num" aria-hidden="true">:</span>
                <select id="update-minute" class="num" aria-label={$t.settings.minute} bind:value={selectedMinute} onchange={updateScheduledTime}>
                  {#each minutes as minute}<option value={minute}>{minute}</option>{/each}
                </select>
                <span class="field-note">{timezoneName}</span>
              </div>
              <p class="rate-status" class:failed={exchangeRateLastRun?.succeeded === false} data-rate-status>
                {#if exchangeRateLastRun?.succeeded === false}
                  <CircleAlert size={13} strokeWidth={2.25} aria-hidden="true" />
                {:else}
                  <CircleCheck size={13} strokeWidth={2.25} aria-hidden="true" />
                {/if}
                {#if exchangeRateLastRun}
                  {$t.settings.exchangeRateLastRun(scheduleTime(exchangeRateLastRun.finishedAt, selectedTimezone), exchangeRateLastRun.succeeded)} ·
                {/if}
                {$t.settings.exchangeRateNextRun(scheduleTime(nextRun, selectedTimezone))}
              </p>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-label-group">
              <span class="setting-label" id="collection-time-label">{$t.settings.scheduledCollection}</span>
              <small class="setting-hint">{$t.settings.scheduledCollectionHint}</small>
            </div>
            <div class="setting-control">
              <div class="collection-control">
                <button
                  id="scheduled-collection-toggle"
                  class="switch collection-switch"
                  type="button"
                  aria-pressed={collectionEnabled}
                  aria-labelledby="collection-time-label"
                  onclick={toggleScheduledCollection}
                >
                  <span>{$t.settings.scheduledCollectionToggle}</span>
                  <span class="switch-track" aria-hidden="true"></span>
                </button>
                <div class="field time-field" class:disabled={!collectionEnabled} role="group" aria-labelledby="collection-time-label">
                  <Clock size={16} strokeWidth={2} aria-hidden="true" />
                  <select id="collection-hour" class="num" aria-label={$t.settings.hour} disabled={!collectionEnabled} bind:value={collectionHour} onchange={saveSystemSettings}>
                    {#each hours as hour}<option value={hour}>{hour}</option>{/each}
                  </select>
                  <span class="time-colon num" aria-hidden="true">:</span>
                  <select id="collection-minute" class="num" aria-label={$t.settings.minute} disabled={!collectionEnabled} bind:value={collectionMinute} onchange={saveSystemSettings}>
                    {#each minutes as minute}<option value={minute}>{minute}</option>{/each}
                  </select>
                  <span class="field-note">{timezoneName}</span>
                </div>
              </div>
              <p class="rate-status" data-collection-status>
                {collectionEnabled
                  ? $t.settings.scheduledCollectionNextRun(scheduleTime(nextCollectionRun, selectedTimezone))
                  : $t.settings.scheduledCollectionOff}
              </p>
            </div>
          </div>
          {#if saveStatus === "error"}
            <div class="settings-error" role="alert">
              <CircleAlert size={16} strokeWidth={2.25} aria-hidden="true" />
              <span>{$t.settings.settingsSaveFailed(saveError)}</span>
              <button class="button" type="button" onclick={saveSystemSettings}>{$t.common.retry}</button>
            </div>
          {/if}
        </div>
      </section>

      <section id="settings-display" class="settings-section" aria-labelledby="settings-display-title">
        <header>
          <h2 id="settings-display-title">{$t.settings.languageDisplaySettings}</h2>
          <p>{$t.settings.languageDisplayDescription}</p>
        </header>
        <div class="card settings-card">
          <div class="setting-row">
            <div class="setting-label-group">
              <span class="setting-label" id="interface-language-label">{$t.settings.interfaceLanguage}</span>
              <small class="setting-hint">{$t.settings.languageDescription}</small>
            </div>
            <div class="segmented" role="group" aria-labelledby="interface-language-label">
              {#each locales as item}
                <button type="button" aria-pressed={$locale === item} onclick={() => chooseLocale(item)}>
                  {localeLabels[item]}
                </button>
              {/each}
            </div>
          </div>
          {#if displayScaleAvailable}
            <div class="setting-row">
              <div class="setting-label-group">
                <label class="setting-label" for="display-scale">{$t.settings.displaySize}</label>
                <small class="setting-hint">{$t.settings.displaySizeDescription}</small>
              </div>
              <div class="scale-control">
                <div class="scale-head">
                  <output class="num" for="display-scale">{draftScale ?? $displayScale}%</output>
                  <button
                    class="scale-reset"
                    type="button"
                    disabled={$displayScale === DISPLAY_SCALE_DEFAULT}
                    onclick={() => changeDisplayScale(DISPLAY_SCALE_DEFAULT)}
                  >{$t.settings.resetScale}</button>
                </div>
                <input
                  id="display-scale"
                  type="range"
                  min={DISPLAY_SCALE_MIN}
                  max={DISPLAY_SCALE_MAX}
                  step={DISPLAY_SCALE_STEP}
                  value={draftScale ?? $displayScale}
                  oninput={(event) => (draftScale = Number(event.currentTarget.value))}
                  onchange={(event) => {
                    draftScale = null;
                    changeDisplayScale(Number(event.currentTarget.value));
                  }}
                />
                <div class="scale-ticks num" aria-hidden="true">
                  {#each scaleTickLabels as tick}
                    <span style:--tick={tick.offset}>{tick.value}%</span>
                  {/each}
                </div>
                <p class="scale-shortcuts">
                  <kbd>{shortcutModifier}−</kbd>{$t.settings.shortcutDecrease}
                  <kbd>{shortcutModifier}+</kbd>{$t.settings.shortcutIncrease}
                  <kbd>{shortcutModifier}0</kbd>{$t.settings.resetScale}
                </p>
              </div>
            </div>
          {/if}
        </div>
      </section>

      <section id="settings-preview" class="settings-section" aria-labelledby="settings-preview-title">
        <header>
          <h2 id="settings-preview-title">{$t.settings.previewFeatures}</h2>
          <p>{$t.settings.previewFeaturesDescription}</p>
        </header>
        <div class="card settings-card">
          <div class="setting-row">
            <div class="setting-label-group">
              <span class="setting-label" id="preview-features-label">{$t.settings.previewSourcesToggle}</span>
              <small class="setting-hint">{$t.settings.previewFeaturesHint}</small>
            </div>
            <div class="setting-control">
              <button
                id="preview-features-toggle"
                class="switch collection-switch setting-switch"
                type="button"
                aria-pressed={previewEnabled}
                aria-labelledby="preview-features-label"
                onclick={togglePreviewFeatures}
              >
                <span class="visually-hidden">{previewEnabled ? $t.settings.previewFeaturesOn : $t.settings.previewFeaturesOff}</span>
                <span class="switch-track" aria-hidden="true"></span>
              </button>
            </div>
          </div>
        </div>
      </section>

      <section id="settings-usage" class="settings-section" aria-labelledby="settings-usage-title">
        <header>
          <h2 id="settings-usage-title">{$t.settings.usageStatistics}</h2>
          <p>{$t.settings.usageStatisticsDescription}</p>
        </header>
        <div class="card settings-card">
          <div class="setting-row">
            <div class="setting-label-group">
              <span class="setting-label" id="usage-statistics-label">{$t.settings.usageStatisticsToggle}</span>
              <small class="setting-hint">{$t.settings.usageStatisticsHint}</small>
            </div>
            <div class="setting-control">
              <button
                id="usage-statistics-toggle"
                class="switch collection-switch setting-switch"
                type="button"
                aria-pressed={usageEnabled}
                aria-labelledby="usage-statistics-label"
                onclick={toggleUsageStatistics}
              >
                <span class="visually-hidden">{usageEnabled ? $t.settings.usageStatisticsOn : $t.settings.usageStatisticsOff}</span>
                <span class="switch-track" aria-hidden="true"></span>
              </button>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-label-group">
              <span class="setting-label">{$t.settings.usagePayload}</span>
              <small class="setting-hint">{$t.settings.usagePayloadHint}</small>
            </div>
            <div class="onboarding-setting-actions">
              <button
                id="usage-payload-toggle"
                class="button"
                type="button"
                aria-expanded={usagePayload !== null}
                aria-controls="usage-payload"
                disabled={usagePayloadStatus === "pending"}
                aria-busy={usagePayloadStatus === "pending"}
                onclick={toggleUsagePayload}
              >
                {usagePayload === null ? $t.settings.showUsagePayload : $t.settings.hideUsagePayload}
              </button>
            </div>
          </div>
          {#if usagePayload !== null}
            <pre id="usage-payload" class="usage-payload">{usagePayload}</pre>
          {/if}
          {#if usagePayloadStatus === "error"}
            <div class="settings-error" role="alert">
              <CircleAlert size={16} strokeWidth={2.25} aria-hidden="true" />
              <span>{$t.settings.usagePayloadFailed}</span>
            </div>
          {/if}
        </div>
      </section>

      <section id="settings-updates" class="settings-section" aria-labelledby="settings-updates-title">
        <header>
          <h2 id="settings-updates-title">{$t.settings.appUpdates}</h2>
          <p>{$t.settings.appUpdatesDescription}</p>
        </header>
        <div class="card settings-card">
          <div class="setting-row">
            <div class="setting-label-group">
              <span class="setting-label">{$t.settings.appUpdatesVersion($updateView?.currentVersion ?? __APP_VERSION__)}</span>
              <small id="app-update-status" class="setting-hint" aria-live="polite">{updateLine}</small>
            </div>
            <div class="onboarding-setting-actions">
              <button
                id="app-update-check"
                class="button"
                type="button"
                disabled={updateState?.status !== "idle" && updateState?.status !== "failed"}
                onclick={() => appUpdates?.check()}
              >
                {$t.settings.appUpdatesCheckNow}
              </button>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-label-group">
              <span class="setting-label" id="app-updates-label">{$t.settings.appUpdatesToggle}</span>
              <small class="setting-hint">{$t.settings.appUpdatesToggleHint}</small>
            </div>
            <div class="setting-control">
              <button
                id="app-updates-toggle"
                class="switch collection-switch setting-switch"
                type="button"
                aria-pressed={updatesEnabled}
                aria-labelledby="app-updates-label"
                onclick={toggleAppUpdates}
              >
                <span class="visually-hidden">{updatesEnabled ? $t.settings.appUpdatesOn : $t.settings.appUpdatesOffLabel}</span>
                <span class="switch-track" aria-hidden="true"></span>
              </button>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-label-group">
              <span class="setting-label" id="app-updates-auto-download-label">{$t.settings.appUpdatesAutoDownloadToggle}</span>
              <small class="setting-hint">{$t.settings.appUpdatesAutoDownloadToggleHint}</small>
            </div>
            <div class="setting-control">
              <button
                id="app-updates-auto-download-toggle"
                class="switch collection-switch setting-switch"
                type="button"
                aria-pressed={updatesAutoDownload}
                aria-labelledby="app-updates-auto-download-label"
                disabled={!updatesEnabled}
                onclick={toggleAppUpdatesAutoDownload}
              >
                <span class="visually-hidden">{updatesAutoDownload ? $t.settings.appUpdatesOn : $t.settings.appUpdatesOffLabel}</span>
                <span class="switch-track" aria-hidden="true"></span>
              </button>
            </div>
          </div>
        </div>
      </section>

      <section id="settings-data" class="settings-section" aria-labelledby="settings-data-title">
        <header>
          <h2 id="settings-data-title">{$t.settings.dataSection}</h2>
          <p>{$t.settings.dataDescription}</p>
        </header>
        <div class="card settings-card">
          <div class="setting-row">
            <div class="setting-label-group">
              <span class="setting-label">{$t.settings.cleanUpAppData}</span>
              <small class="setting-hint">{$t.settings.cleanUpAppDataHint}</small>
              {#if cleanupBackup}
                <small id="cleanup-backup-status" class="setting-hint">
                  {cleanupBackup.bytes === null
                    ? $t.settings.cleanupBackupStatusUnmeasured(backupDate(cleanupBackup.expiresAt, $systemTimezone))
                    : $t.settings.cleanupBackupStatus(megabytes(cleanupBackup.bytes), backupDate(cleanupBackup.expiresAt, $systemTimezone))}
                </small>
                {#if !cleanupBackup.restorable}
                  <small id="cleanup-backup-stale" class="setting-hint warning-hint">{$t.settings.cleanupBackupNotRestorable}</small>
                {/if}
              {/if}
            </div>
            <div class="onboarding-setting-actions">
              {#if cleanupBackup && cleanupBackupStatus !== "confirming"}
                <button
                  id="reveal-cleanup-backup"
                  class="button icon-only"
                  type="button"
                  aria-label={$t.settings.cleanupBackupReveal}
                  title={$t.settings.cleanupBackupReveal}
                  onclick={revealCleanupBackup}
                ><FolderOpen size={16} strokeWidth={2} aria-hidden="true" /></button>
                <button
                  id="delete-cleanup-backup"
                  class="button"
                  type="button"
                  disabled={dataActionPending}
                  aria-busy={cleanupBackupStatus === "pending"}
                  onclick={() => (cleanupBackupStatus = "confirming")}
                >{$t.settings.cleanupBackupDelete}</button>
              {/if}
              {#if cleanupView.kind === "done" || cleanupView.kind === "stopped"}
                <span class="chip status-chip good" role="status">
                  <Check size={13} strokeWidth={2.5} aria-hidden="true" />
                  {cleanupView.kind === "done"
                    ? $t.settings.cleanUpAppDataDone(megabytes(cleanupView.freedBytes))
                    : $t.settings.cleanUpAppDataStopped(megabytes(cleanupView.freedBytes))}
                </span>
              {:else if cleanupView.kind === "nothing"}
                <span class="chip status-chip good" role="status">
                  <Check size={13} strokeWidth={2.5} aria-hidden="true" />
                  {$t.settings.cleanUpAppDataNothing}
                </span>
              {:else if cleanupView.kind !== "estimated" && cleanupView.kind !== "running" && cleanupView.kind !== "backup-failed"}
                <button
                  id="clean-up-app-data"
                  class="button"
                  type="button"
                  disabled={dataActionPending}
                  aria-busy={cleanupView.kind === "checking"}
                  onclick={estimateCleanup}
                >{cleanupView.kind === "checking" ? $t.settings.cleanUpAppDataChecking : $t.settings.cleanUpAppData}</button>
              {/if}
            </div>
          </div>
          {#if cleanupBackupStatus === "confirming"}
            <div class="restart-confirm" role="group" aria-labelledby="cleanup-backup-delete-confirm">
              <p id="cleanup-backup-delete-confirm">{$t.settings.cleanupBackupDeleteConfirm}</p>
              <div class="onboarding-setting-actions">
                <button class="button" type="button" onclick={() => (cleanupBackupStatus = "idle")}>{$t.common.cancel}</button>
                <button id="confirm-delete-cleanup-backup" class="button danger" type="button" disabled={dataActionPending} onclick={deleteCleanupBackup}>{$t.settings.cleanupBackupDeleteAction}</button>
              </div>
            </div>
          {:else if cleanupBackupStatus === "error"}
            <div class="settings-error" role="alert">
              <CircleAlert size={16} strokeWidth={2.25} aria-hidden="true" />
              <span>{$t.settings.cleanupBackupDeleteFailed}</span>
            </div>
          {/if}
          {#if cleanupView.kind === "estimated"}
            {@const total = cleanupView.redundantBytes + cleanupView.temporaryBytes}
            <div class="restart-confirm" role="group" aria-labelledby="ledger-cleanup-estimate">
              <p id="ledger-cleanup-estimate">
                {$t.settings.cleanUpAppDataEstimateBefore}<button
                  type="button"
                  class="figure-tip"
                  aria-describedby="ledger-cleanup-breakdown"
                >{megabytes(total)} MB<span id="ledger-cleanup-breakdown" class="tip" role="tooltip">
                    <span>{$t.settings.cleanUpAppDataRedundant(megabytes(cleanupView.redundantBytes))}</span>
                    <span>{$t.settings.cleanUpAppDataTemporary(megabytes(cleanupView.temporaryBytes))}</span>
                  </span></button>{$t.settings.cleanUpAppDataEstimateAfter}
                {$t.settings.cleanUpAppDataUnchanged}
              </p>
              {#if cleanupView.backup.kind !== "unavailable"}
                {@const fits = cleanupView.backup.kind === "fits"}
                <label class="confirm-option" class:disabled={!fits}>
                  <input
                    id="ledger-cleanup-keep-backup"
                    type="checkbox"
                    checked={fits && cleanupKeepBackup}
                    disabled={!fits}
                    aria-describedby="ledger-cleanup-backup-hint"
                    onchange={(event) => (cleanupKeepBackup = event.currentTarget.checked)}
                  />
                  <span>{$t.settings.cleanUpAppDataKeepBackup}</span>
                  {#if cleanupView.backup.kind === "fits"}
                    <span class="hint-tip">
                      <CircleHelp size={14} strokeWidth={2} aria-hidden="true" />
                      <span id="ledger-cleanup-backup-hint" class="tip" role="tooltip">
                        {$t.settings.cleanUpAppDataKeepBackupHint(megabytes(cleanupView.backup.bytes))}
                      </span>
                    </span>
                  {/if}
                </label>
                {#if cleanupView.backup.kind === "no-room"}
                  <small id="ledger-cleanup-backup-hint" class="setting-hint warning-hint" role="status">
                    {$t.settings.cleanUpAppDataBackupNoRoom(megabytes(cleanupView.backup.neededBytes))}
                  </small>
                {:else if cleanupView.backup.kind === "unreadable"}
                  <small id="ledger-cleanup-backup-hint" class="setting-hint warning-hint" role="status">
                    {$t.settings.cleanUpAppDataBackupUnreadable}
                  </small>
                {/if}
              {/if}
              <div class="onboarding-setting-actions">
                <button class="button" type="button" onclick={() => (cleanupView = { kind: "idle" })}>{$t.common.cancel}</button>
                <button id="confirm-clean-up-app-data" class="button primary" type="button" disabled={dataActionPending} onclick={confirmCleanup}>{$t.settings.cleanUpAppDataAction}</button>
              </div>
            </div>
          {:else if cleanupView.kind === "no-room"}
            <div class="settings-error" role="alert">
              <CircleAlert size={16} strokeWidth={2.25} aria-hidden="true" />
              <span>{$t.settings.cleanUpAppDataNoRoom(megabytes(cleanupView.neededBytes), megabytes(cleanupView.freeBytes))}</span>
            </div>
          {:else if cleanupView.kind === "out-of-room"}
            <div id="ledger-cleanup-out-of-room" class="settings-error" role="alert">
              <CircleAlert size={16} strokeWidth={2.25} aria-hidden="true" />
              <span>{$t.settings.cleanUpAppDataOutOfRoom(megabytes(cleanupView.remainingBytes), megabytes(cleanupView.neededBytes))}</span>
            </div>
          {:else if cleanupView.kind === "failed"}
            <div id="ledger-cleanup-failed" class="settings-error" role="alert">
              <CircleAlert size={16} strokeWidth={2.25} aria-hidden="true" />
              <span>{$t.settings.cleanUpAppDataFailed}{cleanupView.freedBytes > 0 ? ` ${$t.settings.cleanUpAppDataFreed(megabytes(cleanupView.freedBytes))}` : ""}</span>
            </div>
          {:else if cleanupView.kind === "backup-failed"}
            <div id="ledger-cleanup-backup-failed" class="settings-error" role="alert">
              <CircleAlert size={16} strokeWidth={2.25} aria-hidden="true" />
              <span>{$t.settings.cleanUpAppDataBackupFailed}</span>
              <span class="error-actions">
                <button class="button" type="button" disabled={dataActionPending} onclick={() => void cleanUp({ ...cleanupRequest, backup: true })}>{$t.settings.cleanUpAppDataTryAgain}</button>
                <button id="clean-up-without-backup" class="button" type="button" disabled={dataActionPending} onclick={() => void cleanUp({ backup: false, keepBackup: false })}>{$t.settings.cleanUpAppDataWithoutBackup}</button>
              </span>
            </div>
          {/if}
          {#if cleanupView.kind === "running"}
            <Modal titleId="ledger-cleanup-title" title={$t.settings.cleanUpAppDataRunning} subtitle={$t.settings.cleanUpAppDataRunningHint} width="min(480px, 100%)" closable={false} showClose={false} onClose={() => {}}>
              <div class="modal-body cleanup-run">
                {#if cleanupBar}
                  {@const label = cleanupView.progress === null
                    ? $t.settings.cleanUpAppDataStarting
                    : cleanupView.progress.phase === "backing-up"
                    ? $t.settings.cleanUpAppDataBackingUp
                    : cleanupView.progress.phase === "compacting"
                    ? $t.settings.cleanUpAppDataCompacting(cleanupView.progress.index, cleanupView.progress.count)
                    : $t.settings.cleanUpAppDataReclaiming(cleanupView.progress.index, cleanupView.progress.count)}
                  <div
                    id="ledger-cleanup-progress"
                    class="cleanup-bar"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={cleanupBar.percent ?? undefined}
                    aria-valuetext={label}
                    aria-labelledby="ledger-cleanup-step"
                  >
                    {#each cleanupBar.segments as segment (segment.part)}
                      <span class="cleanup-segment" class:indeterminate={segment.fill === null} data-part={segment.part}>
                        <span style:width={segment.fill === null ? null : `${segment.fill * 100}%`}></span>
                      </span>
                    {/each}
                  </div>
                  <p id="ledger-cleanup-step" class="setting-hint" aria-live="polite">{label}</p>
                {/if}
                <div class="onboarding-setting-actions">
                  <button
                    id="stop-ledger-cleanup"
                    class="button"
                    type="button"
                    disabled={cleanupStopping}
                    onclick={stopCleanup}
                  >{cleanupStopping ? $t.settings.cleanUpAppDataStopping : $t.settings.cleanUpAppDataStop}</button>
                </div>
              </div>
            </Modal>
          {/if}
          <div class="setting-row">
            <div class="setting-label-group">
              <span class="setting-label">{$t.settings.resetLedger}</span>
              <small class="setting-hint">{$t.settings.resetLedgerHint}</small>
              {#if signInGuidance.unreadableHint && !resetOutcome?.done.includes("sign-in")}
                <small id="sign-in-data-unreadable" class="setting-hint warning-hint" role="status">{$t.settings.signInDataUnreadable}</small>
              {/if}
              {#if resetOutcome?.kind === "done"}
                <small id="reset-ledger-done" class="setting-hint" role="status">{$t.settings.resetLedgerDone(partList(resetOutcome.done, $t))}</small>
              {/if}
            </div>
            <div class="onboarding-setting-actions">
              {#if resetOutcome?.done.includes("financial")}
                {#if collectStatus === "started"}
                  <span class="chip status-chip good" role="status">
                    <Check size={13} strokeWidth={2.5} aria-hidden="true" />
                    {$t.settings.collectAllSourcesStarted}
                  </span>
                {:else}
                  <button
                    id="collect-all-sources"
                    class="button primary"
                    type="button"
                    disabled={collectStatus === "pending"}
                    aria-busy={collectStatus === "pending"}
                    onclick={collectAllSources}
                  >{$t.settings.collectAllSources}</button>
                {/if}
              {/if}
              <button
                id="reset-ledger"
                class="button danger"
                type="button"
                disabled={dataActionPending}
                aria-haspopup="dialog"
                onclick={openReset}
              >{$t.settings.resetLedger}</button>
            </div>
          </div>
          {#if resetOutcome?.kind === "failed"}
            <div id="reset-ledger-failed" class="settings-error" role="alert">
              <CircleAlert size={16} strokeWidth={2.25} aria-hidden="true" />
              <span>{resetOutcome.failed === null
                ? $t.settings.resetLedgerNotRun
                : $t.settings.resetLedgerFailed(
                  $t.settings.resetLedgerParts[resetOutcome.failed],
                  resetOutcome.done.length > 0 ? partList(resetOutcome.done, $t) : null,
                  resetOutcome.notRun.length > 0 ? partList(resetOutcome.notRun, $t) : null,
                )}</span>
            </div>
          {/if}
          {#if collectStatus === "error"}
            <div class="settings-error" role="alert">
              <CircleAlert size={16} strokeWidth={2.25} aria-hidden="true" />
              <span>{$t.settings.collectAllSourcesFailed}</span>
            </div>
          {/if}
          {#if resetOpen}
            <Modal
              titleId="reset-ledger-title"
              title={$t.settings.resetLedger}
              subtitle={$t.settings.resetLedgerSubtitle}
              width="min(560px, 100%)"
              closable={!resetPending}
              onClose={() => (resetOpen = false)}
            >
              <div class="modal-body reset-ledger">
                <fieldset class="reset-options" disabled={resetPending}>
                  <legend class="visually-hidden">{$t.settings.resetLedgerChoose}</legend>
                  {#each resetChoices.options as option (option.part)}
                    <label class="reset-option" class:locked={option.locked}>
                      <input
                        id={`reset-ledger-${option.part}`}
                        type="checkbox"
                        checked={option.checked}
                        disabled={option.locked}
                        aria-describedby={`reset-ledger-${option.part}-hint`}
                        onchange={(event) => (resetTicked = tickLedgerResetPart(resetTicked, option.part, event.currentTarget.checked))}
                      />
                      <span class="reset-option-text">
                        <span class="reset-option-label">{$t.settings.resetLedgerParts[option.part]}</span>
                        <small id={`reset-ledger-${option.part}-hint`} class="setting-hint">
                          {$t.settings.resetLedgerPartHints[option.part]}{#if option.locked}{" "}{$t.settings.resetLedgerPreviewIncluded}{/if}
                        </small>
                        {#if option.part === "sign-in" && option.checked && !resetTicked.has("financial") && signInGuidance.resetWarning}
                          <small id="reset-ledger-sign-in-warning" class="setting-hint warning-hint" role="status">{$t.settings.resetLedgerSignInWarning}</small>
                        {/if}
                      </span>
                    </label>
                  {/each}
                </fieldset>
                {#if resetChoices.canConfirm}
                  <div id="reset-ledger-summary" class="reset-summary">
                    <p>{$t.settings.resetLedgerWillDelete}</p>
                    <ul>
                      {#each resetChoices.parts as part (part)}<li>{$t.settings.resetLedgerParts[part]}</li>{/each}
                    </ul>
                    <p class="reset-irreversible">{$t.settings.resetLedgerIrreversible}</p>
                  </div>
                {/if}
                <div class="onboarding-setting-actions">
                  <button class="button" type="button" disabled={resetPending} onclick={() => (resetOpen = false)}>{$t.common.cancel}</button>
                  <button
                    id="confirm-reset-ledger"
                    class="button danger"
                    type="button"
                    disabled={!resetChoices.canConfirm || resetPending || cleanupBusy || cleanupBackupStatus === "pending"}
                    aria-busy={resetPending}
                    aria-describedby={resetChoices.canConfirm ? "reset-ledger-summary" : undefined}
                    onclick={resetLedger}
                  >{resetPending ? $t.settings.resetLedgerDeleting : $t.settings.resetLedgerConfirm(resetChoices.parts.length)}</button>
                </div>
              </div>
            </Modal>
          {/if}
        </div>
      </section>

      <section id="settings-onboarding" class="settings-section" aria-labelledby="settings-onboarding-title">
        <header>
          <h2 id="settings-onboarding-title">{$t.settings.onboardingSection}</h2>
          <p>{$t.settings.onboardingDescription}</p>
        </header>
        <div class="card settings-card">
          <div class="setting-row onboarding-row">
            <div class="setting-label-group">
              <span class="setting-label">{$t.settings.onboardingStatusLabel}</span>
              {#if onboardingMeta.length > 0}
                <small class="setting-hint" data-onboarding-meta>{onboardingMeta.join(" · ")}</small>
              {/if}
            </div>
            <div class="onboarding-setting-actions">
              <span class="chip status-chip" class:good={onboardingStatus === "completed"}>
                {#if onboardingStatus === "completed"}
                  <Check size={13} strokeWidth={2.5} aria-hidden="true" />
                {:else if onboardingStatus === "exited"}
                  <CircleStop size={13} strokeWidth={2.25} aria-hidden="true" />
                {/if}
                {$t.settings.onboardingState[onboardingStatus ?? "notStarted"]}
              </span>
              {#if onboardingStatus === null}
                <button
                  class="button primary"
                  type="button"
                  disabled={onboardingRestartPending}
                  aria-busy={onboardingRestartPending}
                  onclick={onRestartOnboarding}
                >
                  {onboardingRestartPending ? $t.onboarding.starting : $t.onboarding.start}
                </button>
              {:else if (onboardingStatus === "exited" || onboardingStatus === "completed") && !restartConfirming}
                <button
                  class="button"
                  class:primary={onboardingStatus === "exited"}
                  type="button"
                  disabled={onboardingRestartPending}
                  aria-busy={onboardingRestartPending}
                  onclick={() => (restartConfirming = true)}
                >
                  <RotateCcw size={15} strokeWidth={2.25} aria-hidden="true" />
                  {onboardingRestartPending ? $t.onboarding.restarting : $t.onboarding.restart}
                </button>
              {/if}
            </div>
          </div>
          {#if restartConfirming && (onboardingStatus === "exited" || onboardingStatus === "completed")}
            <div class="restart-confirm" role="group" aria-labelledby="onboarding-restart-confirm">
              <p id="onboarding-restart-confirm">{$t.onboarding.restartConfirm}</p>
              <div class="onboarding-setting-actions">
                <button class="button" type="button" onclick={() => (restartConfirming = false)}>{$t.common.cancel}</button>
                <button class="button danger" type="button" onclick={confirmRestart}>{$t.onboarding.restartConfirmAction}</button>
              </div>
            </div>
          {/if}
          {#if onboardingRestartError}
            <div class="settings-error" role="alert">
              <CircleAlert size={16} strokeWidth={2.25} aria-hidden="true" />
              <span>{onboardingRestartError}</span>
            </div>
          {/if}
        </div>
      </section>
    </div>
  </div>
</DashboardShell>

<style>
  .settings-content {
    display: grid;
    grid-template-columns: 244px minmax(0, 1fr);
    align-items: start;
    gap: var(--space-6);
    max-width: 1200px;
    /* Centred, so a wide window leaves even margins instead of one empty side. */
    margin: 0 auto;
  }

  .settings-save-status {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--muted);
    font-size: 13px;
    font-weight: 720;
  }

  .settings-save-status.success { color: var(--success); }
  .settings-save-status.error { color: var(--danger); }

  .settings-nav {
    position: sticky;
    top: var(--space-6);
  }

  .settings-nav ul {
    display: grid;
    gap: var(--space-1);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .settings-nav a {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-height: 38px;
    padding: 0 var(--space-3);
    border: 1px solid transparent;
    border-radius: var(--radius);
    color: var(--muted);
    font-size: 14px;
    font-weight: 650;
    text-decoration: none;
  }

  .settings-nav a:hover { color: var(--fg); }

  .settings-nav a[aria-current="true"] {
    border-color: var(--border);
    background: var(--surface);
    color: var(--fg);
    font-weight: 750;
  }

  .settings-sections {
    display: grid;
    gap: var(--space-8);
    min-width: 0;
  }

  .settings-section {
    display: grid;
    gap: var(--space-3);
    scroll-margin-top: var(--space-6);
  }

  .settings-section header h2 {
    margin: 0;
    font-size: 16px;
    font-weight: 750;
  }

  .settings-section header p {
    margin: 2px 0 0;
    color: var(--muted);
    font-size: 12px;
  }

  .settings-card { overflow: hidden; }

  .setting-row {
    display: grid;
    grid-template-columns: minmax(180px, 1fr) minmax(260px, 300px);
    align-items: center;
    gap: var(--space-5);
    min-height: 72px;
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--border);
  }

  .setting-row:last-child { border-bottom: 0; }
  .setting-label { font-size: 14px; font-weight: 720; }
  .setting-label-group { display: grid; gap: 2px; }
  .setting-hint { color: var(--muted); font-size: 12px; line-height: 1.5; }
  .setting-control { display: grid; gap: var(--space-2); }

  .field {
    position: relative;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-height: 40px;
    padding: 0 var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--muted);
    transition: border-color 160ms ease, box-shadow 160ms ease;
  }

  .field:focus-within {
    border-color: var(--fg);
    box-shadow: 0 0 0 3px var(--surface-soft);
  }

  .field-value {
    color: var(--fg);
    font-size: 14px;
    font-weight: 720;
  }

  .field-note { font-size: 11px; }

  .field :global(.field-chevron) { margin-left: auto; }

  /* The native select keeps keyboard and screen-reader behaviour; the styled row draws its value. */
  .select-field select {
    position: absolute;
    inset: 0;
    width: 100%;
    opacity: 0;
    cursor: pointer;
  }

  .time-field select {
    width: calc(2ch + 2px);
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--fg);
    font-size: 14px;
    font-weight: 750;
    appearance: none;
    cursor: pointer;
  }

  .time-field select:focus { outline: none; }
  .time-colon { margin: 0 -7px; color: var(--fg); font-weight: 750; }
  .time-field .field-note { margin-left: var(--space-1); }

  .rate-status {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    margin: 0;
    color: var(--muted);
    font-size: 11px;
  }

  .collection-control {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }

  .collection-switch {
    width: auto;
    min-width: 0;
    min-height: 40px;
    gap: var(--space-3);
    padding: 0 10px 0 12px;
    font: inherit;
    font-size: 13px;
    font-weight: 680;
    cursor: pointer;
  }

  .collection-switch .switch-track {
    background: var(--border);
    transition: background 180ms ease;
  }

  .collection-switch .switch-track::after {
    right: auto;
    left: 3px;
  }

  .collection-switch[aria-pressed="true"] .switch-track { background: var(--fg); }
  .collection-switch[aria-pressed="true"] .switch-track::after { transform: translateX(12px); }
  /*
   * A setting that is only on or off is the switch alone, right-aligned: the
   * track already shows its state, so the box and the 「開啟／關閉」 words it
   * carried are gone (the words stay for a screen reader).
   */
  .setting-switch {
    justify-self: end;
    width: auto;
    min-width: 0;
    min-height: 0;
    padding: 4px;
    border-color: transparent;
    border-radius: 999px;
    background: none;
  }
  .setting-switch .switch-track { width: 38px; height: 22px; }
  .setting-switch .switch-track::after { top: 3px; left: 3px; width: 16px; height: 16px; }
  .setting-switch[aria-pressed="true"] .switch-track::after { transform: translateX(16px); }
  .setting-switch:disabled { cursor: not-allowed; opacity: 0.48; }
  .time-field.disabled { opacity: 0.55; }
  .time-field select:disabled { cursor: default; }

  .rate-status :global(svg) { flex: none; color: var(--success); }
  .rate-status.failed :global(svg) { color: var(--danger); }

  .segmented {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 2px;
    padding: 3px;
    border-radius: var(--radius);
    background: var(--surface-soft);
  }

  .segmented button {
    min-height: 34px;
    border: 1px solid transparent;
    border-radius: calc(var(--radius) - 2px);
    background: transparent;
    color: var(--muted);
    font: inherit;
    font-size: 14px;
    font-weight: 650;
    cursor: pointer;
  }

  .segmented button[aria-pressed="true"] {
    border-color: var(--border);
    background: var(--surface);
    color: var(--fg);
    font-weight: 750;
    box-shadow: 0 1px 2px rgb(0 0 0 / 6%);
  }

  .scale-control { display: grid; gap: var(--space-2); }

  .scale-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
  }

  .scale-head output { font-size: 15px; font-weight: 750; }

  .scale-reset {
    padding: 0;
    border: 0;
    background: none;
    color: var(--muted);
    font: inherit;
    font-size: 12px;
    font-weight: 650;
    cursor: pointer;
  }

  .scale-reset:disabled { cursor: default; opacity: 0.6; }

  .scale-control input[type="range"] {
    width: 100%;
    margin: 0;
    accent-color: var(--fg);
    cursor: pointer;
  }

  .scale-ticks {
    position: relative;
    height: 12px;
    margin: -4px 8px 0;
    color: var(--muted);
    font-size: 9px;
  }

  .scale-ticks span {
    position: absolute;
    left: calc(var(--tick) * 100%);
    transform: translateX(-50%);
  }

  .scale-shortcuts {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-1) var(--space-2);
    margin: var(--space-1) 0 0;
    color: var(--muted);
    font-size: 11px;
  }

  .scale-shortcuts kbd {
    padding: 1px 5px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--surface-soft);
    color: var(--fg);
    font: inherit;
    font-size: 10px;
  }

  .scale-shortcuts kbd:not(:first-child) { margin-left: var(--space-1); }

  .onboarding-row { grid-template-columns: minmax(0, 1fr) auto; }

  .usage-payload {
    margin: 0;
    padding: var(--space-3);
    overflow-x: auto;
    border-radius: 8px;
    background: var(--surface-soft);
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.5;
  }

  .onboarding-setting-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-3);
  }

  .status-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  .onboarding-setting-actions .button {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }

  .restart-confirm {
    display: grid;
    gap: var(--space-3);
    padding: var(--space-4) var(--space-5);
    border-top: 1px solid var(--border);
  }

  .restart-confirm p {
    margin: 0;
    color: var(--muted);
    font-size: 13px;
    line-height: 1.5;
  }

  .confirm-option {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: 13px;
  }

  .warning-hint { color: var(--warn); }

  .settings-error {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    margin: 0 var(--space-5) var(--space-5);
    padding: var(--space-2) var(--space-3);
    border: 1px solid color-mix(in srgb, var(--danger) 35%, var(--border));
    border-radius: var(--radius);
    color: var(--danger);
    font-size: 13px;
    overflow-wrap: anywhere;
  }

  .settings-error :global(svg) { flex: none; }
  .settings-error .button { margin-left: auto; flex: none; }
  .settings-error .error-actions { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-left: auto; }
  .settings-error .error-actions .button { margin-left: 0; }

  .onboarding-setting-actions .button.icon-only {
    justify-content: center;
    width: 34px;
    padding: 0;
  }

  .confirm-option.disabled { color: var(--muted); }
  .confirm-option.disabled input { cursor: not-allowed; }

  .figure-tip,
  .hint-tip {
    position: relative;
    display: inline-flex;
    align-items: center;
  }

  .figure-tip {
    padding: 0;
    border: 0;
    border-bottom: 1px dotted currentColor;
    background: none;
    color: var(--fg);
    font: inherit;
    font-weight: 700;
    cursor: help;
  }

  .hint-tip { color: var(--muted); cursor: help; }

  .tip {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 40;
    display: none;
    width: max-content;
    max-width: 300px;
    padding: var(--space-2) var(--space-3);
    border-radius: 6px;
    background: color-mix(in oklch, var(--surface-strong) 92%, transparent);
    color: white;
    font-size: 12px;
    font-weight: 500;
    line-height: 1.45;
    text-align: left;
    white-space: normal;
    pointer-events: none;
  }

  .figure-tip .tip { flex-direction: column; gap: 2px; }
  .figure-tip:hover .tip,
  .figure-tip:focus-visible .tip { display: flex; }
  .hint-tip:hover .tip,
  .confirm-option:focus-within .hint-tip .tip { display: block; }

  .cleanup-run {
    display: grid;
    gap: var(--space-3);
    padding: var(--space-5);
  }

  .cleanup-bar {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 4px;
  }

  .cleanup-segment {
    position: relative;
    height: 8px;
    overflow: hidden;
    border-radius: 999px;
    background: color-mix(in srgb, var(--fg) 10%, transparent);
  }

  .cleanup-segment > span {
    position: absolute;
    inset: 0 auto 0 0;
    border-radius: inherit;
    background: var(--fg);
    transition: width 240ms ease-out;
  }

  .cleanup-segment.indeterminate > span {
    width: 40%;
    animation: cleanup-indeterminate 1.2s ease-in-out infinite;
  }

  @keyframes cleanup-indeterminate {
    from { transform: translateX(-100%); }
    to { transform: translateX(250%); }
  }

  @media (prefers-reduced-motion: reduce) {
    .cleanup-segment.indeterminate > span { animation: none; width: 100%; opacity: 0.4; }
  }

  .cleanup-run .onboarding-setting-actions { justify-content: flex-end; }

  .reset-ledger {
    display: grid;
    gap: var(--space-4);
    padding: var(--space-5);
  }

  .reset-options {
    display: grid;
    gap: var(--space-3);
    margin: 0;
    padding: 0;
    border: 0;
  }

  .reset-option {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: start;
    gap: var(--space-3);
    cursor: pointer;
  }

  .reset-option input { margin-top: 3px; }
  .reset-option.locked { cursor: not-allowed; }
  .reset-option.locked input { cursor: not-allowed; }

  .reset-option-text {
    display: grid;
    gap: 2px;
  }

  .reset-option-label { font-size: 14px; font-weight: 600; }
  .reset-option.locked .reset-option-label { color: var(--muted); }

  .reset-summary {
    display: grid;
    gap: var(--space-1);
    padding: var(--space-3);
    border: 1px solid color-mix(in srgb, var(--danger) 35%, var(--border));
    border-radius: var(--radius);
    font-size: 13px;
  }

  .reset-summary p { margin: 0; }
  .reset-summary ul { margin: 0; padding-left: 1.25em; }
  .reset-irreversible { color: var(--danger); font-weight: 600; }

  .reset-ledger .onboarding-setting-actions { justify-content: flex-end; }

  @media (max-width: 900px) {
    .settings-content { grid-template-columns: 1fr; }
    .settings-nav { position: static; }
  }

  @media (max-width: 760px) {
    .setting-row,
    .onboarding-row { grid-template-columns: 1fr; gap: var(--space-3); }
    .onboarding-setting-actions { justify-content: flex-start; }
  }
</style>
