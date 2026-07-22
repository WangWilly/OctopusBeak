<script lang="ts">
  import { Chart, Group, Layer, Link, Rect, Text, Tooltip, sankeyGraphFromNode } from "layerchart";
  import { Sankey } from "layerchart/graph";
  import { locale, t } from "$lib/i18n/i18n.ts";
  import type { OverviewSankeyGraphDto } from "$lib/overview/types.ts";
  import { formatMoney } from "$lib/shared-money/money.ts";

  export let graph: OverviewSankeyGraphDto;
  export let currency = "TWD";
  export let twdPerUnit = 1;

  let highlightLinkIndexes: number[] = [];
  let selectedNode: any = null;

  const colors = {
    asset: "oklch(53% 0.1 207)",
    liability: "oklch(56% 0.11 34)",
  } as const;

  function amount(value: number) {
    return formatMoney({ currency, value });
  }

  function colorFor(tone: unknown) {
    return tone === "liability" ? colors.liability : colors.asset;
  }

  function labelFor(value: string) {
    return ($t.knownLabels as Record<string, string>)[value] ?? value;
  }

  function linkedIndexes(node: any) {
    return [...(node.sourceLinks ?? []), ...(node.targetLinks ?? [])].map((link) => link.index);
  }

  function percentage(value: number, total: number) {
    return new Intl.NumberFormat($locale, { style: "percent", maximumFractionDigits: 1 }).format(total ? value / total : 0);
  }

  function selectNode(node: any) {
    selectedNode = selectedNode?.id === node.id || node.sourceLinks?.length === 0 ? null : node;
  }

  function chartHeightFor(nodes: OverviewSankeyGraphDto["nodes"]) {
    const counts = new Map<number, number>();
    for (const node of nodes) counts.set(node.level, (counts.get(node.level) ?? 0) + 1);
    return Math.max(440, Math.max(0, ...counts.values()) * 28 + 48);
  }

  $: chartHeight = chartHeightFor(graph.nodes);
  $: displayGraph = twdPerUnit === 1 ? graph : {
    nodes: graph.nodes,
    links: graph.links.map((link) => ({ ...link, value: link.value / twdPerUnit })),
  };
  $: chartGraph = selectedNode ? sankeyGraphFromNode(selectedNode) : displayGraph;
</script>

<div class="overview-sankey" role="img" aria-label={$t.overview.portfolioFlow}>
  <Chart data={chartGraph} flatData={[]} height={chartHeight} padding={{ top: 18, right: 180, bottom: 18, left: 12 }}>
    {#snippet children({ context })}
      <Layer>
        <Sankey nodeId={(node) => node.id} nodeAlign="justify" nodePadding={8} nodeWidth={10}>
          {#snippet children({ links, nodes })}
            {#each links as link ([link.source.id, link.target.id, link.value].join("-"))}
              <Link
                sankey
                data={link}
                stroke={colorFor(link.tone)}
                strokeOpacity={highlightLinkIndexes.length && !highlightLinkIndexes.includes(link.index) ? 0.05 : 0.25}
                strokeWidth={link.width}
                class="overview-sankey-link"
                onpointermove={(event) => context.tooltip.show(event, { link })}
                onpointerleave={() => {
                  context.tooltip.hide();
                  highlightLinkIndexes = [];
                }}
              />
            {/each}

            {#each nodes as node (node.id)}
              {@const nodeWidth = (node.x1 ?? 0) - (node.x0 ?? 0)}
              {@const nodeHeight = (node.y1 ?? 0) - (node.y0 ?? 0)}
              {@const isLastColumn = node.depth === 3}
              <Group
                x={node.x0}
                y={node.y0}
                onpointerenter={() => (highlightLinkIndexes = linkedIndexes(node))}
                onpointerleave={() => (highlightLinkIndexes = [])}
                onclick={() => selectNode(node)}
              >
                <Rect
                  width={nodeWidth}
                  height={nodeHeight}
                  fill={colorFor(node.tone)}
                  fillOpacity={0.72}
                  class="overview-sankey-node"
                  onpointermove={(event) => context.tooltip.show(event, { node })}
                  onpointerleave={() => context.tooltip.hide()}
                />
                {#if nodeHeight >= 14}
                  <Text
                    value={labelFor(node.label)}
                    x={isLastColumn ? -5 : nodeWidth + 5}
                    y={nodeHeight / 2}
                    textAnchor={isLastColumn ? "end" : "start"}
                    verticalAnchor="middle"
                    class="overview-sankey-label"
                  />
                {/if}
              </Group>
            {/each}
          {/snippet}
        </Sankey>
      </Layer>

      <Tooltip.Root {context} class="overview-sankey-tooltip" variant="none" portal={false}>
        {#snippet children({ data })}
          <div class="overview-sankey-tooltip-body">
            {#if data.node}
              <strong>{labelFor(data.node.label)}</strong>
              <div class="overview-sankey-tooltip-row">
                <span>{$t.common.total}</span>
                <b data-sensitive>{amount(data.node.value)}</b>
              </div>
              {#if data.node.targetLinks.length}
                <div class="overview-sankey-tooltip-section">{$t.common.sources}</div>
                {#each data.node.targetLinks as link}
                  <div class="overview-sankey-tooltip-row">
                    <span>{labelFor(link.source.label)}</span>
                    <span class="overview-sankey-tooltip-values">
                      <b data-sensitive>{amount(link.value)}</b>
                      <em>{percentage(link.value, data.node.value)}</em>
                    </span>
                  </div>
                {/each}
              {/if}
              {#if data.node.sourceLinks.length}
                <div class="overview-sankey-tooltip-section">{$t.common.targets}</div>
                {#each data.node.sourceLinks as link}
                  <div class="overview-sankey-tooltip-row">
                    <span>{labelFor(link.target.label)}</span>
                    <span class="overview-sankey-tooltip-values">
                      <b data-sensitive>{amount(link.value)}</b>
                      <em>{percentage(link.value, data.node.value)}</em>
                    </span>
                  </div>
                {/each}
              {/if}
            {:else if data.link}
              <strong>{labelFor(data.link.source.label)} → {labelFor(data.link.target.label)}</strong>
              <div class="overview-sankey-tooltip-row">
                <span>{$t.common.balance}</span>
                <b data-sensitive>{amount(data.link.value)}</b>
              </div>
            {/if}
          </div>
        {/snippet}
      </Tooltip.Root>
    {/snippet}
  </Chart>
</div>

<style>
  .overview-sankey {
    min-width: 0;
  }

  :global(.overview-sankey-link) {
    transition: stroke-opacity 160ms ease;
  }

  :global(.overview-sankey-node) {
    cursor: pointer;
  }

  :global(.overview-sankey-label) {
    fill: var(--ink);
    font-size: 11px;
    font-weight: 700;
    paint-order: stroke;
    stroke: var(--surface);
    stroke-width: 3px;
  }

  .overview-sankey-tooltip-body {
    display: grid;
    gap: 5px;
    min-width: 180px;
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-sm);
    background: var(--fg);
    color: white;
    box-shadow: 0 8px 20px color-mix(in srgb, black 22%, transparent);
    font-size: 12px;
    font-weight: 800;
  }

  .overview-sankey-tooltip-row {
    display: flex;
    justify-content: space-between;
    gap: 18px;
  }

  .overview-sankey-tooltip-row span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .overview-sankey-tooltip-row b {
    white-space: nowrap;
  }

  .overview-sankey-tooltip-values {
    display: flex;
    gap: 8px;
    white-space: nowrap;
  }

  .overview-sankey-tooltip-values em {
    color: color-mix(in srgb, white 70%, transparent);
    font-style: normal;
  }

  .overview-sankey-tooltip-section {
    margin-top: 3px;
    padding-top: 7px;
    border-top: 1px solid color-mix(in srgb, white 24%, transparent);
    color: color-mix(in srgb, white 70%, transparent);
    font-size: 11px;
    font-weight: 700;
  }
</style>
