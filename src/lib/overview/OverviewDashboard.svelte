<script lang="ts">
  import AllocationCard, { type AllocationTile } from "$lib/overview/components/AllocationCard.svelte";
  import DailyChangeCard from "$lib/overview/components/DailyChangeCard.svelte";
  import DailyHistoryModal from "$lib/overview/components/DailyHistoryModal.svelte";
  import NetWorthCard from "$lib/overview/components/NetWorthCard.svelte";
  import OverviewTicker from "$lib/overview/components/OverviewTicker.svelte";
  import TodayChangeCard from "$lib/overview/components/TodayChangeCard.svelte";
  import { locale, t, type Translation } from "$lib/i18n/i18n.ts";
  import { ASSET_CATEGORY_COLOR, formatShortDate, liabilityColor } from "$lib/overview/overview-format.ts";
import { formatTwd } from "$lib/shared-money/money.ts";
  import { readOverview, type OverviewModel } from "$lib/overview/overview-model.ts";
  import type { OverviewPageDto } from "$lib/overview/types.ts";
  import { awaitingFirstData } from "$lib/shared-ledger/first-data.ts";
  import { accountKindLabel, accountShortLabel, localizeAccount } from "$lib/shared-accounts/localize-account.ts";
  import { institutionLogo } from "$lib/institutions/institutions.ts";
  import type { AllocationMember } from "$lib/shared-ledger/twd-valuation.ts";
  import DashboardShell from "$lib/shared-shell/components/DashboardShell.svelte";
  import EmptySourceBanner from "$lib/shared-shell/components/EmptySourceBanner.svelte";
  import { formatAmountLines, formatMoney } from "$lib/shared-money/money.ts";
  import { localDate, systemTimezone } from "$lib/settings/system-timezone-store.ts";
  import {
    createOnboardingTargetRegistry,
    registerOnboardingTarget,
    type OnboardingTargetRegistry,
  } from "$lib/onboarding/target-observer.ts";
  import { formatUtcDateTime } from "$lib/time/timezone.ts";

  export let overview: OverviewPageDto;
  export let onboardingTargets: OnboardingTargetRegistry = createOnboardingTargetRegistry();
  export let onboardingEmptyState = false;

  let detailOpen = false;



  $: model = readOverview(overview, { today: $localDate });
  $: net = overview.summary.net;
  $: liabilitiesMetric = overview.summary.liabilities;
  $: sideValue = net.incomplete
    ? $t.preview.incomplete
    : net.display === "native" ? formatAmountLines(net.amounts.slice(0, 1), $locale) : formatTwd(net.twd, $locale);
  $: nativeRest = net.display === "native" ? net.amounts.slice(1).map((amount) => formatMoney(amount, { locale: $locale })).join(" / ") : "";
  $: sideSub = nativeRest ||
    (overview.importedAt ? $t.common.importedAt(formatImportedAt(overview.importedAt)) : $t.common.notYet);
  $: sideSubSensitive = nativeRest !== "";
  $: awaitingData = awaitingFirstData(overview);
  $: holdsForeign = overview.accounts.some((account) => account.amountLines.some((amount) => amount.currency !== "TWD"));
  $: assetTiles = model.assetAllocation.slices.map((slice): AllocationTile => ({
    key: slice.category,
    label: $t.overview.assetCategories[slice.category],
    value: slice.value,
    share: slice.share,
    color: ASSET_CATEGORY_COLOR[slice.category],
    members: tileMembers(slice.accounts, slice.value, $t),
  }));
  $: liabilityTiles = model.liabilityAllocation.slices.map((slice): AllocationTile => ({
    key: slice.kind,
    label: accountKindLabel(slice.kind, $t),
    value: slice.value,
    share: slice.share,
    color: liabilityColor(slice.kind),
    members: tileMembers(slice.accounts, slice.value, $t),
  }));

  function formatImportedAt(value: string | null) {
    return value
      ? formatUtcDateTime(value, $systemTimezone, $locale).replace(/:\d{2}$/, "")
      : $t.common.notYet;
  }

  /** 「銀行帳戶 末碼 1234」, and with its Institution for where no logo names it. */
  function memberNames(account: OverviewPageDto["accounts"][number], dictionary: Translation) {
    const short = accountShortLabel(account, dictionary);
    return { short, label: `${localizeAccount(account, dictionary).institution} · ${short}` };
  }

  /** The accounts a tile adds up, for its hover breakdown. */
  function tileMembers(accounts: readonly AllocationMember[], total: number, dictionary: Translation): AllocationTile["members"] {
    return accounts.map(({ account, value }) => ({
      key: account.id,
      ...memberNames(account, dictionary),
      logo: institutionLogo(account.institutionKey),
      value,
      share: total > 0 ? value / total : 0,
    }));
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
  sideValueSensitive={!net.incomplete}
  sideProvenance={net.provenance}
  syncLabel={overview.importedAt ? $t.common.importedAt(formatImportedAt(overview.importedAt)) : $t.common.notYet}
>
  <div class="content overview-content">
    <div class="block-frame">
      <OverviewTicker ticker={model.ticker} />
    </div>
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
    {#if overview.coverage === "unavailable" && !awaitingData}
      <div
        class="projection-state"
        role="status"
        data-overview-state={overview.coverage}
        use:registerOnboardingTarget={{
          registry: onboardingTargets,
          id: onboardingEmptyState ? "overview.empty" : null,
        }}
      >
        <span>{$t.overview.currentUnavailable}</span>
      </div>
    {/if}
    <div class="block-frame">
      <section
        aria-label={$t.overview.netWorth}
        use:registerOnboardingTarget={{ registry: onboardingTargets, id: "overview.summary" }}
      >
        <NetWorthCard
          {net}
          netWorth={model.netWorth}
          series={model.series}
          asOfLabel={model.netWorth.asOf ? formatImportedAt(model.netWorth.asOf) : ""}
          incomplete={net.incomplete}
        />
      </section>
    </div>
    <div class="block-frame">
      <div class="overview-row change-row">
        <DailyChangeCard
          bars={model.dailyBars}
          hasDetail={model.historyRows.length > 0}
          openDetail={() => (detailOpen = true)}
        />
        <TodayChangeCard change={model.todayChange} />
      </div>
    </div>
    <div class="block-frame">
      <div class="overview-row allocation-row">
        <AllocationCard
          state="assets"
          title={$t.overview.assetAllocation}
          total={model.assetAllocation.slices.length > 0 ? model.assetAllocation.total : null}
          rateNote={rateNote(model, holdsForeign, $t)}
          incomplete={model.assetAllocation.incomplete}
          note={unconvertedNote(model.assetAllocation.unconvertedCurrencies)}
          provenance={model.assetAllocation.provenance}
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
          incomplete={liabilitiesMetric.incomplete === true || model.liabilityAllocation.incomplete}
          provenance={model.liabilityAllocation.provenance}
          note={unconvertedNote(model.liabilityAllocation.unconvertedCurrencies)}
          href="#/liabilities"
          linkLabel={$t.nav.liabilities}
          tiles={liabilityTiles}
          emptyTitle={$t.overview.liabilityEmptyTitle}
          emptyBody={$t.overview.liabilityEmptyBody}
        />
      </div>
    </div>
  </div>
  <DailyHistoryModal bind:open={detailOpen} rows={model.historyRows} />
</DashboardShell>

<style>
  .block-frame { position: relative; min-width: 0; }
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
</style>
