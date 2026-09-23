export type CanonicalOverviewExactAmount = Readonly<{
  coefficient: string;
  scale: number;
}>;

export function exactAmountToNumber(value: CanonicalOverviewExactAmount): number {
  const coefficient = BigInt(value.coefficient);
  const number = Number(coefficient) / 10 ** value.scale;
  // The exact coefficient/scale remains authoritative when a value cannot be
  // represented by JavaScript's presentation number. Returning zero here
  // would turn an overflow or underflow into a fabricated financial value.
  return coefficient !== 0n && number === 0
    ? Number.NaN
    : Number.isFinite(number)
      ? number
      : Number.NaN;
}
