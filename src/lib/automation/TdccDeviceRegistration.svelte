<script lang="ts">
  import { onDestroy } from "svelte";
  import { Smartphone } from "@lucide/svelte";
  import { t } from "$lib/i18n/i18n.ts";
  import type {
    TdccRegistrationChannel,
    TdccRegistrationFailure,
    TdccRegistrationStep,
  } from "$lib/automation/types.ts";

  /** Both TDCC sign-in details are saved, with no unsaved edit staged over them. */
  export let signInDetailsSaved: boolean;
  /** A sync-tdcc run is active; the host refuses to register until it ends. */
  export let syncActive: boolean;
  /** TDCC is enabled for sync, so the phone App conflict applies. */
  export let sourceEnabled: boolean;
  /** True from the moment registration starts until it ends, for the dashboard to hold back a TDCC sync. */
  export let registering = false;

  type Registration =
    | { step: "idle" }
    | { step: "starting" }
    | { step: "code"; registrationId: string; channel: TdccRegistrationChannel; submitting: boolean }
    | { step: "registered" }
    | { step: "failed"; reason: TdccRegistrationFailure };

  const CODE_PATTERN = /^\d{4,8}$/u;

  let registered: boolean | null = null;
  let registration: Registration = { step: "idle" };
  let code = "";
  let statusRequest = 0;

  $: registering = registration.step === "starting" || registration.step === "code";
  $: showConflict = sourceEnabled || registration.step !== "idle";
  $: void refreshStatus(signInDetailsSaved);

  async function refreshStatus(_saved: boolean) {
    const request = ++statusRequest;
    try {
      const status = await window.octopusBeak.automation.tdccDeviceRegistrationStatus();
      if (request === statusRequest) registered = status.registered;
    } catch {
      if (request === statusRequest) registered = null;
    }
  }

  function apply(next: TdccRegistrationStep) {
    code = "";
    if (next.status === "code-required") {
      registration = { step: "code", registrationId: next.registrationId, channel: next.channel, submitting: false };
    } else if (next.status === "registered") {
      registration = { step: "registered" };
      registered = true;
    } else {
      registration = { step: "failed", reason: next.reason };
      void refreshStatus(signInDetailsSaved);
    }
  }

  async function start() {
    if (registering) return;
    registration = { step: "starting" };
    try {
      apply(await window.octopusBeak.automation.startTdccDeviceRegistration());
    } catch {
      apply({ status: "failed", reason: "unavailable" });
    }
  }

  async function submit() {
    if (registration.step !== "code" || registration.submitting || !CODE_PATTERN.test(code)) return;
    const { registrationId } = registration;
    const typed = code;
    code = "";
    registration = { ...registration, submitting: true };
    try {
      apply(await window.octopusBeak.automation.submitTdccRegistrationCode(registrationId, typed));
    } catch {
      apply({ status: "failed", reason: "unavailable" });
    }
  }

  async function cancel() {
    if (registration.step !== "code") return;
    const { registrationId } = registration;
    code = "";
    registration = { step: "idle" };
    await window.octopusBeak.automation.cancelTdccDeviceRegistration(registrationId).catch(() => undefined);
  }

  function keepDigits(event: Event) {
    code = (event.currentTarget as HTMLInputElement).value.replace(/\D/gu, "").slice(0, 8);
    (event.currentTarget as HTMLInputElement).value = code;
  }

  onDestroy(() => {
    if (registration.step === "code") {
      void window.octopusBeak.automation.cancelTdccDeviceRegistration(registration.registrationId).catch(() => undefined);
    }
  });
</script>

<section class="tdcc-device" aria-labelledby="tdcc-device-title" data-step={registration.step}>
  <div class="tdcc-device-head">
    <div>
      <h4 id="tdcc-device-title" tabindex="-1">{$t.automation.tdccDevice.title}</h4>
      <p>{$t.automation.tdccDevice.description}</p>
    </div>
    {#if registered === true}
      <span class="chip good">{$t.automation.tdccDevice.registered}</span>
    {:else if registered === false}
      <span class="chip">{$t.automation.tdccDevice.notRegistered}</span>
    {/if}
  </div>

  {#if showConflict}
    <div class="tdcc-device-conflict" role="note">
      <Smartphone size={16} aria-hidden="true" />
      <p>
        <strong>{$t.automation.tdccDevice.conflictTitle}</strong>
        <span>{$t.automation.tdccDevice.conflictBody}</span>
      </p>
    </div>
  {/if}

  {#if registration.step === "code"}
    {@const channel = registration.channel}
    <form class="tdcc-device-code" onsubmit={(event) => { event.preventDefault(); void submit(); }}>
      <label for="tdcc-registration-code">{$t.automation.tdccDevice.codeLabel[channel]}</label>
      <div class="tdcc-device-code-row">
        <input
          id="tdcc-registration-code"
          name="tdcc-registration-code"
          type="text"
          inputmode="numeric"
          autocomplete="one-time-code"
          maxlength="8"
          value={code}
          disabled={registration.submitting}
          aria-describedby="tdcc-registration-code-help"
          oninput={keepDigits}
        />
        <button class="button primary" type="submit" disabled={registration.submitting || !CODE_PATTERN.test(code)}>
          {#if registration.submitting}<span class="spinner" aria-hidden="true"></span>{/if}
          {$t.automation.tdccDevice.submit}
        </button>
        <button class="button" type="button" disabled={registration.submitting} onclick={() => void cancel()}>
          {$t.common.cancel}
        </button>
      </div>
      <p id="tdcc-registration-code-help" class="tdcc-device-help">{$t.automation.tdccDevice.codeHelp}</p>
    </form>
  {:else}
    <div class="tdcc-device-actions">
      <button
        class="button secondary"
        type="button"
        disabled={!signInDetailsSaved || syncActive || registration.step === "starting"}
        onclick={() => void start()}
      >
        {#if registration.step === "starting"}<span class="spinner" aria-hidden="true"></span>{/if}
        {registration.step === "starting"
          ? $t.automation.tdccDevice.starting
          : registered ? $t.automation.tdccDevice.registerAgain : $t.automation.tdccDevice.register}
      </button>
      {#if !signInDetailsSaved}
        <span class="tdcc-device-help">{$t.automation.tdccDevice.saveFirst}</span>
      {:else if syncActive}
        <span class="tdcc-device-help">{$t.automation.tdccDevice.failures["sync-running"]}</span>
      {/if}
    </div>
  {/if}

  <p class="tdcc-device-result" aria-live="polite">
    {#if registration.step === "registered"}
      <span class="tdcc-device-ok">{$t.automation.tdccDevice.registeredMessage}</span>
    {:else if registration.step === "failed"}
      <span class="tdcc-device-error">{$t.automation.tdccDevice.failures[registration.reason]}</span>
    {/if}
  </p>
</section>

<style>
  .tdcc-device {
    display: grid;
    gap: var(--space-3);
    padding: var(--space-4) var(--space-5);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
  }

  .tdcc-device-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-4);
  }

  .tdcc-device-head h4 {
    margin: 0 0 var(--space-1);
    font-size: 15px;
    outline: none;
  }

  .tdcc-device-head p,
  .tdcc-device-help {
    margin: 0;
    color: var(--muted);
    font-size: 13px;
    line-height: 1.55;
  }

  .tdcc-device-head .chip {
    flex: none;
  }

  .tdcc-device-conflict {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    border: 1px solid color-mix(in oklch, var(--warn) 34%, var(--border));
    border-radius: var(--radius);
    background: color-mix(in oklch, var(--warn) 6%, var(--surface));
    color: var(--fg);
    font-size: 13px;
    line-height: 1.55;
  }

  .tdcc-device-conflict :global(svg) {
    flex: none;
    margin-top: 2px;
    color: var(--warn);
  }

  .tdcc-device-conflict p {
    display: grid;
    gap: 2px;
    margin: 0;
  }

  .tdcc-device-conflict span {
    color: var(--muted);
  }

  .tdcc-device-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3);
  }

  .tdcc-device-actions .button,
  .tdcc-device-code-row .button {
    min-height: 36px;
  }

  .tdcc-device-code {
    display: grid;
    gap: var(--space-2);
  }

  .tdcc-device-code label {
    font-size: 13px;
    font-weight: 680;
  }

  .tdcc-device-code-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .tdcc-device-code-row input {
    width: 12ch;
    min-height: 36px;
    padding: 0 var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--fg);
    font-family: var(--font-mono);
    font-size: 15px;
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.12em;
    outline: none;
  }

  .tdcc-device-code-row input:focus {
    border-color: var(--fg);
    box-shadow: 0 0 0 3px var(--surface-soft);
  }

  .tdcc-device-result {
    margin: 0;
    font-size: 13px;
  }

  .tdcc-device-result:empty {
    display: none;
  }

  .tdcc-device-ok {
    color: var(--success);
  }

  .tdcc-device-error {
    color: var(--danger);
  }
</style>
