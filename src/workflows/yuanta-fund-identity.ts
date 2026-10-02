export function normalizeYuantaFundName(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

/** Source history identifies funds by their reported name, independently of later metadata. */
export function resolveYuantaFundIdentity(name: string) {
  const normalized = normalizeYuantaFundName(name);
  if (!normalized) throw new Error("YuanTa fund requires a source name.");
  return { producerSecurityId: `name:${normalized}`, name: normalized, pricingCurrency: null,
    identityKind: "source-fund-name" as const };
}
