<script lang="ts">
  import AllocationCard, { type AllocationTile } from "$lib/overview/components/AllocationCard.svelte";
  import DailyChangeCard from "$lib/overview/components/DailyChangeCard.svelte";
  import DailyHistoryModal from "$lib/overview/components/DailyHistoryModal.svelte";
  import NetWorthCard from "$lib/overview/components/NetWorthCard.svelte";
  import OverviewTicker from "$lib/overview/components/OverviewTicker.svelte";
  import TodayChangeCard from "$lib/overview/components/TodayChangeCard.svelte";
  import { locale, t, type Translation } from "$lib/i18n/i18n.ts";
  import {
    ASSET_CATEGORY_COLOR,
    formatShortDate,
    formatTwd,
    liabilityColor,
    maskedAccountDigits,
  } from "$lib/overview/overview-format.ts";
  import { readOverview, type OverviewModel } from "$lib/overview/overview-model.ts";
  import { dateInTimeZone } from "$lib/shared-ledger/twd-valuation.ts";
  import type { OverviewPageDto } from "$lib/overview/types.ts";
  import {
    safeSourceGapLabel,
    sourceGapCounts,
  } from "$lib/shared-ledger/account-display.ts";
  import { awaitingFirstData } from "$lib/shared-ledger/first-data.ts";
  import { localizeAccount } from "$lib/shared-accounts/localize-account.ts";
  import DashboardShell from "$lib/shared-shell/components/DashboardShell.svelte";
  import EmptySourceBanner from "$lib/shared-shell/components/EmptySourceBanner.svelte";
  import ProgressiveBlock from "$lib/shared-shell/components/ProgressiveBlock.svelte";
  import type { BlockState } from "$lib/shared-shell/block-load-state.ts";
  import type {
    DashboardBlockPayload,
    DashboardBlockValueMap,
  } from "$lib/shared-shell/dashboard-blocks.ts";
  import { resolveOverview } from "$lib/shared-shell/progressive-dashboard-data.ts";
  import { formatAmountLines, formatMoney } from "$lib/shared-money/money.ts";
  import { systemTimezone } from "$lib/settings/system-timezone-store.ts";
  import {
    createOnboardingTargetRegistry,
    registerOnboardingTarget,
    type OnboardingTargetRegistry,
  } from "$lib/onboarding/target-observer.ts";
  import { formatUtcDateTime } from "$lib/time/timezone.ts";

  type OverviewBlocks = DashboardBlockValueMap["overview"];

  export let overview: OverviewPageDto;
  export let blocks: Readonly<Record<string, BlockState<DashboardBlockPayload>>> = {};
  export let retryBlock: (key: string) => void = () => {};
  export let onboardingTargets: OnboardingTargetRegistry = createOnboardingTargetRegistry();
  export let onboardingEmptyState = false;

  let detailOpen = false;

  function blockState(key: keyof OverviewBlocks): BlockState<DashboardBlockPayload> {
    return blocks[key] ?? { status: "loading" };
  }

  function overviewBlockData<Key extends keyof OverviewBlocks>(
    states: typeof blocks,
    key: Key,
  ): OverviewBlocks[Key] | undefined {
    const state = states[key];
    const payload = state && "data" in state ? state.data : undefined;
    return payload?.route === "overview" && payload.block === key
      ? payload.data as OverviewBlocks[Key]
      : undefined;
  }

  $: data = resolveOverview(overview, {
    summary: overviewBlockData(blocks, "summary"),
    chart: overviewBlockData(blocks, "chart"),
    list: overviewBlockData(blocks, "list"),
  });
  $: model = readOverview(data, { today: dateInTimeZone(new Date(), $systemTimezone) });
  $: netAmounts = overview.summary[0]?.amounts ?? [];
  $: convertedNet = model.netWorth.value;
  $: sideValue = convertedNet === null ? formatAmountLines(netAmounts.slice(0, 1)) : formatTwd(convertedNet, $locale);
  $: nativeRest = convertedNet === null ? netAmounts.slice(1).map((amount) => formatMoney(amount)).join(" / ") : "";
  $: sideSub = nativeRest ||
    (overview.importedAt ? $t.common.importedAt(formatImportedAt(overview.importedAt)) : $t.common.notYet);
  $: sideSubSensitive = nativeRest !== "";
  $: awaitingData = awaitingFirstData(overview);
  $: gapCounts = sourceGapCounts(overview.sourceGaps);
  $: currentStateLabel = overview.availability === "unavailable"
    ? $t.overview.currentUnavailable
    : overview.sourceGaps.length > 0
      ? $t.overview.currentPartial(gapCounts.currentValue, gapCounts.sourceNotCollected)
      : overview.availability === "awaiting"
        ? $t.overview.currentAwaiting
        : overview.availability === "empty"
          ? $t.overview.currentEmpty
          : $t.overview.currentUnavailable;
  $: holdsForeign = data.accounts.some((account) => account.amountLines.some((amount) => amount.currency !== "TWD"));
  $: assetTiles = model.assetAllocation.slices.map((slice): AllocationTile => ({
    key: slice.category,
    label: $t.overview.assetCategories[slice.category],
    value: slice.value,
    share: slice.share,
    color: ASSET_CATEGORY_COLOR[slice.category],
  }));
  $: liabilityTiles = model.liabilityAllocation.slices.map((slice): AllocationTile => ({
    key: slice.account.id,
    label: liabilityLabel(slice.account, $t),
    value: slice.value,
    share: slice.share,
    color: liabilityColor(slice.account.kind),
  }));

  function formatImportedAt(value: string | null) {
    return value
      ? formatUtcDateTime(value, $systemTimezone, $locale).replace(/:\d{2}$/, "")
      : $t.common.notYet;
  }

  function liabilityLabel(account: OverviewPageDto["accounts"][number], dictionary: Translation) {
    const digits = maskedAccountDigits(account.label);
    const { institution, product } = localizeAccount(account, dictionary);
    return `${institution} · ${product}${digits ? ` ${dictionary.overview.accountMask(digits)}` : ""}`;
  }

  function rateNote(current: OverviewModel, foreign: boolean, dictionary: Translation) {
    const date = current.assetAllocation.valuationDate;
    return foreign && date && current.assetAllocation.slices.length > 0
      ? dictionary.overview.allocationRateDate(formatShortDate(date, $locale))
      : "";
  }

  function unconvertedNote(currencies: string[]) {
    return currencies.length === 0 ? "" : $t.overview.unconverted(currencies.join(", "));
  }
</script>

<DashboardShell
  active="overview"
  eyebrow={$t.overview.eyebrow}
  title={$t.overview.title}
  sideLabel={$t.overview.sideLabel}
  {sideValue}
  {sideSub}
  {sideSubSensitive}
  syncLabel={overview.importedAt ? $t.common.importedAt(formatImportedAt(overview.importedAt)) : $t.common.notYet}
>
  <div class="content overview-content">
    <ProgressiveBlock label="summary" state={blockState("summary")} retry={() => retryBlock("summary")}>
      <OverviewTicker ticker={model.ticker} />
    </ProgressiveBlock>
    {#if awaitingData}
      <EmptySourceBanner
        title={$t.overview.emptyTitle}
        body={$t.overview.emptyBody}
        ariaLabel={$t.overview.currentEmpty}
        data-overview-state="empty"
        {onboardingTargets}
        onboardingTargetId="overview.empty"
      />
    {/if}
    {#if overview.coverage !== "complete" && !awaitingData}
      <div
        class="projection-state"
        role="status"
        data-overview-state={overview.coverage}
        use:registerOnboardingTarget={{
          registry: onboardingTargets,
          id: onboardingEmptyState ? "overview.empty" : null,
        }}
      >
        <span>{currentStateLabel}</span>
        {#if overview.sourceGaps.length > 0}
          <ul class="projection-gap-list" aria-label={$t.overview.sourceGapsAria}>
            {#each overview.sourceGaps as gap}
              <li>{safeSourceGapLabel(gap)}</li>
            {/each}
          </ul>
        {/if}
      </div>
    {/if}
    <ProgressiveBlock label="summary" state={blockState("summary")} retry={() => retryBlock("summary")}>
      <section
        aria-label={$t.overview.netWorth}
        use:registerOnboardingTarget={{ registry: onboardingTargets, id: "overview.summary" }}
      >
        <NetWorthCard
          netWorth={model.netWorth}
          series={model.series}
          asOfLabel={model.netWorth.asOf ? formatImportedAt(model.netWorth.asOf) : ""}
        />
      </section>
    </ProgressiveBlock>
    <ProgressiveBlock label="list" state={blockState("list")} retry={() => retryBlock("list")}>
      <div class="overview-row change-row">
        <DailyChangeCard
          bars={model.dailyBars}
          hasDetail={model.historyRows.length > 0}
          openDetail={() => (detailOpen = true)}
        />
        <TodayChangeCard change={model.todayChange} />
      </div>
    </ProgressiveBlock>
    <ProgressiveBlock label="chart" state={blockState("chart")} retry={() => retryBlock("chart")}>
      <div class="overview-row allocation-row">
        <AllocationCard
          state="assets"
          title={$t.overview.assetAllocation}
          total={model.assetAllocation.slices.length > 0 ? model.assetAllocation.total : null}
          rateNote={rateNote(model, holdsForeign, $t)}
          note={unconvertedNote(model.assetAllocation.unconvertedCurrencies)}
          href="#/assets"
          linkLabel={$t.nav.assets}
          tiles={assetTiles}
          emptyTitle={$t.overview.assetEmptyTitle}
          emptyBody={$t.overview.assetEmptyBody}
        />
        <AllocationCard
          state="liabilities"
          title={$t.overview.liabilityAllocation}
          total={model.liabilityAllocation.slices.length > 0 ? model.liabilityAllocation.total : null}
          ratio={model.liabilityAllocation.ratio}
          note={unconvertedNote(model.liabilityAllocation.unconvertedCurrencies)}
          href="#/liabilities"
          linkLabel={$t.nav.liabilities}
          tiles={liabilityTiles}
          emptyTitle={$t.overview.liabilityEmptyTitle}
          emptyBody={$t.overview.liabilityEmptyBody}
        />
      </div>
    </ProgressiveBlock>
  </div>
  <DailyHistoryModal bind:open={detailOpen} rows={model.historyRows} />
</DashboardShell>

<style>
  .overview-content {
    display: grid;
    gap: var(--space-6);
  }

  .overview-row {
    display: grid;
    gap: var(--space-6);
  }

  .change-row {
    grid-template-columns: minmax(0, 1.6fr) minmax(320px, 1fr);
  }

  .allocation-row {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  @media (max-width: 1180px) {
    .change-row,
    .allocation-row {
      grid-template-columns: minmax(0, 1fr);
    }
  }

  .projection-state {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: baseline;
    padding: var(--space-3) var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--muted);
    background: var(--surface-soft);
  }

  .projection-gap-list {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-3);
    margin: 0;
    padding: 0;
    list-style: none;
    color: var(--fg);
    font-size: 12px;
  }
</style>
