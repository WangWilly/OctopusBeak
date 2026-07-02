export function buildSparklineYAxis(values: number[]) {
  const finiteValues = values.filter(Number.isFinite);
  if (finiteValues.length === 0) return { min: 0, max: 0, step: 0, ticks: [] };

  const min = Math.min(...finiteValues);
  const max = Math.max(...finiteValues);
  const span = max - min;
  const step = span === 0 ? fallbackAxisStep(max) : span / 2;

  if (span === 0) {
    return {
      min: min - step * 2,
      max: max + step * 2,
      step,
      ticks: [max + step * 2, max + step, max, max - step, max - step * 2],
    };
  }

  return {
    min: min - step,
    max: max + step,
    step,
    ticks: [max + step, max, (min + max) / 2, min, min - step],
  };
}

export function buildCenteredSparklineYAxis(values: number[]) {
  const finiteValues = values.filter(Number.isFinite);
  if (finiteValues.length === 0) return { min: 0, max: 0, step: 0, ticks: [] };

  const rawMax = Math.max(...finiteValues.map((value) => Math.abs(value)));
  const max = rawMax === 0 ? 2 : rawMax * 1.5;
  const step = max / 2;

  return {
    min: -max,
    max,
    step,
    ticks: [max, step, 0, -step, -max],
  };
}

export function formatSparklineTick(value: number, step = 0) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: compactFractionDigits(value, step),
    notation: "compact",
  }).format(value);
}

function fallbackAxisStep(value: number) {
  return Math.max(Math.abs(value) * 0.01, 1);
}

function compactFractionDigits(value: number, step: number) {
  if (step <= 0) return 1;
  const abs = Math.abs(value);
  const scale = abs >= 1_000_000_000 ? 1_000_000_000 : abs >= 1_000_000 ? 1_000_000 : abs >= 1_000 ? 1_000 : 1;
  if (scale === 1) return 0;

  const scaledStep = Math.abs(step) / scale;
  if (scaledStep >= 1) return 0;
  if (scaledStep >= 0.1) return 1;
  if (scaledStep >= 0.01) return 2;
  return 3;
}
