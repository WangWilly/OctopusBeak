import type { AccountRowDto } from "./types.ts";

/**
 * Where a counted figure's data came from besides Verified financial data:
 * Preview financial data (ADR 0047) or a Manual Asset (ADR 0087). A figure
 * carries the origin of every amount it counts (ADR 0069).
 */
export type Origin = "preview" | "manual";

/** Keyed by origin, so a new origin fails to compile until every figure accounts for it. */
export type Provenance = Readonly<Record<Origin, boolean>>;

export const NO_PROVENANCE: Provenance = { preview: false, manual: false };

export function originProvenance(origin: Origin): Provenance {
  return { ...NO_PROVENANCE, [origin]: true };
}

/** The figure counts an amount of `origin`, when there is one, besides what `provenance` already counts. */
export function withOrigin(provenance: Provenance, origin: Origin | null): Provenance {
  return origin === null || provenance[origin] ? provenance : { ...provenance, [origin]: true };
}

export function mergeProvenance(...items: readonly Provenance[]): Provenance {
  return { preview: items.some((item) => item.preview), manual: items.some((item) => item.manual) };
}

export function hasProvenance(provenance: Provenance): boolean {
  return provenance.preview || provenance.manual;
}

/** A Preview account row or a Manual Asset row; null for Verified financial data. */
export function accountOrigin(account: Pick<AccountRowDto, "preview" | "manual">): Origin | null {
  if (account.preview) return "preview";
  if (account.manual) return "manual";
  return null;
}

export function accountProvenance(account: Pick<AccountRowDto, "preview" | "manual">): Provenance {
  return withOrigin(NO_PROVENANCE, accountOrigin(account));
}
