import type { OverviewSankeyGraphDto, OverviewSankeyLinkDto, OverviewSankeyNodeDto } from "../types.ts";
import type { RawPosition } from "$lib/shared-ledger/server/accounts.ts";

type Tone = "asset" | "liability";
type ConvertedPosition = RawPosition & { tone: Tone; twdValue: number };

const kindOrder = ["bank", "fund", "brokerage", "crypto", "foreign", "credit-card", "loan", "other"];

export function buildOverviewSankeyGraph(
  positions: readonly RawPosition[],
  rates: ReadonlyMap<string, number>,
): OverviewSankeyGraphDto | null {
  const converted = positions
    .filter((position) => Number.isFinite(position.value) && position.value > 0)
    .map((position) => ({ ...position, tone: position.group === "liability" ? "liability" as const : "asset" as const, twdValue: toTwd(position, rates) }));
  if (converted.some((position) => position.twdValue === null)) return null;
  const available = converted as ConvertedPosition[];
  if (available.length === 0) return null;

  const nodes: OverviewSankeyNodeDto[] = [];
  const nodeIds = new Set<string>();
  const links: OverviewSankeyLinkDto[] = [];
  const linkIndexes = new Map<string, number>();
  const addNode = (id: string, label: string, level: OverviewSankeyNodeDto["level"], tone: Tone) => {
    if (!nodeIds.has(id)) nodes.push({ id, label, level, tone });
    nodeIds.add(id);
  };
  const addLink = (source: string, target: string, value: number, tone: Tone) => {
    const key = `${source}|${target}`;
    const index = linkIndexes.get(key);
    if (index === undefined) {
      linkIndexes.set(key, links.length);
      links.push({ source, target, value, tone });
    } else {
      links[index].value += value;
    }
  };

  for (const tone of ["asset", "liability"] as const) {
    const byTone = available.filter((position) => position.tone === tone);
    if (byTone.length === 0) continue;
    const rootId = `root:${tone}`;
    addNode(rootId, tone === "asset" ? "Assets" : "Liabilities", 0, tone);

    const kinds = new Map<string, ConvertedPosition[]>();
    for (const position of byTone) kinds.set(position.kind, [...(kinds.get(position.kind) ?? []), position]);
    for (const [kind, kindPositions] of [...kinds.entries()].sort(([left], [right]) => kindRank(left) - kindRank(right) || left.localeCompare(right))) {
      const kindId = `kind:${tone}:${kind}`;
      addNode(kindId, kindPositions[0].typeLabel, 1, tone);
      addLink(rootId, kindId, sum(kindPositions), tone);

      const accounts = new Map<string, ConvertedPosition[]>();
      for (const position of kindPositions) accounts.set(position.accountId, [...(accounts.get(position.accountId) ?? []), position]);
      for (const [accountId, accountPositions] of [...accounts.entries()].sort(([, left], [, right]) => left[0].label.localeCompare(right[0].label))) {
        const accountIdWithKind = `account:${tone}:${kind}:${accountId}`;
        addNode(accountIdWithKind, accountPositions[0].label, 2, tone);
        addLink(kindId, accountIdWithKind, sum(accountPositions), tone);
        if (!accountPositions.every((position) => position.positionDetail)) continue;
        for (const position of accountPositions) {
          const positionId = `position:${tone}:${accountId}:${position.id}`;
          addNode(positionId, position.positionDetail!.name || position.label, 3, tone);
          addLink(accountIdWithKind, positionId, position.twdValue, tone);
        }
      }
    }
  }

  return { nodes, links };
}

function toTwd(position: RawPosition, rates: ReadonlyMap<string, number>) {
  if (position.currency === "TWD") return position.value;
  const rate = rates.get(position.currency);
  return rate && Number.isFinite(rate) && rate > 0 ? position.value * rate : null;
}

function sum(positions: readonly ConvertedPosition[]) {
  return positions.reduce((total, position) => total + position.twdValue, 0);
}

function kindRank(kind: string) {
  const index = kindOrder.indexOf(kind);
  return index === -1 ? kindOrder.length : index;
}
