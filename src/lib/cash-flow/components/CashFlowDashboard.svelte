<script lang="ts">
  import { ArrowLeftRight, ArrowRight, Calendar, CircleHelp, Filter, PiggyBank, Search, X } from "@lucide/svelte";
  import { locale, t } from "$lib/i18n/i18n.ts";
  import DashboardShell from "$lib/shared-shell/components/DashboardShell.svelte";
  import { moneyText } from "$lib/spending/components/money-text.ts";
  import { dayHeadingText } from "$lib/spending/spending-display.ts";
  import {
    compareExact,
    exactToNumber,
    isZeroExact,
    subtractExact,
    normalizeExact,
    addExact,
    type ExactAmount,
  } from "$lib/shared-money/exact-money.ts";
  import type { CashFlowInflowGroup } from "../../../ledger/canonical/cash-flow-inclusion.ts";
  import type { CashFlowAccount, CashFlowPageDto, CashFlowPageRequest, CashFlowRow } from "../model.ts";
  import { CASH_FLOW_SEARCH_FIELDS, cashFlowTransferRole } from "../model.ts";
  import {
    accountInitial,
    accountLabel,
    countedNet,
    groupByDay,
    inflowColor,
    inflowGroupLabel,
    outflowColor,
    outflowGroupLabel,
    percent,
    rowCategoryText,
    rowGroupAmount,
    rowTitle,
    rowTouchesGroup,
    signedAmount,
    type OutflowGroupKey,
  } from "../display.ts";
  import { quickRange, rangeText, type CashFlowPeriodChoice, type CashFlowPreset, type CashFlowRange } from "../period.ts";
  import CashFlowRangePicker from "./CashFlowRangePicker.svelte";

  export let page: CashFlowPageDto;
  export let request: CashFlowPageRequest;
  /** The preset the person chose for `request`, kept apart from the range because two presets can give the same one. */
  export let periodChoice: CashFlowPeriodChoice;
  export let today: string;
  export let loading = false;
  export let changeRequest: (request: CashFlowPageRequest, choice?: CashFlowPeriodChoice) => void;

  type Drill = Readonly<{ kind: "outflow"; group: OutflowGroupKey }> | Readonly<{ kind: "inflow"; group: CashFlowInflowGroup }>;

  let selectedCurrency = "";
  let pickerOpen = false;
  let drill: Drill | null = null;
  let listFilter: Drill | null = null;
  /** The account itself, so the filter still names it in a period where it did not move. */
  let accountFilter: CashFlowAccount | null = null;
  let searchText = request.query ?? "";
  let searchTimer: ReturnType<typeof setTimeout> | null = null;

  $: currencies = page.currencies.map((summary) => summary.currency);
  $: if (!currencies.includes(selectedCurrency)) selectedCurrency = currencies[0] ?? "TWD";
  $: summary = page.currencies.find((entry) => entry.currency === selectedCurrency) ?? null;
  // The figures on screen are the page's, which may still be the previous period while a new one loads.
  let shownChoice = periodChoice;
  $: if (!loading) shownChoice = periodChoice;
  $: periodName = $t.cashFlow.periodThis[shownChoice];
  $: range = { startDate: page.period.startDate, endDate: page.period.endDate };
  $: scale = summary ? Math.max(exactToNumber(summary.inflow.amount), exactToNumber(summary.outflow.amount), 0) : 0;
  $: keptPositive = summary !== null && compareExact(summary.kept, { coefficient: "0", scale: 0 }) > 0;
  $: accounts = page.accounts.filter((change) => change.currency === selectedCurrency);
  $: accountScale = Math.max(0, ...accounts.map((change) => Math.abs(exactToNumber(change.amount))));
  $: visibleRows = page.transactions.filter((row) =>
    (accountFilter === null || row.accountId === accountFilter.id) && (listFilter === null || rowInGroup(row, listFilter)));
  $: days = groupByDay(visibleRows);
  $: searchNet = countedNet(page.transactions);
  $: fieldCounts = page.search?.fields ?? null;
  $: drillRows = drill === null ? [] : page.transactions.filter((row) => row.amount.currency === selectedCurrency && rowInGroup(row, drill!));
  $: transfers = summary?.transfers ?? null;

  function amountText(amount: ExactAmount, currency = selectedCurrency, signed = false) {
    return moneyText({ ...amount, currency }, $locale, signed);
  }

  function digits(amount: ExactAmount, signed = false) {
    return amountText(amount, selectedCurrency, signed).replace(/^[A-Z]{3} /u, "");
  }

  function share(part: ExactAmount, whole: ExactAmount): number {
    const total = exactToNumber(whole);
    return total > 0 ? exactToNumber(part) / total : 0;
  }

  function width(amount: ExactAmount): string {
    return scale > 0 ? `${Math.max(0, exactToNumber(amount)) / scale * 100}%` : "0%";
  }

  function rowInGroup(row: CashFlowRow, target: Drill): boolean {
    if (target.kind === "inflow") return row.cashFlow.class === "inflow" && row.cashFlow.group === target.group;
    return rowTouchesGroup(row, target.group);
  }

  function drillLabel(target: Drill): string {
    return target.kind === "inflow" ? inflowGroupLabel($t, target.group) : outflowGroupLabel($t, target.group);
  }

  function sameDrill(left: Drill | null, right: Drill): boolean {
    return left !== null && left.kind === right.kind && left.group === right.group;
  }

  function openDrill(target: Drill) {
    drill = sameDrill(drill, target) ? null : target;
  }

  function choosePreset(next: CashFlowPreset) {
    pickerOpen = false;
    changeRequest({ ...quickRange(next, today), ...(request.query ? { query: request.query } : {}) }, next);
  }

  function applyRange(next: CashFlowRange) {
    pickerOpen = false;
    changeRequest({ ...next, ...(request.query ? { query: request.query } : {}) }, "custom");
  }

  function search(text: string) {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const query = text.trim();
      changeRequest({ startDate: request.startDate, endDate: request.endDate, ...(query ? { query } : {}) });
    }, 300);
  }

  function clearSearch() {
    searchText = "";
    if (searchTimer) clearTimeout(searchTimer);
    changeRequest({ startDate: request.startDate, endDate: request.endDate });
  }

  /** Through today, or through the last match when one is dated later, so the range holds every match the hint counted. */
  function searchAllPeriods() {
    const all = page.search?.allPeriods;
    if (!all?.firstDate || !all.lastDate) return;
    const endDate = all.lastDate > today ? all.lastDate : today;
    changeRequest({ startDate: all.firstDate < endDate ? all.firstDate : endDate, endDate, ...(request.query ? { query: request.query } : {}) }, "custom");
  }

  function transferOriginText(origins: Readonly<{ evidence: number; confirmed: number; manual: number }>): string {
    return origins.confirmed === 0 && origins.manual === 0 ? $t.cashFlow.transfersAutoPaired : $t.cashFlow.transferOrigins(origins);
  }

  function onlyGroup(target: Drill) {
    listFilter = target;
    drill = null;
  }

  $: headlineText = headline(summary, periodName, keptPositive, $t, $locale);
  $: keptText = keptLine(summary, $t, $locale);

  function headline(..._inputs: unknown[]): string {
    if (!summary || isZeroExact(summary.inflow.amount)) return $t.cashFlow.noInflow(periodName);
    if (!keptPositive) return $t.cashFlow.keptNegative(periodName, amountText(normalizeExact(subtractExact(summary.outflow.amount, summary.inflow.amount))));
    return $t.cashFlow.keptPer100(periodName, String(Math.round((summary.keptRatio ?? 0) * 100)));
  }

  function topShare(groups: readonly { amount: ExactAmount }[], whole: ExactAmount, label: string, count: number): string {
    const top = groups[0];
    if (!top || groups.length < 2 || exactToNumber(whole) <= 0) return $t.cashFlow.countOnly(count);
    return $t.cashFlow.countShare(count, label, percent(share(top.amount, whole), $locale));
  }

  function keptLine(..._inputs: unknown[]): string {
    if (!summary || summary.keptRatio === null) return "";
    const own = $t.cashFlow.keptShare(percent(summary.keptRatio, $locale));
    if (summary.previous.keptRatio === null) return own;
    const points = Math.round((summary.keptRatio - summary.previous.keptRatio) * 100);
    return $t.cashFlow.keptWithPrevious(own, points === 0 ? $t.cashFlow.keptSameAsPrevious : $t.cashFlow.keptVersusPrevious(String(Math.abs(points)), points > 0));
  }

  function rowTag(row: CashFlowRow): string | null {
    if (row.cashFlow.class === "unresolved") return $t.cashFlow.unresolvedTag;
    if (row.cashFlow.class === "not_counted") {
      const role = cashFlowTransferRole(row);
      if (role === "paired") return $t.cashFlow.pairedTransferTag;
      return role === "internal" ? $t.cashFlow.transferTag : $t.cashFlow.notCounted[row.cashFlow.reason];
    }
    return null;
  }

  function dayNumberText(date: string): string {
    return date.slice(8, 10);
  }

  function dayMeta(date: string): string {
    return dayHeadingText(date, $locale).replace(/\d+日\s*/u, " ").replace(/,?\s*\d+$/u, "");
  }
</script>

<DashboardShell
  active="cash-flow"
  eyebrow={$t.cashFlow.eyebrow}
  title={$t.cashFlow.title}
  sideLabel={`${periodName} · ${$t.cashFlow.kept}`}
  sideValue={summary ? amountText(summary.kept, selectedCurrency, true) : "—"}
  sideSub={$t.cashFlow.dailyMeta(page.period.days, page.transactionCount)}
>
  <div class="content cash-flow" class:loading data-cash-flow-page data-period={`${page.period.startDate}/${page.period.endDate}`} aria-busy={loading}>
    <section class="card flow-summary" aria-labelledby="cash-flow-headline">
      <header class="summary-head">
        <div>
          <p class="period-line"><Calendar size={13} strokeWidth={2} aria-hidden="true" />{$t.cashFlow.periodHeading(rangeText(range, today), $t.cashFlow.periodDays(page.period.days))}</p>
          <h2 id="cash-flow-headline" data-cash-flow-headline>{headlineText}</h2>
          {#if loading}<p class="loading-line" role="status" data-cash-flow-loading><span class="spinner" aria-hidden="true"></span>{$t.cashFlow.loading}</p>{/if}
        </div>
        <div class="period-controls">
          {#if currencies.length > 1}
            <div class="filters" role="group" aria-label={$t.cashFlow.currencyAria}>
              {#each currencies as currency (currency)}
                <button type="button" class="filter-btn" aria-pressed={currency === selectedCurrency} onclick={() => selectedCurrency = currency}>{currency}</button>
              {/each}
            </div>
          {/if}
          <div class="preset-anchor">
            <div class="filters preset-switch" role="group" aria-label={$t.cashFlow.periodAria}>
              {#each ["week", "month", "last30"] as const as option (option)}
                <button type="button" class="filter-btn" aria-pressed={!pickerOpen && periodChoice === option} data-preset={option} onclick={() => choosePreset(option)}>{$t.cashFlow.presets[option]}</button>
              {/each}
              <button type="button" class="filter-btn" aria-pressed={periodChoice === "custom" || pickerOpen} aria-expanded={pickerOpen} data-preset="custom" onclick={() => pickerOpen = !pickerOpen}>{$t.cashFlow.presets.custom}</button>
            </div>
            {#if pickerOpen}
              <CashFlowRangePicker {range} {today} apply={applyRange} cancel={() => pickerOpen = false} />
            {/if}
          </div>
        </div>
      </header>

      {#if summary}
        <div class="figures">
          <div class="figure inflow">
            <span class="figure-label">{$t.cashFlow.inflow}</span>
            <strong class="money" data-sensitive data-figure="inflow">{digits(summary.inflow.amount)}</strong>
            <span class="figure-sub">{topShare(summary.inflow.groups, summary.inflow.amount, summary.inflow.groups[0] ? inflowGroupLabel($t, summary.inflow.groups[0].group) : "", summary.inflow.count)}</span>
          </div>
          <span class="operator" aria-hidden="true">−</span>
          <div class="figure outflow">
            <span class="figure-label">{$t.cashFlow.outflow}</span>
            <strong class="money" data-sensitive data-figure="outflow">{digits(summary.outflow.amount)}</strong>
            <span class="figure-sub">{topShare(summary.outflow.groups, summary.outflow.amount, summary.outflow.groups[0] ? outflowGroupLabel($t, summary.outflow.groups[0].group) : "", summary.outflow.count)}</span>
          </div>
          <span class="operator" aria-hidden="true">=</span>
          <div class="figure kept" class:negative={!keptPositive && !isZeroExact(summary.kept)}>
            <span class="figure-label">{$t.cashFlow.kept}</span>
            <strong class="money" data-sensitive data-figure="kept">{digits(summary.kept)}</strong>
            <span class="figure-sub">{keptText}</span>
          </div>
          <div class="aside-notes">
            {#if transfers && (transfers.pairs.count > 0 || transfers.unpaired.count > 0)}
              <div class="note transfer" data-transfers>
                {#if transfers.pairs.count > 0}
                  <span class="note-head" data-transfer-pairs><ArrowLeftRight size={13} strokeWidth={2.2} aria-hidden="true" />{$t.cashFlow.transferPairs(transfers.pairs.count)}</span>
                  <strong class="money" data-sensitive>{amountText(transfers.pairs.amount)}</strong>
                  {#if transfers.unpaired.count > 0}
                    <span class="note-extra" data-transfer-unpaired data-sensitive>{$t.cashFlow.transferUnpaired(transfers.unpaired.count, amountText(transfers.unpaired.amount))}</span>
                  {/if}
                  <span data-transfer-origins>{transferOriginText(transfers.pairs.origins)}</span>
                {:else}
                  <span class="note-head" data-transfer-unpaired><ArrowLeftRight size={13} strokeWidth={2.2} aria-hidden="true" />{$t.cashFlow.transferUnpairedOnly(transfers.unpaired.count)}</span>
                  <strong class="money" data-sensitive>{amountText(transfers.unpaired.amount)}</strong>
                  <span>{$t.cashFlow.transfersNote}</span>
                {/if}
              </div>
            {/if}
            {#if summary.unresolved.count > 0}
              <div class="note unresolved" data-unresolved>
                <span class="note-head"><CircleHelp size={13} strokeWidth={2.2} aria-hidden="true" />{$t.cashFlow.unresolved(summary.unresolved.count)}</span>
                <strong class="money" data-sensitive>{amountText(summary.unresolved.amount)}</strong>
                <span>{$t.cashFlow.unresolvedNote}</span>
              </div>
            {/if}
          </div>
        </div>

        <div class="flow-bars" aria-label={$t.cashFlow.flowBarAria} role="group">
          <span class="bar-label">{$t.cashFlow.inflow}</span>
          <div class="bar">
            {#each summary.inflow.groups as group, index (group.group)}
              <button
                type="button"
                class="segment"
                class:dimmed={drill !== null && !sameDrill(drill, { kind: "inflow", group: group.group })}
                style:width={width(group.amount)}
                style:background={inflowColor(index)}
                title={`${inflowGroupLabel($t, group.group)} ${digits(group.amount)}`}
                data-inflow-group={group.group}
                onclick={() => openDrill({ kind: "inflow", group: group.group })}
              >{#if index === 0}<span data-sensitive>{inflowGroupLabel($t, group.group)} {digits(group.amount)}</span>{/if}</button>
            {/each}
          </div>
          <span class="bar-label">{$t.cashFlow.outflow}</span>
          <div class="bar">
            {#each summary.outflow.groups.filter((group) => exactToNumber(group.amount) > 0) as group, index (group.group ?? "unclassified")}
              <button
                type="button"
                class="segment"
                class:dimmed={drill !== null && !sameDrill(drill, { kind: "outflow", group: group.group })}
                style:width={width(group.amount)}
                style:background={outflowColor(group.group)}
                title={`${outflowGroupLabel($t, group.group)} ${digits(group.amount)}`}
                data-outflow-group={group.group ?? "unclassified"}
                onclick={() => openDrill({ kind: "outflow", group: group.group })}
              >{#if index === 0}<span data-sensitive>{outflowGroupLabel($t, group.group)} {digits(group.amount)}</span>{/if}</button>
            {/each}
            {#if keptPositive && summary.keptRatio !== null}
              <span class="segment kept-segment" style:width={width(summary.kept)} class:dimmed={drill !== null}>
                <PiggyBank size={14} strokeWidth={2} aria-hidden="true" /><span data-sensitive>{$t.cashFlow.keptBar(digits(summary.kept), percent(summary.keptRatio, $locale))}</span>
              </span>
            {/if}
          </div>
          <div class="legend">
            {#if summary.inflow.groups.length > 0}
              <span class="legend-title inflow">{$t.cashFlow.inflow}</span>
              {#each summary.inflow.groups as group, index (group.group)}
                <button type="button" class="legend-item" aria-pressed={sameDrill(drill, { kind: "inflow", group: group.group })} onclick={() => openDrill({ kind: "inflow", group: group.group })}>
                  <span class="dot" style:background={inflowColor(index)} aria-hidden="true"></span>{inflowGroupLabel($t, group.group)}<span class="money" data-sensitive>{digits(group.amount)}</span>
                </button>
              {/each}
            {/if}
            {#if summary.outflow.groups.length > 0}
              <span class="legend-title">{$t.cashFlow.outflow}</span>
              {#each summary.outflow.groups as group (group.group ?? "unclassified")}
                <button type="button" class="legend-item" aria-pressed={sameDrill(drill, { kind: "outflow", group: group.group })} data-legend-outflow={group.group ?? "unclassified"} onclick={() => openDrill({ kind: "outflow", group: group.group })}>
                  <span class="dot" style:background={outflowColor(group.group)} aria-hidden="true"></span>{outflowGroupLabel($t, group.group)}<span class="money" data-sensitive>{digits(group.amount)}</span>
                </button>
              {/each}
            {/if}
          </div>

          {#if drill}
            {@const target = drill}
            {@const outflowGroup = target.kind === "outflow" ? summary.outflow.groups.find((group) => group.group === target.group) : undefined}
            {@const inflowGroup = target.kind === "inflow" ? summary.inflow.groups.find((group) => group.group === target.group) : undefined}
            {@const total = outflowGroup?.amount ?? inflowGroup?.amount ?? { coefficient: "0", scale: 0 }}
            {@const amounts = drillRows
              .map((row) => ({ row, amount: target.kind === "outflow" ? rowGroupAmount(row, target.group) ?? row.amount : row.amount }))
              .sort((left, right) => compareExact(right.amount, left.amount))}
            {@const largest = Math.max(0, ...amounts.map((entry) => exactToNumber(entry.amount)))}
            <div class="drill" role="dialog" aria-label={drillLabel(target)} data-drill={target.kind === "outflow" ? target.group ?? "unclassified" : target.group}>
              <header class="drill-head">
                <div>
                  <p class="drill-title">
                    <span class="dot" style:background={target.kind === "outflow" ? outflowColor(target.group) : inflowColor(summary.inflow.groups.findIndex((group) => group.group === target.group))} aria-hidden="true"></span>
                    <strong>{drillLabel(target)}</strong>
                    <span>{target.kind === "outflow"
                      ? $t.cashFlow.drillShare(percent(share(total, summary.outflow.amount), $locale), outflowGroup?.count ?? 0)
                      : $t.cashFlow.drillInflowShare(percent(share(total, summary.inflow.amount), $locale), inflowGroup?.count ?? 0)}</span>
                  </p>
                  <strong class="drill-amount money" data-sensitive>{digits(total)}</strong>
                  {#if page.search}
                    {@const matched = amounts.reduce((sum, entry) => normalizeExact(addExact(sum, entry.amount)), { coefficient: "0", scale: 0 })}
                    <p class="drill-search" data-drill-search data-sensitive>{$t.cashFlow.drillSearchMatches(page.search.query, amounts.length, digits(matched))}</p>
                  {/if}
                  {#if outflowGroup && !isZeroExact(outflowGroup.previous)}
                    {@const difference = normalizeExact(subtractExact(outflowGroup.amount, outflowGroup.previous))}
                    <p class="drill-compare" data-sensitive>{$t.cashFlow.drillVersusPrevious(digits(difference, true))}</p>
                  {/if}
                </div>
                <button type="button" class="icon-button" aria-label={$t.cashFlow.drillClose} onclick={() => drill = null}><X size={16} strokeWidth={2} aria-hidden="true" /></button>
              </header>
              <ul class="drill-list">
                {#each amounts as entry (entry.row.transactionId)}
                  <li>
                    <span class="drill-date num">{entry.row.date.slice(5).replace("-", "/")}</span>
                    <span class="drill-name">{rowTitle($t, entry.row)}</span>
                    <span class="money" data-sensitive>{digits(entry.amount)}</span>
                    <span class="drill-bar" aria-hidden="true"><span style:width={largest > 0 ? `${Math.max(0, exactToNumber(entry.amount)) / largest * 100}%` : "0%"} style:background={target.kind === "outflow" ? outflowColor(target.group) : inflowColor(0)}></span></span>
                  </li>
                {/each}
              </ul>
              {#if !page.search && amounts.length > 1 && exactToNumber(total) > 0}
                <p class="drill-fact">{$t.cashFlow.drillLargest(percent(largest / exactToNumber(total), $locale))}</p>
              {/if}
              <footer class="drill-foot">
                <button type="button" class="button primary" data-drill-only onclick={() => onlyGroup(target)}><Filter size={14} strokeWidth={2} aria-hidden="true" />{$t.cashFlow.drillOnly(drillLabel(target))}</button>
              </footer>
            </div>
          {/if}
        </div>
      {:else}
        <p class="empty">{$t.cashFlow.noTransactions}</p>
      {/if}
    </section>

    <div class="flow-columns">
      <section class="card daily" aria-labelledby="cash-flow-daily-title" data-daily-list>
        <header class="daily-head">
          <div>
            <h2 id="cash-flow-daily-title">{$t.cashFlow.daily}</h2>
            <p class="muted" data-daily-meta>
              {#if page.search}
                {$t.cashFlow.searchMeta(page.search.query, page.transactions.length, searchNet.map((net) => moneyText(net, $locale, true)).join(" / ") || "0")}
              {:else}
                {$t.cashFlow.dailyMeta(page.period.days, page.transactionCount)}
              {/if}
            </p>
          </div>
          <label class="search" class:active={searchText !== ""}>
            <Search size={15} strokeWidth={2} aria-hidden="true" />
            <input
              type="search"
              placeholder={$t.cashFlow.searchPlaceholder}
              aria-label={$t.cashFlow.searchAria}
              bind:value={searchText}
              oninput={() => search(searchText)}
              data-cash-flow-search
            />
            {#if page.search}<span class="search-count num">{page.transactions.length}</span>{/if}
            {#if searchText !== ""}
              <button type="button" class="clear" aria-label={$t.cashFlow.clearSearch} onclick={clearSearch}><X size={14} strokeWidth={2} aria-hidden="true" /></button>
            {/if}
          </label>
        </header>

        {#if page.search}
          <div class="search-band" data-search-fields>
            <span class="muted">{$t.cashFlow.searchScope}</span>
            {#each CASH_FLOW_SEARCH_FIELDS as field (field)}
              <span class="field-chip" class:hit={(fieldCounts?.[field] ?? 0) > 0} data-search-field={field}>{$t.cashFlow.searchFields[field]} <span class="num">{(fieldCounts?.[field] ?? 0)}</span></span>
            {/each}
            <span class="search-scope"><Calendar size={13} strokeWidth={2} aria-hidden="true" />{$t.cashFlow.searchPeriodOnly(rangeText(range, today))}</span>
          </div>
        {/if}

        {#if accountFilter || listFilter}
          <div class="filter-band">
            {#if accountFilter}<span class="field-chip hit" data-account-filter>{$t.cashFlow.accountFilter(accountLabel($t, accountFilter))}</span>{/if}
            {#if listFilter}<span class="field-chip hit" data-group-filter>{$t.cashFlow.categoryFilter(drillLabel(listFilter))}</span>{/if}
            <button type="button" class="text-link" onclick={() => { accountFilter = null; listFilter = null; }}>{$t.cashFlow.clearFilter}</button>
          </div>
        {/if}

        {#if days.length === 0}
          <p class="empty" data-daily-empty>{page.search ? $t.cashFlow.searchNoMatch(page.search.query) : $t.cashFlow.noTransactions}</p>
        {:else}
          {#each days as day (day.date)}
            <section class="day" data-day={day.date}>
              <div class="day-date">
                <strong class="num">{dayNumberText(day.date)}</strong>
                <span>{dayMeta(day.date)}</span>
              </div>
              <div class="day-body">
                <div class="day-net">
                  {#if day.net.length > 0}
                    <span class="net-pill">{$t.cashFlow.dayNet} {#each day.net as net (net.currency)}<span class="money" data-sensitive>{moneyText(net, $locale, true).replace(/^TWD /u, "")}</span>{/each}</span>
                  {/if}
                  <span class="rule" aria-hidden="true"></span>
                </div>
                <ul class="rows">
                  {#each day.rows as row (row.transactionId)}
                    {@const tag = rowTag(row)}
                    <li class="row" class:transfer={row.cashFlow.class === "not_counted"} class:unresolved={row.cashFlow.class === "unresolved"} data-row={row.transactionId} data-row-class={row.cashFlow.class}>
                      <span class="time num" data-row-time>{row.details.time ?? ""}</span>
                      <span class="mark" aria-hidden="true">{#if row.cashFlow.class === "not_counted"}<ArrowLeftRight size={13} strokeWidth={2.2} />{:else}{accountInitial($t, row.details.account)}{/if}</span>
                      <span class="row-text">
                        <strong>{rowTitle($t, row)}</strong>
                        <span><span class="dot" style:background={row.cashFlow.class === "outflow" || row.cashFlow.class === "refund" ? outflowColor(row.cashFlow.categories[0]?.group ?? null) : row.cashFlow.class === "inflow" ? inflowColor(0) : "var(--border)"} aria-hidden="true"></span>{rowCategoryText($t, row)} · {accountLabel($t, row.details.account)}{#if row.details.note && row.details.note !== rowTitle($t, row)} · {row.details.note}{/if}</span>
                      </span>
                      <span class="tags">
                        {#if row.source === "manual"}<span class="tag">{$t.cashFlow.manualTag}</span>{/if}
                        {#if tag}<span class="tag" class:accent={row.cashFlow.class === "not_counted"}>{tag}</span>{/if}
                      </span>
                      <strong class="amount money" class:positive={row.direction === "inflow" && row.cashFlow.class !== "not_counted"} data-sensitive>
                        {moneyText(signedAmount(row), $locale, row.cashFlow.class !== "not_counted").replace(/^TWD /u, "")}
                      </strong>
                    </li>
                  {/each}
                </ul>
              </div>
            </section>
          {/each}
        {/if}

        {#if page.search && page.search.allPeriods.matches > page.transactions.length}
          <footer class="search-hint" data-search-hint>
            <p>{$t.cashFlow.searchHint(page.transactions.length, page.search.allPeriods.matches)}</p>
            <button type="button" class="text-link" data-search-all onclick={searchAllPeriods}>{$t.cashFlow.searchAllPeriods}<ArrowRight size={13} strokeWidth={2.2} aria-hidden="true" /></button>
          </footer>
        {/if}
      </section>

      <aside class="card accounts" aria-labelledby="cash-flow-accounts-title" data-account-changes>
        <h2 id="cash-flow-accounts-title">{$t.cashFlow.accountChanges}</h2>
        <p class="muted">{$t.cashFlow.accountChangesNote}</p>
        {#if accounts.length === 0}
          <p class="empty">{$t.cashFlow.noAccountChanges}</p>
        {:else}
          <ul class="account-list">
            {#each accounts as change (`${change.account.id}:${change.currency}`)}
              {@const value = exactToNumber(change.amount)}
              <li>
                <button type="button" class="account" aria-pressed={accountFilter?.id === change.account.id} data-account={change.account.id} onclick={() => accountFilter = accountFilter?.id === change.account.id ? null : change.account}>
                  <span class="mark" aria-hidden="true">{accountInitial($t, change.account)}</span>
                  <span class="account-name">{accountLabel($t, change.account)}{#if change.account.source === "manual"}<span class="tag">{$t.cashFlow.manualTag}</span>{/if}</span>
                  <strong class="money" class:positive={value > 0} class:negative={value < 0} data-sensitive>{digits(change.amount, true)}</strong>
                  <span class="account-bar" aria-hidden="true">
                    <span class:positive={value >= 0} style:width={accountScale > 0 ? `${Math.abs(value) / accountScale * 50}%` : "0%"}></span>
                  </span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </aside>
    </div>
  </div>
</DashboardShell>

<style>
  .cash-flow {
    display: grid;
    gap: 24px;
  }

  .flow-summary {
    position: relative;
    display: grid;
    gap: 20px;
    padding: 28px 32px;
  }

  .summary-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
  }

  .period-line {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0 0 6px;
    color: var(--muted);
    font-size: 13px;
  }

  .summary-head h2 {
    margin: 0;
    font-size: 24px;
    font-weight: 750;
    line-height: 1.3;
  }

  .period-controls {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .preset-anchor {
    position: relative;
  }

  .figures {
    display: grid;
    grid-template-columns: auto auto auto auto auto minmax(220px, 1fr);
    align-items: start;
    gap: 16px 24px;
  }

  .figure {
    display: grid;
    gap: 6px;
  }

  .figure-label {
    color: var(--muted);
    font-size: 13px;
  }

  .figure strong {
    font-size: clamp(28px, 3vw, 40px);
    font-weight: 750;
    line-height: 1.1;
  }

  .figure.inflow strong,
  .figure.kept strong {
    color: var(--success);
  }

  .figure.kept.negative strong {
    color: var(--danger);
  }

  .figure-sub {
    color: var(--muted);
    font-size: 12px;
  }

  .operator {
    padding-top: 30px;
    color: color-mix(in oklch, var(--muted) 60%, white);
    font-size: 24px;
  }

  .aside-notes {
    display: grid;
    gap: 8px;
    justify-self: end;
    width: min(100%, 260px);
  }

  .note {
    display: grid;
    gap: 2px;
    padding: 10px 14px;
    border-radius: 10px;
    font-size: 12px;
  }

  .note.transfer {
    background: var(--accent-soft);
    color: var(--accent);
  }

  .note-extra {
    font-weight: 600;
  }

  .drill-search {
    margin: 4px 0 0;
    color: var(--muted);
    font-size: 12px;
  }

  .loading-line {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 6px 0 0;
    color: var(--muted);
    font-size: 12px;
  }

  .spinner {
    width: 10px;
    height: 10px;
    border: 2px solid color-mix(in oklch, var(--muted) 30%, transparent);
    border-top-color: var(--muted);
    border-radius: 50%;
    animation: cash-flow-spin 0.8s linear infinite;
  }

  @keyframes cash-flow-spin {
    to { transform: rotate(360deg); }
  }

  .cash-flow.loading :is(.figures, .flow-bars, .daily, .accounts) {
    opacity: 0.45;
    transition: opacity 120ms ease;
  }

  @media (prefers-reduced-motion: reduce) {
    .spinner { animation: none; }
  }

  .note.unresolved {
    background: color-mix(in oklch, var(--warn) 10%, white);
    color: color-mix(in oklch, var(--warn) 80%, var(--fg));
  }

  .note-head {
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 680;
  }

  .note strong {
    font-size: 15px;
  }

  .flow-bars {
    position: relative;
    display: grid;
    grid-template-columns: 64px 1fr;
    align-items: center;
    gap: 12px 16px;
  }

  .bar-label {
    font-size: 13px;
    font-weight: 680;
  }

  .bar {
    display: flex;
    gap: 2px;
    height: 40px;
  }

  .segment {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    padding: 0 12px;
    border: 0;
    border-radius: 6px;
    color: white;
    font: inherit;
    font-size: 13px;
    font-weight: 680;
    white-space: nowrap;
    overflow: hidden;
    cursor: pointer;
    transition: opacity 120ms ease;
  }

  .segment.dimmed {
    opacity: 0.32;
  }

  .kept-segment {
    flex: 1 0 auto;
    justify-content: center;
    border: 1px solid color-mix(in oklch, var(--success) 45%, var(--border));
    background: color-mix(in oklch, var(--success) 8%, white);
    color: var(--success);
    cursor: default;
  }

  .legend {
    grid-column: 2;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 14px;
    font-size: 12px;
  }

  .legend-title {
    color: var(--muted);
    font-weight: 720;
  }

  .legend-title.inflow {
    color: var(--success);
  }

  .legend-item {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 4px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--fg);
    font: inherit;
    cursor: pointer;
  }

  .legend-item[aria-pressed="true"] {
    background: var(--surface-soft);
  }

  .legend-item .money {
    color: var(--muted);
  }

  .dot {
    display: inline-block;
    flex: none;
    width: 8px;
    height: 8px;
    margin-right: 4px;
    border-radius: 2px;
  }

  .drill {
    position: absolute;
    top: calc(100% + 8px);
    left: 80px;
    z-index: 20;
    display: grid;
    width: min(400px, calc(100% - 80px));
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface);
    box-shadow: 0 14px 34px rgb(15 23 42 / 0.12);
  }

  .drill-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding: 16px 18px 12px;
    border-bottom: 1px solid var(--border);
  }

  .drill-title {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    font-size: 13px;
  }

  .drill-title span:last-child {
    color: var(--muted);
    font-size: 12px;
  }

  .drill-amount {
    display: block;
    margin-top: 6px;
    font-size: 26px;
    font-weight: 750;
  }

  .drill-compare {
    margin: 4px 0 0;
    color: var(--muted);
    font-size: 12px;
  }

  .drill-list {
    display: grid;
    max-height: 320px;
    margin: 0;
    padding: 4px 18px;
    overflow-y: auto;
    list-style: none;
  }

  .drill-list li {
    display: grid;
    grid-template-columns: 44px 1fr auto;
    align-items: baseline;
    gap: 4px 10px;
    padding: 10px 0 8px;
    font-size: 13px;
  }

  .drill-date {
    color: var(--muted);
    font-size: 11px;
  }

  .drill-name {
    overflow: hidden;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .drill-bar {
    grid-column: 2 / -1;
    height: 3px;
    border-radius: 999px;
    background: var(--surface-soft);
  }

  .drill-bar span {
    display: block;
    height: 100%;
    border-radius: inherit;
  }

  .drill-fact {
    margin: 4px 18px 0;
    padding: 10px 12px;
    border-radius: 8px;
    background: var(--surface-soft);
    color: var(--muted);
    font-size: 12px;
  }

  .drill-foot {
    display: flex;
    justify-content: flex-end;
    padding: 12px 18px 16px;
  }

  .drill-foot .button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .flow-columns {
    display: grid;
    grid-template-columns: minmax(0, 1.35fr) minmax(320px, 0.65fr);
    align-items: start;
    gap: 24px;
  }

  .daily {
    padding: 0;
    overflow: hidden;
  }

  .daily-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    padding: 24px 24px 20px;
    border-bottom: 1px solid var(--border);
  }

  .daily-head h2,
  .accounts h2 {
    margin: 0;
    font-size: 16px;
    font-weight: 700;
  }

  .daily-head p,
  .accounts > p {
    margin: 4px 0 0;
    font-size: 12px;
  }

  .search {
    display: flex;
    align-items: center;
    gap: 8px;
    width: min(260px, 100%);
    height: 40px;
    padding: 0 12px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface);
    color: var(--muted);
  }

  .search.active {
    border-color: var(--accent);
  }

  .search input {
    flex: 1;
    min-width: 0;
    border: 0;
    outline: 0;
    background: transparent;
    color: var(--fg);
    font: inherit;
    font-size: 13px;
  }

  .search input:focus {
    box-shadow: none;
  }

  .search input::-webkit-search-cancel-button {
    display: none;
  }

  .search-count {
    font-size: 12px;
  }

  .clear {
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    padding: 0;
    border: 0;
    border-radius: 999px;
    background: var(--surface-soft);
    color: var(--muted);
    cursor: pointer;
  }

  .search-band,
  .filter-band {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: 14px 24px;
    border-bottom: 1px solid var(--border);
    background: var(--surface-soft);
    font-size: 12px;
  }

  .search-scope {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-left: auto;
    color: var(--muted);
  }

  .field-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 24px;
    padding: 0 10px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface);
    color: var(--muted);
  }

  .field-chip.hit {
    border-color: var(--surface-strong);
    background: var(--surface-strong);
    color: white;
    font-weight: 680;
  }

  .text-link {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--accent);
    font: inherit;
    font-weight: 680;
    cursor: pointer;
  }

  .day {
    display: grid;
    grid-template-columns: 88px 1fr;
    gap: 8px;
    padding: 20px 24px;
    border-bottom: 1px solid var(--border);
  }

  .day:last-of-type {
    border-bottom: 0;
  }

  .day-date strong {
    display: block;
    font-size: 26px;
    font-weight: 750;
    line-height: 1.1;
  }

  .day-date span {
    color: var(--muted);
    font-size: 12px;
  }

  .day-net {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 6px;
  }

  .net-pill {
    display: inline-flex;
    gap: 6px;
    padding: 2px 10px;
    border-radius: 999px;
    background: var(--surface-soft);
    color: var(--muted);
    font-size: 11px;
  }

  .net-pill .money {
    color: var(--fg);
    font-weight: 750;
  }

  .rule {
    flex: 1;
    height: 1px;
    background: var(--border);
  }

  .rows {
    display: grid;
    gap: 2px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .row {
    display: grid;
    grid-template-columns: 48px 28px minmax(0, 1fr) auto auto;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;
    border-radius: 10px;
  }

  .row.transfer {
    background: var(--accent-soft);
  }

  .row.transfer .row-text strong {
    color: var(--accent);
  }

  .time {
    color: var(--muted);
    font-size: 11px;
  }

  .mark {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border-radius: 7px;
    background: var(--surface-strong);
    color: white;
    font-size: 12px;
    font-weight: 750;
  }

  .row.transfer .mark {
    background: var(--surface);
    color: var(--accent);
  }

  .row-text {
    display: grid;
    min-width: 0;
    gap: 2px;
  }

  .row-text strong {
    overflow: hidden;
    font-size: 14px;
    font-weight: 650;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .row-text > span {
    display: flex;
    align-items: center;
    overflow: hidden;
    color: var(--muted);
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tags {
    display: flex;
    gap: 4px;
  }

  .tag {
    display: inline-flex;
    align-items: center;
    height: 22px;
    margin-left: 6px;
    padding: 0 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--muted);
    font-size: 11px;
    white-space: nowrap;
  }

  .tag.accent {
    border-color: transparent;
    color: var(--accent);
  }

  .amount {
    min-width: 88px;
    font-size: 14px;
    text-align: right;
  }

  .amount.positive,
  .money.positive {
    color: var(--success);
  }

  .money.negative {
    color: var(--danger);
  }

  .search-hint {
    display: grid;
    justify-items: center;
    gap: 4px;
    padding: 20px 24px 24px;
    border-top: 1px solid var(--border);
    font-size: 13px;
  }

  .search-hint p {
    margin: 0;
  }

  .accounts {
    display: grid;
    gap: 4px;
    padding: 24px 20px;
  }

  .account-list {
    display: grid;
    gap: 2px;
    margin: 12px 0 0;
    padding: 0;
    list-style: none;
  }

  .account {
    display: grid;
    grid-template-columns: 26px 1fr auto;
    align-items: center;
    gap: 6px 10px;
    width: 100%;
    padding: 8px;
    border: 1px solid transparent;
    border-radius: 10px;
    background: transparent;
    color: var(--fg);
    font: inherit;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }

  .account:hover {
    background: var(--surface-soft);
  }

  .account[aria-pressed="true"] {
    border-color: var(--border);
    background: var(--surface-soft);
  }

  .account .mark {
    width: 24px;
    height: 24px;
    font-size: 11px;
  }

  .account-name {
    display: flex;
    align-items: center;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .account-bar {
    position: relative;
    grid-column: 2 / -1;
    height: 4px;
    border-radius: 999px;
    background: var(--surface-soft);
  }

  .account-bar span {
    position: absolute;
    top: 0;
    right: 50%;
    height: 100%;
    border-radius: inherit;
    background: var(--danger);
  }

  .account-bar span.positive {
    right: auto;
    left: 50%;
    background: var(--success);
  }

  .empty {
    margin: 0;
    padding: 24px;
    color: var(--muted);
    font-size: 13px;
    text-align: center;
  }

  @media (max-width: 1180px) {
    .figures {
      grid-template-columns: auto auto auto auto auto;
    }

    .aside-notes {
      grid-column: 1 / -1;
      justify-self: start;
      width: 100%;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    }

    .flow-columns {
      grid-template-columns: 1fr;
    }
  }

  @media (max-width: 760px) {
    .flow-summary {
      padding: 20px 16px;
    }

    .summary-head,
    .daily-head {
      flex-direction: column;
    }

    .figures {
      grid-template-columns: 1fr;
    }

    .operator {
      display: none;
    }

    .row {
      grid-template-columns: 40px 26px minmax(0, 1fr) auto;
    }

    .tags {
      display: none;
    }

    .day {
      grid-template-columns: 1fr;
    }

    .drill {
      left: 0;
      width: 100%;
    }
  }
</style>
