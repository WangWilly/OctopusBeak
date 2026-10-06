<script lang="ts">
  import { Landmark, RefreshCw } from "@lucide/svelte";

  import { t } from "$lib/i18n/i18n.ts";
  import {
    createOnboardingTargetRegistry,
    registerOnboardingTarget,
    type OnboardingTargetRegistry,
  } from "$lib/onboarding/target-observer.ts";

  export let title: string;
  export let body: string;
  export let ariaLabel = title;
  export let onboardingTargets: OnboardingTargetRegistry = createOnboardingTargetRegistry();
  export let onboardingTargetId: string | null = null;
</script>

<section class="empty-source-banner" role="status" aria-label={ariaLabel} {...$$restProps}>
  <span class="empty-icon" aria-hidden="true"><Landmark size={20} strokeWidth={1.8} /></span>
  <div class="empty-copy">
    <strong>{title}</strong>
    <p>{body}</p>
  </div>
  <a
    class="button primary"
    href="#/automation"
    data-go-automation
    use:registerOnboardingTarget={{ registry: onboardingTargets, id: onboardingTargetId }}
  ><RefreshCw size={15} strokeWidth={2} aria-hidden="true" />{$t.overview.goToAutomation}</a>
</section>

<style>
  .empty-source-banner {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-4);
    padding: var(--space-5) var(--space-6);
    border: 1px solid color-mix(in oklch, var(--accent) 24%, var(--border));
    border-radius: var(--radius-lg);
    background: var(--accent-soft);
  }

  .empty-icon {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--accent);
  }

  .empty-copy {
    flex: 1 1 320px;
    min-width: 0;
  }

  .empty-copy strong {
    font-size: 16px;
    font-weight: 700;
  }

  .empty-copy p {
    margin: 2px 0 0;
    color: var(--muted);
    font-size: 13px;
  }
</style>
