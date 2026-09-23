import type { OverviewSankeyGraphDto, OverviewSankeyLinkDto, OverviewSankeyNodeDto } from "../types.ts";
import type { CanonicalOverviewPosition } from "../../../ledger/canonical/canonical-overview-query.ts";
import {
  decimalToExact,
  exactToNumber,
  multiplyExact,
  addExact,
  type ExactAmount,
} from "../../shared-money/exact.ts";

type Tone = "asset" | "liability";
type CanonicalConvertedPosition = {
  id: string;
  accountId: string;
  label: string;
  kind: string;
  typeLabel: string;
  group: "asset";
  currency: string;
  value: number;
  exact: { coefficient: string; scale: number };
  twdExact: ExactAmount;
  positionDetail: { name: string };
  tone: Tone;
  twdValue: number;
  rateDate?: string;
  twdPerUnit?: number;
};

const kindOrder = ["bank", "fund", "brokerage", "crypto", "foreign", "credit-card", "loan", "other"];

/** Builds the Overview flow graph from canonical holding observations. */
export function buildCanonicalOverviewSankeyGraph(
  positions: readonly CanonicalOverviewPosition[],
  rates: ReadonlyMap<string, { rateDate: string; twdPerUnit: number }>,
): OverviewSankeyGraphDto | null {
  const converted: CanonicalConvertedPosition[] = [];
  for (const position of positions) {
    if (position.amount === null) continue;
    const value = exactToNumber(position.amount.exact);
    if (!Number.isFinite(value) || value <= 0) continue;
    const rate = position.currency === "TWD" ? { rateDate: "", twdPerUnit: 1 } : rates.get(position.currency);
    if (!rate || !Number.isFinite(rate.twdPerUnit) || rate.twdPerUnit <= 0) return null;
    const rateExact = decimalToExact(rate.twdPerUnit);
    if (!rateExact) return null;
    const twdExact = multiplyExact(position.amount.exact, rateExact);
    const twdValue = exactToNumber(twdExact);
    if (!Number.isFinite(twdValue) || twdValue <= 0) continue;
    converted.push({
      id: position.id,
      accountId: position.accountId,
      label: position.label,
      kind: position.kind,
      typeLabel: position.typeLabel,
      group: "asset",
      currency: position.currency,
      value,
      exact: position.amount.exact,
      twdExact,
      positionDetail: { name: position.name },
      tone: "asset",
      twdValue,
      rateDate: rate.rateDate,
      twdPerUnit: rate.twdPerUnit,
    });
  }
  if (converted.length === 0) return null;

  const nodes: OverviewSankeyNodeDto[] = [];
  const nodeIds = new Set<string>();
  const links: OverviewSankeyLinkDto[] = [];
  const linkIndexes = new Map<string, number>();
  const addNode = (id: string, label: string, level: OverviewSankeyNodeDto["level"], tone: Tone) => {
    if (!nodeIds.has(id)) nodes.push({ id, label, level, tone });
    nodeIds.add(id);
  };
  const addLink = (
    source: string,
    target: string,
    value: number,
    tone: Tone,
    metadata?: Pick<OverviewSankeyLinkDto, "currency" | "exact" | "convertedExact" | "conversion">,
  ) => {
    const key = `${source}|${target}`;
    const index = linkIndexes.get(key);
    if (index === undefined) {
      linkIndexes.set(key, links.length);
      links.push({ source, target, value, tone, ...(metadata ?? {}) });
    } else {
      links[index]!.value += value;
      if (metadata?.convertedExact) {
        links[index]!.convertedExact = addExact(
          links[index]!.convertedExact ?? { coefficient: "0", scale: 0 },
          metadata.convertedExact,
        );
      }
    }
  };
  const rootId = "root:asset";
  addNode(rootId, "Assets", 0, "asset");
  const kinds = new Map<string, CanonicalConvertedPosition[]>();
  for (const position of converted)
    kinds.set(position.kind, [...(kinds.get(position.kind) ?? []), position]);
  for (const [kind, kindPositions] of [...kinds.entries()].sort(([left], [right]) => kindRank(left) - kindRank(right) || left.localeCompare(right))) {
    const kindId = `kind:asset:${kind}`;
    addNode(kindId, kindPositions[0]!.typeLabel, 1, "asset");
    addLink(rootId, kindId, sum(kindPositions), "asset", {
      convertedExact: sumExact(kindPositions),
      currency: "TWD",
    });
    const accounts = new Map<string, CanonicalConvertedPosition[]>();
    for (const position of kindPositions)
      accounts.set(position.accountId, [...(accounts.get(position.accountId) ?? []), position]);
    for (const [accountId, accountPositions] of [...accounts.entries()].sort(([, left], [, right]) => left[0]!.label.localeCompare(right[0]!.label))) {
      const accountNode = `account:asset:${kind}:${accountId}`;
      addNode(accountNode, accountPositions[0]!.label, 2, "asset");
      addLink(kindId, accountNode, sum(accountPositions), "asset", {
        convertedExact: sumExact(accountPositions),
        currency: "TWD",
      });
      for (const position of accountPositions) {
        const positionNode = `position:asset:${accountId}:${position.id}`;
        addNode(positionNode, position.positionDetail.name, 3, "asset");
        addLink(accountNode, positionNode, position.twdValue, "asset", {
          currency: position.currency,
          exact: position.exact,
          convertedExact: position.twdExact,
          conversion: position.currency === "TWD" || !position.rateDate
            ? undefined
            : {
              fromCurrency: position.currency,
              toCurrency: "TWD",
              rateDate: position.rateDate,
              twdPerUnit: position.twdPerUnit!,
              convertedExact: position.twdExact,
            },
        });
      }
    }
  }
  return { nodes, links };
}

function sum(positions: readonly { twdValue: number }[]) {
  return positions.reduce((total, position) => total + position.twdValue, 0);
}

function kindRank(kind: string) {
  const index = kindOrder.indexOf(kind);
  return index === -1 ? kindOrder.length : index;
}

function sumExact(positions: readonly CanonicalConvertedPosition[]): ExactAmount {
  return positions.reduce<ExactAmount>(
    (total, position) => addExact(total, position.twdExact),
    { coefficient: "0", scale: 0 },
  );
}
