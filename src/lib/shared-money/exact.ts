export type ExactAmount = Readonly<{
  coefficient: string;
  scale: number;
}>;

export function normalizeExact(value: ExactAmount): ExactAmount {
  let coefficient = BigInt(value.coefficient);
  let scale = value.scale;
  if (coefficient === 0n) return { coefficient: "0", scale: 0 };
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  return { coefficient: coefficient.toString(), scale };
}
export function addExact(left: ExactAmount, right: ExactAmount): ExactAmount {
  const scale = Math.max(left.scale, right.scale);
  const coefficient = BigInt(left.coefficient) * 10n ** BigInt(scale - left.scale)
    + BigInt(right.coefficient) * 10n ** BigInt(scale - right.scale);
  return normalizeExact({ coefficient: coefficient.toString(), scale });
}

export function multiplyExact(left: ExactAmount, right: ExactAmount): ExactAmount {
  return normalizeExact({
    coefficient: (BigInt(left.coefficient) * BigInt(right.coefficient)).toString(),
    scale: left.scale + right.scale,
  });
}

/** Divides with a bounded decimal scale so geometry and display stay finite. */
export function divideExact(
  left: ExactAmount,
  right: ExactAmount,
  precision = 18,
): ExactAmount | null {
  const denominator = BigInt(right.coefficient);
  if (denominator === 0n) return null;
  const leftCoefficient = BigInt(left.coefficient);
  if (leftCoefficient === 0n) return { coefficient: "0", scale: 0 };
  const negative = (leftCoefficient < 0n) !== (denominator < 0n);
  let numerator = leftCoefficient < 0n ? -leftCoefficient : leftCoefficient;
  let positiveDenominator = denominator < 0n ? -denominator : denominator;
  const exponent = precision + right.scale - left.scale;
  if (exponent >= 0) numerator *= 10n ** BigInt(exponent);
  else positiveDenominator *= 10n ** BigInt(-exponent);
  let quotient = numerator / positiveDenominator;
  if ((numerator % positiveDenominator) * 2n >= positiveDenominator) quotient += 1n;
  if (negative) quotient = -quotient;
  return normalizeExact({ coefficient: quotient.toString(), scale: precision });
}

export function decimalToExact(value: number): ExactAmount | null {
  if (!Number.isFinite(value)) return null;
  const text = String(value).toLowerCase();
  const match = text.match(/^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/);
  if (!match) return null;
  const sign = match[1] === "-" ? -1n : 1n;
  const whole = match[2] ?? "0";
  const fraction = match[3] ?? "";
  const exponent = Number(match[4] ?? "0");
  let coefficient = sign * BigInt(`${whole}${fraction}`);
  let scale = fraction.length - exponent;
  if (scale < 0) {
    coefficient *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return normalizeExact({ coefficient: coefficient.toString(), scale });
}

export function exactToNumber(value: ExactAmount): number {
  const coefficient = BigInt(value.coefficient);
  const number = Number(coefficient) / 10 ** value.scale;
  return coefficient !== 0n && number === 0
    ? Number.NaN
    : Number.isFinite(number)
      ? number
      : Number.NaN;
}
